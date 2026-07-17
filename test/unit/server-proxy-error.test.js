'use strict'

// Bug fix (review of Milestone 2c/2d work): covers src/server.js's
// proxy.on('error') handler. Previously it served the friendlier offlinePage
// only when `req._janusTunnel.healthy === false` -- gated on a signal that,
// after the BUG 1 fix in tunnel-manager.js (a probe-failure streak destroys
// the dead tunnel outright instead of leaving it cached with
// `healthy: false`), would almost never be true by the time a real request
// reaches this handler. offlinePage must now be served for ANY proxy error
// against a known tenant tunnel -- a proxy error IS the backend being
// unreachable, exactly what the page exists to say.
//
// Exercises `proxy` directly (exported from server.js) with fake req/res
// objects, rather than driving a real tunnel through a real backend --
// http-proxy only ever invokes this handler with (err, req, res), so this is
// a faithful, DHT-free way to test it. See server-healthz-logging.test.js's
// top comment for why server.js's config must be set via env vars BEFORE
// requiring it, and why one test file == one process here.

const path = require('node:path')
const os = require('node:os')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-proxy-error-${process.pid}.json`)

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

const { server, proxy } = require('../../src/server')

after(() => {
  server.close()
})

function fakeRes() {
  const state = { statusCode: null, headers: null, body: null, headersSent: false }
  return {
    get headersSent() {
      return state.headersSent
    },
    writeHead(code, headers) {
      state.statusCode = code
      state.headers = headers
      state.headersSent = true
    },
    end(body) {
      state.body = body
    },
    _state: state,
  }
}

test('proxy.on(error): serves offlinePage for ANY proxy error against a known tenant tunnel, regardless of tunnel.healthy', () => {
  // Even `healthy: true` (the common case now that unhealthy records are
  // destroyed almost immediately, see tunnel-manager.js) must still get
  // offlinePage on an actual proxy error -- the error itself is the signal.
  const res = fakeRes()
  const req = { _janusTunnel: { keyHash: 'deadbeef', healthy: true } }

  proxy.emit('error', new Error('ECONNRESET'), req, res)

  assert.equal(res._state.statusCode, 502)
  assert.equal(res._state.headers['Content-Type'], 'text/html; charset=utf-8')
  assert.ok(res._state.headers['Retry-After'], 'must still set an honest Retry-After header')
  assert.match(res._state.body, /Backend unavailable/, 'expected offlinePage content, not the generic errorPage')
})

test('proxy.on(error): serves offlinePage even when tunnel.healthy is explicitly false', () => {
  const res = fakeRes()
  const req = { _janusTunnel: { keyHash: 'deadbeef', healthy: false } }

  proxy.emit('error', new Error('ECONNRESET'), req, res)

  assert.equal(res._state.statusCode, 502)
  assert.match(res._state.body, /Backend unavailable/)
})

test('proxy.on(error): falls back to the generic errorPage when there is no tunnel context at all', () => {
  const res = fakeRes()
  const req = {}

  proxy.emit('error', new Error('some error'), req, res)

  assert.equal(res._state.statusCode, 502)
  assert.doesNotMatch(res._state.body, /Backend unavailable/)
  assert.match(res._state.body, /Bad Gateway/)
})

test('proxy.on(error): destroys a raw socket on the websocket upgrade path (res has no writeHead)', () => {
  let destroyed = false
  const socket = { destroy: () => { destroyed = true } }

  proxy.emit('error', new Error('ws error'), {}, socket)

  assert.equal(destroyed, true)
})

test('proxy.on(error): does nothing further if headers were already sent', () => {
  const res = fakeRes()
  res.writeHead(200, {}) // simulate headers already sent before the error fired
  const before = res._state.body
  const req = { _janusTunnel: { keyHash: 'deadbeef', healthy: true } }

  assert.doesNotThrow(() => proxy.emit('error', new Error('late error'), req, res))
  assert.equal(res._state.body, before, 'must not attempt to write a body once headers are already sent')
})
