'use strict'

// Phase 1: covers src/store.js's `directory` top-level collection --
// setDirectoryEntry/clearDirectoryEntry/getDirectoryEntry/listDirectory,
// its save/reload persistence, back-compat loading of a pre-directory store
// file, and deleteKey's removal of a key's directory entry. See
// store.test.js for the pre-existing keys/aliases coverage this deliberately
// does not duplicate.

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { Store, load } = require('../../src/store')
const { parseKey } = require('../../src/key')

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'
const KEY_B = 'ejkmcpqxot1uwiszh76934abndrfg8ejkmcpqxot1uwisza3456y'

const tmpPaths = []
function tmpStorePath(label) {
  const p = path.join(
    os.tmpdir(),
    `janus-store-directory-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
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

test('setDirectoryEntry/getDirectoryEntry: round-trips the stored fields', () => {
  const p = tmpStorePath('basic')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setDirectoryEntry(keyHash, KEY_A, { title: 'My Project', description: 'desc', tags: ['a', 'b'] })
  const entry = store.getDirectoryEntry(keyHash)
  assert.equal(entry.rawKey, KEY_A)
  assert.equal(entry.title, 'My Project')
  assert.equal(entry.description, 'desc')
  assert.deepEqual(entry.tags, ['a', 'b'])
  assert.equal(entry.online, true)
  assert.equal(typeof entry.listedAt, 'number')
  assert.equal(typeof entry.lastSeenAt, 'number')
  assert.equal(typeof entry.lastCheckedAt, 'number')
})

test('setDirectoryEntry: re-listing preserves listedAt/lastSeenAt/online from the existing entry', () => {
  const p = tmpStorePath('relist-preserves')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setDirectoryEntry(keyHash, KEY_A, { title: 'V1', description: '', tags: [] })
  const first = store.getDirectoryEntry(keyHash)
  first.online = false // simulate having gone offline since the first listing

  store.setDirectoryEntry(keyHash, KEY_A, { title: 'V2', description: '', tags: [] })
  const second = store.getDirectoryEntry(keyHash)
  assert.equal(second.title, 'V2', 'new fields must overwrite')
  assert.equal(second.listedAt, first.listedAt, 'listedAt must be preserved across a re-list')
  assert.equal(second.lastSeenAt, first.lastSeenAt, 'lastSeenAt must be preserved across a re-list')
  assert.equal(second.online, false, 'online must be preserved across a re-list, not reset to true')
})

test('entries survive a save/reload round-trip through Store.load()', () => {
  const p = tmpStorePath('roundtrip')
  const store1 = load(p)
  const { keyHash } = parseKey(KEY_A)
  store1.setDirectoryEntry(keyHash, KEY_A, { title: 'Persisted', description: 'd', tags: ['x'] })

  const store2 = load(p)
  const entry = store2.getDirectoryEntry(keyHash)
  assert.ok(entry, 'entry must survive a fresh load()')
  assert.equal(entry.title, 'Persisted')
  assert.equal(entry.rawKey, KEY_A)
  assert.deepEqual(entry.tags, ['x'])
})

test('clearDirectoryEntry: removes the entry; no-op if none exists', () => {
  const p = tmpStorePath('clear')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)
  store.setDirectoryEntry(keyHash, KEY_A, { title: 'T', description: '', tags: [] })
  assert.ok(store.getDirectoryEntry(keyHash))

  store.clearDirectoryEntry(keyHash)
  assert.equal(store.getDirectoryEntry(keyHash), undefined)

  // No-op on a keyHash with no entry.
  assert.doesNotThrow(() => store.clearDirectoryEntry(keyHash))
  assert.doesNotThrow(() => store.clearDirectoryEntry('never-existed'))
})

test('listDirectory(): returns every entry with its keyHash included', () => {
  const p = tmpStorePath('listall')
  const store = load(p)
  const { keyHash: khA } = parseKey(KEY_A)
  const { keyHash: khB } = parseKey(KEY_B)
  store.setDirectoryEntry(khA, KEY_A, { title: 'A', description: '', tags: [] })
  store.setDirectoryEntry(khB, KEY_B, { title: 'B', description: '', tags: [] })

  const all = store.listDirectory()
  assert.equal(all.length, 2)
  const keyHashes = all.map((e) => e.keyHash).sort()
  assert.deepEqual(keyHashes, [khA, khB].sort())
})

test('loading an OLD store file with NO "directory" key defaults cleanly to empty (back-compat)', () => {
  const p = tmpStorePath('old-format')
  // Simulate a pre-Phase-1 store file: version/keys/aliases only, no
  // `directory` field at all.
  fs.writeFileSync(p, JSON.stringify({ version: 1, keys: {}, aliases: {} }), 'utf8')

  const store = load(p)
  assert.deepEqual(store.listDirectory(), [])
  assert.equal(Object.getPrototypeOf(store.data.directory), null, 'must be normalized to a null-prototype map like keys/aliases')

  // And it must be fully usable going forward.
  const { keyHash } = parseKey(KEY_A)
  assert.doesNotThrow(() => store.setDirectoryEntry(keyHash, KEY_A, { title: 'New', description: '', tags: [] }))
  assert.ok(store.getDirectoryEntry(keyHash))
})

test('deleteKey: removes the directory entry even when the key has a "keys" record', () => {
  const p = tmpStorePath('deletekey-with-record')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)
  store.setAlias('myalias', KEY_A)
  store.setDirectoryEntry(keyHash, KEY_A, { title: 'T', description: '', tags: [] })
  assert.ok(store.getDirectoryEntry(keyHash))

  store.deleteKey(keyHash)
  assert.equal(store.getDirectoryEntry(keyHash), undefined)
})

test('deleteKey: removes the directory entry even with NO "keys" record at all', () => {
  const p = tmpStorePath('deletekey-no-record')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)
  // Directory entry only -- no setAlias/setPassword/setBlocked ever called,
  // so data.keys[keyHash] does not exist.
  store.setDirectoryEntry(keyHash, KEY_A, { title: 'T', description: '', tags: [] })
  assert.equal(store.getKey(keyHash), undefined, 'precondition: no keys[] record exists')
  assert.ok(store.getDirectoryEntry(keyHash))

  assert.doesNotThrow(() => store.deleteKey(keyHash))
  assert.equal(store.getDirectoryEntry(keyHash), undefined)
})

test('deleteKey: a directory entry is dropped even for a BLOCKED key (not preserved like the block itself)', () => {
  const p = tmpStorePath('deletekey-blocked')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)
  store.setBlocked(keyHash, true)
  store.setDirectoryEntry(keyHash, KEY_A, { title: 'T', description: '', tags: [] })

  store.deleteKey(keyHash)

  assert.equal(store.isBlocked(keyHash), true, 'the block itself must still survive')
  assert.equal(store.getDirectoryEntry(keyHash), undefined, 'the directory entry must NOT survive alongside the block')
})

test('deleteKey directory removal persists across a fresh load()', () => {
  const p = tmpStorePath('deletekey-persist')
  const store1 = load(p)
  const { keyHash } = parseKey(KEY_A)
  store1.setDirectoryEntry(keyHash, KEY_A, { title: 'T', description: '', tags: [] })
  store1.deleteKey(keyHash)

  const store2 = load(p)
  assert.equal(store2.getDirectoryEntry(keyHash), undefined)
})
