'use strict'

// Phase 1: covers src/directory.js's Directory#list() -- the security-load-
// bearing part of the feature. A directory entry is fetched consent from a
// tenant's backend, but the KEY it's attached to can be blocked or
// password-protected by the operator/tenant AFTER the manifest was fetched
// and stored; list() must re-check eligibility on every call, live, with NO
// dependency on a refetch ever happening again. No HTTP servers here --
// entries are seeded directly via store.setDirectoryEntry (and, to control
// ordering/liveness fields precisely, by mutating the entry object
// store.getDirectoryEntry() returns, which is a live reference into the
// store's in-memory state).

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../../src/store')
const { parseKey } = require('../../src/key')
const { Directory } = require('../../src/directory')

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'
const KEY_B = 'ejkmcpqxot1uwiszh76934abndrfg8ejkmcpqxot1uwisza3456y'

const tmpPaths = []
function tmpStorePath(label) {
  const p = path.join(
    os.tmpdir(),
    `janus-directory-list-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
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

function freshHarness(configOverrides) {
  const store = load(tmpStorePath('h'))
  const directory = new Directory({ config: fakeConfig(configOverrides), store })
  return { store, directory }
}

/** Seed a directory entry and return { keyHash, entry } (entry is a live
 * reference -- mutate it directly to control lastSeenAt/online for ordering
 * tests, since the public API has no "set arbitrary timestamp" method). */
function seed(store, rawKey, fields) {
  const { keyHash } = parseKey(rawKey)
  store.setDirectoryEntry(keyHash, parseKey(rawKey).key, fields)
  return { keyHash, entry: store.getDirectoryEntry(keyHash) }
}

test('list(): DIRECTORY_ENABLED false returns [] regardless of stored entries', () => {
  const { store, directory } = freshHarness({ DIRECTORY_ENABLED: false })
  seed(store, KEY_A, { title: 'A', description: '', tags: [] })
  assert.deepEqual(directory.list(), [])
})

test('list(): a listed entry whose key is later blocked disappears without any refetch', () => {
  const { store, directory } = freshHarness()
  const { keyHash } = seed(store, KEY_A, { title: 'A', description: '', tags: [] })

  assert.equal(directory.list().some((e) => e.keyHash === keyHash), true, 'precondition: listed before blocking')

  store.setBlocked(keyHash, true)
  assert.equal(directory.list().some((e) => e.keyHash === keyHash), false, 'a blocked key must disappear from list()')

  store.setBlocked(keyHash, false)
  assert.equal(directory.list().some((e) => e.keyHash === keyHash), true, 'must reappear once unblocked')
})

test('list(): a listed entry whose key later gets a password disappears without any refetch', () => {
  const { store, directory } = freshHarness()
  const { keyHash } = seed(store, KEY_A, { title: 'A', description: '', tags: [] })

  assert.equal(directory.list().some((e) => e.keyHash === keyHash), true)

  store.setPassword(keyHash, parseKey(KEY_A).key, 'hash', 'salt')
  assert.equal(directory.list().some((e) => e.keyHash === keyHash), false, 'a passworded key must disappear from list()')

  store.clearPassword(keyHash)
  assert.equal(directory.list().some((e) => e.keyHash === keyHash), true, 'must reappear once the password is cleared')
})

test('list(): search q matches title, description, and tags, case-insensitively', () => {
  const { store, directory } = freshHarness()
  seed(store, KEY_A, { title: 'Weather Dashboard', description: 'tracks storms', tags: ['weather', 'charts'] })
  seed(store, KEY_B, { title: 'Recipe Book', description: 'family recipes', tags: ['food', 'cooking'] })

  const byTitle = directory.list({ q: 'WEATHER' })
  assert.equal(byTitle.length, 1)
  assert.equal(byTitle[0].title, 'Weather Dashboard')

  const byDescription = directory.list({ q: 'Storms' })
  assert.equal(byDescription.length, 1)
  assert.equal(byDescription[0].title, 'Weather Dashboard')

  const byTag = directory.list({ q: 'cooking' })
  assert.equal(byTag.length, 1)
  assert.equal(byTag[0].title, 'Recipe Book')

  const noMatch = directory.list({ q: 'spreadsheet' })
  assert.equal(noMatch.length, 0)
})

test('list(): ordering -- online entries sort before offline, ties broken by lastSeenAt desc', () => {
  const { store, directory } = freshHarness()
  const now = Date.now()

  const offlineOld = seed(store, KEY_A, { title: 'Offline Old', description: '', tags: [] })
  offlineOld.entry.online = false
  offlineOld.entry.lastSeenAt = now - 100000

  // Need two more distinct keys for the online ties -- reuse KEY_B plus a
  // third synthetic keyHash-only entry (setDirectoryEntry only needs a
  // keyHash + rawKey string, not a real parseable key, for direct seeding).
  const onlineNew = { keyHash: parseKey(KEY_B).keyHash }
  store.setDirectoryEntry(onlineNew.keyHash, parseKey(KEY_B).key, { title: 'Online New', description: '', tags: [] })
  onlineNew.entry = store.getDirectoryEntry(onlineNew.keyHash)
  onlineNew.entry.online = true
  onlineNew.entry.lastSeenAt = now

  const thirdKeyHash = 'a'.repeat(64)
  store.setDirectoryEntry(thirdKeyHash, 'unused-raw-key', { title: 'Online Old', description: '', tags: [] })
  const onlineOldEntry = store.getDirectoryEntry(thirdKeyHash)
  onlineOldEntry.online = true
  onlineOldEntry.lastSeenAt = now - 50000

  const titles = directory.list().map((e) => e.title)
  assert.deepEqual(titles, ['Online New', 'Online Old', 'Offline Old'])
})

test('list(): DIRECTORY_MAX_ENTRIES caps the number of entries returned', () => {
  const { store, directory } = freshHarness({ DIRECTORY_MAX_ENTRIES: 2 })
  seed(store, KEY_A, { title: 'One', description: '', tags: [] })
  seed(store, KEY_B, { title: 'Two', description: '', tags: [] })
  store.setDirectoryEntry('b'.repeat(64), 'unused-raw-key', { title: 'Three', description: '', tags: [] })

  const result = directory.list()
  assert.equal(result.length, 2)
})
