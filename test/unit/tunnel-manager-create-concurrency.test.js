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
// F1's tests drive _createGated directly, which takes a PARSED key.
const { parseKey } = require('../../src/key')

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

// --- F1: the create-queue wait must honour the ensureTunnel deadline -------
//
// Before this, Semaphore.acquire() resolved ONLY when a slot freed. A caller
// queued behind a saturated gate therefore held its socket for the entire
// wait and only then discovered it had failed -- `_createTunnel` fast-fails on
// entry, but nothing shortened the wait itself. With the shipped defaults
// (MAX_CONCURRENT_CREATES=8, MAX_CREATE_QUEUE=64, ENSURE_TUNNEL_TIMEOUT_MS=
// 45000) the back of a full queue could wait ~45s x (64/8) ~= 6 minutes for a
// guaranteed failure.
//
// These drive `_createGated` directly rather than going through
// `ensureTunnel`, so each caller's deadline can be set independently -- via
// ensureTunnel every caller derives the SAME deadline from config, which makes
// "the holder is still working while the waiter's deadline expires" impossible
// to express without racing the two expiries against each other.

test('F1: a caller queued behind a full gate gives up at its deadline instead of waiting for a slot', async (t) => {
  const { factory, state } = makeGatedFactory()
  const manager = new TunnelManager(
    baseConfig({ MAX_CONCURRENT_CREATES: 1, MAX_CREATE_QUEUE: 10 }),
    undefined,
    factory
  )
  t.after(async () => {
    state.openGate()
    await manager.shutdown().catch(() => {})
    await state.closeAll()
  })

  // Occupy the single slot with a create that will not finish on its own.
  const holder = manager._createGated(parseKey(keyFor(0)), Date.now() + 60000)
  holder.catch(() => {})
  await settle()
  assert.equal(manager.stats().createsActive, 1, 'the holder must be occupying the only slot')

  // Queue a second caller whose own deadline is very close.
  const startedAt = Date.now()
  const queued = manager._createGated(parseKey(keyFor(1)), Date.now() + 200)
  await settle(80)
  assert.equal(manager.stats().createsQueued, 1, 'the second caller must actually be queued, not running')

  await assert.rejects(
    queued,
    (err) => err instanceof CapacityError,
    'a caller that times out in the queue must surface CapacityError (503), not a ConnectError (502) -- we never reached the backend'
  )

  const waitedMs = Date.now() - startedAt
  assert.ok(
    waitedMs < 2000,
    `the queued caller must give up at its own deadline (~200ms), not wait for the slot; waited ${waitedMs}ms`
  )
  assert.equal(manager.stats().createQueueTimeouts, 1, 'the timeout must be counted')
  assert.equal(
    manager.stats().createQueueRejected,
    0,
    'a queue TIMEOUT is a distinct condition from a queue-full REJECTION and must not be conflated'
  )
  assert.equal(manager.stats().createsQueued, 0, 'a timed-out waiter must be removed from the queue, not left in it')
})

test('F1: a timed-out waiter must not consume the slot when it is finally released', async (t) => {
  // The failure this guards: release() hands the slot straight to the next
  // waiter without decrementing `active`. If it handed it to a waiter that had
  // already given up, that waiter's settle() would be a no-op and the slot
  // would vanish while `active` still counted it -- shrinking the effective
  // gate by one on every timeout until no create could ever run again.
  const { factory, state } = makeGatedFactory()
  const manager = new TunnelManager(
    baseConfig({ MAX_CONCURRENT_CREATES: 1, MAX_CREATE_QUEUE: 10 }),
    undefined,
    factory
  )
  t.after(async () => {
    state.openGate()
    await manager.shutdown().catch(() => {})
    await state.closeAll()
  })

  const holder = manager._createGated(parseKey(keyFor(2)), Date.now() + 60000)
  holder.catch(() => {})
  await settle()

  const doomed = manager._createGated(parseKey(keyFor(3)), Date.now() + 150)
  await assert.rejects(doomed, (err) => err instanceof CapacityError)

  // Let the holder finish and release its slot.
  state.openGate()
  await holder.catch(() => {})
  await settle()

  assert.equal(manager.stats().createsActive, 0, 'the gate must be fully free again -- no slot may have been lost to the timed-out waiter')

  // Prove it by actually using the gate again.
  const after = await manager._createGated(parseKey(keyFor(4)), Date.now() + 60000)
  assert.ok(after && after.port, 'a fresh create must still be admitted after a queue timeout')
})

test('F1: a config predating ENSURE_TUNNEL_TIMEOUT_MS still queues normally, with no spurious timeout', async (t) => {
  // The backward-compat risk this closes. Several hand-rolled test configs
  // predate ENSURE_TUNNEL_TIMEOUT_MS entirely; ensureTunnel falls back to
  // DEFAULT_ENSURE_TUNNEL_TIMEOUT_MS (45s) for them. A queued create under
  // such a config must keep WAITING for its slot, exactly as before -- the
  // deadline-aware acquire() must not read a missing knob as "already
  // expired" and start rejecting every queued create on sight.
  //
  // Note this goes through ensureTunnel, not _createGated: the fallback lives
  // there, and passing a non-finite deadline into _createGated directly is not
  // a reachable production state (it would also make the per-attempt connect
  // timeout NaN, which fires immediately).
  const cfg = baseConfig({ MAX_CONCURRENT_CREATES: 1, MAX_CREATE_QUEUE: 10 })
  delete cfg.ENSURE_TUNNEL_TIMEOUT_MS

  const { factory, state } = makeGatedFactory()
  const manager = new TunnelManager(cfg, undefined, factory)
  t.after(async () => {
    state.openGate()
    await manager.shutdown().catch(() => {})
    await state.closeAll()
  })

  const holder = manager.ensureTunnel(keyFor(5))
  holder.catch(() => {})
  await settle()
  assert.equal(manager.stats().createsActive, 1)

  let settledEarly = false
  const queued = manager.ensureTunnel(keyFor(6))
  queued.then(() => { settledEarly = true }, () => { settledEarly = true })

  await settle(250)
  assert.equal(settledEarly, false, 'a queued create must keep waiting under the fallback deadline, not give up')
  assert.equal(manager.stats().createsQueued, 1)
  assert.equal(manager.stats().createQueueTimeouts, 0, 'nothing may be counted as a queue timeout here')

  // Both must then complete normally once the gate opens.
  state.openGate()
  const results = await Promise.allSettled([holder, queued])
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'fulfilled'],
    'both creates must succeed once a slot frees'
  )
})
