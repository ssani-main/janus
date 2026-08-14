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
//    alias, set/clear password, block/unblock, delete, logout), each
//    CSRF-protected since they're reachable from a browser session (S13:
//    logout included -- it mutates session state just like the others).
//    S14: every cookie-authenticated mutating endpoint, INCLUDING kill and
//    unblock (the original bearer-only JSON API, whose auth check was later
//    OR'd with cookieValid without ever gaining CSRF/Origin protection),
//    also passes through isOriginAllowed(). See that function for why
//    SameSite=Strict alone does not cover this gateway.
//
// The admin cookie's payload is bound to a hash of the *current*
// ADMIN_TOKEN (`th`), so rotating ADMIN_TOKEN invalidates every outstanding
// admin session immediately, without needing a separate revocation list.
// S9: it also carries a per-login random `sid`, which is what CSRF tokens
// are actually bound to (see csrfToken/verifyCsrf calls below) -- `th` alone
// would mean every session sharing one ADMIN_TOKEN also shares one CSRF
// token, forever, which is exactly what S9 closes.
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

// S8: per-IP failed-login tracking for POST /_admin/login, keyed by
// clientIp(req) (threaded in from server.js as `ip`). Module-level (not
// per-request) so it actually accumulates across requests -- that's the
// whole point of a lockout. Each entry is
// `{ fails: number, lockedUntil: number, lastAt: number }`; entries are
// pruned opportunistically (see the top of the /_admin/login handler) so a
// distributed brute force can't grow this Map without bound.
const loginFails = new Map()

/**
 * @param {*} s
 * @returns {boolean}
 */
function isValidKeyHash(s) {
  return typeof s === 'string' && KEYHASH_RE.test(s)
}

function sendJson(res, code, body) {
  const json = JSON.stringify(body)
  // S12 -- the admin surface renders keyHashes, aliases, ports, and the live
  // CSRF token; never let a shared/intermediate cache retain it.
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(json)
}

function sendHtml(res, code, html) {
  // S12 -- see sendJson above: same rationale, this is the branch that
  // actually renders the dashboard HTML (keyHashes, aliases, ports, CSRF
  // token).
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
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
 * S14: validate the `Origin` header on cookie-authenticated mutating
 * requests, as defense in depth against CSRF. SameSite=Strict on the
 * `janus_admin` cookie is NOT sufficient by itself here, because SameSite
 * is scoped to the registrable domain (eTLD+1), not the origin: with
 * BASE_DOMAIN=janus.example.com, the admin origin
 * (https://janus.example.com) and every tenant origin
 * (https://0000<key>.janus.example.com) are the SAME SITE. Tenants serve
 * attacker-controlled HTML on those subdomains, so a tenant page can
 * auto-submit a same-site cross-origin POST to e.g. /_admin/kill and the
 * browser still attaches the cookie.
 *
 * - Absent Origin -> ALLOW. Browsers always send Origin on state-changing
 *   requests (POST); a missing Origin means a non-browser client (curl,
 *   scripts, the e2e suite / `janus kill`), which cannot be CSRF-driven by a
 *   browser session in the first place. Rejecting here would break
 *   legitimate scripted/API use for no security benefit.
 * - Present Origin -> must match the admin origin EXACTLY (scheme + host +
 *   port). There is deliberately no BASE_DOMAIN/suffix comparison: a suffix
 *   match would accept `https://0000<key>.BASE_DOMAIN`, which is precisely
 *   the attacker origin this check exists to reject.
 *
 * Host+port are read straight off the request's own `Host` header, so the
 * comparison is self-relative and needs no BASE_DOMAIN-specific logic --
 * it works unmodified in prod (BASE_DOMAIN, real Host) and in dev/test
 * (127.0.0.1/localhost, arbitrary port). The scheme is derived from
 * `config.COOKIE_SECURE` -- the same signal admin.js already uses to decide
 * whether the session cookie itself gets the `Secure` attribute (see the
 * login handler below) -- because this process has no other reliable signal
 * for its own TLS-ness: Caddy terminates TLS in front of it, so
 * `req.socket.encrypted` is always false and there's no forwarded-proto
 * header wired in for the admin surface.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ COOKIE_SECURE: boolean }} config
 * @returns {boolean}
 */
function isOriginAllowed(req, config) {
  const origin = req.headers['origin']
  if (!origin) return true
  const host = req.headers['host'] || ''
  const expected = `${config.COOKIE_SECURE ? 'https' : 'http'}://${host}`
  return origin === expected
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
      // S11: listMetadata() now returns hasPassword as a plain boolean (never
      // the password hash/salt/rawKey) -- m.password no longer exists.
      hasPassword: !!(m && m.hasPassword),
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
 * @param {{ manager: any, config: any, store: any, sessionSecret: string, ip: string }} deps
 */
async function handleAdmin(req, res, { manager, config, store, sessionSecret, ip }) {
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
  // `sid` is required, not merely expected. Every cookie-authenticated
  // mutation below binds its CSRF token to `session.sid` (S9), and
  // csrfToken()/verifyCsrf() stringify whatever they are handed -- so a
  // session payload WITHOUT a sid would have its CSRF token computed over the
  // literal string 'undefined', giving every such session one shared,
  // permanently-valid token. Sessions minted before S9 have exactly that
  // shape. They are unforgeable without sessionSecret and ADMIN_SESSION_TTL_MS
  // (12h default) expired them long ago, so this is defense in depth rather
  // than a live hole -- but the guard belongs here, at the single place
  // `cookieValid` is decided, not replicated at each of the six call sites
  // that trust it.
  const cookieValid = !!(
    session &&
    session.adm === 1 &&
    session.th === tokenHash &&
    typeof session.sid === 'string' &&
    session.sid !== ''
  )

  const url = new URL(req.url, 'http://internal')
  const pathname = url.pathname

  // --- Login / logout (cookie-session bootstrap, no prior auth required) --

  if (pathname === '/_admin/login' && req.method === 'POST') {
    const now = Date.now()

    // S8: opportunistically prune stale lockout records at the top of every
    // login attempt, so loginFails can't grow unbounded under a distributed
    // brute force (many attacking IPs, each attempted only a few times). An
    // entry is only dropped once its lockout (if any) has already expired
    // AND it hasn't been touched in a good while -- 10x the base lockout is
    // comfortably longer than any legitimate retry gap.
    for (const [k, rec] of loginFails) {
      if (rec.lockedUntil < now && now - rec.lastAt > 10 * config.ADMIN_LOGIN_LOCKOUT_MS) {
        loginFails.delete(k)
      }
    }

    // S8: if this IP is currently locked out, refuse before even reading/
    // checking the submitted token -- a locked-out attacker gets no signal
    // about whether their guess was right or wrong.
    const failRec = loginFails.get(ip)
    if (failRec && failRec.lockedUntil > now) {
      // Never log the token -- only ip + timestamp, so this line is safe to
      // ship to any log aggregator.
      console.warn(`[admin] login blocked (locked out): ip=${ip} at=${new Date(now).toISOString()}`)
      const retryAfterSec = Math.ceil((failRec.lockedUntil - now) / 1000)
      // sendHtml already sets Cache-Control: no-store (S12), but it doesn't
      // set Retry-After, so this branch writes headers explicitly instead.
      res.writeHead(429, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(retryAfterSec),
      })
      res.end(adminLoginPage({ error: 'Too many attempts, try again later.' }))
      return
    }

    const form = await readForm(req)
    const token = form.get('token') || ''
    if (timingSafeEqualStr(token, config.ADMIN_TOKEN)) {
      // S8: a correct login clears this IP's accumulated failure record --
      // otherwise a legitimate operator who mistyped a few times would stay
      // partway toward a lockout indefinitely.
      loginFails.delete(ip)
      // S9: bind CSRF to a per-login random `sid` carried in the signed
      // session, so a leaked CSRF token isn't valid across sessions /
      // forever. This does NOT change the `th` (ADMIN_TOKEN-hash) binding
      // used to auth the session cookie itself -- rotating ADMIN_TOKEN still
      // invalidates every outstanding session immediately.
      const sid = crypto.randomBytes(16).toString('hex')
      const cookieVal = signSession(sessionSecret, { adm: 1, th: tokenHash, sid, iat: Date.now() })
      const secureAttr = config.COOKIE_SECURE ? '; Secure' : ''
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${cookieVal}; HttpOnly; SameSite=Strict; Path=/_admin; Max-Age=${Math.floor(config.ADMIN_SESSION_TTL_MS / 1000)}${secureAttr}`,
        'Location': '/_admin',
      })
      res.end()
      return
    }

    // S8: incorrect token. Track the failure per-IP with exponential
    // backoff once ADMIN_LOGIN_MAX_FAILS is reached (capped at 2^6 lockout
    // multiples so a very persistent attacker doesn't get an effectively
    // infinite lockout window either). Respond 401, NOT 200 -- a 200 on a
    // failed login is indistinguishable from a normal page render to any
    // log/metrics pipeline watching status codes, which is exactly the
    // signal an operator needs to detect a brute-force attempt. Never log
    // the submitted token, only ip + timestamp + running fail count.
    const rec = loginFails.get(ip) || { fails: 0, lockedUntil: 0, lastAt: 0 }
    rec.fails += 1
    rec.lastAt = now
    if (rec.fails >= config.ADMIN_LOGIN_MAX_FAILS) {
      const backoffExp = Math.min(rec.fails - config.ADMIN_LOGIN_MAX_FAILS, 6)
      rec.lockedUntil = now + config.ADMIN_LOGIN_LOCKOUT_MS * 2 ** backoffExp
    }
    loginFails.set(ip, rec)
    console.warn(`[admin] failed login attempt: ip=${ip} at=${new Date(now).toISOString()} fails=${rec.fails}`)
    sendHtml(res, 401, adminLoginPage({ error: 'Incorrect token.' }))
    return
  }

  if (pathname === '/_admin/logout' && req.method === 'POST') {
    // S13: logout mutates session state (clears the cookie) and is
    // cookie-reachable, so it needs the same CSRF gate as the other form
    // POSTs below -- SameSite=Strict already blocks the cross-site POST
    // today, but every other mutating form endpoint here is CSRF-protected
    // in depth on top of SameSite, and logout was the one gap.
    // S14: also require the Origin check -- see isOriginAllowed above.
    const form = await readForm(req)
    if (!cookieValid || !isOriginAllowed(req, config) || !verifyCsrf(sessionSecret, session.sid, form.get('csrf'))) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
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
    // S9: the dashboard is reachable via bearer OR cookie -- a bearer-only
    // caller has no session (and therefore no sid) to bind a CSRF token to.
    // That's fine: bearer callers use the JSON API below, never these HTML
    // forms, so an empty token here is harmless.
    const csrf = session && session.sid ? csrfToken(sessionSecret, session.sid) : ''
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
    // S14: kill/unblock predate the dashboard -- they're the original
    // Bearer-only Phase 3 JSON API, and `cookieValid` was later OR'd into
    // their auth check without ever gaining the CSRF/Origin protection the
    // dashboard's own form endpoints have (see the file-header comment).
    // The dashboard renders no form for either endpoint, so there is no
    // existing browser flow to preserve here -- the least invasive fix is
    // to gate the COOKIE path only (Bearer callers are exempt: a bearer
    // token is never auto-attached by a browser, so it can't be CSRF-driven,
    // and requiring a CSRF token from a bearer script would break the
    // documented API for no security benefit). A cookie-authenticated
    // caller must pass the Origin check and present a valid CSRF token as a
    // query parameter, mirroring how keyHash/block are already passed here.
    if (!bearerValid) {
      if (!isOriginAllowed(req, config)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      if (!verifyCsrf(sessionSecret, session.sid, url.searchParams.get('csrf'))) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
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
    // S14: see the matching comment on /_admin/kill above -- same rationale.
    if (!bearerValid) {
      if (!isOriginAllowed(req, config)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      if (!verifyCsrf(sessionSecret, session.sid, url.searchParams.get('csrf'))) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
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
    // S9: CSRF verified against the session's sid, not the static tokenHash
    // -- cookieValid ⇒ session is set (cookieValid checks session.adm/th),
    // so session.sid is always readable here.
    // S14: also require the Origin check -- see isOriginAllowed above.
    if (!cookieValid || !isOriginAllowed(req, config) || !verifyCsrf(sessionSecret, session.sid, form.get('csrf'))) {
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
      const csrf = csrfToken(sessionSecret, session.sid)
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
    // S9: see /_admin/alias above -- CSRF is bound to session.sid.
    // S14: also require the Origin check -- see isOriginAllowed above.
    if (!cookieValid || !isOriginAllowed(req, config) || !verifyCsrf(sessionSecret, session.sid, form.get('csrf'))) {
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
        const { hash, salt } = await hashPassword(password)
        store.setPassword(keyHash, rawKey || null, hash, salt)
      } else if (action === 'clear') {
        store.clearPassword(keyHash)
      }
    } catch (err) {
      const csrf = csrfToken(sessionSecret, session.sid)
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
    // S9: see /_admin/alias above -- CSRF is bound to session.sid.
    // S14: also require the Origin check -- see isOriginAllowed above.
    if (!cookieValid || !isOriginAllowed(req, config) || !verifyCsrf(sessionSecret, session.sid, form.get('csrf'))) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const action = form.get('action')
    const keyHash = form.get('keyHash') || ''
    if (keyHash) {
      if (!isValidKeyHash(keyHash)) {
        const csrf = csrfToken(sessionSecret, session.sid)
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

  // S7 "fuller fix": the only endpoint that fully removes a stored record
  // (store.deleteKey) rather than just clearing one field of it -- see
  // store.js#deleteKey for the blocked-preservation rule (a blocked record
  // is purged but not dropped, so the block itself survives). Modeled
  // exactly on /_admin/block above: cookie session + CSRF via session.sid,
  // isValidKeyHash guard, error re-render, 302 redirect on success.
  if (pathname === '/_admin/delete' && req.method === 'POST') {
    const form = await readForm(req)
    // S9: see /_admin/alias above -- CSRF is bound to session.sid.
    // S14: also require the Origin check -- see isOriginAllowed above.
    if (!cookieValid || !isOriginAllowed(req, config) || !verifyCsrf(sessionSecret, session.sid, form.get('csrf'))) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    const keyHash = form.get('keyHash') || ''
    if (keyHash) {
      if (!isValidKeyHash(keyHash)) {
        const csrf = csrfToken(sessionSecret, session.sid)
        const rows = buildRows(manager, store)
        sendHtml(res, 200, adminDashboardPage({ rows, csrf, config, error: 'invalid keyHash' }))
        return
      }
      // Tear down any live tunnel for this key too (deleteKey only removes
      // stored metadata; the port stays held until the tunnel is destroyed).
      await manager.destroyTunnel(keyHash)
      store.deleteKey(keyHash)
    }
    res.writeHead(302, { 'Location': '/_admin' })
    res.end()
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

module.exports = { handleAdmin }
