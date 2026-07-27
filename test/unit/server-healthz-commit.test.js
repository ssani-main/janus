'use strict'

// Tier 0 (trust transparency): covers /healthz's `commit` and `version`
// fields (src/server.js, near the /healthz handler). Separate process/file
// from server-healthz-logging.test.js since config.js reads JANUS_COMMIT
// once, synchronously, at require time -- see that file's top comment for
// why each distinct env-driven config case needs its own file.
//
// PORT=0 (OS-assigned ephemeral port) -- no fixed TCP range is bound, so
// this file needs no entry in fixtures/port-ranges.js (same technique as
// server-healthz-logging.test.js / server-metrics-auth.test.js).

const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-healthz-commit-${process.pid}.json`)
const COMMIT = 'deadbeef1234567890abcdef1234567890abcdef'

process.env.BASE_DOMAIN = 'gateway.example.com'
process.env.PORT = '0'
process.env.BIND_HOST = '127.0.0.1'
process.env.STORE_PATH = STORE_PATH
process.env.SESSION_SECRET = 'c'.repeat(64)
process.env.ADMIN_TOKEN = ''
process.env.RATE_MAX_REQUESTS = '1000'
process.env.RATE_MAX_NEW_TUNNELS = '1000'
process.env.LOG_REQUESTS = 'false'
process.env.COOKIE_SECURE = 'false'
process.env.JANUS_COMMIT = COMMIT

const { server } = require('../../src/server')
const { version: PACKAGE_VERSION } = require('../../package.json')

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
      res.on('end', () => resolve({ status: res.statusCode, body }))
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

test('/healthz includes commit (from JANUS_COMMIT) and version (from package.json)', async () => {
  const res = await get('/healthz', { host: 'gateway.example.com' })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.commit, COMMIT, '/healthz commit must reflect configured JANUS_COMMIT')
  assert.equal(body.version, PACKAGE_VERSION, '/healthz version must reflect package.json version')
  assert.equal(body.status, 'ok')
})
