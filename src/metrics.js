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

/**
 * @param {{ manager: { stats(): object }, limiter: { stats(): object }, startedAt: number }} deps
 * @returns {string}
 */
function renderMetrics({ manager, limiter, startedAt }) {
  const m = manager.stats()
  const l = limiter.stats()
  const uptimeSeconds = Math.max(0, (Date.now() - startedAt) / 1000)

  let body = ''
  body += gauge('janus_tunnels_active', 'Number of currently cached/live tunnels.', m.active)
  body += gauge('janus_tunnels_pending', 'Number of tunnels currently being created.', m.pending)
  body += gauge('janus_tunnels_max', 'Configured maximum number of concurrent tunnels.', m.maxTunnels)
  body += gauge('janus_uptime_seconds', 'Seconds since this process started.', uptimeSeconds)
  body += gauge('janus_ratelimit_buckets', 'Number of active per-IP rate-limit buckets.', l.buckets)

  body += counter('janus_tunnels_created_total', 'Total number of tunnels created since process start.', m.created)
  body += counter('janus_tunnels_evicted_total', 'Total number of tunnels evicted to make room for a new one.', m.evicted)
  body += counter('janus_tunnels_swept_total', 'Total number of tunnels destroyed by the idle sweeper.', m.swept)
  body += counter('janus_connect_failures_total', 'Total number of tunnel connect attempts that failed.', m.connectFailures)
  body += counter('janus_port_retries_total', 'Total number of port-collision retries during tunnel creation.', m.portRetries)

  body += help('janus_ratelimit_hits_total', 'Total number of requests denied by the rate limiter, by dimension.')
  body += type('janus_ratelimit_hits_total', 'counter')
  body += `janus_ratelimit_hits_total{limiter="request"} ${l.request}\n`
  body += `janus_ratelimit_hits_total{limiter="new_tunnel"} ${l.newTunnel}\n`

  return body
}

module.exports = { renderMetrics }
