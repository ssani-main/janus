'use strict'

// Run as a real, standalone Node process (NOT under node:test) -- see
// port-guard-toctou.js's top comment for why: an uncaughtException that
// escapes must be observable as a nonzero process exit, which the test
// runner would otherwise intercept.
//
// Proves the port-quarantine half of the late-bind fix in
// src/tunnel-manager.js. Sequence reproduced here:
//
//   1. A cold create acquires pool port P and calls connect().
//   2. connect() never calls back, so connectWithPortGuard times out and
//      removes P from `pendingPorts`. The attempt is abandoned; the request
//      it belonged to was answered (502) long ago.
//   3. holesail-client's internal net.Server -- still alive, because our
//      timeout does not reach into it -- finally calls listen(P), which
//      fails EADDRINUSE with no 'error' listener attached anywhere in its
//      chain.
//
// Before the fix, step 3's error reached onUncaughtPortGuard with no
// `pendingPorts` entry to claim it, so it was classified as a genuine
// unhandled bug and killed the gateway. Now P is quarantined for
// PORT_QUARANTINE_MS and the late error is absorbed instead.
//
// If this subprocess exits nonzero, the quarantine has regressed and a
// timed-out DHT connect can crash the whole gateway again -- which matters
// most exactly when connects are already timing out en masse (filtered
// outbound UDP, see DEPLOY.md).

const net = require('node:net')
const path = require('node:path')

const { TunnelManager } = require(path.join(__dirname, '..', '..', '..', 'src', 'tunnel-manager.js'))

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

// Port range 21070-21075 -- see test/unit/fixtures/port-ranges.js for the
// full cross-file allocation map (test files run in parallel, so ranges
// must stay disjoint).
// Named exactly TUNNEL_PORT_MIN/TUNNEL_PORT_MAX with literal values on
// purpose: port-ranges.test.js greps this file's source for that pattern to
// verify the registry hasn't drifted.
const TUNNEL_PORT_MIN = 21070
const TUNNEL_PORT_MAX = 21075

// The port the abandoned attempt was given, captured so the fixture can
// stage the late collision on exactly that port.
let attemptedPort = null

class NeverCallsBackClient {
  async connect(options, _callback) {
    attemptedPort = options.port
    // Never invoke the callback and never reject: this is the real
    // holesail-client failure shape our CONNECT_TIMEOUT_MS exists for. The
    // internal server is still notionally on its way to listen().
    return new Promise(() => {})
  }

  async destroy() {}
}

async function main() {
  const config = {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN,
    TUNNEL_PORT_MAX,
    CONNECT_TIMEOUT_MS: 200,
    ENSURE_TUNNEL_TIMEOUT_MS: 2000,
    IDLE_TTL_MS: 900000,
    MAX_PORT_ATTEMPTS: 1,
    RECONNECT_MAX_ATTEMPTS: 0,
    WS_MAX_SLOTS: 2,
    // The knob under test. Must outlast the staged late bind below.
    PORT_QUARANTINE_MS: 10000,
  }

  const manager = new TunnelManager(config, undefined, () => new NeverCallsBackClient())

  // Step 1-2: the create times out and abandons its port.
  let failed = false
  try {
    await manager.ensureTunnel(KEY_A)
  } catch {
    failed = true
  }
  if (!failed) {
    console.log('FAIL: expected the cold create to fail with a connect timeout')
    process.exit(2)
  }
  if (attemptedPort === null) {
    console.log('FAIL: client.connect was never called, so nothing was quarantined')
    process.exit(2)
  }
  if (manager.stats().portsInQuarantine !== 1) {
    console.log(`FAIL: expected exactly 1 quarantined port, got ${manager.stats().portsInQuarantine}`)
    process.exit(2)
  }

  // Step 3: stage the late bind on the abandoned port. Occupy it first, then
  // listen() on it with NO 'error' listener -- byte for byte the shape
  // holesail-client's createTcpProxy() produces, which is what escalates to
  // uncaughtException.
  const blocker = net.createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(attemptedPort, '127.0.0.1', () => {
      blocker.removeListener('error', reject)
      resolve()
    })
  })

  const lateServer = net.createServer()
  lateServer.listen(attemptedPort, '127.0.0.1') // no 'error' listener, on purpose

  // Give the EADDRINUSE time to fire and be absorbed. If the guard mishandles
  // it, the process dies here and the parent sees a nonzero exit.
  await new Promise((resolve) => setTimeout(resolve, 500))

  const stats = manager.stats()
  if (stats.lateBindsAbsorbed !== 1) {
    console.log(`FAIL: expected 1 absorbed late bind, got ${stats.lateBindsAbsorbed}`)
    process.exit(2)
  }

  try { lateServer.close() } catch {}
  await new Promise((resolve) => blocker.close(resolve))
  await manager.shutdown()

  console.log('PASS: late EADDRINUSE on a quarantined port was absorbed, process survived')
  process.exit(0)
}

main().catch((err) => {
  console.log(`FAIL: unexpected error: ${err && err.stack}`)
  process.exit(3)
})
