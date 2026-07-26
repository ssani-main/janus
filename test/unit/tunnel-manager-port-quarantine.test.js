'use strict'

// Covers the port-quarantine fix in src/tunnel-manager.js
// (PORT_QUARANTINE_MS, quarantinedPorts, onUncaughtPortGuard's absorption
// branch).
//
// THE BUG: connectWithPortGuard drops its `pendingPorts` entry the moment its
// attempt settles -- including on TIMEOUT. But a timeout does not reach into
// holesail-client, whose internal net.Server may still be on its way to
// listen() (its server reference is only set after an internal DHT round
// trip). If that late listen() lands on a port the pool has since reissued,
// the resulting EADDRINUSE arrives with no pending attempt to claim it, so
// onUncaughtPortGuard correctly classifies it as a real unhandled bug -- and
// kills the gateway. systemd restarts it in ~2s, but every live tunnel dies.
//
// Two mitigations, both required, both exercised here:
//   1. a timed-out port is held OUT of the pool for PORT_QUARANTINE_MS, so a
//      late bind usually finds nothing to collide with (in-process tests);
//   2. a late EADDRINUSE on a still-quarantined port is absorbed rather than
//      fatal (subprocess fixture, since the failure mode is a process exit).
//
// The scoping in (2) is the risky part, so it has a negative control: an
// EADDRINUSE on a port that is neither pending nor quarantined must STILL
// crash. Swallowing those would hide genuine bind bugs.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { TunnelManager } = require('../../src/tunnel-manager')

// Must match the range registered for this file in fixtures/port-ranges.js.
const TUNNEL_PORT_MIN = 21050
const TUNNEL_PORT_MAX = 21055

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'
const KEY_B = 'ywmtcwpb3xzo8hbjr86wrhmfmkkpnyyxbcocnzjxsrsdfpztq8zo'

/** A client whose connect() never settles, forcing CONNECT_TIMEOUT_MS to fire. */
function neverCallsBackFactory(captured) {
  return () => ({
    async connect(options) {
      captured.ports.push(options.port)
      return new Promise(() => {})
    },
    async destroy() {},
  })
}

function baseConfig(overrides) {
  return {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN,
    TUNNEL_PORT_MAX,
    CONNECT_TIMEOUT_MS: 150,
    ENSURE_TUNNEL_TIMEOUT_MS: 2000,
    IDLE_TTL_MS: 900000,
    MAX_PORT_ATTEMPTS: 1,
    RECONNECT_MAX_ATTEMPTS: 0,
    WS_MAX_SLOTS: 2,
    ...overrides,
  }
}

test('a timed-out connect holds its port OUT of the pool for the quarantine window', async (t) => {
  const captured = { ports: [] }
  const manager = new TunnelManager(
    baseConfig({ PORT_QUARANTINE_MS: 60000 }),
    undefined,
    neverCallsBackFactory(captured)
  )
  t.after(async () => { await manager.shutdown() })

  await assert.rejects(() => manager.ensureTunnel(KEY_A))
  const firstPort = captured.ports[0]
  assert.ok(Number.isInteger(firstPort), 'the attempt should have acquired a pool port')

  const stats = manager.stats()
  assert.equal(stats.portsInQuarantine, 1, 'the abandoned port must be quarantined')
  assert.equal(stats.portsQuarantined, 1, 'and counted for /metrics')

  // The next create must NOT be handed the same port -- that reuse is exactly
  // what turns a late bind into a process-killing collision.
  await assert.rejects(() => manager.ensureTunnel(KEY_B))
  const secondPort = captured.ports[1]
  assert.notEqual(
    secondPort,
    firstPort,
    'a quarantined port must not be reissued while still quarantined'
  )
})

test('the quarantined port returns to the pool once the window expires', async (t) => {
  const captured = { ports: [] }
  const manager = new TunnelManager(
    // Short window so the test can observe the release without a long wait.
    baseConfig({ PORT_QUARANTINE_MS: 120 }),
    undefined,
    neverCallsBackFactory(captured)
  )
  t.after(async () => { await manager.shutdown() })

  await assert.rejects(() => manager.ensureTunnel(KEY_A))
  const firstPort = captured.ports[0]
  assert.equal(manager.stats().portsInQuarantine, 1)

  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.equal(
    manager.stats().portsInQuarantine,
    0,
    'quarantine must expire -- otherwise every timeout permanently shrinks the pool'
  )
  assert.ok(
    manager.portPool.acquire.call(manager.portPool) >= TUNNEL_PORT_MIN,
    'the pool must still hand out ports after a quarantine expires'
  )
  // The released port is back in circulation.
  manager.portPool.release(firstPort)
})

test('PORT_QUARANTINE_MS=0 disables quarantining (port returns to the pool at once)', async (t) => {
  const captured = { ports: [] }
  const manager = new TunnelManager(
    baseConfig({ PORT_QUARANTINE_MS: 0 }),
    undefined,
    neverCallsBackFactory(captured)
  )
  t.after(async () => { await manager.shutdown() })

  await assert.rejects(() => manager.ensureTunnel(KEY_A))
  assert.equal(manager.stats().portsInQuarantine, 0, 'nothing should be quarantined when disabled')
  assert.equal(manager.stats().portsQuarantined, 0)
})

test('quarantining does not apply to non-timeout failures', async (t) => {
  // A synchronous throw from connect() means no bind was ever started, so
  // nothing can arrive late and the port is safe to reuse immediately.
  // Quarantining these too would churn -- and could exhaust -- a small pool.
  const manager = new TunnelManager(
    baseConfig({ PORT_QUARANTINE_MS: 60000 }),
    undefined,
    () => ({
      async connect() { throw new Error('immediate, non-timeout failure') },
      async destroy() {},
    })
  )
  t.after(async () => { await manager.shutdown() })

  await assert.rejects(() => manager.ensureTunnel(KEY_A))
  assert.equal(
    manager.stats().portsInQuarantine,
    0,
    'only connect TIMEOUTS quarantine -- see _attemptPortConnect'
  )
})

test('a late EADDRINUSE on a quarantined port is absorbed, not fatal (subprocess)', () => {
  const fixture = path.join(__dirname, 'fixtures', 'port-guard-late-bind-absorbed.js')
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 20000 })

  assert.equal(
    result.status,
    0,
    `subprocess should survive the late bind:\n${result.stdout}\n${result.stderr}`
  )
  assert.match(result.stdout, /PASS: late EADDRINUSE on a quarantined port was absorbed/)
  assert.match(
    result.stderr,
    /absorbed late EADDRINUSE on quarantined tunnel port/,
    'the absorption must be logged loudly -- it is a real operational signal'
  )
})

test('an EADDRINUSE on an UNQUARANTINED port still crashes (absorption stays narrow)', () => {
  const fixture = path.join(__dirname, 'fixtures', 'port-guard-unquarantined-still-crashes.js')
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 20000 })

  assert.notEqual(
    result.status,
    0,
    `an unrelated bind failure must still crash, not be swallowed:\n${result.stdout}\n${result.stderr}`
  )
  assert.match(
    result.stderr,
    /EADDRINUSE/,
    `expected the EADDRINUSE to escape uncaught:\n${result.stdout}\n${result.stderr}`
  )
})
