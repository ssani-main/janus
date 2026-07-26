'use strict'

// Milestone 1, Feature 3: pure crypto helpers backing per-key password
// protection (login page + signed cookie) and, for Feature 4, dashboard
// session/CSRF helpers. node:crypto only -- no new dependencies.

const crypto = require('node:crypto')

const SCRYPT_KEYLEN = 64
const SESSION_VERSION = 'v1'

/**
 * Promise wrapper over the ASYNC crypto.scrypt.
 *
 * These two functions used to call `crypto.scryptSync`, which is the one
 * genuinely expensive thing this gateway does on a request path: measured at
 * ~30ms per call. Node runs JavaScript on a single thread, so a *Sync* call
 * here does not merely slow the login down -- it stalls the entire gateway,
 * every tenant's proxied traffic included, for the whole 30ms. At the
 * RATE_MAX_REQUESTS default of 120/min a single IP could buy ~3.7 seconds of
 * total event-loop stall per minute just by POSTing wrong passwords at any
 * password-protected key, and a handful of IPs could make the whole box
 * unresponsive.
 *
 * The async form hands the work to libuv's threadpool instead, so it costs a
 * worker thread rather than the event loop. Note the threadpool defaults to 4
 * threads (UV_THREADPOOL_SIZE) and is shared with fs/dns work: concurrent
 * logins queue against each other, which is correct backpressure -- they no
 * longer block anything else.
 *
 * scrypt is deliberately expensive; that is the point of using it. Keep it
 * async so the cost lands on the caller and not on every other tenant.
 *
 * @param {string} plain
 * @param {string} salt
 * @returns {Promise<Buffer>}
 */
function scryptAsync(plain, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, SCRYPT_KEYLEN, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

/**
 * @param {string} plain
 * @param {?string} [salt] hex-encoded salt; generated if omitted
 * @returns {Promise<{ hash: string, salt: string }>}
 */
async function hashPassword(plain, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex')
  const hash = (await scryptAsync(plain, useSalt)).toString('hex')
  return { hash, salt: useSalt }
}

/**
 * Never throws on malformed stored input -- a corrupt/short expectedHash
 * returns false rather than rejecting, same as before the async conversion.
 *
 * @param {string} plain
 * @param {string} salt
 * @param {string} expectedHash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plain, salt, expectedHash) {
  const actualBuf = await scryptAsync(plain, salt)
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
 * Timing-safe string compare -- used for the bearer token and admin login
 * token checks (and, Milestone 2a, /metrics' bearer check), which must not
 * leak length/prefix information via timing.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStr(a, b) {
  const aBuf = Buffer.from(String(a))
  const bBuf = Buffer.from(String(b))
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
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
  timingSafeEqualStr,
}
