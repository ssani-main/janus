'use strict'

// Phase 3 / Milestone 1 Feature 4: the admin surface at /_admin (apex host
// only, wired in server.js). Two parallel auth mechanisms share this one
// handler:
//
//  - Bearer token (`Authorization: Bearer <ADMIN_TOKEN>`) -- the original
//    Phase 3 JSON API (GET /_admin/tunnels, POST /_admin/kill, POST
//    /_admin/unblock). Scripts and the e2e suite depend on these staying
//    byte-for-byte compatible: same paths, same auth check, same JSON
//    shapes.
//  - Cookie session (Feature 4) -- a signed `janus_admin` cookie, obtained
//    via POST /_admin/login (token -> cookie), that additionally unlocks an
//    HTML dashboard (GET /_admin) and browser form endpoints (set/clear
//    alias, set/clear password, block/unblock), each CSRF-protected since
//    they're reachable from a browser session.
//
// The admin cookie's payload is bound to a hash of the *current*
// ADMIN_TOKEN (`th`), so rotating ADMIN_TOKEN invalidates every outstanding
// admin session immediately, without needing a separate revocation list.
//
// Only reachable at all when ADMIN_TOKEN is set (server.js routes
// /_admin/* here on the apex host only).

const crypto = require('node:crypto')
const {
  signSession,
  verifySession,
  parseCookies,
  csrfToken,
  verifyCsrf,
  hashPassword,
  timingSafeEqualStr,
} = require('./auth')
const { parseKey } = require('./key')
const { adminLoginPage, adminDashboardPage } = require('./pages')

const COOKIE_NAME = 'janus_admin'
const FORM_BODY_MAX_BYTES = 4096

// keyHash is always a SHA-256 hex digest (64 lowercase hex chars). Any
// operator-supplied keyHash (form field or query param) must be validated
// against this shape before it ever reaches a plain-object key (store's
// data.keys / data.aliases), otherwise a value like '__proto__' could
// corrupt the in-memory store via prototype pollution.
const KEYHASH_RE = /^[0-9a-f]{64}$/

/**
 * @param {*} s
 * @returns {boolean}
 */
function isValidKeyHash(s) {
  return typeof s === 'string' && KEYHASH_RE.test(s)
}

function sendJson(res, code, body) {
  const json = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(json)
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

/**
 * Read a request body up to `maxBytes`, resolving to the collected string,
 * or null if exceeded/errored/aborted. Mirrors server.js's readBodyCapped
 * (kept as a small local copy so admin.js has no dependency on server.js).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<?string>}
 */
function readBodyCapped(req, maxBytes) {
  return new Promise((resolve) => {
    let total = 0
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        req.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
    req.on('aborted', () => finish(null))
  })
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<URLSearchParams>}
 */
async function readForm(req) {
  const body = await readBodyCapped(req, FORM_BODY_MAX_BYTES)
  return new URLSearchParams(body || '')
}

/**
 * @param {string} adminToken
 * @returns {string}
 */
function hashToken(adminToken) {
  return crypto.createHash('sha256').update(adminToken).digest('hex')
}

/**
 * Merge live tunnel state (manager.list()) with persisted metadata
 * (store.listMetadata()) into one row per keyHash seen in either source.
 *
 * @param {any} manager
 * @param {any} store
 * @returns {Array<object>}
 */
function buildRows(manager, store) {
  const live = new Map(manager.list().map((t) => [t.keyHash, t]))
  const meta = new Map(store.listMetadata().map((m) => [m.keyHash, m]))

  const keyHashes = new Set([...live.keys(), ...meta.keys()])
  const rows = []
  for (const keyHash of keyHashes) {
    const t = live.get(keyHash)
    const m = meta.get(keyHash)
    rows.push({
      keyHash,
      alias: (m && m.alias) || null,
      blocked: !!(m && m.blocked),
      hasPassword: !!(m && m.password),
      live: !!t,
      port: t ? t.port : null,
      inFlight: t ? t.inFlight : null,
      lastRequestAt: t ? t.lastRequestAt : null,
      // Milestone 2d: surfaces manager.list()'s new health-probe fields.
      healthy: t ? t.healthy : null,
      lastProbeAt: t ? t.lastProbeAt : null,
    })
  }
  rows.sort((a, b) => a.keyHash.localeCompare(b.keyHash))
  return rows
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ manager: any, config: any, store: any, sessionSecret: string }} deps
 */
async function handleAdmin(req, res, { manager, config, store, sessionSecret }) {
  if (!config.ADMIN_TOKEN) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const tokenHash = hashToken(config.ADMIN_TOKEN)

  const authHeader = req.headers['authorization'] || ''
  const expectedBearer = `Bearer ${config.ADMIN_TOKEN}`
  const bearerValid = timingSafeEqualStr(authHeader, expectedBearer)

  const cookies = parseCookies(req.headers.cookie)
  const session = verifySession(sessionSecret, cookies[COOKIE_NAME], { maxAgeMs: config.ADMIN_SESSION_TTL_MS })
  const cookieValid = !!(session && session.adm === 1 && session.th === tokenHash)

  const url = new URL(req.url, 'http://internal')
  const pathname = url.pathname

  // --- Login / logout (cookie-session bootstrap, no prior auth required) --

  if (pathname === '/_admin/login' && req.method === 'POST') {
    const form = await readForm(req)
    const token = form.get('token') || ''
    if (timingSafeEqualStr(token, config.ADMIN_TOKEN)) {
      const cookieVal = signSession(sessionSecret, { adm: 1, th: tokenHash, iat: Date.now() })
      const secureAttr = config.COOKIE_SECURE ? '; Secure' : ''
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${cookieVal}; HttpOnly; SameSite=Strict; Path=/_admin; Max-Age=${Math.floor(config.ADMIN_SESSION_TTL_MS / 1000)}${secureAttr}`,
        'Location': '/_admin',
      })
      res.end()
      return
    }
    sendHtml(res, 200, adminLoginPage({ error: 'Incorrect token.' }))
    return
  }

  if (pathname === '/_admin/logout' && req.method === 'POST') {
    res.writeHead(302, {
      'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/_admin; Max-Age=0`,
      'Location': '/_admin',
    })
    res.end()
    return
  }

  // --- Dashboard (cookie session OR bearer) -------------------------------

  if ((pathname === '/_admin' || pathname === '/_admin/') && req.method === 'GET') {
    if (!cookieValid && !bearerValid) {
      sendHtml(res, 200, adminLoginPage({ error: null }))
      return
    }
    const rows = buildRows(manager, store)
    const csrf = csrfToken(sessionSecret, tokenHash)
    sendHtml(res, 200, adminDashboardPage({ rows, csrf, config }))
    return
  }

  // --- Existing JSON API (bearer OR cookie session) -----------------------

  if (pathname === '/_admin/tunnels' && req.method === 'GET') {
    if (!bearerValid && !cookieValid) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const tunnels = manager.list()
    sendJson(res, 200, { tunnels, count: tunnels.length })
    return
  }

  if (pathname === '/_admin/kill' && req.method === 'POST') {
    if (!bearerValid && !cookieValid) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const keyHash = url.searchParams.get('keyHash')
    const block = url.searchParams.get('block') === '1'
    if (!keyHash) {
      sendJson(res, 400, { error: 'missing keyHash query parameter' })
      return
    }
    if (!isValidKeyHash(keyHash)) {
      sendJson(res, 400, { error: 'invalid keyHash' })
      return
    }
    await manager.destroyTunnel(keyHash)
    if (block) manager.block(keyHash)
    sendJson(res, 200, { killed: keyHash, blocked: block })
    return
  }

  if (pathname === '/_admin/unblock' && req.method === 'POST') {
    if (!bearerValid && !cookieValid) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const keyHash = url.searchParams.get('keyHash')
    if (!keyHash) {
      sendJson(res, 400, { error: 'missing keyHash query parameter' })
      return
    }
    if (!isValidKeyHash(keyHash)) {
      sendJson(res, 400, { error: 'invalid keyHash' })
      return
    }
    manager.unblock(keyHash)
    sendJson(res, 200, { unblocked: keyHash })
    return
  }

  // --- Browser form endpoints (cookie session + CSRF only, never bearer) --

  if (pathname === '/_admin/alias' && req.method === 'POST') {
    const form = await readForm(req)
    if (!cookieValid || !verifyCsrf(sessionSecret, tokenHash, form.get('csrf'))) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const action = form.get('action')
    const alias = form.get('alias') || ''
    try {
      if (action === 'set') {
        const rawKey = form.get('rawKey') || ''
        store.setAlias(alias, rawKey)
      } else if (action === 'clear') {
        store.clearAlias(alias)
      }
    } catch (err) {
      const csrf = csrfToken(sessionSecret, tokenHash)
      const rows = buildRows(manager, store)
      sendHtml(res, 200, adminDashboardPage({ rows, csrf, config, error: err.message }))
      return
    }
    res.writeHead(302, { 'Location': '/_admin' })
    res.end()
    return
  }

  if (pathname === '/_admin/password' && req.method === 'POST') {
    const form = await readForm(req)
    if (!cookieValid || !verifyCsrf(sessionSecret, tokenHash, form.get('csrf'))) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const action = form.get('action')
    try {
      const rawKey = form.get('rawKey') || ''
      let keyHash = form.get('keyHash') || ''
      if (rawKey) {
        keyHash = parseKey(rawKey).keyHash
      }
      if (!keyHash) {
        throw new Error('either rawKey or keyHash is required')
      }
      if (!isValidKeyHash(keyHash)) {
        throw new Error('invalid keyHash')
      }
      if (action === 'set') {
        const password = form.get('password') || ''
        if (!password) throw new Error('password is required')
        const { hash, salt } = hashPassword(password)
        store.setPassword(keyHash, rawKey || null, hash, salt)
      } else if (action === 'clear') {
        store.clearPassword(keyHash)
      }
    } catch (err) {
      const csrf = csrfToken(sessionSecret, tokenHash)
      const rows = buildRows(manager, store)
      sendHtml(res, 200, adminDashboardPage({ rows, csrf, config, error: err.message }))
      return
    }
    res.writeHead(302, { 'Location': '/_admin' })
    res.end()
    return
  }

  if (pathname === '/_admin/block' && req.method === 'POST') {
    const form = await readForm(req)
    if (!cookieValid || !verifyCsrf(sessionSecret, tokenHash, form.get('csrf'))) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const action = form.get('action')
    const keyHash = form.get('keyHash') || ''
    if (keyHash) {
      if (!isValidKeyHash(keyHash)) {
        const csrf = csrfToken(sessionSecret, tokenHash)
        const rows = buildRows(manager, store)
        sendHtml(res, 200, adminDashboardPage({ rows, csrf, config, error: 'invalid keyHash' }))
        return
      }
      if (action === 'block') {
        await manager.destroyTunnel(keyHash)
        manager.block(keyHash)
      } else if (action === 'unblock') {
        manager.unblock(keyHash)
      }
    }
    res.writeHead(302, { 'Location': '/_admin' })
    res.end()
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

module.exports = { handleAdmin }
