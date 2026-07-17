'use strict'

// Run as a real, standalone Node process (NOT under node:test) by
// tunnel-manager-port-retry.test.js. This is necessary because node:test's
// own runner flags ANY 'uncaughtException' event that fires during a test
// as a failure for that test, regardless of whether application code (our
// connectWithPortGuard) already handled it via its own listener -- verified
// separately, this is a property of the test harness, not a bug in the fix.
// Running in a separate real process is the only way to prove the crash
// guard actually prevents the process from dying, since that's the whole
// point of the fix.
//
// Simulates a TOCTOU race: TunnelManager's probeFree() pre-check reports the
// port free, but by the time the (fake) HolesailClient actually goes to
// bind it, something else has grabbed it. Exercises connectWithPortGuard
// specifically (independent of the probeFree fast path in the other tests).

const net = require('node:net')
const path = require('node:path')

const { TunnelManager } = require(path.join(__dirname, '..', '..', '..', 'src', 'tunnel-manager.js'))

const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

class RacingHolesailClient {
  constructor(collidePorts) {
    this.collidePorts = collidePorts
    this._server = null
    this._foreign = null
  }

  async connect(options, callback) {
    if (this.collidePorts.has(options.port)) {
      const foreign = net.createServer()
      this._foreign = foreign
      foreign.listen(options.port, options.host, () => {
        const server = net.createServer() // no 'error' listener -- mirrors the real library
        this._server = server
        server.listen(options.port, options.host, () => {
          callback()
        })
      })
      return
    }
    const server = net.createServer()
    this._server = server
    server.listen(options.port, options.host, () => {
      callback()
    })
  }

  async destroy() {
    if (this._server) await new Promise((r) => this._server.close(r))
    if (this._foreign) await new Promise((r) => this._foreign.close(r))
  }
}

async function main() {
  const config = {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN: 20110,
    TUNNEL_PORT_MAX: 20115,
    IDLE_TTL_MS: 1e9,
    CONNECT_TIMEOUT_MS: 2000,
  }

  const collidePorts = new Set([20110])
  const manager = new TunnelManager(config, undefined, () => new RacingHolesailClient(collidePorts))

  const record = await manager.ensureTunnel(KEY_A)
  if (record.port !== 20111) {
    console.log(`FAIL: expected retry onto port 20111, got ${record.port}`)
    process.exit(1)
  }
  await manager.destroyTunnel(record.keyHash)
  console.log('OK')
  process.exit(0)
}

main().catch((err) => {
  console.log(`FAIL: ${err.stack}`)
  process.exit(1)
})
