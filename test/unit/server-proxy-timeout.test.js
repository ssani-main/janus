'use strict'

// Bug fix (adversarial review of Milestone 2c/2d): the previous BUG 1 fix
// was only HALF done. tunnel-manager.js's _probeOne skips a tunnel whose
// `inFlight > 0`, reasoning that an in-flight request proves the backend is
// alive -- but that's false exactly when the in-flight request IS the stuck
// thing: a backend that accepts the proxy connection and then hangs
// (deadlock, infinite loop, black-holed socket) never errors, so
// `release()` never fires, `inFlight` never drains, the probe never runs,
// and the tunnel pins forever with `healthy` still `true` (nothing visibly
// wrong on the admin dashboard).
//
// The fix is `PROXY_TIMEOUT_MS` (src/config.js) threaded into
// `httpProxy.createProxyServer` (src/server.js) as `proxyTimeout`, which
// makes http-proxy abort a hung upstream request and emit 'error' -- the
// EXISTING proxy.on('error') handler (already covered by
// server-proxy-error.test.js) then does the rest: recordFailure + serve
// offlinePage, and res 'finish' fires -> release() runs -> inFlight drains.
//
// This file exercises the REAL http-proxy instance and REAL server.js HTTP
// handling end-to-end, but with a fake tunnel record manually inserted into
// `manager.tunnels` (no real HolesailClient/DHT anywhere) -- the same
// "clientFactory injection harness" spirit as the other tunnel-manager
// tests, just applied at the manager's cache layer directly since
// server.js's manager doesn't accept a custom clientFactory. Every scenario
// here uses a real loopback TCP/HTTP backend standing in for the tunneled
// origin.
//
// server.js's config (src/config.js) is read once, synchronously, from
// process.env at require time -- see server-healthz-logging.test.js's top
// comment for why every env var this file needs is set BEFORE requiring
// server.js, and why one test file == one process here. PROXY_TIMEOUT_MS is
// set small (300ms) so these tests run fast without real timers/fake clocks
// -- http-proxy's proxyReq.setTimeout is a real socket timer, not mockable
// via t.mock.timers.

const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const net = require('node:net')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const WebSocket = require('ws')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-proxy-timeout-${process.pid}.json`)

const PROXY_TIMEOUT_MS = 300

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
process.env.PROXY_TIMEOUT_MS = String(PROXY_TIMEOUT_MS)
process.env.CIRCUIT_FAILURE_THRESHOLD = '2'

const { server, manager } = require('../../src/server')
const { parseKey } = require('../../src/key')

let gatewayPort

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
})

/**
 * Manually insert a fake, already-connected tunnel record for `rawKey`
 * pointing at `port`, bypassing TunnelManager's real cold-create path
 * entirely (no HolesailClient/DHT). Same record shape `_attemptPortConnect`
 * produces in tunnel-manager.js.
 */
function insertFakeTunnel(rawKey, port) {
  const { keyHash } = parseKey(rawKey)
  const record = {
    client: { destroy: async () => {} },
    port,
    keyHash,
    firstSeenAt: Date.now(),
    lastRequestAt: Date.now(),
    inFlight: 0,
    healthy: true,
    lastProbeAt: null,
    _probeFailStreak: 0,
  }
  manager.tunnels.set(keyHash, record)
  return record
}

function get(rawKey, pth = '/', extraOpts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: gatewayPort,
      path: pth,
      headers: { host: `${rawKey}.gateway.example.com` },
      ...extraOpts,
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

function closeNetServer(srv) {
  return new Promise((resolve) => {
    if (!srv || !srv.listening) return resolve()
    srv.close(() => resolve())
  })
}

// 52-char z-base-32 raw keys (bare form -- treated as public/connect-mode),
// one per test to keep each scenario's tunnel record fully isolated.
const KEY_HUNG = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'
const KEY_CIRCUIT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const KEY_WS = 'nnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnnn'
const KEY_SLOW = 'gggggggggggggggggggggggggggggggggggggggggggggggggggg'

test('headline (BUG 1, fully closed): a hung backend does not pin the tunnel forever -- the request errors, inFlight drains, the probe then runs, and the tunnel is destroyed automatically', async () => {
  let acceptedSocket = null
  const backend = net.createServer((socket) => {
    acceptedSocket = socket
    // Represents a genuinely wedged backend process: it accepted this one
    // connection and will never respond to it, AND -- since a truly
    // deadlocked event loop can't accept() anything else either -- it stops
    // listening for further connections right away. This is exactly why the
    // health probe (a transport-level loopback connect) is blind to this
    // failure mode on its own: probePort() would happily connect if the
    // listener were still up. The proxyTimeout fix, not the probe, is what
    // actually breaks the pin.
    backend.close()
  })
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const port = backend.address().port

  const record = insertFakeTunnel(KEY_HUNG, port)

  const res = await get(KEY_HUNG)
  assert.equal(res.status, 502, 'a hung backend must eventually surface as a 502, not hang the client forever')
  assert.match(res.body, /Backend unavailable/, 'expected offlinePage -- proxy.on(\'error\') already knows this tunnel')

  assert.equal(record.inFlight, 0, 'inFlight must drain back to 0 once the proxy timeout fires and res finishes')

  await manager._probeTunnels() // streak 1 -- "open by default", must not destroy yet
  assert.equal(manager.tunnels.has(record.keyHash), true, 'a single failed probe must not destroy the tunnel')

  await manager._probeTunnels() // streak 2 -- destroys
  assert.equal(
    manager.tunnels.has(record.keyHash),
    false,
    'a hung backend\'s tunnel must be destroyed after the probe failure streak -- no operator action required'
  )

  if (acceptedSocket) acceptedSocket.destroy()
})

test('a hung backend\'s proxy timeout feeds recordFailure and eventually opens the circuit', async () => {
  const sockets = []
  const backend = net.createServer((socket) => {
    sockets.push(socket) // accept and hold every connection open, never respond
  })
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const port = backend.address().port

  const record = insertFakeTunnel(KEY_CIRCUIT, port)

  assert.equal(manager.circuits.has(record.keyHash), false)

  // CIRCUIT_FAILURE_THRESHOLD=2 for this process -- two timed-out requests
  // must be enough to open the circuit via the existing proxy.on('error')
  // -> recordFailure wiring.
  const res1 = await get(KEY_CIRCUIT)
  assert.equal(res1.status, 502)
  const res2 = await get(KEY_CIRCUIT)
  assert.equal(res2.status, 502)

  const circuit = manager.circuits.get(record.keyHash)
  assert.ok(circuit, 'a circuit entry must exist after repeated proxy-timeout failures')
  assert.ok(circuit.circuitOpenUntil > Date.now(), 'the circuit must be open after reaching CIRCUIT_FAILURE_THRESHOLD')

  manager.tunnels.delete(record.keyHash)
  for (const s of sockets) s.destroy()
  await closeNetServer(backend)
})

test('a long-lived websocket is NOT killed by the proxy timeout', async () => {
  const app = http.createServer((req, res) => {
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocket.Server({ server: app })
  wss.on('connection', (socket) => {
    socket.on('message', (m) => socket.send(`echo:${m}`))
  })
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  const port = app.address().port

  insertFakeTunnel(KEY_WS, port)

  const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/`, {
    headers: { host: `${KEY_WS}.gateway.example.com` },
  })

  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  // Outlive PROXY_TIMEOUT_MS by a wide margin -- a websocket has no response
  // to time out (http-proxy's ws pass never reads options.proxyTimeout), so
  // this connection must still be open and functional afterward.
  await new Promise((resolve) => setTimeout(resolve, PROXY_TIMEOUT_MS * 3))
  assert.equal(ws.readyState, WebSocket.OPEN, 'the websocket must still be open well past PROXY_TIMEOUT_MS')

  const echoed = await new Promise((resolve, reject) => {
    ws.once('message', (data) => resolve(data.toString()))
    ws.once('error', reject)
    ws.send('still-alive')
  })
  assert.equal(echoed, 'echo:still-alive', 'the long-lived websocket must still be functional after outliving the proxy timeout')

  ws.close()
  await new Promise((resolve) => wss.close(resolve))
  await closeNetServer(app)
  manager.tunnels.delete(parseKey(KEY_WS).keyHash)
})

test('a slow-but-working backend (responds just under the timeout) is NOT severed', async () => {
  const backend = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('slow but working')
    }, PROXY_TIMEOUT_MS - 150)
  })
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const port = backend.address().port

  const record = insertFakeTunnel(KEY_SLOW, port)

  const res = await get(KEY_SLOW)
  assert.equal(res.status, 200, 'a backend that responds just under PROXY_TIMEOUT_MS must not be severed')
  assert.equal(res.body, 'slow but working')
  assert.equal(record.inFlight, 0, 'inFlight must still drain normally on a real (non-timed-out) response')

  manager.tunnels.delete(record.keyHash)
  await closeNetServer(backend)
})
