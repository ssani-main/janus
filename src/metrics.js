'use strict'

// Milestone 2a: zero-dep Prometheus text-format renderer for /metrics.
// Deliberately pulls only from `manager.stats()` and `limiter.stats()` --
// never reaches into TunnelManager/RateLimiter internals (this.tunnels,
// this.buckets, etc.) so this module can't accidentally leak per-tenant
// data (keyHash, raw key) into a metric label. Prometheus labels are
// unbounded-cardinality by design; a keyHash label would let the metrics
// endpoint grow one series per tenant forever.

function help(name, text) {
  return `# HELP ${name} ${text}\n`
}

function type(name, kind) {
  return `# TYPE ${name} ${kind}\n`
}

function gauge(name, text, value) {
  return help(name, text) + type(name, 'gauge') + `${name} ${value}\n`
}

function counter(name, text, value) {
  return help(name, text) + type(name, 'counter') + `${name} ${value}\n`
}

// Bug fix (robustness): a metrics renderer must be structurally incapable of
// emitting a body a Prometheus scraper rejects. `manager.stats()` /
// `limiter.stats()` are production-validated today so a missing/non-finite
// field "can't happen" in practice, but this renderer must not rely on that
// -- defensively coerce every value at the render site instead. A
// missing/non-finite stat (undefined, null, NaN, Infinity, a non-number)
// renders as `0`, never `undefined`/`NaN`, which would otherwise produce an
// invalid sample line.
function num(value) {
  return Number.isFinite(value) ? value : 0
}

/**
 * @param {{ manager: { stats(): object }, limiter: { stats(): object }, startedAt: number }} deps
 * @returns {string}
 */
function renderMetrics({ manager, limiter, startedAt }) {
  const m = manager.stats()
  const l = limiter.stats()
  const uptimeSeconds = num(Math.max(0, (Date.now() - startedAt) / 1000))

  let body = ''
  body += gauge('janus_tunnels_active', 'Number of currently cached/live tunnels.', num(m.active))
  body += gauge('janus_tunnels_pending', 'Number of tunnels currently being created.', num(m.pending))
  body += gauge('janus_tunnels_max', 'Configured maximum number of concurrent tunnels.', num(m.maxTunnels))
  body += gauge('janus_uptime_seconds', 'Seconds since this process started.', uptimeSeconds)
  body += gauge('janus_ratelimit_buckets', 'Number of active per-IP rate-limit buckets.', num(l.buckets))
  // Milestone 2c: aggregate-only, process-wide gauge/counters -- see the
  // module-level comment: NEVER label any of these with a keyHash.
  body += gauge('janus_circuits_open', 'Number of keyHash circuits currently open (fast-failing cold creates).', num(m.circuitsOpen))
  // Milestone 2d: aggregate-only, same rationale -- NEVER label with a keyHash.
  body += gauge('janus_tunnels_unhealthy', 'Number of currently cached tunnels the periodic health probe considers unhealthy.', num(m.unhealthy))

  body += counter('janus_tunnels_created_total', 'Total number of tunnels created since process start.', num(m.created))
  body += counter('janus_tunnels_evicted_total', 'Total number of tunnels evicted to make room for a new one.', num(m.evicted))
  body += counter('janus_tunnels_swept_total', 'Total number of tunnels destroyed by the idle sweeper.', num(m.swept))
  body += counter('janus_connect_failures_total', 'Total number of tunnel connect attempts that failed.', num(m.connectFailures))
  body += counter('janus_port_retries_total', 'Total number of port-collision retries during tunnel creation.', num(m.portRetries))
  body += counter('janus_circuit_opens_total', 'Total number of times a keyHash circuit has opened.', num(m.circuitOpens))
  body += counter('janus_reconnect_attempts_total', 'Total number of reconnect-with-backoff attempts made.', num(m.reconnectAttempts))
  body += counter('janus_reconnect_successes_total', 'Total number of reconnect attempts that succeeded.', num(m.reconnectSuccesses))
  body += counter('janus_health_probes_total', 'Total number of periodic tunnel health probes performed.', num(m.healthProbes))
  body += counter('janus_health_probe_failures_total', 'Total number of periodic tunnel health probes that failed.', num(m.healthProbeFailures))

  body += help('janus_ratelimit_hits_total', 'Total number of requests denied by the rate limiter, by dimension.')
  body += type('janus_ratelimit_hits_total', 'counter')
  body += `janus_ratelimit_hits_total{limiter="request"} ${num(l.request)}\n`
  body += `janus_ratelimit_hits_total{limiter="new_tunnel"} ${num(l.newTunnel)}\n`

  return body
}

module.exports = { renderMetrics }
