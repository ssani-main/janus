'use strict'

// F-API: the bearer-only JSON API at /_admin/api/* (src/admin.js
// handleAdminApi). Structured after admin.test.js / admin-origin-csrf.test.js
// -- same mock req/res/manager/store shims. The single most important
// property under test here is that this namespace NEVER accepts a cookie
// session, even a perfectly valid one: see the "cookie rejected" tests
// below.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')

const { handleAdmin } = require('../../src/admin')
const { signSession } = require('../../src/auth')

const ADMIN_TOKEN = 'testtoken123'
const SESSION_SECRET = 'a'.repeat(64)
const TOKEN_HASH = crypto.createHash('sha256').update(ADMIN_TOKEN).digest('hex')
const SID = 'test-session-id-0123456789abcdef'
const KEY_HASH = 'b'.repeat(64)

const baseConfig = () => ({
  ADMIN_TOKEN,
  ADMIN_SESSION_TTL_MS: 43200000,
  COOKIE_SECURE: false,
  SESSION_TTL_MS: 604800000,
  ADMIN_LOGIN_MAX_FAILS: 5,
  ADMIN_LOGIN_LOCKOUT_MS: 60000,
})

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
    list: () => [{ keyHash: KEY_HASH, port: 20999, firstSeenAt: 1, lastRequestAt: 2, inFlight: 0, healthy: true, lastProbeAt: 3 }],
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
    listMetadata: () => [
      { keyHash: KEY_HASH, alias: 'demo', blocked: false, directorySuppressed: false, hasPassword: false, createdAt: 1, updatedAt: 2 },
    ],
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

function bearerHeaders(token = ADMIN_TOKEN) {
  return { authorization: `Bearer ${token}` }
}

function cookieHeaders() {
  return { cookie: `janus_admin=${adminCookieValue()}` }
}

const deps = (overrides = {}) => ({
  manager: fakeManager(),
  config: baseConfig(),
  store: fakeStore(),
  sessionSecret: SESSION_SECRET,
  ip: '203.0.113.7',
  ...overrides,
})

// --- ADMIN_TOKEN unset disables the whole namespace -------------------------

test('admin api: ADMIN_TOKEN unset -> /_admin/api/keys is 404, not 401', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/keys', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps({ config: { ...baseConfig(), ADMIN_TOKEN: '' } }))
  assert.equal(res.statusCode, 404)
})

// --- Auth: bearer required, cookie NEVER accepted ---------------------------

test('admin api: GET /_admin/api/keys with correct bearer -> 200', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/keys', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.keys.length, 1)
  assert.equal(body.keys[0].keyHash, KEY_HASH)
})

test('admin api: GET /_admin/api/keys with NO auth -> 401', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/keys', headers: {} })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 401)
  assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' })
})

test('admin api: GET /_admin/api/keys with WRONG bearer -> 401', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/keys', headers: bearerHeaders('nope') })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 401)
})

// Critical: a fully valid session cookie, on its own, must NOT authenticate
// this namespace. Proves there is no cookie fallback, structurally.
test('admin api: GET /_admin/api/keys with ONLY a valid session cookie -> 401 (cookie never accepted here)', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/keys', headers: cookieHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 401)
  assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' })
})

test('admin api: GET /_admin/api/tunnels with a valid cookie AND no bearer -> still 401', async () => {
  const req = mockReq({
    method: 'GET',
    url: '/_admin/api/tunnels',
    headers: cookieHeaders(),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 401)
})

test('admin api: cookie + bearer both present, bearer correct -> 200 (bearer alone is sufficient/necessary)', async () => {
  const req = mockReq({
    method: 'GET',
    url: '/_admin/api/keys',
    headers: { ...bearerHeaders(), ...cookieHeaders() },
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 200)
})

// --- Cache-Control ------------------------------------------------------

test('admin api: responses set Cache-Control: no-store', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/keys', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.headers['Cache-Control'], 'no-store')
})

// --- No rawKey ever appears in a response body -------------------------

test('admin api: GET /_admin/api/keys never includes rawKey in the response', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/keys', headers: bearerHeaders() })
  const res = mockRes()
  await run(
    req,
    res,
    deps({
      store: fakeStore({
        listMetadata: () => [
          { keyHash: KEY_HASH, alias: 'demo', blocked: false, hasPassword: true, createdAt: 1, updatedAt: 2 },
        ],
      }),
    })
  )
  assert.equal(res.statusCode, 200)
  assert.doesNotMatch(res.body, /rawKey/)
})

// --- GET /_admin/api/tunnels -------------------------------------------

test('admin api: GET /_admin/api/tunnels -> 200 tunnels array, mirrors manager.list()', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/tunnels', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.count, 1)
  assert.equal(body.tunnels[0].keyHash, KEY_HASH)
})

test('admin api: POST /_admin/api/tunnels -> 405', async () => {
  const req = mockReq({ method: 'POST', url: '/_admin/api/tunnels', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 405)
})

// --- POST /_admin/api/alias ----------------------------------------------

test('admin api: POST /_admin/api/alias set -> 200, calls store.setAlias', async () => {
  const store = fakeStore()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/alias',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'set', alias: 'demo', rawKey: '0000' + 'y'.repeat(52) }),
  })
  const res = mockRes()
  await run(req, res, deps({ store }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(store.recorded[0], ['alias', 'demo', '0000' + 'y'.repeat(52)])
})

test('admin api: POST /_admin/api/alias clear -> 200, calls store.clearAlias', async () => {
  const store = fakeStore()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/alias',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'clear', alias: 'demo' }),
  })
  const res = mockRes()
  await run(req, res, deps({ store }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(store.recorded[0], ['clearAlias', 'demo'])
})

test('admin api: POST /_admin/api/alias with bad action -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/alias',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'nope', alias: 'demo' }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

test('admin api: POST /_admin/api/alias set missing rawKey -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/alias',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'set', alias: 'demo' }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

test('admin api: POST /_admin/api/alias propagates store.setAlias validation errors as 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/alias',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'set', alias: 'demo', rawKey: 'bad-key' }),
  })
  const res = mockRes()
  await run(
    req,
    res,
    deps({
      store: fakeStore({
        setAlias: () => {
          throw new Error('boom')
        },
      }),
    })
  )
  assert.equal(res.statusCode, 400)
  assert.equal(JSON.parse(res.body).error, 'boom')
})

test('admin api: POST /_admin/api/alias malformed JSON body -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/alias',
    headers: bearerHeaders(),
    body: '{not json',
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

test('admin api: GET /_admin/api/alias -> 405', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/alias', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 405)
})

// --- POST /_admin/api/password --------------------------------------------

test('admin api: POST /_admin/api/password set -> 200, calls store.setPassword', async () => {
  const store = fakeStore()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/password',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'set', keyHash: KEY_HASH, password: 'hunter2hunter2' }),
  })
  const res = mockRes()
  await run(req, res, deps({ store }))
  assert.equal(res.statusCode, 200)
  assert.equal(store.recorded[0][0], 'setPassword')
  assert.equal(store.recorded[0][1], KEY_HASH)
})

test('admin api: POST /_admin/api/password clear -> 200, calls store.clearPassword', async () => {
  const store = fakeStore()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/password',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'clear', keyHash: KEY_HASH }),
  })
  const res = mockRes()
  await run(req, res, deps({ store }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(store.recorded[0], ['clearPassword', KEY_HASH])
})

test('admin api: POST /_admin/api/password set with invalid keyHash -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/password',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'set', keyHash: 'not-a-hash', password: 'hunter2hunter2' }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

test('admin api: POST /_admin/api/password set with no password -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/password',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'set', keyHash: KEY_HASH }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

test('admin api: POST /_admin/api/password set with neither rawKey nor keyHash -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/password',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'set', password: 'hunter2hunter2' }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

// --- POST /_admin/api/block -----------------------------------------------

test('admin api: POST /_admin/api/block block -> 200, destroys tunnel and blocks', async () => {
  const manager = fakeManager()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/block',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'block', keyHash: KEY_HASH }),
  })
  const res = mockRes()
  await run(req, res, deps({ manager }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(manager.recorded, [['destroy', KEY_HASH], ['block', KEY_HASH]])
})

test('admin api: POST /_admin/api/block unblock -> 200, calls manager.unblock', async () => {
  const manager = fakeManager()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/block',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'unblock', keyHash: KEY_HASH }),
  })
  const res = mockRes()
  await run(req, res, deps({ manager }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(manager.recorded, [['unblock', KEY_HASH]])
})

test('admin api: POST /_admin/api/block with invalid keyHash -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/block',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'block', keyHash: 'nope' }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

// --- POST /_admin/api/directory --------------------------------------------
//
// Directory-only suppression: unlike /_admin/api/block, this must NEVER call
// manager.destroyTunnel or manager.block/unblock -- suppression only flips
// store.directorySuppressed and must leave the tunnel/site entirely alone.

test('admin api: POST /_admin/api/directory suppress -> 200, calls store.setDirectorySuppressed(true), touches no tunnel', async () => {
  const manager = fakeManager()
  const store = fakeStore()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/directory',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'suppress', keyHash: KEY_HASH }),
  })
  const res = mockRes()
  await run(req, res, deps({ manager, store }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { suppressed: KEY_HASH })
  assert.deepEqual(store.recorded, [['setDirectorySuppressed', KEY_HASH, true]])
  assert.deepEqual(manager.recorded, [], 'suppression must never touch the tunnel')
})

test('admin api: POST /_admin/api/directory unsuppress -> 200, calls store.setDirectorySuppressed(false)', async () => {
  const manager = fakeManager()
  const store = fakeStore()
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/directory',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'unsuppress', keyHash: KEY_HASH }),
  })
  const res = mockRes()
  await run(req, res, deps({ manager, store }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { unsuppressed: KEY_HASH })
  assert.deepEqual(store.recorded, [['setDirectorySuppressed', KEY_HASH, false]])
  assert.deepEqual(manager.recorded, [])
})

test('admin api: POST /_admin/api/directory with invalid keyHash -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/directory',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'suppress', keyHash: 'nope' }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

test('admin api: POST /_admin/api/directory with bad action -> 400', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/directory',
    headers: bearerHeaders(),
    body: JSON.stringify({ action: 'nope', keyHash: KEY_HASH }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

test('admin api: GET /_admin/api/directory -> 405', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/directory', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 405)
})

test('admin api: POST /_admin/api/directory with ONLY a valid session cookie -> 401 (cookie never accepted here)', async () => {
  const req = mockReq({
    method: 'POST',
    url: '/_admin/api/directory',
    headers: cookieHeaders(),
    body: JSON.stringify({ action: 'suppress', keyHash: KEY_HASH }),
  })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 401)
})

// --- DELETE /_admin/api/keys/<keyHash> ------------------------------------

test('admin api: DELETE /_admin/api/keys/<keyHash> -> 200, tears down tunnel and deletes record', async () => {
  const manager = fakeManager()
  const store = fakeStore()
  const forgotten = []
  const req = mockReq({ method: 'DELETE', url: `/_admin/api/keys/${KEY_HASH}`, headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps({ manager, store, directory: { forget: (kh) => forgotten.push(kh) } }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(manager.recorded, [['destroy', KEY_HASH]])
  assert.deepEqual(store.recorded, [['deleteKey', KEY_HASH]])
  assert.deepEqual(forgotten, [KEY_HASH])
})

test('admin api: DELETE /_admin/api/keys/<invalid> -> 400', async () => {
  const req = mockReq({ method: 'DELETE', url: '/_admin/api/keys/not-a-hash', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 400)
})

test('admin api: GET /_admin/api/keys/<keyHash> -> 405 (only DELETE is defined)', async () => {
  const req = mockReq({ method: 'GET', url: `/_admin/api/keys/${KEY_HASH}`, headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 405)
})

// --- Unknown route ---------------------------------------------------------

test('admin api: unknown /_admin/api/* route -> 404', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/api/nope', headers: bearerHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 404)
})

// --- Existing routes must be unaffected ------------------------------------

test('admin api addition does not affect the pre-existing /_admin/tunnels (bearer OR cookie) route', async () => {
  const req = mockReq({ method: 'GET', url: '/_admin/tunnels', headers: cookieHeaders() })
  const res = mockRes()
  await run(req, res, deps())
  assert.equal(res.statusCode, 200)
})
