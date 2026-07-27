'use strict'

// Tier 0 (trust transparency): mirror case of server-healthz-commit.test.js
// -- JANUS_COMMIT left unset must render as an explicit `null` on /healthz,
// not be omitted, and must not affect startup. Separate process/file for the
// same reason as its sibling (config.js reads JANUS_COMMIT once at require
// time).
//
// PORT=0 -- no fixed TCP range bound, so no fixtures/port-ranges.js entry
// needed.

const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-healthz-commit-unset-${process.pid}.json`)

process.env.BASE_DOMAIN = 'gateway.example.com'
process.env.PORT = '0'
process.env.BIND_HOST = '127.0.0.1'
process.env.STORE_PATH = STORE_PATH
process.env.SESSION_SECRET = 'd'.repeat(64)
process.env.ADMIN_TOKEN = ''
process.env.RATE_MAX_REQUESTS = '1000'
process.env.RATE_MAX_NEW_TUNNELS = '1000'
process.env.LOG_REQUESTS = 'false'
process.env.COOKIE_SECURE = 'false'
process.env.JANUS_COMMIT = ''

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

test('/healthz: commit is explicit null when JANUS_COMMIT is unset', async () => {
  const res = await get('/healthz', { host: 'gateway.example.com' })
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.commit, null, '/healthz commit must be null (not omitted) when JANUS_COMMIT is unset')
  assert.ok('commit' in body, '/healthz body must include a commit key even when unset')
})
