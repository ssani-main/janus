'use strict'

// Milestone 2d: covers the periodic health probe in src/tunnel-manager.js
// (startHealthProbing/stopHealthProbing, _probeTunnels/_probeOne, and the
// HEALTH_PROBE_UNHEALTHY_STREAK gate). Also covers the BUG 1/BUG 2 fixes:
// probes deliberately do NOT feed the circuit breaker in either direction,
// and a probe-failure streak destroys the dead tunnel outright (instead of
// pinning it forever with `healthy: false` and no eviction path) so the next
// request's cold-create is what legitimately decides -- via the existing
// circuit breaker -- whether the backend is really down. Uses the same
// clientFactory injection harness as test/unit/tunnel-manager-circuit.test.js
// / tunnel-manager-counters.test.js -- no real DHT/HolesailClient anywhere
// here.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { TunnelManager } = require('../../src/tunnel-manager')

const KEY_A = 'oz6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qi'

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
  })
}

/** Always-succeeds fake client (same shape as the counters/circuit tests). */
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

// Port range 20700-20720 -- see test/unit/fixtures/port-ranges.js for the
// full cross-file allocation map (test files run in parallel, so ranges
// must stay disjoint).
function baseConfig(overrides) {
  return Object.assign(
    {
      MAX_TUNNELS: 5,
      TUNNEL_PORT_MIN: 20700,
      TUNNEL_PORT_MAX: 20720,
      IDLE_TTL_MS: 1e9,
      CONNECT_TIMEOUT_MS: 2000,
      HEALTH_PROBE_INTERVAL_MS: 1000,
      HEALTH_PROBE_TIMEOUT_MS: 100,
      CIRCUIT_FAILURE_THRESHOLD: 10, // keep the circuit closed through these tests
      CIRCUIT_COOLDOWN_MS: 1000,
    },
    overrides
  )
}

test('health probe: a single failed probe does not flip healthy -> false, but two consecutive failures do', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)
  assert.equal(record.healthy, true)

  // Kill the backing listener so subsequent probes fail (ECONNREFUSED).
  await closeServer(record.client._server)

  await manager._probeTunnels()
  assert.equal(record.healthy, true, 'a single failed probe must not flip healthy -> false')
  assert.ok(record.lastProbeAt, 'lastProbeAt must be stamped even on a failed probe')

  await manager._probeTunnels()
  assert.equal(record.healthy, false, 'two consecutive failed probes must flip healthy -> false')

  await manager.destroyTunnel(record.keyHash)
})

// BUG 1 fix: a record no longer "recovers in place" once destroyed -- a
// probe-failure streak now destroys the dead tunnel outright (see
// tunnel-manager.js's _probeOne), so recovery instead happens through a
// brand-new cold-create the next time ensureTunnel is called for the same
// key. This test replaces the old "recovers in place on the same record"
// assertion, which encoded the design BUG 1's fix removes.
test('health probe recovery (BUG 1 acceptance): a dead backend is destroyed, then the NEXT request cold-creates a fresh tunnel automatically -- no operator action', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)

  // Backend dies.
  await closeServer(record.client._server)
  await manager._probeTunnels() // streak 1 -- still cached, not yet unhealthy
  assert.equal(manager.tunnels.has(record.keyHash), true, 'tunnel must survive a single failed probe')

  await manager._probeTunnels() // streak 2 -- destroyed
  assert.equal(record.healthy, false, 'healthy still flips false as an observability signal')
  assert.equal(
    manager.tunnels.has(record.keyHash),
    false,
    'a dead backend tunnel must be destroyed after the probe failure streak, not pinned forever'
  )

  // Backend "recovers" (a fresh ensureTunnel call is exactly what a new
  // visitor request triggers) -- this must succeed with NO operator action,
  // via the normal cold-create path (a brand-new record/port), not by
  // reviving the destroyed one.
  const record2 = await manager.ensureTunnel(KEY_A)
  assert.notEqual(record2, record, 'recovery must produce a brand-new tunnel record, not the destroyed one')
  assert.equal(record2.healthy, true)
  manager.release(record2)

  await manager.destroyTunnel(record2.keyHash)
})

// BUG 1 fix, the exact pinning scenario from the review: constant traffic
// (each request bumps lastRequestAt) must NOT prevent a dead tunnel from
// being torn down -- an idle-TTL sweeper keyed only on lastRequestAt would
// never fire here, which is precisely why the health probe must act
// independently of it.
test('health probe (BUG 1): a dead backend tunnel is destroyed even while constant traffic keeps bumping lastRequestAt', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)

  await closeServer(record.client._server)

  await manager._probeTunnels() // streak 1
  manager.touch(record.keyHash) // simulates a visitor request refreshing activity
  assert.ok(manager.tunnels.has(record.keyHash))

  await manager._probeTunnels() // streak 2 -- must destroy despite the touch() above
  assert.equal(
    manager.tunnels.has(record.keyHash),
    false,
    'a dead tunnel must be destroyed by the health probe regardless of lastRequestAt activity'
  )
})

// Guard from the review: a request can arrive between a probe starting
// (inFlight===0 check at the top of _probeOne) and its async probePort()
// settling. Re-check inFlight immediately before destroying, same as the
// idle sweeper's existing inFlight guard.
test('health probe: a record whose inFlight becomes > 0 between probe start and completion is never destroyed by the probe', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)
  await closeServer(record.client._server)

  // One more failed probe reaches HEALTH_PROBE_UNHEALTHY_STREAK (2).
  record._probeFailStreak = 1

  const probePromise = manager._probeOne(record, manager.config.HEALTH_PROBE_TIMEOUT_MS)
  // Simulate a request arriving while this probe's async probePort() is
  // still pending (before the `await` above has settled).
  record.inFlight++

  await probePromise

  assert.equal(record.healthy, false, 'healthy still flips false as an observability signal')
  assert.equal(
    manager.tunnels.has(record.keyHash),
    true,
    'a record with inFlight > 0 at destroy time must not be destroyed by the probe'
  )

  record.inFlight--
  await manager.destroyTunnel(record.keyHash)
})

test('health probe: skips a tunnel with inFlight > 0 entirely', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A) // inFlight is 1, never released here
  assert.equal(record.inFlight, 1)

  await manager._probeTunnels()
  assert.equal(record.lastProbeAt, null, 'an in-flight tunnel must never be probed')
  assert.equal(manager.stats().healthProbes, 0)

  manager.release(record)
  await manager.destroyTunnel(record.keyHash)
})

// BUG 2 fix: a probe failure must NEVER feed the circuit breaker -- a
// passing/failing loopback TCP connect to our own proxy port is too weak a
// signal to open a circuit that gates real traffic (see recordFailure's and
// _probeOne's doc comments in tunnel-manager.js). This test replaces the old
// assertion that a failed probe calls recordFailure, which encoded the
// design BUG 2's fix removes: previously, isolated non-consecutive probe
// blips over time could ratchet `circuit.failures` up with no decay
// (recordFailure never resets on success) until an unrelated cold-create
// against a perfectly healthy backend got fast-failed by a stale circuit.
test('health probe (BUG 2): probe failures NEVER touch the circuit breaker, even across a full unhealthy streak', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)
  await closeServer(record.client._server)

  assert.equal(manager.circuits.has(record.keyHash), false)
  await manager._probeTunnels() // streak 1
  assert.equal(manager.circuits.has(record.keyHash), false, 'a failed probe must never open/touch a circuit entry')
  assert.equal(manager.stats().healthProbeFailures, 1)

  await manager._probeTunnels() // streak 2 -- destroys the tunnel
  assert.equal(manager.circuits.has(record.keyHash), false, 'destroying the tunnel must not touch the circuit either')
  assert.equal(manager.stats().healthProbeFailures, 2)
})

// BUG 2's exact scenario: isolated, non-consecutive probe blips spread out
// over time (each one resets `_probeFailStreak` back to 0 via a passing
// probe in between) must never accumulate into an open circuit.
test('health probe (BUG 2): isolated, non-consecutive probe failures do not open a circuit', async () => {
  const manager = new TunnelManager(baseConfig({ CIRCUIT_FAILURE_THRESHOLD: 3 }), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)

  for (let i = 0; i < 5; i++) {
    await closeServer(record.client._server)
    await manager._probeTunnels() // one isolated failure (streak resets after)
    // Bring the backend back up on the same port so the NEXT probe passes
    // and resets _probeFailStreak back to 0 -- non-consecutive by design.
    const server = net.createServer()
    record.client._server = server
    await new Promise((resolve) => server.listen(record.port, '127.0.0.1', resolve))
    await manager._probeTunnels()
  }

  assert.equal(manager.stats().healthProbeFailures, 5)
  assert.equal(manager.circuits.has(record.keyHash), false, '5 isolated probe blips must never open a circuit')
  assert.equal(manager.stats().circuitsOpen, 0)

  await manager.destroyTunnel(record.keyHash)
})

test('health probe: a successful probe does NOT call recordSuccess (does not close an already-open circuit)', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)

  // Force the circuit open independently of the health probe.
  manager.recordFailure(record.keyHash)
  manager.recordFailure(record.keyHash)
  const threshold = manager.config.CIRCUIT_FAILURE_THRESHOLD ?? 10
  for (let i = 2; i < threshold; i++) manager.recordFailure(record.keyHash)
  assert.ok(manager.circuits.get(record.keyHash).circuitOpenUntil > Date.now(), 'circuit should be open')

  // A passing probe against the still-live tunnel must not clear it.
  await manager._probeTunnels()
  assert.ok(
    manager.circuits.has(record.keyHash) && manager.circuits.get(record.keyHash).circuitOpenUntil > Date.now(),
    'a successful health probe must not call recordSuccess / close an open circuit'
  )

  await manager.destroyTunnel(record.keyHash)
})

test('health probe: stops firing once shutdown() is called', async (t) => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record)

  let calls = 0
  const originalProbeTunnels = manager._probeTunnels.bind(manager)
  manager._probeTunnels = async () => {
    calls++
    return originalProbeTunnels()
  }

  t.mock.timers.enable({ apis: ['setInterval'] })
  try {
    manager.startHealthProbing()
    t.mock.timers.tick(1000)
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(calls, 1)

    await manager.shutdown() // must stop both the sweeper and the health probe
    t.mock.timers.tick(5000)
    await Promise.resolve()
    assert.equal(calls, 1, 'no further probes should fire once shutdown() has run')
  } finally {
    manager.stopHealthProbing()
    manager.stopSweeper()
  }
})
