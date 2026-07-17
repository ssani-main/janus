'use strict'

// Milestone 2a: covers src/metrics.js's Prometheus text-format renderer.
// renderMetrics() only ever reads from `manager.stats()` / `limiter.stats()`
// (see the file's top comment) -- these tests drive it with fake stats
// objects (and, for the security-critical assertions, a real TunnelManager
// with live tunnels) rather than a real DHT/HolesailClient.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { renderMetrics } = require('../../src/metrics')
const { TunnelManager } = require('../../src/tunnel-manager')

function fakeManager(overrides = {}) {
  return {
    stats: () => Object.assign(
      { active: 2, pending: 1, maxTunnels: 50, created: 10, evicted: 3, swept: 1, connectFailures: 2, portRetries: 4 },
      overrides
    ),
  }
}

function fakeLimiter(overrides = {}) {
  return {
    stats: () => Object.assign({ request: 5, newTunnel: 1, buckets: 7 }, overrides),
  }
}

function render(overrides = {}) {
  return renderMetrics(Object.assign(
    { manager: fakeManager(), limiter: fakeLimiter(), startedAt: Date.now() - 5000 },
    overrides
  ))
}

const EXPECTED_METRIC_NAMES = [
  'janus_tunnels_active',
  'janus_tunnels_pending',
  'janus_tunnels_max',
  'janus_uptime_seconds',
  'janus_ratelimit_buckets',
  'janus_tunnels_created_total',
  'janus_tunnels_evicted_total',
  'janus_tunnels_swept_total',
  'janus_connect_failures_total',
  'janus_port_retries_total',
  'janus_ratelimit_hits_total',
]

test('renderMetrics: every emitted metric name has both a # HELP and # TYPE line', () => {
  const body = render()
  for (const name of EXPECTED_METRIC_NAMES) {
    assert.match(body, new RegExp(`# HELP ${name} .+`), `missing HELP line for ${name}`)
    assert.match(body, new RegExp(`# TYPE ${name} (counter|gauge)`), `missing TYPE line for ${name}`)
  }
})

test('renderMetrics: every metric name is prefixed janus_', () => {
  const body = render()
  const nameLines = body.split('\n').filter((l) => l && !l.startsWith('#'))
  assert.ok(nameLines.length > 0, 'expected at least one metric sample line')
  for (const line of nameLines) {
    assert.match(line, /^janus_/, `metric sample line does not start with janus_: "${line}"`)
  }
})

test('renderMetrics: body ends with a trailing newline', () => {
  const body = render()
  assert.equal(body.slice(-1), '\n')
  assert.equal(body.endsWith('\n\n'), false, 'should end with exactly one trailing newline, not a blank line')
})

test('renderMetrics: counters render as plain integers, not floats or NaN, including at zero', () => {
  const body = render({
    manager: fakeManager({ created: 0, evicted: 0, swept: 0, connectFailures: 0, portRetries: 0 }),
    limiter: fakeLimiter({ request: 0, newTunnel: 0 }),
  })
  assert.doesNotMatch(body, /NaN/)
  assert.match(body, /^janus_tunnels_created_total 0$/m)
  assert.match(body, /^janus_tunnels_evicted_total 0$/m)
  assert.match(body, /^janus_tunnels_swept_total 0$/m)
  assert.match(body, /^janus_connect_failures_total 0$/m)
  assert.match(body, /^janus_port_retries_total 0$/m)
  assert.match(body, /^janus_ratelimit_hits_total\{limiter="request"\} 0$/m)
  assert.match(body, /^janus_ratelimit_hits_total\{limiter="new_tunnel"\} 0$/m)

  // Also check a normal non-zero case renders as an integer, not "10.0" etc.
  const nonZero = render()
  assert.match(nonZero, /^janus_tunnels_created_total 10$/m)
  assert.match(nonZero, /^janus_port_retries_total 4$/m)
})

test('renderMetrics: uptime is a non-negative number of seconds derived from startedAt', () => {
  const body = render({ startedAt: Date.now() - 12345 })
  const match = body.match(/^janus_uptime_seconds ([\d.]+)$/m)
  assert.ok(match, 'expected an uptime sample line')
  const value = Number(match[1])
  assert.ok(Number.isFinite(value) && value >= 0, `uptime should be a finite, non-negative number, got ${match[1]}`)
})

test('renderMetrics: rate-limit hits are labeled by dimension (request / new_tunnel)', () => {
  const body = render({ limiter: fakeLimiter({ request: 9, newTunnel: 3 }) })
  assert.match(body, /^janus_ratelimit_hits_total\{limiter="request"\} 9$/m)
  assert.match(body, /^janus_ratelimit_hits_total\{limiter="new_tunnel"\} 3$/m)
})

// --- Security-critical: no keyHash / raw key can ever leak into /metrics ---

test('renderMetrics: NEVER includes a live tunnel keyHash, even with real tunnels present', async () => {
  // Real TunnelManager (not a fake) with actual cached tunnels, driven via
  // the clientFactory injection harness -- see
  // test/unit/tunnel-manager-port-retry.test.js for the same pattern. No
  // real DHT/HolesailClient is used.
  class FakeHolesailClient {
    async connect(options, callback) {
      const server = net.createServer()
      this._server = server
      server.listen(options.port, options.host, () => callback())
    }
    async destroy() {
      if (this._server) await new Promise((resolve) => this._server.close(resolve))
    }
  }

  const config = {
    MAX_TUNNELS: 5,
    TUNNEL_PORT_MIN: 20600,
    TUNNEL_PORT_MAX: 20610,
    IDLE_TTL_MS: 1e9,
    CONNECT_TIMEOUT_MS: 2000,
  }
  const KEY = 'oz6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qi'
  const manager = new TunnelManager(config, undefined, () => new FakeHolesailClient())

  const record = await manager.ensureTunnel(KEY)
  manager.release(record)

  try {
    const body = renderMetrics({ manager, limiter: fakeLimiter(), startedAt: Date.now() })

    assert.doesNotMatch(body, new RegExp(record.keyHash), 'the live tunnel keyHash must never appear in /metrics output')
    assert.doesNotMatch(body, new RegExp(KEY), 'the raw key must never appear in /metrics output')
    // Only the aggregate active count, never a per-tenant label.
    assert.match(body, /^janus_tunnels_active 1$/m)
  } finally {
    await manager.destroyTunnel(record.keyHash)
  }
})
