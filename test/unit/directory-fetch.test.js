'use strict'

// Phase 1: covers src/directory.js's Directory#maybeFetchManifest, which
// fetches `http://127.0.0.1:<port>/.well-known/janus-index.json` from a
// tenant's own backend over the already-established local tunnel port. Every
// server here is a REAL loopback http.Server (or bare net.Server, for the
// "never responds" case) bound with `.listen(0, ...)` (OS-assigned ephemeral
// port) -- no fixed port range, so nothing to register in
// test/unit/fixtures/port-ranges.js (same pattern as
// server-proxy-timeout.test.js).
//
// The method's own doc comment says it must NEVER throw. Failure modes
// split into two families: content-level failures (bad status, wrong
// content-type, oversized body, malformed JSON, `list: false`) mean the
// backend answered and disqualified itself, and de-list any existing
// entry. Transport-level failures (connection refused, timeout) mean no
// answer was ever received -- an outage, not a revocation -- so they mark
// an existing entry offline WITHOUT deleting it, and create nothing for a
// key that was never listed. Every test below asserts via
// assert.doesNotReject AND checks which of those two outcomes occurred.

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { Store, load } = require('../../src/store')
const { parseKey } = require('../../src/key')
const { Directory } = require('../../src/directory')

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'
const KEY_B = 'ejkmcpqxot1uwiszh76934abndrfg8ejkmcpqxot1uwisza3456y'

const tmpPaths = []
function tmpStorePath(label) {
  const p = path.join(
    os.tmpdir(),
    `janus-directory-fetch-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
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

/** New Store + Directory pair backed by a fresh tmp file. */
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

function listenRaw(handler) {
  return new Promise((resolve) => {
    const server = net.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
    // http.Server#close() waits for in-flight connections to end before
    // firing its callback -- destroy any still-open sockets so a test whose
    // handler deliberately never calls res.end() doesn't hang this cleanup.
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
  })
}

function makeRecord(port, rawKey) {
  const parsed = parseKey(rawKey)
  return { port, keyHash: parsed.keyHash, client: { seed: parsed.key } }
}

test('maybeFetchManifest: happy path -- a valid manifest is persisted as a directory entry', async () => {
  const { store, directory } = freshHarness()
  let requests = 0
  const server = await listenHttp((req, res) => {
    requests++
    assert.equal(req.url, '/.well-known/janus-index.json')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ list: true, title: 'My Project', description: 'A neat project.', tags: ['node', 'demo'] }))
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    assert.equal(requests, 1)
    const entry = store.getDirectoryEntry(record.keyHash)
    assert.ok(entry, 'a directory entry must be persisted')
    assert.equal(entry.title, 'My Project')
    assert.equal(entry.description, 'A neat project.')
    assert.deepEqual(entry.tags, ['node', 'demo'])
    assert.equal(entry.rawKey, parseKey(KEY_A).key)
    assert.equal(entry.online, true)
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: DIRECTORY_ENABLED false -- no fetch happens at all, no entry created', async () => {
  const { store, directory } = freshHarness({ DIRECTORY_ENABLED: false })
  let requests = 0
  const server = await listenHttp((req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ list: true, title: 'Should Not Be Fetched' }))
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    assert.equal(requests, 0, 'DIRECTORY_ENABLED=false must skip the HTTP fetch entirely')
    assert.equal(store.getDirectoryEntry(record.keyHash), undefined)
  } finally {
    await closeServer(server)
  }
})

for (const status of [404, 500]) {
  test(`maybeFetchManifest: a ${status} response de-lists any existing entry`, async () => {
    const { store, directory } = freshHarness()
    const record = makeRecord(0, KEY_A) // port filled in below
    const { keyHash } = record
    store.setDirectoryEntry(keyHash, parseKey(KEY_A).key, { title: 'Old Listing', description: '', tags: [] })
    assert.ok(store.getDirectoryEntry(keyHash), 'precondition: entry exists before the fetch')

    const server = await listenHttp((req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: true }))
    })
    try {
      record.port = server.address().port
      await assert.doesNotReject(() => directory.maybeFetchManifest(record))
      assert.equal(store.getDirectoryEntry(keyHash), undefined, `a ${status} response must de-list the existing entry`)
    } finally {
      await closeServer(server)
    }
  })
}

test('maybeFetchManifest: a non-application/json content-type de-lists an existing entry', async () => {
  const { store, directory } = freshHarness()
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Old Listing', description: '', tags: [] })

  const server = await listenHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>not json</body></html>')
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    assert.equal(store.getDirectoryEntry(keyHash), undefined)
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: malformed JSON body de-lists an existing entry', async () => {
  const { store, directory } = freshHarness()
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Old Listing', description: '', tags: [] })

  const server = await listenHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{ this is not valid json')
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    assert.equal(store.getDirectoryEntry(keyHash), undefined)
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: a body exceeding DIRECTORY_MANIFEST_MAX_BYTES de-lists the entry and does not hang the socket', async () => {
  // Timeout is deliberately much larger than the max-bytes abort should
  // take -- if the oversized-body guard didn't actively abort the response,
  // this test would only resolve once the FULL timeout elapsed, which the
  // elapsed-time assertion below would catch.
  const { store, directory } = freshHarness({ DIRECTORY_MANIFEST_MAX_BYTES: 1000, DIRECTORY_MANIFEST_TIMEOUT_MS: 5000 })
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Old Listing', description: '', tags: [] })

  const server = await listenHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    // Oversized single chunk, then deliberately never call res.end() -- if
    // the client didn't actively destroy the response on overflow, this
    // connection would hang until the (long) timeout.
    res.write(Buffer.alloc(5000, 'a'))
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    const startedAt = Date.now()
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    const elapsed = Date.now() - startedAt
    assert.equal(store.getDirectoryEntry(keyHash), undefined, 'an oversized body must de-list the entry')
    assert.ok(elapsed < 3000, `expected the oversized-body abort to resolve well under the 5000ms timeout, took ${elapsed}ms`)
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: a server that accepts but never responds times out per DIRECTORY_MANIFEST_TIMEOUT_MS', async () => {
  const TIMEOUT_MS = 250
  const { store, directory } = freshHarness({ DIRECTORY_MANIFEST_TIMEOUT_MS: TIMEOUT_MS })
  // Bare net.Server: accepts the TCP connection but never writes an HTTP
  // response at all, simulating a hung backend.
  const server = await listenRaw(() => {
    // intentionally do nothing with the socket
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    const startedAt = Date.now()
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed >= TIMEOUT_MS, `expected to wait at least ${TIMEOUT_MS}ms, only waited ${elapsed}ms`)
    assert.ok(elapsed < TIMEOUT_MS + 3000, `expected the timeout to fire promptly, took ${elapsed}ms`)
    assert.equal(store.getDirectoryEntry(record.keyHash), undefined)
  } finally {
    server.close()
  }
})

test('maybeFetchManifest: connection refused (nothing listening) is swallowed, never throws', async () => {
  const { store, directory } = freshHarness()
  // Bind an ephemeral port, learn its number, then close it immediately so
  // nothing is listening there anymore.
  const probe = await listenRaw(() => {})
  const freePort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  const record = makeRecord(freePort, KEY_A)
  await assert.doesNotReject(() => directory.maybeFetchManifest(record))
  assert.equal(store.getDirectoryEntry(record.keyHash), undefined)
})

test('maybeFetchManifest: recheck cache -- two calls within DIRECTORY_RECHECK_MS only hit the server once', async () => {
  const { directory } = freshHarness({ DIRECTORY_RECHECK_MS: 3600000 })
  let requests = 0
  const server = await listenHttp((req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ list: true, title: 'Cached Project' }))
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await directory.maybeFetchManifest(record)
    await directory.maybeFetchManifest(record)
    await directory.maybeFetchManifest(record)
    assert.equal(requests, 1, 'a call inside the recheck window must not re-fetch')
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: connection refused on a LISTED key marks it offline but keeps the entry', async () => {
  const { store, directory } = freshHarness()
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Existing Listing', description: '', tags: [] })
  assert.equal(store.getDirectoryEntry(keyHash).online, true, 'precondition: entry starts online')

  const probe = await listenRaw(() => {})
  const freePort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  const record = makeRecord(freePort, KEY_A)
  await assert.doesNotReject(() => directory.maybeFetchManifest(record))
  const entry = store.getDirectoryEntry(keyHash)
  assert.ok(entry, 'a transport-level failure (outage) must NOT delete the entry')
  assert.equal(entry.online, false, 'the entry must be marked offline')
})

test('maybeFetchManifest: a hung backend (timeout) on a LISTED key marks it offline but keeps the entry', async () => {
  const TIMEOUT_MS = 250
  const { store, directory } = freshHarness({ DIRECTORY_MANIFEST_TIMEOUT_MS: TIMEOUT_MS })
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Existing Listing', description: '', tags: [] })

  // Bare net.Server: accepts the TCP connection but never writes an HTTP
  // response at all, simulating a hung (but tunnelled, not dead) backend.
  const server = await listenRaw(() => {
    // intentionally do nothing with the socket
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    const entry = store.getDirectoryEntry(keyHash)
    assert.ok(entry, 'a timeout must be treated as an outage, not a de-listing, and must NOT delete the entry')
    assert.equal(entry.online, false, 'the entry must be marked offline')
  } finally {
    server.close()
  }
})

test('maybeFetchManifest: a 404 response deletes the entry (content-level failure, not an outage)', async () => {
  const { store, directory } = freshHarness()
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Existing Listing', description: '', tags: [] })

  const server = await listenHttp((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    assert.equal(store.getDirectoryEntry(keyHash), undefined, 'a 404 answer must delete the entry, not mark it offline')
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: a 200 text/plain response deletes the entry', async () => {
  const { store, directory } = freshHarness()
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Existing Listing', description: '', tags: [] })

  const server = await listenHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('not json')
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    assert.equal(store.getDirectoryEntry(keyHash), undefined)
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: a 200 JSON response with list:false deletes the entry', async () => {
  const { store, directory } = freshHarness()
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Existing Listing', description: '', tags: [] })

  const server = await listenHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ list: false, title: 'Withdrawn' }))
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    assert.equal(store.getDirectoryEntry(keyHash), undefined, 'list:false is an explicit revocation and must delete the entry')
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: an oversized body on a LISTED key deletes the entry (content-level, not an outage)', async () => {
  const { store, directory } = freshHarness({ DIRECTORY_MANIFEST_MAX_BYTES: 1000, DIRECTORY_MANIFEST_TIMEOUT_MS: 5000 })
  const rawKey = parseKey(KEY_A).key
  const keyHash = parseKey(KEY_A).keyHash
  store.setDirectoryEntry(keyHash, rawKey, { title: 'Existing Listing', description: '', tags: [] })

  const server = await listenHttp((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write(Buffer.alloc(5000, 'a'))
  })
  try {
    const record = makeRecord(server.address().port, KEY_A)
    await assert.doesNotReject(() => directory.maybeFetchManifest(record))
    assert.equal(store.getDirectoryEntry(keyHash), undefined, 'an oversized body is a content-level failure and must delete the entry')
  } finally {
    await closeServer(server)
  }
})

test('maybeFetchManifest: connection refused on an UNLISTED key creates no phantom entry', async () => {
  const { store, directory } = freshHarness()
  const keyHash = parseKey(KEY_B).keyHash
  assert.equal(store.getDirectoryEntry(keyHash), undefined, 'precondition: no existing entry')

  const probe = await listenRaw(() => {})
  const freePort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))

  const record = makeRecord(freePort, KEY_B)
  await assert.doesNotReject(() => directory.maybeFetchManifest(record))
  assert.equal(store.getDirectoryEntry(keyHash), undefined, 'markOffline on an unlisted key must not create a phantom entry')
})

test('maybeFetchManifest: never throws on missing record fields (no port/keyHash)', async () => {
  const { directory } = freshHarness()
  await assert.doesNotReject(() => directory.maybeFetchManifest(null))
  await assert.doesNotReject(() => directory.maybeFetchManifest(undefined))
  await assert.doesNotReject(() => directory.maybeFetchManifest({}))
  await assert.doesNotReject(() => directory.maybeFetchManifest({ keyHash: 'abc' })) // no port
  await assert.doesNotReject(() => directory.maybeFetchManifest({ port: 12345 })) // no keyHash
})
