'use strict'

// Milestone 2a: covers src/server.js's /metrics auth flow when ADMIN_TOKEN
// IS configured (the mirror case of test/unit/server-healthz-logging.test.js,
// which covers the ADMIN_TOKEN-unset "invisible" case -- config.js reads
// ADMIN_TOKEN once at require time, so the two cases need separate
// processes/files). Also covers that /metrics is apex-only -- a tenant
// subdomain request never reaches the metrics renderer.
//
// See server-healthz-logging.test.js's top comment for why this file uses
// ONE test() rather than several: node:test + a real http.Server + a real
// stdout-writing logger in one process was empirically observed to
// occasionally drop a sibling test's report when 3+ tests/subtests each
// drive real requests against the same long-lived server.

const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-metrics-${process.pid}.json`)
const ADMIN_TOKEN = 'metrics-test-secret-token'

process.env.BASE_DOMAIN = 'gateway.example.com'
process.env.PORT = '0'
process.env.BIND_HOST = '127.0.0.1'
process.env.STORE_PATH = STORE_PATH
process.env.SESSION_SECRET = 'b'.repeat(64)
process.env.ADMIN_TOKEN = ADMIN_TOKEN
process.env.RATE_MAX_REQUESTS = '1000'
process.env.RATE_MAX_NEW_TUNNELS = '1000'
process.env.LOG_REQUESTS = 'false'
process.env.COOKIE_SECURE = 'false'

const { server } = require('../../src/server')

let port

function waitForListening(srv) {
  if (srv.listening) return Promise.resolve()
  return new Promise((resolve) => srv.once('listening', resolve))
}

function get(pth, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pth, headers }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  await waitForListening(server)
  port = server.address().port
})

after(() => {
  server.close()
})

test('/metrics auth flow when ADMIN_TOKEN is configured', async () => {
  // --- no bearer -> 401 + WWW-Authenticate: Bearer --------------------------
  const noAuth = await get('/metrics', { host: 'gateway.example.com' })
  assert.equal(noAuth.status, 401, 'no Authorization header -> 401')
  assert.equal(noAuth.headers['www-authenticate'], 'Bearer', 'must advertise WWW-Authenticate: Bearer on 401')

  // --- wrong bearer -> 401 --------------------------------------------------
  const wrongAuth = await get('/metrics', { host: 'gateway.example.com', authorization: 'Bearer not-the-token' })
  assert.equal(wrongAuth.status, 401, 'wrong bearer token -> 401')

  // --- correct bearer -> 200, correct content-type + cache-control ----------
  const ok = await get('/metrics', { host: 'gateway.example.com', authorization: `Bearer ${ADMIN_TOKEN}` })
  assert.equal(ok.status, 200, 'correct bearer token -> 200')
  assert.equal(ok.headers['content-type'], 'text/plain; version=0.0.4')
  assert.equal(ok.headers['cache-control'], 'no-store')
  assert.match(ok.body, /^# HELP janus_/m, 'body should look like a real Prometheus metrics payload')

  // --- not reachable on a tenant subdomain (apex-only) ----------------------
  // /metrics is only handled inside the `route.apex` branch of server.js;
  // on a tenant Host, the same path falls through to key parsing +
  // ensureTunnel. A garbage label that doesn't parse as a key and has no
  // matching alias produces a KeyError -> 400, and critically the response
  // must NOT be the metrics payload (no leaked "# HELP"/"janus_" content,
  // regardless of exact status code).
  const tenantHost = 'not-a-real-holesail-key.gateway.example.com'
  const onTenant = await get('/metrics', { host: tenantHost, authorization: `Bearer ${ADMIN_TOKEN}` })
  assert.equal(onTenant.status, 400, 'unparseable key on a tenant subdomain -> KeyError -> 400, not the metrics 200')
  assert.notEqual(
    onTenant.headers['content-type'],
    'text/plain; version=0.0.4',
    '/metrics content-type must never be served from a tenant subdomain'
  )
  assert.doesNotMatch(onTenant.body, /# HELP janus_/, '/metrics content must never be served from a tenant subdomain')
})
