'use strict'

// Milestone 1, Feature 3: pure crypto helpers backing per-key password
// protection (login page + signed cookie) and, for Feature 4, dashboard
// session/CSRF helpers. node:crypto only -- no new dependencies.

const crypto = require('node:crypto')

const SCRYPT_KEYLEN = 64
const SESSION_VERSION = 'v1'

/**
 * @param {string} plain
 * @param {?string} [salt] hex-encoded salt; generated if omitted
 * @returns {{ hash: string, salt: string }}
 */
function hashPassword(plain, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(plain, useSalt, SCRYPT_KEYLEN).toString('hex')
  return { hash, salt: useSalt }
}

/**
 * @param {string} plain
 * @param {string} salt
 * @param {string} expectedHash
 * @returns {boolean}
 */
function verifyPassword(plain, salt, expectedHash) {
  const actual = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex')
  const actualBuf = Buffer.from(actual, 'hex')
  const expectedBuf = Buffer.from(String(expectedHash), 'hex')
  if (actualBuf.length !== expectedBuf.length) return false
  return crypto.timingSafeEqual(actualBuf, expectedBuf)
}

/**
 * Sign a JSON-serializable payload into an opaque, tamper-evident cookie
 * value: `v1.<base64url(JSON payload)>.<hmac-sha256 hex>`.
 *
 * @param {string} secret
 * @param {object} payloadObj
 * @returns {string}
 */
function signSession(secret, payloadObj) {
  const json = JSON.stringify(payloadObj)
  const b64 = Buffer.from(json).toString('base64url')
  const body = `${SESSION_VERSION}.${b64}`
  const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex')
  return `${body}.${hmac}`
}

/**
 * Verify + decode a cookie value produced by signSession. Never throws --
 * returns null on any malformed/invalid/expired input.
 *
 * @param {string} secret
 * @param {string} value
 * @param {{ maxAgeMs: number }} opts
 * @returns {?object}
 */
function verifySession(secret, value, opts) {
  try {
    if (typeof value !== 'string') return null
    const parts = value.split('.')
    if (parts.length !== 3) return null
    const [version, b64, hmacHex] = parts
    if (version !== SESSION_VERSION) return null

    const body = `${version}.${b64}`
    const expectedHmac = crypto.createHmac('sha256', secret).update(body).digest('hex')
    const expectedBuf = Buffer.from(expectedHmac, 'hex')
    const actualBuf = Buffer.from(hmacHex, 'hex')
    if (expectedBuf.length !== actualBuf.length) return null
    if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) return null

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
    if (!payload || !Number.isFinite(payload.iat)) return null
    if (opts && typeof opts.maxAgeMs === 'number') {
      if (Date.now() - payload.iat > opts.maxAgeMs) return null
    }
    return payload
  } catch {
    return null
  }
}

/**
 * @param {?string} cookieHeader
 * @returns {object}
 */
function parseCookies(cookieHeader) {
  const out = {}
  if (!cookieHeader) return out
  const parts = String(cookieHeader).split(';')
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const name = part.slice(0, idx).trim()
    if (!name) continue
    const value = part.slice(idx + 1).trim()
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

/**
 * Feature 4 (dashboard) helper: a CSRF token bound to a session id.
 *
 * @param {string} secret
 * @param {string} sessionId
 * @returns {string}
 */
function csrfToken(secret, sessionId) {
  return crypto.createHmac('sha256', secret).update(String(sessionId)).digest('hex')
}

/**
 * @param {string} secret
 * @param {string} sessionId
 * @param {string} token
 * @returns {boolean}
 */
function verifyCsrf(secret, sessionId, token) {
  if (typeof token !== 'string') return false
  const expected = csrfToken(secret, sessionId)
  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(token, 'hex')
  if (expectedBuf.length !== actualBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, actualBuf)
}

module.exports = {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  parseCookies,
  csrfToken,
  verifyCsrf,
}
