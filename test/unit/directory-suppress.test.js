'use strict'

// Directory-only suppression flag: an operator moderation lever that hides a
// key from /directory and /directory.json (both of which render
// src/directory.js's Directory#list() -- see server.js's /directory and
// /directory.json handlers, both of which call `directory.list({ q })`
// directly) without touching the tenant's tunnel/site at all.
//
// Critical design property under test here: directorySuppressed lives on the
// KEY record (data.keys[keyHash], via store.setDirectorySuppressed), NOT on
// the directory entry (data.directory[keyHash]). The directory entry is
// created/overwritten by every successful manifest fetch and deleted by every
// failed one -- a moderation decision stored there would be silently cleared
// the next time the owner's own backend gets visited. This file's most
// important test proves suppression survives exactly that: a full delete +
// recreate of the directory entry via the real fetch path.

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
    `janus-directory-suppress-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
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
  }
})

function fakeConfig(overrides) {
  return Object.assign(
    {
      DIRECTORY_ENABLED: true,
      DIRECTORY_MANIFEST_TIMEOUT_MS: 5000,
      DIRECTORY_MANIFEST_MAX_BYTES: 65536,
      DIRECTORY_RECHECK_MS: 0, // 0 so maybeFetchManifest never skips as "not due" in tests
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

function seed(store, rawKey, fields) {
  const { keyHash } = parseKey(rawKey)
  store.setDirectoryEntry(keyHash, parseKey(rawKey).key, fields)
  return { keyHash, entry: store.getDirectoryEntry(keyHash) }
}

// --- store.js: setDirectorySuppressed/isDirectorySuppressed -----------------

test('store: isDirectorySuppressed defaults false for an unknown key', () => {
  const store = load(tmpStorePath('default'))
  assert.equal(store.isDirectorySuppressed('a'.repeat(64)), false)
})

test('store: setDirectorySuppressed(true) creates a bare record and flips the flag', () => {
  const store = load(tmpStorePath('create'))
  const keyHash = 'b'.repeat(64)
  assert.equal(store.getKey(keyHash), undefined, 'precondition: no record yet')

  store.setDirectorySuppressed(keyHash, true)
  assert.equal(store.isDirectorySuppressed(keyHash), true)
  const record = store.getKey(keyHash)
  assert.ok(record, 'a bare record must now exist')
  assert.equal(record.rawKey, null, 'suppressing a keyHash with no prior sighting must not fabricate a rawKey')
})

test('store: setDirectorySuppressed(false) clears the flag', () => {
  const store = load(tmpStorePath('clear'))
  const keyHash = 'c'.repeat(64)
  store.setDirectorySuppressed(keyHash, true)
  assert.equal(store.isDirectorySuppressed(keyHash), true)
  store.setDirectorySuppressed(keyHash, false)
  assert.equal(store.isDirectorySuppressed(keyHash), false)
})

test('store: directorySuppressed survives a save/reload round-trip', () => {
  const p = tmpStorePath('roundtrip')
  const store1 = load(p)
  const keyHash = 'd'.repeat(64)
  store1.setDirectorySuppressed(keyHash, true)

  const store2 = load(p)
  assert.equal(store2.isDirectorySuppressed(keyHash), true)
})

test('store: listMetadata() includes directorySuppressed and never leaks rawKey/password', () => {
  const store = load(tmpStorePath('listmeta'))
  const { keyHash } = parseKey(KEY_A)
  store.setDirectorySuppressed(keyHash, true)

  const meta = store.listMetadata().find((m) => m.keyHash === keyHash)
  assert.ok(meta)
  assert.equal(meta.directorySuppressed, true)
  assert.equal('rawKey' in meta, false)
  assert.equal('password' in meta, false)
})

test('store: directorySuppressed and blocked are independent flags', () => {
  const store = load(tmpStorePath('independent'))
  const keyHash = 'e'.repeat(64)
  store.setBlocked(keyHash, true)
  store.setDirectorySuppressed(keyHash, true)
  assert.equal(store.isBlocked(keyHash), true)
  assert.equal(store.isDirectorySuppressed(keyHash), true)

  store.setDirectorySuppressed(keyHash, false)
  assert.equal(store.isBlocked(keyHash), true, 'unsuppressing must not touch blocked')
  assert.equal(store.isDirectorySuppressed(keyHash), false)
})

// --- directory.js: list() eligibility, no refetch required ------------------

test('list(): a suppressed key disappears from list() immediately, with no refetch', () => {
  const { store, directory } = freshHarness()
  const { keyHash } = seed(store, KEY_A, { title: 'A', description: '', tags: [] })

  assert.equal(directory.list().some((e) => e.keyHash === keyHash), true, 'precondition: listed before suppression')

  store.setDirectorySuppressed(keyHash, true)
  assert.equal(directory.list().some((e) => e.keyHash === keyHash), false, 'a suppressed key must disappear from list()')
})

test('list(): unsuppressing restores the listing immediately, with no refetch', () => {
  const { store, directory } = freshHarness()
  const { keyHash } = seed(store, KEY_A, { title: 'A', description: '', tags: [] })

  store.setDirectorySuppressed(keyHash, true)
  assert.equal(directory.list().some((e) => e.keyHash === keyHash), false)

  store.setDirectorySuppressed(keyHash, false)
  assert.equal(directory.list().some((e) => e.keyHash === keyHash), true, 'must reappear once unsuppressed, with the entry still intact')
})

test('list(): suppression does not delete the underlying directory entry', () => {
  const { store, directory } = freshHarness()
  const { keyHash } = seed(store, KEY_A, { title: 'Original Title', description: '', tags: [] })

  store.setDirectorySuppressed(keyHash, true)
  directory.list() // render once while suppressed

  const entry = store.getDirectoryEntry(keyHash)
  assert.ok(entry, 'the directory entry itself must still exist on disk/in-memory')
  assert.equal(entry.title, 'Original Title', 'entry content must be untouched by suppression')
})

// --- The critical property: survives a full manifest refetch ----------------

test('directorySuppressed survives a manifest refetch that deletes and recreates the directory entry', async () => {
  const { store, directory } = freshHarness()
  const rawKey = parseKey(KEY_A).key

  // Seed an initial listing exactly like a real fetch would (setDirectoryEntry),
  // then suppress it via the operator lever.
  const { keyHash } = seed(store, KEY_A, { title: 'Before', description: '', tags: [] })
  store.setDirectorySuppressed(keyHash, true)
  assert.equal(directory.list().some((e) => e.keyHash === keyHash), false, 'precondition: suppressed')

  // Simulate the owner's backend answering with a fresh, valid manifest --
  // this is exactly the passive fetch path that creates/overwrites
  // data.directory[keyHash] via setDirectoryEntry. Eligibility is re-checked
  // in maybeFetchManifest before persisting (see _eligibleNow), so a
  // suppressed key's manifest fetch must skip persisting entirely rather than
  // resurrecting the listing.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ list: true, title: 'After Refetch', description: '', tags: [] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await directory.maybeFetchManifest({ port, keyHash, client: { seed: rawKey } })
  } finally {
    server.close()
  }

  assert.equal(store.isDirectorySuppressed(keyHash), true, 'the operator decision must survive the refetch')
  assert.equal(
    directory.list().some((e) => e.keyHash === keyHash),
    false,
    'must still be hidden from list() after a manifest refetch recreated/would-have-recreated the directory entry'
  )
})

test('unsuppressing after a legitimate refetch restores the (now-updated) listing without a further refetch', async () => {
  const { store, directory } = freshHarness()
  const rawKey = parseKey(KEY_A).key
  const { keyHash } = seed(store, KEY_A, { title: 'Before', description: '', tags: [] })

  store.setDirectorySuppressed(keyHash, false)
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ list: true, title: 'Updated', description: '', tags: [] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    await directory.maybeFetchManifest({ port, keyHash, client: { seed: rawKey } })
  } finally {
    server.close()
  }

  assert.equal(directory.list().some((e) => e.keyHash === keyHash && e.title === 'Updated'), true)
})

// --- Proxying/routing must be entirely unaffected ----------------------------

test('suppression is orthogonal to routing: isDirectorySuppressed has no bearing on isBlocked, which is what gates tunnels', () => {
  const store = load(tmpStorePath('routing'))
  const keyHash = 'f'.repeat(64)
  store.setDirectorySuppressed(keyHash, true)

  // The only flag tunnel-manager/server.js consult before proxying a request
  // is isBlocked -- suppression must never flip it.
  assert.equal(store.isBlocked(keyHash), false, 'a directory-suppressed key must not be blocked')
})
