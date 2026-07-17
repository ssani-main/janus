'use strict'

// Security review (FIX 1, post-Milestone-2): src/server.js's ensureTunnel
// catch branch used to serve `err.message` verbatim (HTML-escaped, but not
// stripped) via errorPage() -- for a ConnectError originating from
// tunnel-manager.js's probePort/probeFree, that message can literally
// contain `127.0.0.1:<port>`, revealing the TUNNEL_PORT_MIN/MAX allocation
// range to an unauthenticated visitor. For a CapacityError it reveals the
// configured MAX_TUNNELS. This file drives the REAL src/server.js HTTP
// handler end-to-end (same technique as server-proxy-timeout.test.js), but
// monkey-patches `manager.ensureTunnel` to throw a canned error directly --
// no real DHT/HolesailClient anywhere, consistent with the "clientFactory
// injection harness + t.mock.timers, no real DHT in tests" constraint (the
// error class + message shape is exactly what tunnel-manager.js already
// produces; only the actual connect attempt is stubbed out).
//
// server.js's config (src/config.js) is read once, synchronously, from
// process.env at require time -- see server-healthz-logging.test.js's top
// comment for why every env var this file needs is set BEFORE requiring
// server.js, and why one test file == one process here.

const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-error-leak-${process.pid}.json`)

process.env.BASE_DOMAIN = 'gateway.example.com'
process.env.PORT = '0'
process.env.BIND_HOST = '127.0.0.1'
process.env.STORE_PATH = STORE_PATH
process.env.SESSION_SECRET = 'e'.repeat(64)
process.env.ADMIN_TOKEN = ''
process.env.RATE_MAX_REQUESTS = '1000'
process.env.RATE_MAX_NEW_TUNNELS = '1000'
process.env.LOG_REQUESTS = 'false'
process.env.COOKIE_SECURE = 'false'
// Port range 20900-20910 -- see test/unit/fixtures/port-ranges.js for the
// full cross-file allocation map (test files run in parallel via
// `node --test`, so ranges must stay disjoint).
process.env.TUNNEL_PORT_MIN = '20900'
process.env.TUNNEL_PORT_MAX = '20910'
process.env.MAX_TUNNELS = '7'

const { server, manager } = require('../../src/server')
const { ConnectError, CapacityError } = require('../../src/tunnel-manager')

let gatewayPort
const originalEnsureTunnel = manager.ensureTunnel.bind(manager)

function waitForListening(srv) {
  if (srv.listening) return Promise.resolve()
  return new Promise((resolve) => srv.once('listening', resolve))
}

before(async () => {
  await waitForListening(server)
  gatewayPort = server.address().port
})

after(() => {
  server.close()
  manager.ensureTunnel = originalEnsureTunnel
})

function get(rawKey) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      path: '/',
      headers: { host: `${rawKey}.gateway.example.com` },
    }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('test request timed out')))
    req.end()
  })
}

function captureConsoleError() {
  const calls = []
  const original = console.error
  console.error = (...args) => {
    calls.push(args.join(' '))
  }
  return {
    calls,
    restore() {
      console.error = original
    },
  }
}

const KEY_CONNECT_ERR = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const KEY_CAPACITY_ERR = 'cccccccccccccccccccccccccccccccccccccccccccccccccc'

test('ConnectError from a port-probe timeout does not leak the internal 127.0.0.1:<port> into the visitor-facing page', async () => {
  const leakyPort = 20905 // inside TUNNEL_PORT_MIN..TUNNEL_PORT_MAX
  const detailedMessage = `failed to connect tunnel for key: liveness probe timed out for 127.0.0.1:${leakyPort}`
  manager.ensureTunnel = async () => {
    throw new ConnectError(detailedMessage)
  }

  const cap = captureConsoleError()
  let res
  try {
    res = await get(KEY_CONNECT_ERR)
  } finally {
    cap.restore()
    manager.ensureTunnel = originalEnsureTunnel
  }

  assert.equal(res.status, 502)
  assert.doesNotMatch(res.body, /127\.0\.0\.1/, 'visitor-facing body must never contain the internal loopback host')
  assert.doesNotMatch(res.body, new RegExp(String(leakyPort)), 'visitor-facing body must never contain the internal port number')
  // Sanity: no digit sequence in the page's actual TEXT (excluding the
  // embedded <style> block's base64 font data, which legitimately contains
  // incidental digit runs unrelated to this leak) falls inside the
  // configured tunnel port range (20900-20910).
  const bodyWithoutStyle = res.body.replace(/<style>[\s\S]*?<\/style>/, '')
  const numbers = bodyWithoutStyle.match(/\b\d{5}\b/g) || []
  for (const n of numbers) {
    const value = Number(n)
    assert.ok(
      !(value >= 20900 && value <= 20910),
      `body contains a 5-digit number (${n}) inside the tunnel port range`
    )
  }

  // Operator-side: console.error must still have received the full detail.
  const loggedFull = cap.calls.some((line) => line.includes(detailedMessage))
  assert.ok(loggedFull, 'console.error must still receive the detailed err.message for operators')
})

test('CapacityError does not reveal the configured MAX_TUNNELS value to the visitor', async () => {
  const detailedMessage = 'gateway at capacity (7 tunnels), all active; try again shortly'
  manager.ensureTunnel = async () => {
    throw new CapacityError(detailedMessage)
  }

  const cap = captureConsoleError()
  let res
  try {
    res = await get(KEY_CAPACITY_ERR)
  } finally {
    cap.restore()
    manager.ensureTunnel = originalEnsureTunnel
  }

  assert.equal(res.status, 503)
  assert.doesNotMatch(res.body, /7 tunnels/, 'visitor-facing body must never contain the MAX_TUNNELS value')
  assert.doesNotMatch(res.body, /capacity \(/i, 'visitor-facing body must not echo the operator-facing capacity phrasing')

  const loggedFull = cap.calls.some((line) => line.includes(detailedMessage))
  assert.ok(loggedFull, 'console.error must still receive the detailed err.message for operators')
})
