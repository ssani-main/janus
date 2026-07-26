'use strict'

// Run as a real, standalone Node process (NOT under node:test).
//
// The NEGATIVE CONTROL for port-guard-late-bind-absorbed.js. Absorbing a late
// EADDRINUSE is only safe because it is scoped to ports we KNOW we abandoned
// inside their quarantine window. If that scoping ever widened to "any
// EADDRINUSE", the guard would start silently swallowing genuine bind bugs --
// a service quietly failing to listen is far worse than one that crashes
// loudly and gets restarted.
//
// So: an EADDRINUSE on a port that is neither pending NOR quarantined must
// still crash the process, exactly as it would with no guard installed.
// If this subprocess exits 0, the absorption has over-widened.

const net = require('node:net')
const path = require('node:path')

// Requiring the module is what installs the process-wide
// 'uncaughtException' guard (onUncaughtPortGuard). No TunnelManager instance
// is needed -- and deliberately none is created, so nothing can be pending or
// quarantined.
require(path.join(__dirname, '..', '..', '..', 'src', 'tunnel-manager.js'))

// Port range 21080-21085 -- see test/unit/fixtures/port-ranges.js. Named
// exactly TUNNEL_PORT_MIN/TUNNEL_PORT_MAX with literal values on purpose:
// port-ranges.test.js greps this file's source for that pattern to verify the
// registry hasn't drifted.
const TUNNEL_PORT_MIN = 21080
const TUNNEL_PORT_MAX = 21085
const PORT = TUNNEL_PORT_MIN

async function main() {
  const blocker = net.createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(PORT, '127.0.0.1', () => {
      blocker.removeListener('error', reject)
      resolve()
    })
  })

  // No 'error' listener: this escalates to uncaughtException, and the guard
  // must re-throw it because PORT is neither pending nor quarantined.
  const colliding = net.createServer()
  colliding.listen(PORT, '127.0.0.1')

  await new Promise((resolve) => setTimeout(resolve, 500))

  // Reaching here means the error was swallowed -- the regression this
  // fixture exists to catch.
  console.log('FAIL: EADDRINUSE on an unquarantined port was swallowed instead of crashing')
  process.exit(0)
}

main().catch((err) => {
  console.log(`unexpected error: ${err && err.stack}`)
  process.exit(3)
})
