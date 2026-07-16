'use strict'

const crypto = require('node:crypto')

// Holesail key format: optional "hs://" scheme, then a 4-char mode prefix,
// then a 52-char z-base-32 key. The prefix may also be omitted entirely
// ("bare" form) -- a bare key is treated as public mode.
//
//   hs://0000<52-char-z32>   -> public mode  (accept)
//   hs://s000<52-char-z32>   -> secure mode  (reject -- see assertPublic)
//   <52-char-z32>            -> bare, treated as public mode

const SCHEME_PREFIX = 'hs://'
const PUBLIC_PREFIX = '0000'
const SECURE_PREFIX = 's000'
const KEY_LEN = 52
const Z32_RE = /^[ybndrfg8ejkmcpqxot1uwisza345h769]+$/

/**
 * Parse a raw Holesail key string (with or without scheme/prefix) into a
 * normalized descriptor. Pure function, no side effects. Throws a
 * descriptive KeyError-shaped Error on anything malformed.
 *
 * @param {string} raw
 * @returns {{ secure: boolean, key: string, keyHash: string }}
 */
function parseKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('Invalid key: expected a non-empty string')
  }

  let rest = raw.trim()

  if (rest.toLowerCase().startsWith(SCHEME_PREFIX)) {
    rest = rest.slice(SCHEME_PREFIX.length)
  }

  let secure = false
  const maybePrefix = rest.slice(0, 4).toLowerCase()
  if (maybePrefix === SECURE_PREFIX) {
    secure = true
    rest = rest.slice(4)
  } else if (maybePrefix === PUBLIC_PREFIX) {
    secure = false
    rest = rest.slice(4)
  }
  // else: no recognized prefix -> treat the whole remainder as a bare
  // (public) key, per spec.

  if (rest.length !== KEY_LEN) {
    throw new Error(
      `Invalid key: expected ${KEY_LEN} z-base-32 characters after the mode ` +
      `prefix, got ${rest.length}`
    )
  }

  if (!Z32_RE.test(rest)) {
    throw new Error(
      'Invalid key: contains characters outside the z-base-32 alphabet ' +
      '(ybndrfg8ejkmcpqxot1uwisza345h769)'
    )
  }

  const normalized = rest.toLowerCase()
  const keyHash = crypto.createHash('sha256').update(normalized).digest('hex')

  return { secure, key: normalized, keyHash }
}

/**
 * Throws if the parsed key is secure-mode. Secure-mode keys are the
 * connection *seed* (serve/impersonate-capable); exposing one via a URL or
 * TLS SNI (both plaintext-on-the-wire in this gateway's design) is unsafe.
 * Only public-mode (connect-only) keys may be proxied.
 *
 * @param {{ secure: boolean }} parsed
 */
function assertPublic(parsed) {
  if (parsed.secure) {
    throw new Error(
      'Secure-mode keys are not allowed here: a secure-mode key is the ' +
      'connection seed, and this gateway exposes keys via SNI/URL, which is ' +
      'plaintext on the wire. Re-share the project in public mode (a ' +
      '"0000..." key) instead.'
    )
  }
}

module.exports = { parseKey, assertPublic }
