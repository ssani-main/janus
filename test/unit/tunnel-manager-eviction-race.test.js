'use strict'

// Covers the _pickEvictable guard that keeps a freshly-created but
// NOT-YET-CLAIMED tunnel from being evicted out from under the caller who
// asked for it.
//
// The window: `_attemptPortConnect` publishes a brand-new record into
// `this.tunnels` with `inFlight: 0`, and the caller only increments
// `inFlight` after `ensureTunnel`'s `await p` resumes. In between, the record
// looks perfectly idle to `_pickEvictable`. At MAX_TUNNELS with every OTHER
// tunnel busy, it is the ONLY evictable candidate -- so a concurrent cold
// create for a different key would destroy it, and the original caller would
// then proxy through an already-destroyed client and 502.
//
// The fix skips records whose keyHash is still in `this.pending`, which
// exactly covers the unclaimed window: `this.pending` is deleted in
// `ensureTunnel`'s `finally` and the claiming `inFlight++` runs in the same
// synchronous continuation, so nothing can interleave between the two.
//
// Uses the same clientFactory injection harness as the other tunnel-manager
// suites -- no real DHT/HolesailClient anywhere here.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { TunnelManager, CapacityError } = require('../../src/tunnel-manager')
const { parseKey } = require('../../src/key')

const KEY_A = 'oz6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qi'
const KEY_B = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'
const KEY_C = 'ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1u'

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve()
    server.close(() => resolve())
  })
}

/** Always-succeeds fake client (same shape as the circuit/health suites). */
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

// Port range 20970-20980 -- see test/unit/fixtures/port-ranges.js for the
// full cross-file allocation map (test files run in parallel, so ranges must
// stay disjoint).
function baseConfig(overrides) {
  return Object.assign(
    {
      MAX_TUNNELS: 2,
      TUNNEL_PORT_MIN: 20970,
      TUNNEL_PORT_MAX: 20980,
      IDLE_TTL_MS: 1e9,
      CONNECT_TIMEOUT_MS: 2000,
    },
    overrides
  )
}

test('_pickEvictable: skips an idle record whose cold create is still pending (unclaimed)', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const record = await manager.ensureTunnel(KEY_A)
  manager.release(record) // inFlight back to 0 -- normally evictable
  assert.equal(manager._pickEvictable(), record, 'sanity: an idle, claimed record IS evictable')

  // Simulate the unclaimed window: the record is published in `this.tunnels`
  // but its keyHash is still registered in `this.pending`.
  manager.pending.set(record.keyHash, Promise.resolve(record))
  assert.equal(manager._pickEvictable(), null, 'a still-pending record must never be chosen as a victim')

  manager.pending.delete(record.keyHash)
  assert.equal(manager._pickEvictable(), record, 'and it becomes evictable again once claimed')

  await manager.destroyTunnel(record.keyHash)
})

test('at capacity, a concurrent cold create must not evict another key\'s freshly-created, unclaimed tunnel', async () => {
  const manager = new TunnelManager(baseConfig(), undefined, () => new FakeHolesailClient())
  const keyHashB = parseKey(KEY_B).keyHash

  // Widen the unclaimed window deterministically: hold B's cold create open
  // AFTER _attemptPortConnect has published its record into `this.tunnels`
  // but BEFORE ensureTunnel resumes to claim it. This is the exact interval
  // the fix protects -- it is otherwise only a microtask wide.
  let openGate
  const gate = new Promise((resolve) => {
    openGate = resolve
  })
  const originalAttempt = manager._attemptPortConnect.bind(manager)
  manager._attemptPortConnect = async (parsed, deadlineAt) => {
    const created = await originalAttempt(parsed, deadlineAt)
    if (parsed.keyHash === keyHashB) await gate
    return created
  }

  // Tunnel A: claimed and BUSY (never released), so it can never be a victim.
  const recordA = await manager.ensureTunnel(KEY_A)

  // Tunnel B: in flight, parked inside the widened unclaimed window. Now
  // tunnels.size === MAX_TUNNELS (2), so the next cold create must evict.
  const pendingB = manager.ensureTunnel(KEY_B)
  while (!manager.tunnels.has(keyHashB)) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  const recordB = manager.tunnels.get(keyHashB)
  assert.equal(recordB.inFlight, 0, 'B is published but not yet claimed -- the vulnerable state')
  assert.equal(manager.pending.has(keyHashB), true)

  try {
    // Tunnel C: at capacity with A busy and B unclaimed, there is NO safe
    // victim, so this must fail cleanly rather than sacrifice B.
    await assert.rejects(() => manager.ensureTunnel(KEY_C), CapacityError)
    assert.equal(manager.tunnels.has(keyHashB), true, 'B must have survived the concurrent cold create')
  } finally {
    // Always release the gate, even on assertion failure -- otherwise
    // `pendingB` never settles and the whole test file hangs instead of
    // reporting the failure.
    openGate()
  }

  // Confirm B's caller got a live, usable record.
  const claimedB = await pendingB
  assert.equal(claimedB, recordB, 'the caller receives the same record it was promised')
  assert.equal(claimedB.inFlight, 1, 'and it is now claimed')
  assert.equal(manager.counters.evicted, 0, 'nothing should have been evicted at all')

  manager.release(claimedB)
  manager.release(recordA)
  await manager.shutdown()
})
