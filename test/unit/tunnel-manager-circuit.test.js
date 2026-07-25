'use strict'

// Milestone 2c: covers the manager-level circuit breaker (`this.circuits`,
// `recordFailure`/`recordSuccess`, the ensureTunnel fast-fail check), the
// reconnect-with-backoff loop in `_createTunnel`, the exported
// `reconnectDelayMs` backoff/jitter helper, and the connectWithPortGuard
// async-rejection fix. Uses the same clientFactory injection harness as
// test/unit/tunnel-manager-port-retry.test.js / tunnel-manager-counters.test.js
// -- none of this touches a real DHT/HolesailClient.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { TunnelManager, ConnectError, CircuitOpenError, reconnectDelayMs } = require('../../src/tunnel-manager')
const { parseKey } = require('../../src/key')

const KEY_A = 'oz6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qi'

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
  })
}

/** Always-succeeds fake client (same shape as tunnel-manager-counters.test.js). */
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

// Port ranges 20500-20520, 20550-20560, 20570-20580, 20585-20589,
// 20590-20595 -- see
// test/unit/fixtures/port-ranges.js for the full cross-file allocation map
// (test files run in parallel, so ranges must stay disjoint).
function baseConfig(overrides) {
  return Object.assign(
    {
      MAX_TUNNELS: 5,
      TUNNEL_PORT_MIN: 20500,
      TUNNEL_PORT_MAX: 20520,
      IDLE_TTL_MS: 1e9,
      CONNECT_TIMEOUT_MS: 2000,
      CIRCUIT_FAILURE_THRESHOLD: 3,
      CIRCUIT_COOLDOWN_MS: 1000,
      RECONNECT_MAX_ATTEMPTS: 0,
      RECONNECT_BASE_DELAY_MS: 10,
      RECONNECT_MAX_DELAY_MS: 50,
    },
    overrides
  )
}

// --- reconnectDelayMs: pure backoff/jitter helper --------------------------

test('reconnectDelayMs: the delay floor grows exponentially with attempt and caps at maxDelayMs/2', () => {
  const base = 100
  const max = 1000
  const originalRandom = Math.random
  Math.random = () => 0 // pin jitter to the floor so growth is deterministic
  try {
    const d0 = reconnectDelayMs(0, base, max) // min(100,1000)=100 -> floor 50
    const d1 = reconnectDelayMs(1, base, max) // min(200,1000)=200 -> floor 100
    const d2 = reconnectDelayMs(2, base, max) // min(400,1000)=400 -> floor 200
    const d5 = reconnectDelayMs(5, base, max) // min(3200,1000)=1000 (capped) -> floor 500
    assert.ok(d0 < d1, 'delay should grow from attempt 0 to 1')
    assert.ok(d1 < d2, 'delay should grow from attempt 1 to 2')
    assert.equal(d5, max / 2, 'once the exponent exceeds maxDelayMs, the floor must equal maxDelayMs/2')
  } finally {
    Math.random = originalRandom
  }
})

test('reconnectDelayMs: applies jitter -- a higher Math.random draw yields a longer delay, bounded to [cap/2, cap]', () => {
  const base = 1000
  const max = 10000
  const originalRandom = Math.random
  try {
    Math.random = () => 0
    const low = reconnectDelayMs(0, base, max)
    Math.random = () => 1
    const high = reconnectDelayMs(0, base, max)
    assert.equal(low, 500, 'Math.random()=0 should give exactly cap/2')
    assert.equal(high, 1000, 'Math.random()=1 should give exactly cap')
    assert.ok(high > low, 'jitter must actually vary the delay')
  } finally {
    Math.random = originalRandom
  }
})

// --- circuit breaker state machine -----------------------------------------

test('circuit breaker: opens once failures reach CIRCUIT_FAILURE_THRESHOLD', () => {
  const manager = new TunnelManager(baseConfig())
  const { keyHash } = parseKey(KEY_A)

  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  assert.equal(manager.stats().circuitsOpen, 0, 'circuit must not open before the threshold is reached')
  assert.equal(manager.stats().circuitOpens, 0)

  manager.recordFailure(keyHash) // 3rd failure -- hits CIRCUIT_FAILURE_THRESHOLD (3)
  assert.equal(manager.stats().circuitsOpen, 1)
  assert.equal(manager.stats().circuitOpens, 1)
})

test('circuit breaker: ensureTunnel fast-fails with CircuitOpenError while open, without ever calling clientFactory', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => {
    throw new Error('clientFactory must not be called while the circuit is open')
  })
  const { keyHash } = parseKey(KEY_A)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)

  await assert.rejects(() => manager.ensureTunnel(KEY_A), CircuitOpenError)
})

test('circuit breaker: CircuitOpenError carries circuitOpenUntil for an honest Retry-After', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const { keyHash } = parseKey(KEY_A)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)

  await assert.rejects(() => manager.ensureTunnel(KEY_A), (err) => {
    assert.ok(err instanceof CircuitOpenError)
    assert.ok(err.circuitOpenUntil > Date.now())
    return true
  })
})

test('circuit breaker: closes again after the cooldown elapses', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const { keyHash } = parseKey(KEY_A)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  await assert.rejects(() => manager.ensureTunnel(KEY_A), CircuitOpenError)

  // Backdate the open circuit's expiry instead of waiting real wall-clock
  // time -- simulates the cooldown having elapsed.
  manager.circuits.get(keyHash).circuitOpenUntil = Date.now() - 1

  const record = await manager.ensureTunnel(KEY_A)
  assert.ok(record)
  await manager.destroyTunnel(keyHash)
})

test('circuit breaker: recordSuccess resets failures and clears an open circuit', () => {
  const manager = new TunnelManager(baseConfig())
  const { keyHash } = parseKey(KEY_A)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  assert.ok(manager.circuits.has(keyHash))

  manager.recordSuccess(keyHash)
  assert.equal(manager.circuits.has(keyHash), false)
})

test('circuit breaker: a cached, healthy tunnel is NEVER fast-failed by a stale/open circuit', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)
  const { keyHash } = parseKey(KEY_A)

  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  assert.ok(manager.circuits.get(keyHash).circuitOpenUntil > Date.now(), 'circuit should be open')

  const record2 = await manager.ensureTunnel(KEY_A)
  assert.equal(record2, record, 'a cache hit must bypass the circuit check entirely')
  manager.release(record2)
  await manager.destroyTunnel(keyHash)
})

test('circuit breaker sweeper: drops circuit entries that are closed and have been quiet past CIRCUIT_COOLDOWN_MS', async (t) => {
  const manager = new TunnelManager(baseConfig({ CIRCUIT_COOLDOWN_MS: 1000 }))
  const { keyHash } = parseKey(KEY_A)
  manager.recordFailure(keyHash) // below threshold -- circuit never opens
  manager.circuits.get(keyHash).lastFailureAt = Date.now() - 5000 // long quiet

  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    manager.startSweeper()
    t.mock.timers.tick(60000) // fires the 60s sweep interval once
    assert.equal(manager.circuits.has(keyHash), false)
  } finally {
    manager.stopSweeper()
  }
})

test('circuit breaker sweeper: keeps an entry that is currently open, even past its own cooldown expiry', async (t) => {
  const manager = new TunnelManager(baseConfig({ CIRCUIT_COOLDOWN_MS: 1000 }))
  const { keyHash } = parseKey(KEY_A)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash)
  manager.recordFailure(keyHash) // opens the circuit

  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    manager.startSweeper()
    t.mock.timers.tick(60000)
    // Still open (circuitOpenUntil is ~1000ms in the future relative to
    // when recordFailure ran), so the sweeper must not have dropped it.
    assert.ok(manager.circuits.has(keyHash))
  } finally {
    manager.stopSweeper()
  }
})

// --- reconnect-with-backoff loop --------------------------------------------

test('reconnect: retries with backoff and eventually succeeds, sharing one chain across concurrent callers (pending dedupe)', async (t) => {
  const config = baseConfig({
    TUNNEL_PORT_MIN: 20550,
    TUNNEL_PORT_MAX: 20560,
    RECONNECT_MAX_ATTEMPTS: 3,
    RECONNECT_BASE_DELAY_MS: 10,
    RECONNECT_MAX_DELAY_MS: 100,
    CIRCUIT_FAILURE_THRESHOLD: 10, // keep the circuit closed through these failures
  })

  let calls = 0
  const factory = () => {
    calls++
    const failThisCall = calls <= 2 // first two attempts fail, third succeeds
    return {
      _server: null,
      async connect(options, callback) {
        if (failThisCall) {
          callback() // reports "connected" but never binds -> liveness probe fails
        } else {
          const server = net.createServer()
          this._server = server
          server.listen(options.port, options.host, () => callback())
        }
      },
      async destroy() {
        await closeServer(this._server)
      },
    }
  }

  const manager = new TunnelManager(config, undefined, factory)

  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const p1 = manager.ensureTunnel(KEY_A)
    const p2 = manager.ensureTunnel(KEY_A) // concurrent cold-create for the same key

    // Repeatedly flush real microtasks/IO (setImmediate is NOT mocked) and
    // fire whatever backoff timer is currently pending, until the chain
    // resolves.
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setImmediate(resolve))
      t.mock.timers.tick(100000)
    }

    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(r1, r2, 'concurrent callers for the same key must share the single reconnect chain')
    assert.equal(calls, 3, 'factory should be called exactly once per attempt (2 failures + 1 success)')
    assert.equal(manager.stats().reconnectAttempts, 2)
    assert.equal(manager.stats().reconnectSuccesses, 1)

    await manager.destroyTunnel(r1.keyHash)
  } finally {
    manager.stopSweeper()
  }
})

/** Always "connects" but never binds -> the liveness probe always fails. */
class AlwaysFailingClient {
  async connect(_options, callback) {
    callback()
  }
  async destroy() {}
}

/**
 * Drive one ensureTunnel() call all the way to rejection under mocked
 * setTimeout, flushing real microtasks/IO between ticks so the reconnect
 * backoff chain can make progress.
 *
 * The rejection assertion is attached BEFORE the flush loop deliberately --
 * otherwise the promise can reject during the loop with nothing awaiting it,
 * which node:test's runner reports as an unhandled rejection and fails the
 * test even though we do handle it a moment later.
 */
async function driveToRejection(t, manager, key, errType) {
  const p = manager.ensureTunnel(key)
  const assertion = assert.rejects(() => p, errType)
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    t.mock.timers.tick(100000)
  }
  await assertion
}

test('reconnect: exhausting RECONNECT_MAX_ATTEMPTS surfaces ConnectError but records exactly ONE circuit failure', async (t) => {
  const config = baseConfig({
    TUNNEL_PORT_MIN: 20570,
    TUNNEL_PORT_MAX: 20580,
    RECONNECT_MAX_ATTEMPTS: 2,
    RECONNECT_BASE_DELAY_MS: 5,
    RECONNECT_MAX_DELAY_MS: 20,
    CIRCUIT_FAILURE_THRESHOLD: 3,
  })

  const manager = new TunnelManager(config, undefined, () => new AlwaysFailingClient())
  const { keyHash } = parseKey(KEY_A)

  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await driveToRejection(t, manager, KEY_A, ConnectError)

    const stats = manager.stats()
    assert.equal(stats.reconnectAttempts, 2, 'the reconnect loop should still have retried twice')
    assert.equal(stats.reconnectSuccesses, 0)
    // The whole point of the fix: 3 connect ATTEMPTS (1 initial + 2
    // reconnects) inside a single cold create is still only ONE failed
    // request as far as the breaker is concerned. Counting per-attempt used
    // to open the circuit here, silently coupling CIRCUIT_FAILURE_THRESHOLD
    // to RECONNECT_MAX_ATTEMPTS.
    assert.equal(manager.circuits.get(keyHash).failures, 1, 'one cold create must record exactly one failure')
    assert.equal(stats.circuitsOpen, 0, 'a single failed request must not reach a threshold of 3')
    assert.equal(stats.circuitOpens, 0)
  } finally {
    manager.stopSweeper()
  }
})

test('reconnect: CIRCUIT_FAILURE_THRESHOLD counts failed REQUESTS -- three of them open the circuit', async (t) => {
  const config = baseConfig({
    TUNNEL_PORT_MIN: 20585,
    TUNNEL_PORT_MAX: 20589,
    RECONNECT_MAX_ATTEMPTS: 2,
    RECONNECT_BASE_DELAY_MS: 5,
    RECONNECT_MAX_DELAY_MS: 20,
    CIRCUIT_FAILURE_THRESHOLD: 3,
  })

  const manager = new TunnelManager(config, undefined, () => new AlwaysFailingClient())
  const { keyHash } = parseKey(KEY_A)

  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await driveToRejection(t, manager, KEY_A, ConnectError)
    assert.equal(manager.stats().circuitsOpen, 0, 'after 1 failed request')

    await driveToRejection(t, manager, KEY_A, ConnectError)
    assert.equal(manager.stats().circuitsOpen, 0, 'after 2 failed requests')

    await driveToRejection(t, manager, KEY_A, ConnectError)
    assert.equal(manager.circuits.get(keyHash).failures, 3)
    assert.equal(manager.stats().circuitsOpen, 1, 'the 3rd failed request hits the threshold')
    assert.equal(manager.stats().circuitOpens, 1)

    // And now the breaker actually does its job: no further connect attempt.
    await assert.rejects(() => manager.ensureTunnel(KEY_A), CircuitOpenError)
  } finally {
    manager.stopSweeper()
  }
})

// --- connectWithPortGuard async-rejection fix -------------------------------

test('connectWithPortGuard: an async rejection from client.connect() is wrapped as ConnectError, not an unhandled rejection', async () => {
  let unhandled = null
  const onUnhandled = (err) => {
    unhandled = err
  }
  process.on('unhandledRejection', onUnhandled)

  class AsyncRejectingClient {
    async connect(_options, _callback) {
      await Promise.resolve() // force a genuinely async rejection, not a sync throw
      throw new Error('async connect failure')
    }
    async destroy() {}
  }

  const manager = new TunnelManager(
    baseConfig({ TUNNEL_PORT_MIN: 20590, TUNNEL_PORT_MAX: 20595 }),
    undefined,
    () => new AsyncRejectingClient()
  )

  try {
    await assert.rejects(() => manager.ensureTunnel(KEY_A), ConnectError)
    // Give any stray unhandled rejection a chance to surface before asserting.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(unhandled, null, 'the async rejection must be caught and wrapped, not surfaced as unhandledRejection')
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})
