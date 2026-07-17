'use strict'

// Security review (FIX 2, post-Milestone-2): covers ENSURE_TUNNEL_TIMEOUT_MS
// -- the overall wall-clock deadline on TunnelManager.ensureTunnel()'s ENTIRE
// cold-create chain (reconnect loop x port-collision loop x per-attempt
// connect timeout x backoff sleeps), enforced from inside TunnelManager
// itself so the pending-dedupe Map and PortPool are always cleaned up
// correctly, not just raced from outside. Same clientFactory injection
// harness + t.mock.timers technique as tunnel-manager-circuit.test.js -- no
// real DHT/HolesailClient anywhere. Date is ALSO mocked here (unlike most
// other tunnel-manager test files, which only mock setTimeout) because the
// deadline is computed and checked via real `Date.now()` calls in
// tunnel-manager.js -- without mocking Date too, ticking the fake setTimeout
// clock forward would never actually move `Date.now()`, and the deadline
// could never be observed as exceeded without a real multi-second sleep.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { TunnelManager, ConnectError } = require('../../src/tunnel-manager')
const { parseKey } = require('../../src/key')

const KEY_A = 'oz6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qi'

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
  })
}

/** Always-succeeds fake client (same shape as tunnel-manager-circuit.test.js). */
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
 * Reports "connected" immediately but never actually binds anything --
 * `probePort`'s liveness check then fails fast with a REAL (not mocked)
 * ECONNREFUSED, since nothing is listening on the port. This keeps every
 * individual attempt fast in real wall-clock time; only the backoff sleep
 * BETWEEN attempts needs the mocked setTimeout/Date clock advanced.
 */
class NeverBindsClient {
  async connect(_options, callback) {
    callback()
  }
  async destroy() {}
}

// Port range 20800-20810 -- see test/unit/fixtures/port-ranges.js for the
// full cross-file allocation map (test files run in parallel via
// `node --test`, so ranges must stay disjoint).
function baseConfig(overrides) {
  return Object.assign(
    {
      MAX_TUNNELS: 5,
      TUNNEL_PORT_MIN: 20800,
      TUNNEL_PORT_MAX: 20810,
      IDLE_TTL_MS: 1e9,
      CONNECT_TIMEOUT_MS: 2000,
      CIRCUIT_FAILURE_THRESHOLD: 1e9, // don't let the circuit interfere with this test
      CIRCUIT_COOLDOWN_MS: 1000,
      RECONNECT_MAX_ATTEMPTS: 1000, // effectively unbounded -- the deadline must stop it first
      RECONNECT_BASE_DELAY_MS: 20,
      RECONNECT_MAX_DELAY_MS: 50,
      ENSURE_TUNNEL_TIMEOUT_MS: 500,
    },
    overrides
  )
}

test('ensureTunnel: an overall deadline rejects with ConnectError long before RECONNECT_MAX_ATTEMPTS would exhaust, releasing the port and cleaning up `pending`', async (t) => {
  const config = baseConfig()
  const manager = new TunnelManager(config, undefined, () => new NeverBindsClient())

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  try {
    const p = manager.ensureTunnel(KEY_A)
    const assertion = assert.rejects(() => p, ConnectError)

    // Flush real microtasks/IO (the liveness-probe ECONNREFUSED is real I/O,
    // not a mocked timer) and advance the fake clock in small increments,
    // repeatedly, until the deadline is exceeded. Bounded loop count so a
    // regression that removes the deadline entirely fails this test instead
    // of hanging it.
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      t.mock.timers.tick(50)
      if (manager.pending.size === 0) break
    }

    await assertion

    assert.equal(manager.pending.size, 0, 'the pending dedupe entry must be cleaned up once the deadline rejects')
    assert.equal(manager.portPool.used.size, 0, 'every port acquired during the aborted chain must be released')
    assert.equal(manager.tunnels.size, 0, 'no tunnel record should have been cached')
  } finally {
    manager.stopSweeper()
  }
})

test('ensureTunnel: a normal successful cold create well within the deadline is unaffected', async () => {
  const config = baseConfig({ ENSURE_TUNNEL_TIMEOUT_MS: 45000 })
  const manager = new TunnelManager(config, undefined, () => new FakeHolesailClient())

  const record = await manager.ensureTunnel(KEY_A)
  assert.ok(record, 'a fast, successful cold create must still resolve normally')
  assert.equal(manager.tunnels.size, 1)
  manager.release(record)
  await manager.destroyTunnel(record.keyHash)
  manager.stopSweeper()
})
