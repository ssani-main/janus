'use strict'

// Covers the process-wide cold-create concurrency cap in
// src/tunnel-manager.js (MAX_CONCURRENT_CREATES / MAX_CREATE_QUEUE).
//
// WHY THE CAP EXISTS: MAX_TUNNELS is checked against `this.tunnels.size`, and
// a record only lands in `this.tunnels` after a connect SUCCEEDS -- so it
// bounds finished tunnels, not in-flight creates. `this.pending` dedupes
// concurrent creates for the same key but does nothing across distinct keys.
// That left RATE_MAX_NEW_TUNNELS (per-IP) as the only throttle on the
// expensive path, so the real ceiling was 10 x (number of distinct client
// IPs). Each in-flight create holds a HolesailClient -- a HyperDHT node with
// a UDP socket -- for up to ENSURE_TUNNEL_TIMEOUT_MS, so an unbounded number
// of them walks the process into its systemd MemoryMax and restarts it,
// dropping every live tenant.
//
// These tests use a fake client (injected via the `clientFactory` constructor
// param) whose connect() genuinely listens on the requested port -- the
// manager's own probeFree()/probePort() do real loopback TCP -- but which
// parks before calling back until the test opens the gate. That holds creates
// "in flight" so the high-water mark of concurrency is observable, with no
// DHT involved.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { TunnelManager, CapacityError } = require('../../src/tunnel-manager')

// Must match the range registered for this file in fixtures/port-ranges.js.
const TUNNEL_PORT_MIN = 21000
const TUNNEL_PORT_MAX = 21040

const Z32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'

/**
 * Distinct, valid 52-char z-base-32 keys -- one per index.
 *
 * The first four characters are `index` in base 32 (least-significant first),
 * which makes distinctness for index < 32^4 a property of the encoding rather
 * than something to eyeball. An earlier version used a single mixed modulo
 * expression and silently collapsed 12 indices onto 4 distinct keys, which
 * made the dedupe path swallow most of the concurrency the tests meant to
 * measure.
 */
function keyFor(index) {
  let out = ''
  let n = index
  for (let i = 0; i < 4; i++) {
    out += Z32[n % Z32.length]
    n = Math.floor(n / Z32.length)
  }
  for (let i = 4; i < 52; i++) {
    out += Z32[(i * 7 + index) % Z32.length]
  }
  return out
}

/**
 * Give the manager real event-loop time: probeFree(), server.listen() and
 * probePort() are all genuine async TCP operations, so a couple of
 * setImmediate ticks is not enough for a create to actually reach the gate.
 */
function settle(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function baseConfig(overrides) {
  return {
    TUNNEL_PORT_MIN,
    TUNNEL_PORT_MAX,
    CONNECT_TIMEOUT_MS: 5000,
    ENSURE_TUNNEL_TIMEOUT_MS: 20000,
    IDLE_TTL_MS: 900000,
    MAX_TUNNELS: 100,
    MAX_PORT_ATTEMPTS: 5,
    RECONNECT_MAX_ATTEMPTS: 0,
    WS_MAX_SLOTS: 50,
    ...overrides,
  }
}

/**
 * Tracks how many connects are simultaneously in flight (`maxObserved` is the
 * high-water mark the semaphore is supposed to bound) and parks each one at a
 * gate until `openGate()` is called.
 *
 * The gate is a LATCH, not a one-shot broadcast: once open it stays open, so
 * a create that reaches it later -- after the cap admits the next wave --
 * proceeds immediately instead of parking forever. A release-the-current-
 * waiters design races with creates still working through listen()/probe.
 */
function makeGatedFactory({ failAll = false, open = false } = {}) {
  const state = {
    inFlight: 0,
    maxObserved: 0,
    started: 0,
    open,
    servers: [],
    _waiters: [],
  }

  state.openGate = () => {
    state.open = true
    const waiters = state._waiters
    state._waiters = []
    for (const w of waiters) w()
  }

  state.closeAll = async () => {
    await Promise.all(
      state.servers.map(
        (s) => new Promise((resolve) => (s && s.listening ? s.close(() => resolve()) : resolve()))
      )
    )
  }

  const factory = () => {
    state.started++
    return {
      async connect(options, callback) {
        state.inFlight++
        if (state.inFlight > state.maxObserved) state.maxObserved = state.inFlight
        try {
          const server = net.createServer()
          state.servers.push(server)
          await new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(options.port, options.host, () => {
              server.removeListener('error', reject)
              resolve()
            })
          })

          if (!state.open) {
            await new Promise((resolve) => state._waiters.push(resolve))
          }

          if (failAll) throw new Error('simulated connect failure')
          callback()
        } finally {
          state.inFlight--
        }
      },
      async destroy() {
        // best-effort, mirrors HolesailClient.destroy()
      },
    }
  }

  return { factory, state }
}

test('cold creates never exceed MAX_CONCURRENT_CREATES across distinct keys', async (t) => {
  const { factory, state } = makeGatedFactory()
  const manager = new TunnelManager(
    baseConfig({ MAX_CONCURRENT_CREATES: 3, MAX_CREATE_QUEUE: 100 }),
    undefined,
    factory
  )
  // Open the gate and tear down on the way out no matter how the test ends.
  // Without this a FAILED assertion leaves creates parked at the gate, the
  // event loop never drains, and the runner hangs instead of reporting the
  // failure.
  t.after(async () => {
    state.openGate()
    await manager.shutdown().catch(() => {})
    await state.closeAll()
  })

  // 12 distinct keys, all cold, all at once.
  const pending = Array.from({ length: 12 }, (_, i) => manager.ensureTunnel(keyFor(i)))
  await settle()

  assert.equal(
    state.maxObserved,
    3,
    `expected exactly 3 concurrent creates (the cap), observed ${state.maxObserved}`
  )
  assert.equal(manager.stats().createsActive, 3)
  assert.equal(manager.stats().createsQueued, 9, 'the other 9 must be waiting, not running')

  state.openGate()
  const results = await Promise.allSettled(pending)
  assert.equal(
    results.filter((r) => r.status === 'fulfilled').length,
    12,
    'every create should eventually succeed -- the cap throttles, it does not reject'
  )
  assert.ok(
    state.maxObserved <= 3,
    `cap must hold for the whole drain, observed ${state.maxObserved}`
  )

})

test('creates past MAX_CREATE_QUEUE fast-fail with CapacityError instead of queueing', async (t) => {
  const { factory, state } = makeGatedFactory()
  const manager = new TunnelManager(
    baseConfig({ MAX_CONCURRENT_CREATES: 2, MAX_CREATE_QUEUE: 2 }),
    undefined,
    factory
  )
  // Open the gate and tear down on the way out no matter how the test ends.
  // Without this a FAILED assertion leaves creates parked at the gate, the
  // event loop never drains, and the runner hangs instead of reporting the
  // failure.
  t.after(async () => {
    state.openGate()
    await manager.shutdown().catch(() => {})
    await state.closeAll()
  })

  // 2 running + 2 queued = 4 admitted; anything past that must be rejected.
  const admitted = Array.from({ length: 4 }, (_, i) => manager.ensureTunnel(keyFor(i)))
  await settle()
  assert.equal(manager.stats().createsActive, 2)
  assert.equal(manager.stats().createsQueued, 2)

  await assert.rejects(
    () => manager.ensureTunnel(keyFor(100)),
    (err) => err instanceof CapacityError && /queue full/i.test(err.message),
    'a create arriving with a full queue must fast-fail, not wait out the deadline'
  )
  await assert.rejects(() => manager.ensureTunnel(keyFor(101)), CapacityError)

  assert.equal(
    manager.stats().createQueueRejected,
    2,
    'both rejections should be counted for /metrics'
  )

  state.openGate()
  await Promise.allSettled(admitted)
})

test('a failing create releases its slot (the gate never shrinks permanently)', async (t) => {
  // Gate starts open: these creates fail immediately rather than parking.
  // RECONNECT_MAX_ATTEMPTS is 0, so each ensureTunnel fails once and gives up.
  const { factory, state } = makeGatedFactory({ failAll: true, open: true })
  const manager = new TunnelManager(
    baseConfig({ MAX_CONCURRENT_CREATES: 2, MAX_CREATE_QUEUE: 50 }),
    undefined,
    factory
  )
  // Open the gate and tear down on the way out no matter how the test ends.
  // Without this a FAILED assertion leaves creates parked at the gate, the
  // event loop never drains, and the runner hangs instead of reporting the
  // failure.
  t.after(async () => {
    state.openGate()
    await manager.shutdown().catch(() => {})
    await state.closeAll()
  })

  const failing = Array.from({ length: 6 }, (_, i) => manager.ensureTunnel(keyFor(i)))
  const results = await Promise.allSettled(failing)
  assert.equal(results.filter((r) => r.status === 'rejected').length, 6, 'all should fail')

  // If a failed create leaked its slot the gate would now be permanently
  // narrowed -- eventually to zero, wedging every future cold create.
  const stats = manager.stats()
  assert.equal(stats.createsActive, 0, 'no slot may remain held after every create settled')
  assert.equal(stats.createsQueued, 0, 'no waiter may remain queued')

  // Prove the gate still admits work at full width afterwards.
  const { factory: okFactory, state: okState } = makeGatedFactory({ open: true })
  manager.clientFactory = okFactory
  await manager.ensureTunnel(keyFor(50))
  assert.equal(manager.stats().createsActive, 0)

  await okState.closeAll()
})

test('concurrent callers for the SAME key share one slot and one create', async (t) => {
  // Regression test. Acquiring the semaphore between ensureTunnel's
  // `pending.has()` check and its `pending.set()` puts an await in that
  // window, letting two callers for one key each start a create and each take
  // a slot. The gate must be acquired INSIDE the promise stored in `pending`
  // -- see _createGated in src/tunnel-manager.js.
  const { factory, state } = makeGatedFactory()
  const manager = new TunnelManager(
    baseConfig({ MAX_CONCURRENT_CREATES: 4, MAX_CREATE_QUEUE: 50 }),
    undefined,
    factory
  )
  // Open the gate and tear down on the way out no matter how the test ends.
  // Without this a FAILED assertion leaves creates parked at the gate, the
  // event loop never drains, and the runner hangs instead of reporting the
  // failure.
  t.after(async () => {
    state.openGate()
    await manager.shutdown().catch(() => {})
    await state.closeAll()
  })

  const key = keyFor(7)
  const callers = [
    manager.ensureTunnel(key),
    manager.ensureTunnel(key),
    manager.ensureTunnel(key),
  ]
  await settle()

  assert.equal(state.started, 1, 'only ONE client should ever have been constructed')
  assert.equal(state.maxObserved, 1, 'only ONE slot should have been consumed')
  assert.equal(manager.stats().createsActive, 1)

  state.openGate()
  const records = await Promise.all(callers)
  assert.equal(records[0], records[1], 'all callers must share the same tunnel record')
  assert.equal(records[1], records[2])
  assert.equal(records[0].inFlight, 3, 'each caller retains its own reference')

})

test('MAX_CONCURRENT_CREATES absent from config -> unbounded (pre-cap behavior preserved)', async (t) => {
  // baseConfig deliberately omits both knobs, exactly like the hand-rolled
  // configs in the older test files that predate them.
  const { factory, state } = makeGatedFactory()
  const manager = new TunnelManager(baseConfig(), undefined, factory)
  t.after(async () => {
    state.openGate()
    await manager.shutdown().catch(() => {})
    await state.closeAll()
  })

  const pending = Array.from({ length: 5 }, (_, i) => manager.ensureTunnel(keyFor(i)))
  await settle()
  assert.equal(state.maxObserved, 5, 'with no cap configured, all 5 run at once')

  state.openGate()
  await Promise.allSettled(pending)
})
