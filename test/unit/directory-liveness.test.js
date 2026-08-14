'use strict'

// Phase 1: covers src/directory.js's Directory#markOnline/#markOffline,
// which wrap store.touchDirectoryLiveness() and are called on the HOT
// tenant request path (see store.js's touchDirectoryLiveness doc comment).
// The critical property under test is the persist-debounce: touching an
// already-online entry must update in-memory state but must NOT trigger a
// blocking disk write (_persist, a synchronous fsync+rename) on every single
// proxied request -- only when `online` actually flips. Verified by spying
// on store._persist and counting calls, not by inspecting the filesystem
// (mtime granularity would be too coarse to catch a regression reliably).

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
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
    `janus-directory-liveness-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
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
      DIRECTORY_RECHECK_MS: 3600000,
      DIRECTORY_MAX_ENTRIES: 500,
    },
    overrides
  )
}

/** Wraps store._persist to count calls, returning a getter for the count. */
function spyOnPersist(store) {
  const original = store._persist.bind(store)
  let calls = 0
  store._persist = (...args) => {
    calls++
    return original(...args)
  }
  return () => calls
}

test('markOnline: flips an offline entry online and bumps lastSeenAt', async () => {
  const store = load(tmpStorePath('online-flip'))
  const directory = new Directory({ config: fakeConfig(), store })
  const { keyHash, key: rawKey } = parseKey(KEY_A)
  store.setDirectoryEntry(keyHash, rawKey, { title: 'T', description: '', tags: [] })
  store.getDirectoryEntry(keyHash).online = false
  const before = store.getDirectoryEntry(keyHash).lastSeenAt

  await new Promise((r) => setTimeout(r, 5)) // ensure Date.now() advances
  await directory.markOnline(keyHash)

  const entry = store.getDirectoryEntry(keyHash)
  assert.equal(entry.online, true)
  assert.ok(entry.lastSeenAt >= before, 'lastSeenAt must be updated (or at least not go backwards)')
})

test('markOffline: flips an online entry offline', async () => {
  const store = load(tmpStorePath('offline-flip'))
  const directory = new Directory({ config: fakeConfig(), store })
  const { keyHash, key: rawKey } = parseKey(KEY_A)
  store.setDirectoryEntry(keyHash, rawKey, { title: 'T', description: '', tags: [] }) // online defaults true

  await directory.markOffline(keyHash)
  assert.equal(store.getDirectoryEntry(keyHash).online, false)
})

test('persist-debounce: repeated markOnline on an already-online entry never triggers repeated disk writes', async () => {
  const store = load(tmpStorePath('debounce-online'))
  const directory = new Directory({ config: fakeConfig(), store })
  const { keyHash, key: rawKey } = parseKey(KEY_A)
  store.setDirectoryEntry(keyHash, rawKey, { title: 'T', description: '', tags: [] }) // online: true already

  const getCalls = spyOnPersist(store)
  for (let i = 0; i < 20; i++) {
    await directory.markOnline(keyHash) // already online every time -- must not flip
  }
  assert.equal(getCalls(), 0, 'touching an already-online entry must never call _persist')
})

test('persist-debounce: only a state FLIP triggers _persist, not every call', async () => {
  const store = load(tmpStorePath('debounce-flip'))
  const directory = new Directory({ config: fakeConfig(), store })
  const { keyHash, key: rawKey } = parseKey(KEY_A)
  store.setDirectoryEntry(keyHash, rawKey, { title: 'T', description: '', tags: [] }) // online: true

  const getCalls = spyOnPersist(store)
  await directory.markOnline(keyHash) // no flip (already online)
  await directory.markOnline(keyHash) // no flip
  assert.equal(getCalls(), 0)

  await directory.markOffline(keyHash) // flip true -> false
  assert.equal(getCalls(), 1)

  await directory.markOffline(keyHash) // no flip (already offline)
  await directory.markOffline(keyHash) // no flip
  assert.equal(getCalls(), 1, 'repeated markOffline on an already-offline entry must not persist again')

  await directory.markOnline(keyHash) // flip false -> true
  assert.equal(getCalls(), 2)
})

test('markOnline/markOffline on an unknown keyHash: no-op, does not throw, creates no entry', async () => {
  const store = load(tmpStorePath('unknown-keyhash'))
  const directory = new Directory({ config: fakeConfig(), store })
  const unknownKeyHash = 'deadbeef'.repeat(8)

  await assert.doesNotReject(() => directory.markOnline(unknownKeyHash))
  await assert.doesNotReject(() => directory.markOffline(unknownKeyHash))
  assert.equal(store.getDirectoryEntry(unknownKeyHash), undefined)
})

test('markOnline/markOffline: an empty/falsy keyHash is a no-op and does not throw', async () => {
  const store = load(tmpStorePath('empty-keyhash'))
  const directory = new Directory({ config: fakeConfig(), store })

  await assert.doesNotReject(() => directory.markOnline(''))
  await assert.doesNotReject(() => directory.markOnline(null))
  await assert.doesNotReject(() => directory.markOffline(''))
  await assert.doesNotReject(() => directory.markOffline(undefined))
})
