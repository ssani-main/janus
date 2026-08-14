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
 * @param {{ manager: { stats(): object }, limiter: { stats(): object }, startedAt: number, pwLockouts?: { entries: number }, directoryStats?: { total: number, online: number } }} deps
 *   `pwLockouts` is optional: it comes from a plain Map in src/server.js
 *   rather than from a class with a stats() method, and several existing
 *   callers/tests predate it. Absent renders as 0, same as any other
 *   missing/non-finite stat (see num() above). `directoryStats` follows the
 *   same optional-plain-object convention -- see the gauges below for what
 *   it counts.
 * @returns {string}
 */
function renderMetrics({ manager, limiter, startedAt, pwLockouts, directoryStats }) {
  const m = manager.stats()
  const l = limiter.stats()
  const uptimeSeconds = num(Math.max(0, (Date.now() - startedAt) / 1000))

  let body = ''
  body += gauge('janus_tunnels_active', 'Number of currently cached/live tunnels.', num(m.active))
  body += gauge('janus_tunnels_pending', 'Number of tunnels currently being created.', num(m.pending))
  body += gauge('janus_tunnels_max', 'Configured maximum number of concurrent tunnels.', num(m.maxTunnels))
  body += gauge('janus_uptime_seconds', 'Seconds since this process started.', uptimeSeconds)
  body += gauge('janus_ratelimit_buckets', 'Number of active per-IP rate-limit buckets.', num(l.buckets))
  // F2 follow-up (guard finding): the per-(IP, keyHash) password-lockout map
  // in src/server.js has no hard size cap -- it is bounded only by its prune
  // rule. It is self-limiting in practice (a locked-out attempt returns 429
  // WITHOUT refreshing lastAt, so an attacker can only keep an entry alive by
  // waiting out each exponentially-growing lockout and spending a fresh
  // counted failure), but an operator previously had no way to see it grow at
  // all. Aggregate count only -- NEVER label this with an ip or keyHash, same
  // rationale as the module-level comment.
  //
  // Worth watching for CPU as much as memory: the prune is an O(n) scan of
  // this map on every password POST, a path whose frequency an attacker
  // controls.
  body += gauge('janus_pw_lockout_entries', 'Number of tracked (client IP, keyHash) pairs with recent failed per-key password attempts.', num(pwLockouts && pwLockouts.entries))
  // Directory feature (opt-in, DIRECTORY_ENABLED, default false) had no
  // observability at all -- the whole point of shipping it was to learn
  // whether anyone uses it. Always emitted, even when the feature is
  // disabled: reporting 0 is more useful to an operator than a series that
  // vanishes and breaks a dashboard (same convention as pwLockouts above).
  //
  // Deliberately counts STORED directory entries (src/store.js's
  // listDirectory()), NOT what /directory's list() would currently render.
  // list() additionally hides blocked/password-protected keys and caps the
  // result at DIRECTORY_MAX_ENTRIES -- re-deriving that here on every scrape
  // would mean calling store.isBlocked()/getPassword() per entry, which is
  // needless work on an operator-facing but still-hot-enough path. So this
  // gauge can read slightly higher than the live page's entry count; the
  // HELP text says so explicitly rather than silently meaning something
  // narrower than its name implies.
  body += gauge('janus_directory_entries', 'Total directory entries currently stored (may exceed what /directory renders: it excludes blocked/password-protected keys and caps at DIRECTORY_MAX_ENTRIES).', num(directoryStats && directoryStats.total))
  body += gauge('janus_directory_online', 'Of the stored directory entries, how many are currently marked online.', num(directoryStats && directoryStats.online))
  // Milestone 2c: aggregate-only, process-wide gauge/counters -- see the
  // module-level comment: NEVER label any of these with a keyHash.
  body += gauge('janus_circuits_open', 'Number of keyHash circuits currently open (fast-failing cold creates).', num(m.circuitsOpen))
  // Milestone 2d: aggregate-only, same rationale -- NEVER label with a keyHash.
  body += gauge('janus_tunnels_unhealthy', 'Number of currently cached tunnels the periodic health probe considers unhealthy.', num(m.unhealthy))
  // Security audit S3: aggregate-only gauges/counter for the websocket slot
  // cap that prevents websockets from pinning every tunnel slot forever --
  // same "never label with a keyHash" rationale as the module-level comment.
  body += gauge('janus_ws_slots', 'Number of tunnel slots currently pinned by at least one live websocket.', num(m.wsSlots))
  body += gauge('janus_ws_slots_max', 'Configured maximum number of tunnel slots websockets may pin at once (WS_MAX_SLOTS).', num(m.wsSlotsMax))
  // Scale review: cold-create concurrency. janus_creates_queued sitting above
  // zero is the signal that MAX_CONCURRENT_CREATES is the live bottleneck --
  // raising MAX_TUNNELS while this is nonzero accomplishes nothing.
  body += gauge('janus_creates_active', 'Number of cold tunnel creates running concurrently right now.', num(m.createsActive))
  body += gauge('janus_creates_queued', 'Number of cold tunnel creates waiting for a concurrency slot.', num(m.createsQueued))
  body += gauge('janus_creates_max', 'Configured maximum concurrent cold creates (MAX_CONCURRENT_CREATES).', num(m.createsMax))
  body += gauge('janus_ports_in_quarantine', 'Tunnel ports currently held out of the pool after a connect timeout (PORT_QUARANTINE_MS).', num(m.portsInQuarantine))

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
  // Security audit S3: cumulative count of websocket upgrades rejected by
  // the WS_MAX_SLOTS / WS_MAX_PER_IP caps -- see tunnel-manager.js's
  // noteWsRejected and src/server.js's upgrade handler.
  body += counter('janus_ws_rejected_total', 'Total number of websocket upgrades rejected by the WS_MAX_SLOTS/WS_MAX_PER_IP caps.', num(m.wsRejected))
  body += counter('janus_create_queue_rejected_total', 'Total number of cold creates rejected because the create queue was full (MAX_CREATE_QUEUE).', num(m.createQueueRejected))
  // Distinct from the counter above: rejected = never joined the queue (it was
  // full); timeouts = joined it, then the ENSURE_TUNNEL_TIMEOUT_MS deadline
  // passed before a slot freed. Sustained growth means MAX_CONCURRENT_CREATES
  // is too low for the offered load rather than the queue being too short.
  body += counter('janus_create_queue_timeouts_total', 'Total number of cold creates that gave up waiting for a concurrency slot before the ensureTunnel deadline.', num(m.createQueueTimeouts))
  body += counter('janus_ports_quarantined_total', 'Total number of tunnel ports quarantined after a connect timeout.', num(m.portsQuarantined))
  // A nonzero janus_late_binds_absorbed_total is the load-bearing signal that
  // the port quarantine is doing its job: each one is a late EADDRINUSE that
  // would previously have reached the uncaughtException guard with no pending
  // attempt to claim it and killed the process. Sustained growth means DHT
  // connects are timing out -- check outbound UDP per DEPLOY.md.
  body += counter('janus_late_binds_absorbed_total', 'Total number of late EADDRINUSE binds absorbed instead of crashing the process.', num(m.lateBindsAbsorbed))

  body += help('janus_ratelimit_hits_total', 'Total number of requests denied by the rate limiter, by dimension.')
  body += type('janus_ratelimit_hits_total', 'counter')
  body += `janus_ratelimit_hits_total{limiter="request"} ${num(l.request)}\n`
  body += `janus_ratelimit_hits_total{limiter="new_tunnel"} ${num(l.newTunnel)}\n`

  return body
}

module.exports = { renderMetrics }
