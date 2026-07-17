'use strict'

// Run as a real, standalone Node process (NOT under node:test) -- see
// port-guard-toctou.js's top comment for why.
//
// Proves the shared 'uncaughtException' guard installed by
// src/tunnel-manager.js (onUncaughtPortGuard) is NOT a blanket swallow: a
// genuine, unrelated bug thrown during a connect attempt (anything that
// isn't `{ code: 'EADDRINUSE', port: <a currently pending port> }`) must
// still crash the process, exactly as it would with no guard installed at
// all. If this test's subprocess exits 0, the guard has regressed into
// hiding real bugs.

const path = require('node:path')

const { TunnelManager } = require(path.join(__dirname, '..', '..', '..', 'src', 'tunnel-manager.js'))

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

class BuggyClient {
  async connect(_options, _callback) {
    // Simulate a real, unrelated bug thrown asynchronously during connect --
    // NOT an EADDRINUSE, so pendingPorts.has(err.port) will be false and the
    // guard must re-throw it instead of swallowing it.
    setImmediate(() => {
      throw new TypeError('boom: totally unrelated bug, not a port collision')
    })
  }

  async destroy() {}
}

async function main() {
  const config = {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN: 20150,
    TUNNEL_PORT_MAX: 20155,
    IDLE_TTL_MS: 1e9,
    CONNECT_TIMEOUT_MS: 2000,
  }

  const manager = new TunnelManager(config, undefined, () => new BuggyClient())

  // This call should never resolve or "cleanly" reject -- the process
  // should crash out from under it via the unhandled TypeError.
  await manager.ensureTunnel(KEY_A)

  // If we get here, the bug was incorrectly swallowed.
  console.log('FAIL: process did not crash on an unrelated bug')
  process.exit(1)
}

main().catch(() => {
  // A normal promise rejection here would ALSO mean the guard mishandled
  // this -- the unrelated error is supposed to escape as an uncaught
  // exception, not settle this promise.
  console.log('FAIL: unrelated bug was turned into a promise rejection instead of a crash')
  process.exit(1)
})
