'use strict'

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { Store, load } = require('../../src/store')
const { parseKey } = require('../../src/key')

// Two distinct real 52-char z-base-32 keys, same ones used by
// tunnel-manager.test.js -- reused here for consistency.
const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'
const KEY_B = 'ejkmcpqxot1uwiszh76934abndrfg8ejkmcpqxot1uwisza3456y'

// Collect every temp path we create so a single after() hook cleans them all
// up, even if an individual test throws before reaching its own cleanup.
const tmpPaths = []
function tmpStorePath(label) {
  const p = path.join(os.tmpdir(), `janus-store-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
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

test('load: a missing path returns an empty default store', () => {
  const p = tmpStorePath('missing')
  const store = load(p)
  assert.equal(store.data.version, 1)
  // keys/aliases are null-prototype maps (defense in depth against
  // prototype pollution), so compare shape via Object.keys rather than
  // deepEqual against a plain {} (which would fail on prototype mismatch).
  assert.deepEqual(Object.keys(store.data.keys), [])
  assert.deepEqual(Object.keys(store.data.aliases), [])
  assert.equal(Object.getPrototypeOf(store.data.keys), null)
  assert.equal(Object.getPrototypeOf(store.data.aliases), null)
})

test('write + reload round-trip: a blocked key persists across a fresh load()', () => {
  const p = tmpStorePath('roundtrip')
  const store1 = load(p)
  const { keyHash } = parseKey(KEY_A)
  store1.setBlocked(keyHash, true)

  const store2 = load(p)
  assert.equal(store2.isBlocked(keyHash), true)
})

test('atomic write: no pid-scoped .tmp file is left behind after a mutation', () => {
  const p = tmpStorePath('atomic')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)
  store.setBlocked(keyHash, true)

  assert.equal(fs.existsSync(p), true)
  // _persist() now uses a RANDOM tmp suffix (`${p}.tmp.<pid>.<hex>`, S5), so
  // assert on the PREFIX -- scan the dir and confirm no `${basename}.tmp.`
  // sibling survives a successful persist, rather than checking one
  // hard-coded name (which would now pass vacuously).
  const dir = path.dirname(p)
  const tmpPrefix = `${path.basename(p)}.tmp.`
  const leftover = fs.readdirSync(dir).filter((n) => n.startsWith(tmpPrefix))
  assert.deepEqual(leftover, [], `unexpected tmp files left behind: ${leftover.join(', ')}`)
})

test('setBlocked/isBlocked: true then false', () => {
  const p = tmpStorePath('blocked-toggle')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  assert.equal(store.isBlocked(keyHash), false)
  store.setBlocked(keyHash, true)
  assert.equal(store.isBlocked(keyHash), true)
  store.setBlocked(keyHash, false)
  assert.equal(store.isBlocked(keyHash), false)
})

test('setAlias + getByAlias: round-trip returns { keyHash, rawKey }', () => {
  const p = tmpStorePath('alias-roundtrip')
  const store = load(p)
  const { keyHash } = parseKey(KEY_B)

  store.setAlias('myblog', KEY_B)
  const entry = store.getByAlias('myblog')
  assert.deepEqual(entry, { keyHash, rawKey: KEY_B })
})

test('setAlias: rejects the reserved label "www"', () => {
  const p = tmpStorePath('alias-www')
  const store = load(p)
  assert.throws(() => store.setAlias('www', KEY_A), /reserved/)
})

test('setAlias: rejects a label that itself parses as a valid key', () => {
  const p = tmpStorePath('alias-is-key')
  const store = load(p)
  // KEY_A is itself 52 chars of [a-z0-9], so it also satisfies ALIAS_RE --
  // the extra _isValidKey guard is what must reject it.
  assert.throws(() => store.setAlias(KEY_A, KEY_B), /valid key itself/)
})

test('setAlias: normalizes an uppercase label to lowercase', () => {
  const p = tmpStorePath('alias-uppercase')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setAlias('MyBlog', KEY_A)
  assert.deepEqual(store.getByAlias('myblog'), { keyHash, rawKey: KEY_A })
  // getByAlias itself lowercases its input too.
  assert.deepEqual(store.getByAlias('MYBLOG'), { keyHash, rawKey: KEY_A })
})

test('setAlias: rejects a label with a leading hyphen', () => {
  const p = tmpStorePath('alias-leading-hyphen')
  const store = load(p)
  assert.throws(() => store.setAlias('-abc', KEY_A), /must not start or end with/)
})

test('setAlias: rejects a label with a trailing hyphen', () => {
  const p = tmpStorePath('alias-trailing-hyphen')
  const store = load(p)
  assert.throws(() => store.setAlias('abc-', KEY_A), /must not start or end with/)
})

test('setAlias: rejects a label with characters outside [a-z0-9-]', () => {
  const p = tmpStorePath('alias-bad-chars')
  const store = load(p)
  assert.throws(() => store.setAlias('my_blog', KEY_A))
  assert.throws(() => store.setAlias('my blog', KEY_A))
  assert.throws(() => store.setAlias('my.blog', KEY_A))
})

test('setAlias: assigning the same label to a different key throws', () => {
  const p = tmpStorePath('alias-uniqueness')
  const store = load(p)
  store.setAlias('shared', KEY_A)
  assert.throws(() => store.setAlias('shared', KEY_B), /already assigned/)
})

test('clearAlias: removes a previously set alias', () => {
  const p = tmpStorePath('alias-clear')
  const store = load(p)
  store.setAlias('gone-soon', KEY_A)
  assert.ok(store.getByAlias('gone-soon'))

  store.clearAlias('gone-soon')
  assert.equal(store.getByAlias('gone-soon'), undefined)
})

test('setPassword/getPassword/clearPassword: pwdVersion starts at 1, bumps on clear, never reused', () => {
  const p = tmpStorePath('password-lifecycle')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setPassword(keyHash, KEY_A, 'hash1', 'salt1')
  const first = store.getPassword(keyHash)
  assert.deepEqual(first, { hash: 'hash1', salt: 'salt1', pwdVersion: 1 })

  store.clearPassword(keyHash)
  assert.equal(store.getPassword(keyHash), undefined)

  store.setPassword(keyHash, KEY_A, 'hash2', 'salt2')
  const second = store.getPassword(keyHash)
  assert.deepEqual(second, { hash: 'hash2', salt: 'salt2', pwdVersion: 3 })
  assert.ok(second.pwdVersion > first.pwdVersion)
})

// S7: rawKey (record.rawKey) is a live credential shared between the alias
// and password features. clearAlias()/clearPassword() must only purge it
// when the OTHER feature isn't still relying on it -- an unconditional
// null-out would silently break a passworded, non-aliased key (or make an
// aliased key undialable). These tests pin all four branches of that
// asymmetric guard, plus persistence of a purge across a fresh load().

test('S7 clearAlias: with NO password, rawKey is purged and the alias becomes undialable', () => {
  const p = tmpStorePath('s7-clearalias-no-password')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setAlias('myalias', KEY_A)
  assert.deepEqual(store.getByAlias('myalias'), { keyHash, rawKey: KEY_A })
  assert.equal(store.getKey(keyHash).rawKey, KEY_A)

  store.clearAlias('myalias')
  assert.equal(store.getKey(keyHash).rawKey, null)
  assert.equal(store.getByAlias('myalias'), undefined)
})

test('S7 clearAlias: WITH a password still set, rawKey is preserved', () => {
  const p = tmpStorePath('s7-clearalias-with-password')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setAlias('myalias', KEY_A)
  store.setPassword(keyHash, KEY_A, 'hash1', 'salt1')

  store.clearAlias('myalias')
  const record = store.getKey(keyHash)
  assert.equal(record.rawKey, KEY_A, 'rawKey must survive because the password still needs it')
  assert.equal(record.alias, null)
  // The alias itself is still gone, only rawKey retention differs.
  assert.equal(store.getByAlias('myalias'), undefined)
})

test('S7 clearPassword: with NO alias, rawKey is purged', () => {
  const p = tmpStorePath('s7-clearpassword-no-alias')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setPassword(keyHash, KEY_A, 'hash1', 'salt1')
  assert.equal(store.getKey(keyHash).rawKey, KEY_A)

  store.clearPassword(keyHash)
  assert.equal(store.getKey(keyHash).rawKey, null)
})

test('S7 clearPassword: WITH an alias still set, rawKey is preserved and the alias stays dialable', () => {
  const p = tmpStorePath('s7-clearpassword-with-alias')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setAlias('myalias', KEY_A)
  store.setPassword(keyHash, KEY_A, 'hash1', 'salt1')

  store.clearPassword(keyHash)
  const record = store.getKey(keyHash)
  assert.equal(record.rawKey, KEY_A, 'rawKey must survive because the alias still needs it')
  assert.deepEqual(store.getByAlias('myalias'), { keyHash, rawKey: KEY_A })
})

test('S7 persistence: a clearAlias-triggered rawKey purge survives a fresh load()', () => {
  const p = tmpStorePath('s7-clearalias-persist')
  const store1 = load(p)
  const { keyHash } = parseKey(KEY_A)

  store1.setAlias('myalias', KEY_A)
  store1.clearAlias('myalias')
  assert.equal(store1.getKey(keyHash).rawKey, null)

  const store2 = load(p)
  assert.equal(store2.getKey(keyHash).rawKey, null, 'purge must be persisted to disk, not just in-memory')
  assert.equal(store2.getByAlias('myalias'), undefined)
})

// S11: listMetadata() is the only view of the store's per-key metadata that
// ever crosses the admin API boundary (see admin.js's buildRows()), so it
// must never expose a live credential (rawKey) or a password's hash/salt --
// only a `hasPassword` boolean. These tests pin that allowlist directly
// against a record that actually has both a rawKey and a password set, so a
// regression back to spreading `...record` would be caught immediately.

test('S11 listMetadata: never leaks rawKey or password hash/salt; hasPassword is true when a password is set', () => {
  const p = tmpStorePath('s11-listmetadata-with-password')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  store.setAlias('myapp', KEY_A)
  store.setPassword(keyHash, KEY_A, 'secrethash', 'secretsalt')

  const rows = store.listMetadata()
  assert.equal(rows.length, 1)
  const row = rows[0]

  // Must-have safe fields.
  assert.ok('keyHash' in row)
  assert.ok('alias' in row)
  assert.ok('blocked' in row)
  assert.ok('hasPassword' in row)
  assert.ok('createdAt' in row)
  assert.ok('updatedAt' in row)
  assert.equal(row.keyHash, keyHash)
  assert.equal(row.alias, 'myapp')
  assert.equal(row.blocked, false)
  assert.equal(row.hasPassword, true)
  assert.equal(typeof row.createdAt, 'number')
  assert.equal(typeof row.updatedAt, 'number')

  // Must-NOT-have credential fields, even though the underlying record has
  // both a live rawKey and a password hash/salt at this point.
  assert.equal('rawKey' in row, false, 'listMetadata() must never expose rawKey')
  assert.equal('password' in row, false, 'listMetadata() must never expose the password sub-object (hash/salt)')
})

test('S11 listMetadata: hasPassword is false for a key with no password set', () => {
  const p = tmpStorePath('s11-listmetadata-no-password')
  const store = load(p)
  const { keyHash } = parseKey(KEY_B)

  // setBlocked creates a bare record (rawKey: null, password: null) --
  // exercises the "no password" branch without ever calling setPassword.
  store.setBlocked(keyHash, true)

  const rows = store.listMetadata()
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.keyHash, keyHash)
  assert.equal(row.hasPassword, false)
  assert.equal(row.blocked, true)
  assert.equal('rawKey' in row, false)
  assert.equal('password' in row, false)
})

test('load: a corrupt JSON file throws', () => {
  const p = tmpStorePath('corrupt')
  fs.writeFileSync(p, 'this is not { valid json', 'utf8')
  assert.throws(() => load(p), /Invalid store file/)
})
