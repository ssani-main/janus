'use strict'

// Phase 1 follow-up fix: covers src/directory.js's Directory#forget (explicit
// eviction of a keyHash's _lastCheckedAt recheck-cache entry, wired from
// admin.js's /_admin/delete handler) and the opportunistic
// _sweepLastCheckedAt bound that keeps the Map's steady-state size capped
// even for eviction paths (tunnel-manager idle/circuit/shutdown) that have no
// Directory reference to call forget() from. See directory.js's module
// comment on LAST_CHECKED_SWEEP_MULTIPLIER/warnedMissingSeed for why.

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../../src/store')
const { parseKey } = require('../../src/key')
const { Directory } = require('../../src/directory')

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

const tmpPaths = []
function tmpStorePath(label) {
  const p = path.join(
    os.tmpdir(),
    `janus-directory-forget-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  )
  tmpPaths.push(p)
  return p
}

after(() => {
  for (const p of tmpPaths) {
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort
    }
    try {
      const dir = path.dirname(p)
      const prefix = `${path.basename(p)}.tmp.`
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix)) {
          try {
            fs.unlinkSync(path.join(dir, name))
          } catch {
            // best-effort
          }
        }
      }
    } catch {
      // best-effort
    }
  }
})

function fakeConfig(overrides) {
  return Object.assign(
    {
      DIRECTORY_ENABLED: true,
      DIRECTORY_MANIFEST_TIMEOUT_MS: 500,
      DIRECTORY_MANIFEST_MAX_BYTES: 65536,
      DIRECTORY_RECHECK_MS: 3600000,
      DIRECTORY_MAX_ENTRIES: 500,
    },
    overrides
  )
}

function freshHarness(configOverrides) {
  const store = load(tmpStorePath('h'))
  const directory = new Directory({ config: fakeConfig(configOverrides), store })
  return { store, directory }
}

function listenHttp(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  })
}

test('forget: removes the keyHash from the recheck cache', () => {
  const { directory } = freshHarness()
  directory._lastCheckedAt.set('some-key-hash', Date.now())
  assert.ok(directory._lastCheckedAt.has('some-key-hash'))

  directory.forget('some-key-hash')
  assert.equal(directory._lastCheckedAt.has('some-key-hash'), false)
})

test('forget: no-op (does not throw) for an unknown keyHash', () => {
  const { directory } = freshHarness()
  assert.doesNotThrow(() => directory.forget('never-seen'))
})

test('forget: never throws on falsy input', () => {
  const { directory } = freshHarness()
  assert.doesNotThrow(() => directory.forget(undefined))
  assert.doesNotThrow(() => directory.forget(null))
  assert.doesNotThrow(() => directory.forget(''))
})

test('forget: a forgotten keyHash is re-fetched immediately even inside the recheck window', async () => {
  const { directory } = freshHarness({ DIRECTORY_RECHECK_MS: 3600000 })
  let requests = 0
  const server = await listenHttp((req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ list: true, title: 'T' }))
  })
  try {
    const parsed = parseKey(KEY_A)
    const record = { port: server.address().port, keyHash: parsed.keyHash, client: { seed: parsed.key } }
    await directory.maybeFetchManifest(record)
    assert.equal(requests, 1)

    // Still inside the recheck window -- a second call must NOT re-fetch.
    await directory.maybeFetchManifest(record)
    assert.equal(requests, 1)

    // After forget(), the cache no longer remembers this keyHash was
    // recently checked, so the very next call re-fetches immediately.
    directory.forget(record.keyHash)
    await directory.maybeFetchManifest(record)
    assert.equal(requests, 2, 'forget() must clear the recheck-cache entry so the next call re-fetches')
  } finally {
    await closeServer(server)
  }
})

test('_sweepLastCheckedAt: stale entries beyond the size bound are evicted opportunistically', () => {
  const { directory } = freshHarness({ DIRECTORY_MAX_ENTRIES: 5, DIRECTORY_RECHECK_MS: 1000 })
  // Bound is DIRECTORY_MAX_ENTRIES * 4 = 20. Populate it well past that with
  // entries that are already stale (older than DIRECTORY_RECHECK_MS).
  const now = Date.now()
  for (let i = 0; i < 30; i++) {
    directory._lastCheckedAt.set(`stale-${i}`, now - 5000)
  }
  // One fresh entry that must survive the sweep.
  directory._lastCheckedAt.set('fresh', now)
  assert.equal(directory._lastCheckedAt.size, 31)

  directory._sweepLastCheckedAt(now)

  assert.equal(directory._lastCheckedAt.has('fresh'), true, 'a fresh (non-stale) entry must survive the sweep')
  assert.equal(directory._lastCheckedAt.size, 1, 'every stale entry must be evicted once the bound is crossed')
})

test('_sweepLastCheckedAt: does nothing while under the size bound', () => {
  const { directory } = freshHarness({ DIRECTORY_MAX_ENTRIES: 5, DIRECTORY_RECHECK_MS: 1000 })
  const now = Date.now()
  for (let i = 0; i < 10; i++) {
    directory._lastCheckedAt.set(`stale-${i}`, now - 5000)
  }
  assert.ok(directory._lastCheckedAt.size <= 5 * 4, 'precondition: under the bound')

  directory._sweepLastCheckedAt(now)

  assert.equal(directory._lastCheckedAt.size, 10, 'sweep must be a no-op while under the bound, even with stale entries')
})

test('maybeFetchManifest triggers the sweep as a side effect once the bound is crossed', async () => {
  const { directory } = freshHarness({ DIRECTORY_MAX_ENTRIES: 2, DIRECTORY_RECHECK_MS: 1000 })
  const now = Date.now()
  // Bound is 2 * 4 = 8. Pre-populate 8 stale entries so the very next
  // maybeFetchManifest call (which adds one more entry, crossing to 9) fires
  // the sweep.
  for (let i = 0; i < 8; i++) {
    directory._lastCheckedAt.set(`stale-${i}`, now - 5000)
  }

  const server = await listenHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ list: true, title: 'T' }))
  })
  try {
    const parsed = parseKey(KEY_A)
    const record = { port: server.address().port, keyHash: parsed.keyHash, client: { seed: parsed.key } }
    await directory.maybeFetchManifest(record)

    for (let i = 0; i < 8; i++) {
      assert.equal(directory._lastCheckedAt.has(`stale-${i}`), false, `stale-${i} must have been swept`)
    }
    assert.equal(directory._lastCheckedAt.has(record.keyHash), true, 'the just-checked key must remain')
  } finally {
    await closeServer(server)
  }
})
