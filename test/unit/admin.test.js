'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')

const { handleAdmin } = require('../../src/admin')
const { signSession, csrfToken } = require('../../src/auth')

const ADMIN_TOKEN = 'testtoken123'
const SESSION_SECRET = 'a'.repeat(64)
const TOKEN_HASH = crypto.createHash('sha256').update(ADMIN_TOKEN).digest('hex')
// S9: CSRF tokens are now bound to a per-login random `sid`, not the static
// TOKEN_HASH -- tests that hand-construct a session cookie (bypassing the
// real /_admin/login handler, which would generate its own random sid) need
// a fixed, known sid so they can also hand-construct a matching CSRF token.
const SID = 'test-session-id-0123456789abcdef'
// S8: a fixed test IP for handleAdmin's `ip` dep (server.js threads in
// clientIp(req) for the per-IP login lockout -- admin.js's `loginFails` map
// is module-level, so any test hitting POST /_admin/login needs a real
// (even if fake) ip value here).
const TEST_IP = '203.0.113.7'

const baseConfig = () => ({
  ADMIN_TOKEN,
  ADMIN_SESSION_TTL_MS: 43200000,
  COOKIE_SECURE: false,
  SESSION_TTL_MS: 604800000,
  // S8: mirror config.js's defaults so these tests exercise the same
  // lockout thresholds a real deployment would.
  ADMIN_LOGIN_MAX_FAILS: 5,
  ADMIN_LOGIN_LOCKOUT_MS: 60000,
})

/**
 * The body reader in admin.js (readBodyCapped) attaches 'data'/'end'/'error'
 * listeners via req.on(...) -- a real node:stream.Readable satisfies that
 * contract directly (attaching a 'data' listener puts it in flowing mode,
 * which then delivers already-pushed chunks and emits 'end' automatically),
 * so no manual .emit() timing juggling is needed here.
 */
function mockReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = new Readable({ read() {} })
  req.push(body)
  req.push(null)
  req.method = method
  req.url = url
  req.headers = headers
  return req
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: '',
  }
  let resolveDone
  res.done = new Promise((resolve) => {
    resolveDone = resolve
  })
  res.writeHead = (code, headers) => {
    res.statusCode = code
    Object.assign(res.headers, headers || {})
  }
  res.setHeader = (key, value) => {
    res.headers[key] = value
  }
  res.end = (chunk) => {
    if (chunk) res.body += chunk
    resolveDone()
  }
  return res
}

function fakeManager(overrides = {}) {
  const recorded = []
  return {
    recorded,
    list: () => [],
    destroyTunnel: async (keyHash) => {
      recorded.push(['destroy', keyHash])
    },
    block: (keyHash) => recorded.push(['block', keyHash]),
    unblock: (keyHash) => recorded.push(['unblock', keyHash]),
    ...overrides,
  }
}

function fakeStore(overrides = {}) {
  const recorded = []
  return {
    recorded,
    listMetadata: () => [],
    setAlias: (alias, rawKey) => recorded.push(['alias', alias, rawKey]),
    clearAlias: (alias) => recorded.push(['clearAlias', alias]),
    setPassword: (keyHash, rawKey, hash, salt) => recorded.push(['setPassword', keyHash, rawKey, hash, salt]),
    clearPassword: (keyHash) => recorded.push(['clearPassword', keyHash]),
    // S7 "fuller fix": POST /_admin/delete calls store.deleteKey(keyHash)
    // after tearing down any live tunnel.
    deleteKey: (keyHash) => recorded.push(['deleteKey', keyHash]),
    ...overrides,
  }
}

function adminCookieValue(sid = SID) {
  // S9: real sessions (issued by POST /_admin/login) now carry a random
  // `sid` alongside `th` -- tests that fabricate a cookie directly need to
  // include one too, so CSRF tokens computed against SID (below) verify.
  return signSession(SESSION_SECRET, { adm: 1, th: TOKEN_HASH, sid, iat: Date.now() })
}

async function run(req, res, deps) {
  await handleAdmin(req, res, deps)
  await res.done
  return res
}

// --- 1. No ADMIN_TOKEN configured -----------------------------------------

test('handleAdmin: no ADMIN_TOKEN configured -> 404', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin', headers: {} })
  const res = mockRes()
  const config = { ...baseConfig(), ADMIN_TOKEN: '' }
  await run(req, res, { manager: fakeManager(), config, store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 404)
})

// --- 2. Bearer JSON API ------------------------------------------------------

test('handleAdmin: GET /_admin/tunnels with correct bearer -> 200 JSON tunnels array', async () => {
  const req = mockReq({
    method: 'GET',
    url: '/_admin/tunnels',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 200)
  const parsed = JSON.parse(res.body)
  assert.ok(Array.isArray(parsed.tunnels))
  assert.equal(parsed.tunnels.length, 0)
  assert.equal(parsed.count, 0)
})

test('handleAdmin: GET /_admin/tunnels with wrong bearer -> 401', async () => {
  const req = mockReq({
    method: 'GET',
    url: '/_admin/tunnels',
    headers: { authorization: 'Bearer wrongtoken' },
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' })
})

// --- 3. GET /_admin with no auth --------------------------------------------

test('handleAdmin: GET /_admin with no auth -> 200 HTML login page', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin', headers: {} })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /<form method="POST" action="\/_admin\/login">/)
})

// --- 4. POST /_admin/login ----------------------------------------------------

test('handleAdmin: POST /_admin/login with correct token -> 302 + Set-Cookie', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/login',
    headers: {},
    body: `token=${encodeURIComponent(ADMIN_TOKEN)}`,
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET, ip: TEST_IP })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['Location'], '/_admin')
  const setCookie = res.headers['Set-Cookie']
  assert.ok(setCookie, 'expected a Set-Cookie header')
  assert.match(setCookie, /^janus_admin=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Path=\/_admin/)
})

// S8: a failed login must return 401, not 200 -- a 200 here would be
// indistinguishable from a normal page render to any log/metrics pipeline
// watching status codes, defeating brute-force detection. Updated per the
// S8 spec (was previously asserting 200).
test('handleAdmin: POST /_admin/login with wrong token -> 401 login page again, no cookie', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/login',
    headers: {},
    body: 'token=nope',
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET, ip: TEST_IP })
  assert.equal(res.statusCode, 401)
  assert.equal(res.headers['Set-Cookie'], undefined)
  assert.match(res.body, /Incorrect token\./)
})

// S8: repeated failed logins from the same IP eventually get locked out
// (429 + Retry-After), independent of whether the token guess is right --
// the whole point of the lockout is to refuse the attempt before even
// checking the token once the threshold is hit.
test('handleAdmin: POST /_admin/login: repeated wrong tokens from one IP trigger a 429 lockout', async () => {
  const ip = '203.0.113.99'
  const config = baseConfig()
  for (let i = 0; i < config.ADMIN_LOGIN_MAX_FAILS; i++) {
    const req = mockReq({ method: 'POST', url: '/_admin/login', headers: {}, body: 'token=nope' })
    const res = mockRes()
    await run(req, res, { manager: fakeManager(), config, store: fakeStore(), sessionSecret: SESSION_SECRET, ip })
    assert.equal(res.statusCode, 401)
  }
  // One more attempt (even with the CORRECT token) must now be locked out.
  const lockedReq = mockReq({
    method: 'POST',
    url: '/_admin/login',
    headers: {},
    body: `token=${encodeURIComponent(ADMIN_TOKEN)}`,
  })
  const lockedRes = mockRes()
  await run(lockedReq, lockedRes, { manager: fakeManager(), config, store: fakeStore(), sessionSecret: SESSION_SECRET, ip })
  assert.equal(lockedRes.statusCode, 429)
  assert.ok(lockedRes.headers['Retry-After'], 'expected a Retry-After header')
  assert.equal(lockedRes.headers['Set-Cookie'], undefined, 'must not issue a cookie while locked out')
})

// --- 5. GET /_admin with a valid admin cookie --------------------------------

test('handleAdmin: GET /_admin with valid admin cookie -> 200 dashboard HTML', async () => {
  const cookieVal = adminCookieValue()
  const req = mockReq({
    method: 'GET',
    url: '/_admin',
    headers: { cookie: `janus_admin=${cookieVal}` },
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /name="csrf" value="[0-9a-f]+"/)
  assert.match(res.body, /<table>/)
})

// --- 6. CSRF enforcement on POST /_admin/block -------------------------------

test('handleAdmin: POST /_admin/block with valid cookie but missing csrf -> 403, no block performed', async () => {
  const cookieVal = adminCookieValue()
  const manager = fakeManager()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: 'action=block&keyHash=abc123',
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(manager.recorded, [])
})

test('handleAdmin: POST /_admin/block with valid cookie but wrong csrf -> 403, no block performed', async () => {
  const cookieVal = adminCookieValue()
  const manager = fakeManager()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: 'action=block&keyHash=abc123&csrf=deadbeef',
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(manager.recorded, [])
})

test('handleAdmin: POST /_admin/block with valid cookie and correct csrf -> block succeeds, 302', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'a'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: `action=block&keyHash=${keyHash}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['Location'], '/_admin')
  assert.deepEqual(manager.recorded, [['destroy', keyHash], ['block', keyHash]])
})

// --- 7. Form POST without a valid admin cookie (bearer not accepted) --------

test('handleAdmin: POST /_admin/block with bearer only (no cookie) -> rejected, no action performed', async () => {
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    body: `action=block&keyHash=abc123&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.ok(res.statusCode === 403 || res.statusCode === 401, `expected 403/401, got ${res.statusCode}`)
  assert.deepEqual(manager.recorded, [])
})

// --- 8. POST /_admin/alias ----------------------------------------------------

test('handleAdmin: POST /_admin/alias set with valid cookie+csrf -> calls store.setAlias, 302', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const store = fakeStore()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/alias',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: `action=set&alias=${encodeURIComponent('my-app')}&rawKey=${encodeURIComponent('somerawkey')}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store, sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['Location'], '/_admin')
  assert.deepEqual(store.recorded, [['alias', 'my-app', 'somerawkey']])
})

test('handleAdmin: POST /_admin/alias set where store.setAlias throws -> dashboard re-rendered with error, no crash', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const store = fakeStore({
    setAlias: () => {
      throw new Error('invalid alias')
    },
  })
  const req = mockReq({
    method: 'POST',
    url: '/_admin/alias',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: `action=set&alias=bad&rawKey=somerawkey&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store, sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /invalid alias/)
  assert.match(res.body, /<table>/)
})

// --- 9. S12: admin responses set Cache-Control: no-store ---------------------
//
// The admin surface renders keyHashes, aliases, ports, and the live CSRF
// token; a shared/intermediate cache (or a shared-computer browser's back-
// forward cache) must never be able to serve a stale copy of any of that.
// sendHtml/sendJson in admin.js both set this header explicitly -- these
// tests pin it on one HTML response and one JSON response so a future
// refactor that drops it from either helper is caught.

test('S12: GET /_admin dashboard (authenticated) sets Cache-Control: no-store', async () => {
  const cookieVal = adminCookieValue()
  const req = mockReq({
    method: 'GET',
    url: '/_admin',
    headers: { cookie: `janus_admin=${cookieVal}` },
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

test('S12: GET /_admin/tunnels (JSON API, bearer) sets Cache-Control: no-store', async () => {
  const req = mockReq({
    method: 'GET',
    url: '/_admin/tunnels',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

// --- 10. S13: logout requires CSRF -------------------------------------------
//
// Logout mutates session state (clears the cookie) and is cookie-reachable
// just like block/alias/password, so it needs the same CSRF gate -- before
// S13 it was the one mutating form endpoint that skipped verifyCsrf entirely.

test('S13: POST /_admin/logout with valid cookie but missing csrf -> 403, no cookie cleared', async () => {
  const cookieVal = adminCookieValue()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/logout',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: '',
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' })
  assert.equal(res.headers['Set-Cookie'], undefined, 'must not clear the session cookie without a valid CSRF token')
})

test('S13: POST /_admin/logout with valid cookie but wrong csrf -> 403, no cookie cleared', async () => {
  const cookieVal = adminCookieValue()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/logout',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: 'csrf=deadbeef',
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' })
  assert.equal(res.headers['Set-Cookie'], undefined, 'must not clear the session cookie without a valid CSRF token')
})

test('S13: POST /_admin/logout with valid cookie and correct csrf -> 302, cookie cleared (Max-Age=0)', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/logout',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: `csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['Location'], '/_admin')
  const setCookie = res.headers['Set-Cookie']
  assert.ok(setCookie, 'expected a Set-Cookie header clearing the session')
  assert.match(setCookie, /^janus_admin=;/)
  assert.match(setCookie, /Max-Age=0/)
})

// --- 11. S9: CSRF is per-session (cross-session isolation) -------------------
//
// Before S9, the CSRF token was bound only to a hash of the (static, shared)
// ADMIN_TOKEN -- every session sharing one ADMIN_TOKEN therefore shared one
// CSRF token, forever, until the token was rotated. Now csrfToken/verifyCsrf
// are bound to the per-login random `sid` carried in the signed session
// cookie, so a token minted for one session must be rejected for a different
// session, even though both sessions are otherwise fully valid (same
// ADMIN_TOKEN, same tokenHash). These two tests pin exactly that: the same
// csrf value is accepted for the session it was minted against, and rejected
// for a different session.

test('S9: CSRF token minted for session A is rejected when submitted under session B\'s cookie', async () => {
  const SID_B = 'test-session-id-B-0123456789abcd'
  const cookieA = adminCookieValue(SID)
  const cookieB = adminCookieValue(SID_B)
  const csrfA = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'b'.repeat(64)

  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    // session B's cookie, but session A's csrf token.
    headers: { cookie: `janus_admin=${cookieB}` },
    body: `action=block&keyHash=${keyHash}&csrf=${csrfA}`,
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 403, 'a CSRF token from a different session must not validate')
  assert.deepEqual(manager.recorded, [], 'no mutation should have occurred')
})

test('S9: CSRF token minted for session A is accepted when submitted under session A\'s own cookie', async () => {
  const cookieA = adminCookieValue(SID)
  const csrfA = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'b'.repeat(64)

  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    headers: { cookie: `janus_admin=${cookieA}` },
    body: `action=block&keyHash=${keyHash}&csrf=${csrfA}`,
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 302, 'the matching session\'s own CSRF token must be accepted')
  assert.equal(res.headers['Location'], '/_admin')
  assert.deepEqual(manager.recorded, [['destroy', keyHash], ['block', keyHash]])
})

// --- 12. S7 "fuller fix": POST /_admin/delete --------------------------------
//
// Mirrors /_admin/block: cookie session + CSRF (bound to session.sid),
// isValidKeyHash guard with a dashboard-error re-render on failure, and on
// success `await manager.destroyTunnel(keyHash)` then `store.deleteKey
// (keyHash)` before the 302 redirect. deleteKey is the only endpoint that
// fully removes a stored record (see store.js#deleteKey for the
// blocked-preservation rule), so these tests pin the HTTP-layer contract:
// CSRF gates it exactly like block, an invalid keyHash never reaches the
// store, and a valid request calls both destroyTunnel and deleteKey with the
// same keyHash.

test('S7 delete: POST /_admin/delete with valid cookie but missing csrf -> 403, store.deleteKey not called', async () => {
  const cookieVal = adminCookieValue()
  const manager = fakeManager()
  const store = fakeStore()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/delete',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: `keyHash=${keyHash}`,
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store, sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' })
  assert.deepEqual(store.recorded, [], 'store.deleteKey must not be called without a valid csrf')
  assert.deepEqual(manager.recorded, [], 'manager.destroyTunnel must not be called without a valid csrf')
})

test('S7 delete: POST /_admin/delete with valid cookie but wrong csrf -> 403, store.deleteKey not called', async () => {
  const cookieVal = adminCookieValue()
  const manager = fakeManager()
  const store = fakeStore()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/delete',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: `keyHash=${keyHash}&csrf=deadbeef`,
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store, sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 403)
  assert.deepEqual(JSON.parse(res.body), { error: 'forbidden' })
  assert.deepEqual(store.recorded, [], 'store.deleteKey must not be called with a wrong csrf')
  assert.deepEqual(manager.recorded, [], 'manager.destroyTunnel must not be called with a wrong csrf')
})

test('S7 delete: POST /_admin/delete with valid cookie and correct csrf -> 302, destroyTunnel then deleteKey both called with the same keyHash', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const store = fakeStore()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/delete',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: `keyHash=${keyHash}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store, sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['Location'], '/_admin')
  assert.deepEqual(manager.recorded, [['destroy', keyHash]])
  assert.deepEqual(store.recorded, [['deleteKey', keyHash]])
})

test('S7 delete: POST /_admin/delete with valid cookie+csrf but a malformed keyHash -> 200 dashboard error, no delete/destroy performed', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const store = fakeStore()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/delete',
    headers: { cookie: `janus_admin=${cookieVal}` },
    body: `keyHash=nothex&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, { manager, config: baseConfig(), store, sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /invalid keyHash/)
  assert.match(res.body, /<table>/)
  assert.deepEqual(manager.recorded, [], 'manager.destroyTunnel must not be called for an invalid keyHash')
  assert.deepEqual(store.recorded, [], 'store.deleteKey must not be called for an invalid keyHash')
})
