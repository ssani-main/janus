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

const baseConfig = () => ({
  ADMIN_TOKEN,
  ADMIN_SESSION_TTL_MS: 43200000,
  COOKIE_SECURE: false,
  SESSION_TTL_MS: 604800000,
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
    ...overrides,
  }
}

function adminCookieValue() {
  return signSession(SESSION_SECRET, { adm: 1, th: TOKEN_HASH, iat: Date.now() })
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
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 302)
  assert.equal(res.headers['Location'], '/_admin')
  const setCookie = res.headers['Set-Cookie']
  assert.ok(setCookie, 'expected a Set-Cookie header')
  assert.match(setCookie, /^janus_admin=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Path=\/_admin/)
})

test('handleAdmin: POST /_admin/login with wrong token -> login page again, no cookie', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/login',
    headers: {},
    body: 'token=nope',
  })
  const res = mockRes()
  await run(req, res, { manager: fakeManager(), config: baseConfig(), store: fakeStore(), sessionSecret: SESSION_SECRET })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Set-Cookie'], undefined)
  assert.match(res.body, /Incorrect token\./)
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
  const csrf = csrfToken(SESSION_SECRET, TOKEN_HASH)
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
  const csrf = csrfToken(SESSION_SECRET, TOKEN_HASH)
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
  const csrf = csrfToken(SESSION_SECRET, TOKEN_HASH)
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
  const csrf = csrfToken(SESSION_SECRET, TOKEN_HASH)
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
