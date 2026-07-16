'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  parseCookies,
  csrfToken,
  verifyCsrf,
} = require('../../src/auth')

const HEX_RE = /^[0-9a-f]+$/

test('hashPassword: returns a {hash, salt} pair of hex strings', () => {
  const { hash, salt } = hashPassword('correct-horse')
  assert.equal(typeof hash, 'string')
  assert.equal(typeof salt, 'string')
  assert.match(hash, HEX_RE)
  assert.match(salt, HEX_RE)
})

test('hashPassword: same password + same salt -> same hash', () => {
  const first = hashPassword('correct-horse')
  const second = hashPassword('correct-horse', first.salt)
  assert.equal(second.salt, first.salt)
  assert.equal(second.hash, first.hash)
})

test('hashPassword: same password + different salt -> different hash', () => {
  const first = hashPassword('correct-horse')
  const second = hashPassword('correct-horse')
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
})

test('verifyPassword: correct password against its own hash/salt -> true', () => {
  const { hash, salt } = hashPassword('correct-horse')
  assert.equal(verifyPassword('correct-horse', salt, hash), true)
})

test('verifyPassword: wrong password -> false', () => {
  const { hash, salt } = hashPassword('correct-horse')
  assert.equal(verifyPassword('wrong-password', salt, hash), false)
})

test('verifyPassword: wrong salt -> false', () => {
  const { hash } = hashPassword('correct-horse')
  const otherSalt = hashPassword('correct-horse').salt
  assert.equal(verifyPassword('correct-horse', otherSalt, hash), false)
})

test('verifyPassword: does not throw on mismatched-length hash input', () => {
  const { salt } = hashPassword('correct-horse')
  assert.doesNotThrow(() => {
    const result = verifyPassword('correct-horse', salt, 'ab')
    assert.equal(result, false)
  })
})

test('signSession + verifySession: round-trips a payload and preserves fields', () => {
  const secret = 'top-secret'
  const payload = { kh: 'abc', pv: 1, iat: Date.now() }
  const token = signSession(secret, payload)
  const decoded = verifySession(secret, token, { maxAgeMs: 60 * 60 * 1000 })
  assert.ok(decoded)
  assert.equal(decoded.kh, 'abc')
  assert.equal(decoded.pv, 1)
  assert.equal(decoded.iat, payload.iat)
})

test('verifySession: rejects a tampered signature', () => {
  const secret = 'top-secret'
  const payload = { kh: 'abc', pv: 1, iat: Date.now() }
  const token = signSession(secret, payload)
  const segments = token.split('.')
  const lastSeg = segments[2]
  const flippedChar = lastSeg[0] === 'a' ? 'b' : 'a'
  segments[2] = flippedChar + lastSeg.slice(1)
  const tampered = segments.join('.')
  assert.equal(verifySession(secret, tampered, { maxAgeMs: 60 * 60 * 1000 }), null)
})

test('verifySession: rejects when verified with the wrong secret', () => {
  const payload = { kh: 'abc', pv: 1, iat: Date.now() }
  const token = signSession('secret-a', payload)
  assert.equal(verifySession('secret-b', token, { maxAgeMs: 60 * 60 * 1000 }), null)
})

test('verifySession: rejects an expired token', () => {
  const secret = 'top-secret'
  const payload = { kh: 'abc', pv: 1, iat: Date.now() - 100000 }
  const token = signSession(secret, payload)
  assert.equal(verifySession(secret, token, { maxAgeMs: 1000 }), null)
})

test('verifySession: rejects malformed/garbage input without throwing', () => {
  const secret = 'top-secret'
  assert.doesNotThrow(() => {
    assert.equal(verifySession(secret, 'not-a-valid-token', { maxAgeMs: 1000 }), null)
  })
  assert.doesNotThrow(() => {
    assert.equal(verifySession(secret, '', { maxAgeMs: 1000 }), null)
  })
  assert.doesNotThrow(() => {
    assert.equal(verifySession(secret, undefined, { maxAgeMs: 1000 }), null)
  })
  assert.doesNotThrow(() => {
    assert.equal(verifySession(secret, 'v1.notbase64url!!.deadbeef', { maxAgeMs: 1000 }), null)
  })
})

test('parseCookies: parses a standard "a=1; b=2" cookie header', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' })
})

test('parseCookies: undefined input -> {}', () => {
  assert.deepEqual(parseCookies(undefined), {})
})

test('parseCookies: empty string input -> {}', () => {
  assert.deepEqual(parseCookies(''), {})
})

test('parseCookies: a segment with no "=" is skipped gracefully', () => {
  assert.deepEqual(parseCookies('a=1; noequalshere; b=2'), { a: '1', b: '2' })
})

test('csrfToken + verifyCsrf: round-trips for the same secret + sessionId', () => {
  const secret = 'csrf-secret'
  const token = csrfToken(secret, 'session-123')
  assert.equal(verifyCsrf(secret, 'session-123', token), true)
})

test('verifyCsrf: rejects a token issued for a different sessionId', () => {
  const secret = 'csrf-secret'
  const token = csrfToken(secret, 'session-123')
  assert.equal(verifyCsrf(secret, 'session-456', token), false)
})

test('verifyCsrf: rejects a tampered token', () => {
  const secret = 'csrf-secret'
  const token = csrfToken(secret, 'session-123')
  const tampered = (token[0] === 'a' ? 'b' : 'a') + token.slice(1)
  assert.equal(verifyCsrf(secret, 'session-123', tampered), false)
})

test('verifyCsrf: does not throw on garbage token input', () => {
  const secret = 'csrf-secret'
  assert.doesNotThrow(() => {
    assert.equal(verifyCsrf(secret, 'session-123', 'not-hex-!!'), false)
  })
  assert.doesNotThrow(() => {
    assert.equal(verifyCsrf(secret, 'session-123', undefined), false)
  })
  assert.doesNotThrow(() => {
    assert.equal(verifyCsrf(secret, 'session-123', ''), false)
  })
})
