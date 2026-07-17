'use strict'

// Milestone 2a: covers the cumulative counters TunnelManager exposes via
// stats() for the /metrics endpoint (src/tunnel-manager.js `this.counters`).
// Uses the same clientFactory injection harness as
// test/unit/tunnel-manager-port-retry.test.js so none of this touches a real
// DHT/HolesailClient -- see that file's top comment for the full rationale.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { TunnelManager, ConnectError } = require('../../src/tunnel-manager')

// Four distinct valid 52-char z-base-32 keys (public/bare form), generated
// deterministically -- only their sha256 keyHash matters for dedupe/eviction.
const KEY_A = 'oz6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qi'
const KEY_B = '7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qihdkta9gpw5n'
const KEY_C = 'kta9gpw5njoz6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bex'
const KEY_D = 'z6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qih'

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
  })
}

/**
 * Always-succeeds fake client -- connect() resolves immediately without
 * binding a real socket, so `probePort`'s liveness check is the only real
 * network touch (loopback-only, same as the existing port-retry harness).
 * We still need probePort to succeed, so this fake actually listens.
 */
class FakeHolesailClient {
  constructor() {
    this._server = null
  }

  async connect(options, callback) {
    const server = net.createServer()
    this._server = server
    server.listen(options.port, options.host, () => callback())
  }

  async destroy() {
    await closeServer(this._server)
  }
}

/**
 * Fake client that reports success via the callback (like a real
 * HolesailClient would once its internal proxy server is up) but never
 * actually binds/listens on the target port. This makes the post-connect
 * liveness probe (`probePort`) fail with ECONNREFUSED -- a realistic,
 * non-EADDRINUSE failure mode that should be counted as a connectFailure
 * without retrying onto another port.
 */
class SilentClient {
  async connect(_options, callback) {
    callback()
  }

  async destroy() {}
}

// Port ranges 20400-20420, 20430-20435 -- see
// test/unit/fixtures/port-ranges.js for the full cross-file allocation map
// (test files run in parallel, so ranges must stay disjoint).
function baseConfig(overrides) {
  return Object.assign(
    {
      MAX_TUNNELS: 5,
      TUNNEL_PORT_MIN: 20400,
      TUNNEL_PORT_MAX: 20420,
      IDLE_TTL_MS: 1e9,
      CONNECT_TIMEOUT_MS: 2000,
    },
    overrides
  )
}

test('counters: created increments once per successful cold create, not on cache hits', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const rec1 = await manager.ensureTunnel(KEY_A)
  manager.release(rec1)
  const rec2 = await manager.ensureTunnel(KEY_A) // cache hit -- same keyHash
  manager.release(rec2)

  assert.equal(manager.stats().created, 1)
  await manager.destroyTunnel(rec1.keyHash)
})

test('counters: evicted increments when an idle tunnel is evicted to make room', async () => {
  const manager = new TunnelManager(baseConfig({ MAX_TUNNELS: 1 }), undefined, () => new FakeHolesailClient())

  const recA = await manager.ensureTunnel(KEY_A)
  manager.release(recA) // idle now (inFlight === 0), eligible for eviction

  const recB = await manager.ensureTunnel(KEY_B) // forces eviction of A (capacity 1)
  manager.release(recB)

  const stats = manager.stats()
  assert.equal(stats.evicted, 1)
  assert.equal(stats.created, 2)
  assert.equal(manager.tunnels.has(recA.keyHash), false, 'A should have been evicted')
  assert.equal(manager.tunnels.has(recB.keyHash), true)

  await manager.destroyTunnel(recB.keyHash)
})

test('counters: connectFailures increments on a non-collision failure (liveness probe fails), portRetries stays 0', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new SilentClient())

  await assert.rejects(() => manager.ensureTunnel(KEY_C), ConnectError)

  const stats = manager.stats()
  assert.equal(stats.connectFailures, 1)
  assert.equal(stats.portRetries, 0)
  assert.equal(stats.created, 0)
})

test('counters: portRetries increments once per skipped-over occupied port, created still increments on eventual success', async () => {
  const config = baseConfig({ TUNNEL_PORT_MIN: 20430, TUNNEL_PORT_MAX: 20435 })
  const foreign = net.createServer()
  await new Promise((resolve, reject) => {
    foreign.once('error', reject)
    foreign.listen(20430, '127.0.0.1', () => {
      foreign.removeListener('error', reject)
      resolve()
    })
  })

  const manager = new TunnelManager(config, undefined, () => new FakeHolesailClient())
  try {
    const record = await manager.ensureTunnel(KEY_D)
    assert.equal(record.port, 20431, 'should have skipped the occupied port 20430')
    const stats = manager.stats()
    assert.equal(stats.portRetries, 1)
    assert.equal(stats.created, 1)
    assert.equal(stats.connectFailures, 0)
    await manager.destroyTunnel(record.keyHash)
  } finally {
    await closeServer(foreign)
  }
})

test('counters: swept increments when the idle sweeper destroys a tunnel past IDLE_TTL_MS', async (t) => {
  const manager = new TunnelManager(
    baseConfig({ IDLE_TTL_MS: 1000 }),
    undefined,
    () => new FakeHolesailClient()
  )
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record) // idle, inFlight === 0
  // Backdate lastRequestAt so the sweeper sees it as long-idle without
  // needing to wait 1000ms of wall-clock time.
  record.lastRequestAt = Date.now() - 10_000

  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    manager.startSweeper()
    t.mock.timers.tick(60000) // fires the 60s sweep interval once

    // The sweep's destroyTunnel() call is async (awaits client.destroy()) --
    // flush real microtasks/macrotasks with an un-mocked timer so its
    // .then(() => counters.swept++) has a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(manager.stats().swept, 1)
    assert.equal(manager.tunnels.has(record.keyHash), false)
  } finally {
    manager.stopSweeper()
  }
})

test('stats(): returns a fresh object each call -- mutating the result cannot corrupt internal counters', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)

  const first = manager.stats()
  assert.equal(first.created, 1)
  first.created = 9999
  first.active = 9999

  const second = manager.stats()
  assert.equal(second.created, 1, 'mutating a previous stats() snapshot must not affect a later one')
  assert.equal(second.active, 1)
  assert.notEqual(first, second, 'stats() must not return the same object reference twice')

  await manager.destroyTunnel(record.keyHash)
})
