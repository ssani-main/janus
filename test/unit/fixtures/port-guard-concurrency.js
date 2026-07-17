'use strict'

// Run as a real, standalone Node process (NOT under node:test) by
// tunnel-manager-port-retry.test.js -- see port-guard-toctou.js's top
// comment for why: node:test's own runner flags ANY 'uncaughtException'
// event that fires during a test as a failure for that test, regardless of
// whether application code already handled it. This scenario deliberately
// fires one (routed through the shared connectWithPortGuard registry in
// src/tunnel-manager.js), so it must run out-of-process.
//
// Reproduces the CONCURRENCY bug this fixture guards against: two DISTINCT
// keys cold-create tunnels at the same time. The pool hands them adjacent
// ports (20140, 20141 given the range below and TunnelManager's synchronous
// acquire-before-first-await ordering). Port 20141 loses a TOCTOU race (a
// foreign process grabs it between our probeFree() pre-check and the fake
// client's internal listen()), so its connect attempt genuinely triggers an
// uncaughtException carrying `{ code: 'EADDRINUSE', port: 20141 }`.
//
// Before the fix, a single 'uncaughtException' listener was installed PER
// ATTEMPT, so both attempts' listeners would receive the SAME event. The
// good attempt's (port 20140) listener would see err.port === 20141, fail
// its own match check, remove itself, and re-throw -- permanently hanging
// its own promise (silently leaking port 20140), while the process still
// crashed once no listeners remained.
//
// After the fix, there is exactly ONE shared listener plus a `pendingPorts`
// registry keyed by port, so the EADDRINUSE(20141) can only ever settle the
// attempt that registered port 20141. The good attempt on 20140 must
// resolve normally, must NOT hang, and port 20140 must remain the only
// entry left in the pool's `used` set afterward.

const net = require('node:net')
const path = require('node:path')

const { TunnelManager, ConnectError } = require(path.join(__dirname, '..', '..', '..', 'src', 'tunnel-manager.js'))

const KEY_GOOD = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'
const KEY_BAD = 'ejkmcpqxot1uwiszh76934abndrfg8ejkmcpqxot1uwisza3456y'

/**
 * Faithful stand-in for HolesailClient's TCP path (see FakeHolesailClient /
 * RacingHolesailClient in the sibling test file / fixture): connect()
 * creates its own net.Server with NO 'error' listener attached, mirroring
 * the real library. For ports in `collidePorts`, a foreign server binds the
 * port first (simulating the TOCTOU race after probeFree() already
 * reported it free), so the internal server's listen() fails
 * asynchronously with EADDRINUSE and zero listeners on it -- exactly the
 * shape that used to crash the process.
 *
 * `settleDelayMs` deliberately keeps a non-colliding connect's success
 * callback pending for a few extra event-loop turns. This is what makes the
 * concurrency bug reproducible at all: without it, the fast (single-listen)
 * good path settles and deregisters its guard before the slower
 * (foreign-then-internal, two-listen) bad path's EADDRINUSE has a chance to
 * fire, so both attempts are never simultaneously in-flight and the old
 * per-attempt-listener bug can't be observed. Real concurrent tunnel
 * creates for two independent tenants have no such guarantee about which
 * one's connect() resolves first, so this delay stands in for "the good
 * attempt just hasn't settled yet" -- a perfectly realistic timing.
 */
class RacingClient {
  constructor(collidePorts, settleDelayMs) {
    this.collidePorts = collidePorts
    this.settleDelayMs = settleDelayMs || 0
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
      setTimeout(callback, this.settleDelayMs)
    })
  }

  async destroy() {
    if (this._server) await new Promise((r) => this._server.close(r))
    if (this._foreign) await new Promise((r) => this._foreign.close(r))
  }
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} did not settle within ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Port range 20140-20141 -- see test/unit/fixtures/port-ranges.js for the
// full cross-file allocation map (test files run in parallel, so ranges
// must stay disjoint).
async function main() {
  const config = {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN: 20140,
    TUNNEL_PORT_MAX: 20141,
    IDLE_TTL_MS: 1e9,
    CONNECT_TIMEOUT_MS: 2000,
  }

  const collidePorts = new Set([20141])
  // The good client (KEY_GOOD, port 20140) deliberately settles ~50ms later
  // than the bad client's EADDRINUSE fires, so both attempts are genuinely
  // in-flight -- and both guard registrations genuinely live -- at the
  // moment the process-level 'uncaughtException' is emitted. See the
  // class-level comment on RacingClient for why this matters.
  const manager = new TunnelManager(config, undefined, () => new RacingClient(collidePorts, 50))

  // Fire both cold-creates back-to-back (not awaited individually) so they
  // are genuinely concurrent: TunnelManager acquires a port synchronously
  // before its first await, so KEY_GOOD claims 20140 and KEY_BAD claims
  // 20141, then both proceed to their async connect() calls in parallel.
  const pGood = manager.ensureTunnel(KEY_GOOD)
  const pBad = manager.ensureTunnel(KEY_BAD)

  const [goodResult, badResult] = await Promise.allSettled([
    withTimeout(pGood, 5000, 'good tunnel (port 20140)'),
    withTimeout(pBad, 5000, 'bad tunnel (port 20141)'),
  ])

  if (goodResult.status !== 'fulfilled') {
    console.log(`FAIL: good tunnel did not resolve: ${goodResult.reason && goodResult.reason.stack}`)
    process.exit(1)
  }
  if (goodResult.value.port !== 20140) {
    console.log(`FAIL: expected good tunnel on port 20140, got ${goodResult.value.port}`)
    process.exit(1)
  }

  if (badResult.status !== 'rejected') {
    console.log('FAIL: bad tunnel should have rejected, but it resolved')
    process.exit(1)
  }
  if (!(badResult.reason instanceof ConnectError)) {
    console.log(`FAIL: expected ConnectError, got ${badResult.reason && badResult.reason.stack}`)
    process.exit(1)
  }

  const used = [...manager.portPool.used]
  if (used.length !== 1 || used[0] !== 20140) {
    console.log(`FAIL: expected only port 20140 to remain used, got [${used.join(', ')}]`)
    process.exit(1)
  }

  await manager.destroyTunnel(goodResult.value.keyHash)
  console.log('OK')
  process.exit(0)
}

main().catch((err) => {
  console.log(`FAIL: ${err.stack}`)
  process.exit(1)
})
