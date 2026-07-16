'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseKey, assertPublic } = require('../../src/key')

// A real 52-char z-base-32 string (bare key, no mode prefix).
const BARE_KEY = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

test('parseKey: bare 52-char z32 key parses as public with a keyHash', () => {
  const parsed = parseKey(BARE_KEY)
  assert.equal(parsed.secure, false)
  assert.equal(parsed.key, BARE_KEY)
  assert.equal(typeof parsed.keyHash, 'string')
  assert.equal(parsed.keyHash.length, 64) // sha256 hex digest
})

test('parseKey: hs://0000<key> parses as public', () => {
  const parsed = parseKey(`hs://0000${BARE_KEY}`)
  assert.equal(parsed.secure, false)
  assert.equal(parsed.key, BARE_KEY)
})

test('parseKey: hs://s000<key> parses as secure', () => {
  const parsed = parseKey(`hs://s000${BARE_KEY}`)
  assert.equal(parsed.secure, true)
  assert.equal(parsed.key, BARE_KEY)
})

test('assertPublic: throws on a secure-mode parse', () => {
  const parsed = parseKey(`s000${BARE_KEY}`)
  assert.throws(() => assertPublic(parsed), /[Ss]ecure-mode/)
})

test('assertPublic: passes (no throw) on a public-mode parse', () => {
  const parsed = parseKey(BARE_KEY)
  assert.doesNotThrow(() => assertPublic(parsed))
})

test('parseKey: throws on wrong-length key', () => {
  assert.throws(() => parseKey(BARE_KEY.slice(0, -1)), /Invalid key/)
  assert.throws(() => parseKey(BARE_KEY + 'y'), /Invalid key/)
})

test('parseKey: throws on non-z32 characters', () => {
  // 'l' and 'v' are not in the z-base-32 alphabet used here.
  const bad = 'l'.repeat(52)
  assert.throws(() => parseKey(bad), /z-base-32/)
})

test('parseKey: throws on empty / non-string input', () => {
  assert.throws(() => parseKey(''), /Invalid key/)
  assert.throws(() => parseKey(undefined), /Invalid key/)
})

test('parseKey: keyHash is identical for bare key and its 0000-prefixed form', () => {
  const bare = parseKey(BARE_KEY)
  const prefixed = parseKey(`0000${BARE_KEY}`)
  assert.equal(bare.keyHash, prefixed.keyHash)
})
