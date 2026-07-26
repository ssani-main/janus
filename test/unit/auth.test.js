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
  timingSafeEqualStr,
} = require('../../src/auth')

const HEX_RE = /^[0-9a-f]+$/

// hashPassword/verifyPassword are async (crypto.scrypt on the libuv
// threadpool, NOT scryptSync on the event loop -- see src/auth.js). Every
// test below must await them; a missing await makes assert.equal compare a
// Promise object and silently pass on the truthiness of the wrapper.
test('hashPassword: returns a {hash, salt} pair of hex strings', async () => {
  const { hash, salt } = await hashPassword('correct-horse')
  assert.equal(typeof hash, 'string')
  assert.equal(typeof salt, 'string')
  assert.match(hash, HEX_RE)
  assert.match(salt, HEX_RE)
})

test('hashPassword: returns a promise, never a bare value (stays off the event loop)', () => {
  const pending = hashPassword('correct-horse')
  assert.ok(pending instanceof Promise, 'hashPassword must be async')
  return pending
})

test('hashPassword: same password + same salt -> same hash', async () => {
  const first = await hashPassword('correct-horse')
  const second = await hashPassword('correct-horse', first.salt)
  assert.equal(second.salt, first.salt)
  assert.equal(second.hash, first.hash)
})

test('hashPassword: same password + different salt -> different hash', async () => {
  const first = await hashPassword('correct-horse')
  const second = await hashPassword('correct-horse')
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
})

test('verifyPassword: correct password against its own hash/salt -> true', async () => {
  const { hash, salt } = await hashPassword('correct-horse')
  assert.equal(await verifyPassword('correct-horse', salt, hash), true)
})

test('verifyPassword: wrong password -> false', async () => {
  const { hash, salt } = await hashPassword('correct-horse')
  assert.equal(await verifyPassword('wrong-password', salt, hash), false)
})

test('verifyPassword: wrong salt -> false', async () => {
  const { hash } = await hashPassword('correct-horse')
  const { salt: otherSalt } = await hashPassword('correct-horse')
  assert.equal(await verifyPassword('correct-horse', otherSalt, hash), false)
})

test('verifyPassword: resolves false (never rejects) on mismatched-length hash input', async () => {
  const { salt } = await hashPassword('correct-horse')
  assert.equal(await verifyPassword('correct-horse', salt, 'ab'), false)
})

test('verifyPassword: resolves false (never rejects) on a non-hex stored hash', async () => {
  const { salt } = await hashPassword('correct-horse')
  assert.equal(await verifyPassword('correct-horse', salt, 'not-hex-at-all'), false)
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

// --- timingSafeEqualStr (Milestone 2a: guards /metrics' bearer check) ------

test('timingSafeEqualStr: identical strings -> true', () => {
  assert.equal(timingSafeEqualStr('Bearer secret-token', 'Bearer secret-token'), true)
})

test('timingSafeEqualStr: different strings of the same length -> false', () => {
  assert.equal(timingSafeEqualStr('Bearer aaaaaaaaaaaa', 'Bearer bbbbbbbbbbbb'), false)
})

test('timingSafeEqualStr: different lengths -> false, does not throw', () => {
  assert.doesNotThrow(() => {
    assert.equal(timingSafeEqualStr('short', 'a-much-longer-string'), false)
  })
})

test('timingSafeEqualStr: empty vs non-empty -> false', () => {
  assert.equal(timingSafeEqualStr('', 'nonempty'), false)
})

test('timingSafeEqualStr: empty vs empty -> true', () => {
  assert.equal(timingSafeEqualStr('', ''), true)
})

test('timingSafeEqualStr: is case-sensitive', () => {
  assert.equal(timingSafeEqualStr('Bearer TOKEN', 'Bearer token'), false)
})
