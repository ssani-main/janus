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
      fs.unlinkSync(`${p}.tmp.${process.pid}`)
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
  assert.equal(fs.existsSync(`${p}.tmp.${process.pid}`), false)
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

test('load: a corrupt JSON file throws', () => {
  const p = tmpStorePath('corrupt')
  fs.writeFileSync(p, 'this is not { valid json', 'utf8')
  assert.throws(() => load(p), /Invalid store file/)
})
