'use strict'

// Covers the EADDRINUSE port-collision crash fix in src/tunnel-manager.js.
// PortPool only tracks ports this process has handed out -- it never checks
// whether the OS actually has the port free (src/port-pool.js). If anything
// else holds that port, holesail-client's internal net.Server.listen() fails
// ASYNCHRONOUSLY as an 'error' event with no listener attached anywhere in
// its call chain (see node_modules/holesail-client/index.js:45-58 and
// node_modules/@holesail/hyper-cmd-lib-net/index.js:246-252), which used to
// escalate straight to uncaughtException and kill the whole gateway process.
//
// These tests use fake HolesailClient stand-ins (injected via the
// `clientFactory` constructor param) that faithfully reproduce that same
// "net.createServer().listen() with no error listener" shape, so we
// exercise the real fix (probeFree + connectWithPortGuard) without needing
// a real DHT-backed HolesailClient/backend.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { TunnelManager, ConnectError } = require('../../src/tunnel-manager')

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
  })
}

/**
 * Faithful stand-in for HolesailClient's TCP path: on connect(), it creates
 * its own net.Server and listens on the requested port/host with NO 'error'
 * listener attached -- exactly like handleTCP() -> createTcpProxy() does in
 * the real library. If the port is already taken, this will crash the
 * process unless TunnelManager's connectWithPortGuard catches it.
 */
class FakeHolesailClient {
  constructor() {
    this._server = null
  }

  async connect(options, callback) {
    const server = net.createServer()
    this._server = server
    server.listen(options.port, options.host, () => {
      callback()
    })
  }

  async destroy() {
    await closeServer(this._server)
  }
}

// Port ranges 20100-20105, 20120-20122, 20130-20132 -- see
// test/unit/fixtures/port-ranges.js for the full cross-file allocation map
// (test files run in parallel, so ranges must stay disjoint).
test('_createTunnel: port occupied by a foreign listener retries onto the next pool port and succeeds', async () => {
  const config = {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN: 20100,
    TUNNEL_PORT_MAX: 20105,
    IDLE_TTL_MS: 1e9,
    CONNECT_TIMEOUT_MS: 2000,
  }

  const foreign = net.createServer()
  await listen(foreign, 20100, '127.0.0.1')

  const manager = new TunnelManager(config, undefined, () => new FakeHolesailClient())

  try {
    const record = await manager.ensureTunnel(KEY_A)
    assert.equal(record.port, 20101, 'should have skipped the occupied port 20100')
    assert.equal(manager.portPool.used.has(20100), false, 'the occupied port must not be marked used')
    await manager.destroyTunnel(record.keyHash)
  } finally {
    await closeServer(foreign)
  }
})

test('_createTunnel: TOCTOU race caught by connectWithPortGuard also retries and succeeds (no crash)', () => {
  // Run in a real, separate Node process -- see the fixture's top comment
  // for why: node:test's own runner flags any 'uncaughtException' fired
  // during a test as a failure regardless of whether app code handled it,
  // so an in-process test here would give a false negative. A subprocess
  // is the only way to prove the process doesn't actually die.
  const fixture = path.join(__dirname, 'fixtures', 'port-guard-toctou.js')
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000 })

  assert.equal(result.status, 0, `subprocess should exit cleanly, not crash:\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /OK/, `expected success marker in subprocess output:\n${result.stdout}\n${result.stderr}`)
})

test('_createTunnel: every candidate port occupied throws ConnectError, not a crash', async () => {
  const config = {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN: 20120,
    TUNNEL_PORT_MAX: 20122, // only 3 ports -- fewer than MAX_PORT_ATTEMPTS
    IDLE_TTL_MS: 1e9,
    CONNECT_TIMEOUT_MS: 2000,
  }

  const foreigns = []
  for (let port = 20120; port <= 20122; port++) {
    const server = net.createServer()
    await listen(server, port, '127.0.0.1')
    foreigns.push(server)
  }

  const manager = new TunnelManager(config, undefined, () => new FakeHolesailClient())

  try {
    await assert.rejects(() => manager.ensureTunnel(KEY_A), ConnectError)
  } finally {
    await Promise.all(foreigns.map(closeServer))
  }
})

test('connectWithPortGuard: two concurrent cold-creates on DIFFERENT ports -- one EADDRINUSE, one succeeds -- neither hangs the process, and no port leaks', () => {
  // Run in a real, separate Node process for the same reason as the TOCTOU
  // test above: the good attempt's EADDRINUSE-guard handling still fires a
  // real process-level 'uncaughtException' event (just a handled one), and
  // node:test's own runner flags that as a test failure regardless of
  // whether application code handled it. A subprocess is also the only way
  // to prove the "good" concurrent attempt doesn't actually hang forever --
  // that's exactly the regression this guards against (see the fixture's
  // top comment for the full bug walkthrough).
  const fixture = path.join(__dirname, 'fixtures', 'port-guard-concurrency.js')
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000 })

  assert.equal(
    result.status,
    0,
    `subprocess should exit cleanly (good tunnel resolves, bad one rejects, no crash, no leak):\n${result.stdout}\n${result.stderr}`
  )
  assert.match(result.stdout, /OK/, `expected success marker in subprocess output:\n${result.stdout}\n${result.stderr}`)
})

test('onUncaughtPortGuard: a genuinely unrelated bug (not EADDRINUSE on a pending port) still crashes the process', () => {
  // Proves the shared guard is not a blanket swallow -- an unrelated,
  // unhandled error thrown during connect() must still take the process
  // down, exactly as it would with no guard installed. Run out-of-process
  // since we're deliberately triggering a real crash.
  const fixture = path.join(__dirname, 'fixtures', 'port-guard-real-bug-still-crashes.js')
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000 })

  assert.notEqual(result.status, 0, `subprocess should crash on an unrelated bug, not exit cleanly:\n${result.stdout}\n${result.stderr}`)
  assert.match(
    result.stderr,
    /boom: totally unrelated bug/,
    `expected the unrelated TypeError to escape uncaught:\n${result.stdout}\n${result.stderr}`
  )
})

test('_createTunnel: port pool has no leak after every attempt fails', async () => {
  const config = {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN: 20130,
    TUNNEL_PORT_MAX: 20132,
    IDLE_TTL_MS: 1e9,
    CONNECT_TIMEOUT_MS: 2000,
  }

  const foreigns = []
  for (let port = 20130; port <= 20132; port++) {
    const server = net.createServer()
    await listen(server, port, '127.0.0.1')
    foreigns.push(server)
  }

  const manager = new TunnelManager(config, undefined, () => new FakeHolesailClient())

  try {
    await assert.rejects(() => manager.ensureTunnel(KEY_A), ConnectError)
    assert.equal(manager.portPool.used.size, 0, 'every acquired port must have been released back to the pool')
    // Pool should still be fully usable afterwards.
    const port = manager.portPool.acquire()
    assert.ok(port >= 20130 && port <= 20132)
    manager.portPool.release(port)
  } finally {
    await Promise.all(foreigns.map(closeServer))
  }
})
