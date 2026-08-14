'use strict'

// S14: /_admin/kill and /_admin/unblock were reachable with a cookie
// session and NO CSRF/Origin check (every other mutating admin endpoint has
// one). SameSite=Strict on the admin cookie does not close this gap: with
// BASE_DOMAIN=janus.example.com the admin origin and every tenant origin
// (https://0000<key>.janus.example.com) are the SAME SITE, and tenants serve
// attacker-controlled HTML on those subdomains. A tenant page can therefore
// auto-submit a cross-origin POST to /_admin/kill (params live in the query
// string, so no body is even required) and the browser still attaches the
// cookie. See src/admin.js `isOriginAllowed` for the fix.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')

const { handleAdmin } = require('../../src/admin')
const { signSession, csrfToken } = require('../../src/auth')

const ADMIN_TOKEN = 'testtoken123'
const SESSION_SECRET = 'a'.repeat(64)
const TOKEN_HASH = crypto.createHash('sha256').update(ADMIN_TOKEN).digest('hex')
const SID = 'test-session-id-0123456789abcdef'

// Mirrors admin.test.js's baseConfig -- COOKIE_SECURE: false means
// isOriginAllowed expects an http:// origin, matching these http-only tests.
const baseConfig = () => ({
  ADMIN_TOKEN,
  ADMIN_SESSION_TTL_MS: 43200000,
  COOKIE_SECURE: false,
  SESSION_TTL_MS: 604800000,
  ADMIN_LOGIN_MAX_FAILS: 5,
  ADMIN_LOGIN_LOCKOUT_MS: 60000,
})

const ADMIN_HOST = 'janus.example.com'

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
  const res = { statusCode: null, headers: {}, body: '' }
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
    deleteKey: (keyHash) => recorded.push(['deleteKey', keyHash]),
    setDirectorySuppressed: (keyHash, suppressed) => recorded.push(['setDirectorySuppressed', keyHash, suppressed]),
    ...overrides,
  }
}

function adminCookieValue(sid = SID) {
  return signSession(SESSION_SECRET, { adm: 1, th: TOKEN_HASH, sid, iat: Date.now() })
}

async function run(req, res, deps) {
  await handleAdmin(req, res, deps)
  await res.done
  return res
}

function baseDeps(overrides = {}) {
  return {
    manager: fakeManager(),
    config: baseConfig(),
    store: fakeStore(),
    sessionSecret: SESSION_SECRET,
    ...overrides,
  }
}

// --- /_admin/kill: cookie path requires Origin match + CSRF ----------------

test('S14: POST /_admin/kill with cookie + sibling-subdomain Origin -> 403, no kill performed', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'a'.repeat(64)
  const req = mockReq({
    method: 'POST',
    // A tenant subdomain is SAME SITE as the admin origin under
    // SameSite=Strict, but must NOT be accepted as the admin's own origin.
    url: `/_admin/kill?keyHash=${keyHash}&csrf=${csrf}`,
    headers: {
      cookie: `janus_admin=${cookieVal}`,
      host: ADMIN_HOST,
      origin: `http://0000${'x'.repeat(48)}.${ADMIN_HOST}`,
    },
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(manager.recorded, [], 'a sibling-subdomain Origin must never authorize a kill')
})

test('S14: POST /_admin/kill with cookie + no Origin header -> allowed (non-browser client)', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'a'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: `/_admin/kill?keyHash=${keyHash}&csrf=${csrf}`,
    headers: { cookie: `janus_admin=${cookieVal}`, host: ADMIN_HOST },
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(manager.recorded, [['destroy', keyHash]])
})

test('S14: POST /_admin/kill with cookie + exact-match Origin -> allowed', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'a'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: `/_admin/kill?keyHash=${keyHash}&csrf=${csrf}`,
    headers: {
      cookie: `janus_admin=${cookieVal}`,
      host: ADMIN_HOST,
      origin: `http://${ADMIN_HOST}`,
    },
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(manager.recorded, [['destroy', keyHash]])
})

test('S14: POST /_admin/kill with cookie, correct Origin, but missing csrf -> 403, no kill performed', async () => {
  const cookieVal = adminCookieValue()
  const manager = fakeManager()
  const keyHash = 'a'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: `/_admin/kill?keyHash=${keyHash}`,
    headers: { cookie: `janus_admin=${cookieVal}`, host: ADMIN_HOST, origin: `http://${ADMIN_HOST}` },
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(manager.recorded, [])
})

test('S14: POST /_admin/kill with valid Bearer token bypasses the Origin/CSRF check entirely', async () => {
  const manager = fakeManager()
  const keyHash = 'a'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: `/_admin/kill?keyHash=${keyHash}`,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      host: ADMIN_HOST,
      // A hostile/foreign Origin -- irrelevant on the bearer path, since
      // bearer tokens are never auto-attached by a browser and therefore
      // cannot be CSRF-driven.
      origin: 'https://evil.example.net',
    },
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(manager.recorded, [['destroy', keyHash]])
})

// --- /_admin/unblock: mirrors kill -----------------------------------------

test('S14: POST /_admin/unblock with cookie + sibling-subdomain Origin -> 403, no unblock performed', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'b'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: `/_admin/unblock?keyHash=${keyHash}&csrf=${csrf}`,
    headers: {
      cookie: `janus_admin=${cookieVal}`,
      host: ADMIN_HOST,
      origin: `http://0000${'y'.repeat(48)}.${ADMIN_HOST}`,
    },
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(manager.recorded, [])
})

test('S14: POST /_admin/unblock with cookie + exact-match Origin + valid csrf -> allowed', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'b'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: `/_admin/unblock?keyHash=${keyHash}&csrf=${csrf}`,
    headers: { cookie: `janus_admin=${cookieVal}`, host: ADMIN_HOST, origin: `http://${ADMIN_HOST}` },
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(manager.recorded, [['unblock', keyHash]])
})

test('S14: POST /_admin/unblock with valid Bearer token bypasses the Origin/CSRF check entirely', async () => {
  const manager = fakeManager()
  const keyHash = 'b'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: `/_admin/unblock?keyHash=${keyHash}`,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, host: ADMIN_HOST },
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(manager.recorded, [['unblock', keyHash]])
})

// --- Origin check applied to the already-CSRF-protected form endpoints -----
// (defense in depth: pin that a sibling-subdomain Origin is rejected even
// with a fully valid cookie + csrf pair)

test('S14: POST /_admin/block with cookie + valid csrf but sibling-subdomain Origin -> 403, no block performed', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    headers: {
      cookie: `janus_admin=${cookieVal}`,
      host: ADMIN_HOST,
      origin: `http://0000${'z'.repeat(48)}.${ADMIN_HOST}`,
    },
    body: `action=block&keyHash=${keyHash}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(manager.recorded, [])
})

test('S14: POST /_admin/block with cookie + valid csrf + exact-match Origin -> succeeds', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    headers: { cookie: `janus_admin=${cookieVal}`, host: ADMIN_HOST, origin: `http://${ADMIN_HOST}` },
    body: `action=block&keyHash=${keyHash}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 302)
  assert.deepEqual(manager.recorded, [['destroy', keyHash], ['block', keyHash]])
})

test('S14: POST /_admin/block with cookie + valid csrf + absent Origin -> succeeds (non-browser client)', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/block',
    headers: { cookie: `janus_admin=${cookieVal}`, host: ADMIN_HOST },
    body: `action=block&keyHash=${keyHash}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager }))
  assert.equal(res.statusCode, 302)
  assert.deepEqual(manager.recorded, [['destroy', keyHash], ['block', keyHash]])
})

// --- /_admin/suppress: mirrors /_admin/block's Origin coverage above -------
// Directory-only suppression must enforce Origin/CSRF exactly like block,
// but must never call manager.destroyTunnel/block/unblock -- only
// store.setDirectorySuppressed.

test('S14: POST /_admin/suppress with cookie + valid csrf but sibling-subdomain Origin -> 403, no suppression performed', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const store = fakeStore()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/suppress',
    headers: {
      cookie: `janus_admin=${cookieVal}`,
      host: ADMIN_HOST,
      origin: `http://0000${'z'.repeat(48)}.${ADMIN_HOST}`,
    },
    body: `action=suppress&keyHash=${keyHash}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager, store }))
  assert.equal(res.statusCode, 403)
  assert.deepEqual(store.recorded, [])
  assert.deepEqual(manager.recorded, [])
})

test('S14: POST /_admin/suppress with cookie + valid csrf + exact-match Origin -> succeeds, tunnel untouched', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const store = fakeStore()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/suppress',
    headers: { cookie: `janus_admin=${cookieVal}`, host: ADMIN_HOST, origin: `http://${ADMIN_HOST}` },
    body: `action=suppress&keyHash=${keyHash}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager, store }))
  assert.equal(res.statusCode, 302)
  assert.deepEqual(store.recorded, [['setDirectorySuppressed', keyHash, true]])
  assert.deepEqual(manager.recorded, [], 'suppression must never touch the tunnel')
})

test('S14: POST /_admin/suppress with cookie + valid csrf + absent Origin -> succeeds (non-browser client)', async () => {
  const cookieVal = adminCookieValue()
  const csrf = csrfToken(SESSION_SECRET, SID)
  const manager = fakeManager()
  const store = fakeStore()
  const keyHash = 'c'.repeat(64)
  const req = mockReq({
    method: 'POST',
    url: '/_admin/suppress',
    headers: { cookie: `janus_admin=${cookieVal}`, host: ADMIN_HOST },
    body: `action=suppress&keyHash=${keyHash}&csrf=${csrf}`,
  })
  const res = mockRes()
  await run(req, res, baseDeps({ manager, store }))
  assert.equal(res.statusCode, 302)
  assert.deepEqual(store.recorded, [['setDirectorySuppressed', keyHash, true]])
})
