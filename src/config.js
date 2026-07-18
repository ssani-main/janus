'use strict'

// Central config, read once from process.env with sane defaults.
// Fails fast (throws) if a required value is missing, so a bad deploy
// never silently boots into a broken state.

function readString(name, def) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  return raw
}

function readInt(name, def) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid config: ${name}="${raw}" is not an integer`)
  }
  return n
}

// TARGET_KEY was Phase 0's single hardcoded Holesail public key. Phase 1
// derives the key from the request Host header instead, so this is now an
// optional legacy/debug override only -- no fail-fast, no default.
const TARGET_KEY = process.env.TARGET_KEY || null

// BASE_DOMAIN is the domain this gateway is served on (e.g.
// "gateway.example.com"). Phase 1 routing derives the tenant key from the
// leftmost subdomain label of req.headers.host relative to this domain, so
// it is REQUIRED -- fail fast if unset, same rationale as Phase 0's
// TARGET_KEY check: a bad deploy should fail at startup, not at request time.
const BASE_DOMAIN = process.env.BASE_DOMAIN
if (!BASE_DOMAIN) {
  throw new Error(
    'Missing required env var BASE_DOMAIN. Set it to the domain this gateway ' +
    'is served on (e.g. gateway.example.com) -- see .env.example / README.md.'
  )
}

// Phase 3: operator identity fields, all optional -- unset fields are
// rendered as an explicit "NOT CONFIGURED" placeholder by src/pages.js
// rather than silently omitted, so an operator can't accidentally ship a
// legal page that looks complete but isn't.
const OPERATOR_NAME = process.env.OPERATOR_NAME || ''
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS || ''
const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || ''
const ABUSE_EMAIL = process.env.ABUSE_EMAIL || OPERATOR_EMAIL

// Phase 3: operator kill-switch admin API. null (unset) DISABLES the
// /_admin/* endpoints entirely (404) -- an operator must opt in explicitly.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null

// Whether to trust X-Forwarded-For for client IP (only correct when the
// gateway sits behind a proxy we control, e.g. Caddy -- see TRUST_PROXY doc
// in .env.example).
function readBool(name, def) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return def
  return !(raw === 'false' || raw === '0')
}
const TRUST_PROXY = readBool('TRUST_PROXY', true)

const config = {
  PORT: readInt('PORT', 3000),
  BIND_HOST: process.env.BIND_HOST || '127.0.0.1',
  TARGET_KEY,
  BASE_DOMAIN: BASE_DOMAIN.toLowerCase(),
  TUNNEL_PORT_MIN: readInt('TUNNEL_PORT_MIN', 20000),
  TUNNEL_PORT_MAX: readInt('TUNNEL_PORT_MAX', 20999),
  CONNECT_TIMEOUT_MS: readInt('CONNECT_TIMEOUT_MS', 8000),
  IDLE_TTL_MS: readInt('IDLE_TTL_MS', 900000),
  MAX_TUNNELS: readInt('MAX_TUNNELS', 50),
  OPERATOR_NAME,
  OPERATOR_ADDRESS,
  OPERATOR_EMAIL,
  ABUSE_EMAIL,
  ADMIN_TOKEN,
  TRUST_PROXY,
  // Security audit S2: number of trusted reverse proxies (e.g. Caddy) between
  // the client and this gateway. clientIp() (src/server.js) reads the
  // X-Forwarded-For entry this many positions from the RIGHT, not the
  // leftmost -- Caddy's reverse_proxy APPENDS to XFF rather than replacing
  // it, so the leftmost entry is attacker-controlled while the rightmost N
  // entries are appended by trusted hops. Default 1 (a single Caddy).
  TRUSTED_PROXY_HOPS: readInt('TRUSTED_PROXY_HOPS', 1),
  RATE_WINDOW_MS: readInt('RATE_WINDOW_MS', 60000),
  RATE_MAX_REQUESTS: readInt('RATE_MAX_REQUESTS', 120),
  RATE_MAX_NEW_TUNNELS: readInt('RATE_MAX_NEW_TUNNELS', 10),
  // Milestone 1: path to the persistent JSON store (blocklist, aliases,
  // dashboard passwords). Relative paths are resolved against process.cwd().
  STORE_PATH: readString('STORE_PATH', './janus-data.json'),
  // Milestone 1, Feature 3/4: secret used to sign/verify session cookies
  // (per-key password gate, and later the admin dashboard). Empty by
  // default -- config.js stays pure/synchronous, so a random fallback (and
  // the accompanying warning that sessions won't survive a restart or work
  // across processes) is generated in server.js at boot, not here.
  SESSION_SECRET: readString('SESSION_SECRET', ''),
  // How long a signed session cookie stays valid. Default 7 days.
  SESSION_TTL_MS: readInt('SESSION_TTL_MS', 604800000),
  // Whether session cookies get the Secure attribute. Only set this to
  // false for local HTTP-only testing -- it must be true (the default) in
  // any deployment served over TLS, which is the norm for this gateway.
  COOKIE_SECURE: readBool('COOKIE_SECURE', true),
  // Milestone 1, Feature 4: how long an admin dashboard login (cookie
  // session) stays valid. Separate from SESSION_TTL_MS (per-key password
  // sessions) since the admin session grants far more power and should be
  // shorter-lived by default. Default 12 hours.
  ADMIN_SESSION_TTL_MS: readInt('ADMIN_SESSION_TTL_MS', 43200000),
  // Milestone 2a: whether to emit a JSON line per request to stdout. Off by
  // default -- per-request logging is high volume and an operator should opt
  // in explicitly, same rationale as ADMIN_TOKEN being unset by default.
  LOG_REQUESTS: readBool('LOG_REQUESTS', false),
  // Milestone 2c: circuit breaker + reconnect tuning. Consecutive cold-create
  // (or reactive proxy-error) failures for a keyHash before its circuit
  // opens and further cold creates fast-fail (503 + Retry-After) instead of
  // paying for a DHT round trip against a backend we already know is down.
  CIRCUIT_FAILURE_THRESHOLD: readInt('CIRCUIT_FAILURE_THRESHOLD', 5),
  // How long a circuit stays open once it trips, in milliseconds. Default
  // 30 seconds.
  CIRCUIT_COOLDOWN_MS: readInt('CIRCUIT_COOLDOWN_MS', 30000),
  // Milestone 2c: how many extra reconnect attempts `_createTunnel` makes
  // (with exponential backoff + jitter) after the first cold-create attempt
  // fails, before giving up and surfacing ConnectError. Default 3 (so up to
  // 4 total attempts: 1 initial + 3 reconnects).
  RECONNECT_MAX_ATTEMPTS: readInt('RECONNECT_MAX_ATTEMPTS', 3),
  // Base delay for the reconnect backoff (`RECONNECT_BASE_DELAY_MS * 2^attempt`,
  // capped at RECONNECT_MAX_DELAY_MS, jittered). Default 250ms.
  RECONNECT_BASE_DELAY_MS: readInt('RECONNECT_BASE_DELAY_MS', 250),
  // Cap on the reconnect backoff delay, in milliseconds. Default 5s.
  RECONNECT_MAX_DELAY_MS: readInt('RECONNECT_MAX_DELAY_MS', 5000),
  // Milestone 2d: how often the periodic health probe checks every cached
  // tunnel's port for liveness (independent of the 60s idle sweeper, which
  // is too coarse for this). Default 30 seconds.
  HEALTH_PROBE_INTERVAL_MS: readInt('HEALTH_PROBE_INTERVAL_MS', 30000),
  // Per-probe connect timeout. Must be well under HEALTH_PROBE_INTERVAL_MS
  // (enforced below) -- a probe that can outlive its own interval would
  // stack up behind the next tick instead of settling first. Default 2s.
  HEALTH_PROBE_TIMEOUT_MS: readInt('HEALTH_PROBE_TIMEOUT_MS', 2000),
  // Milestone 2d (bug fix): how long proxy.web() waits for the upstream
  // (tunneled backend) to respond before http-proxy aborts the outgoing
  // request and emits 'error' on the shared proxy instance -- see
  // src/server.js's `httpProxy.createProxyServer` call. Without this, a
  // backend that accepts the connection and then hangs (deadlock, infinite
  // loop, black-holed socket) never errors, never releases `inFlight`, is
  // never probed (the inFlight>0 guard in tunnel-manager.js's _probeOne
  // assumes -- correctly, but only once this timeout exists -- that an
  // in-flight request proves the backend is alive), and pins the tunnel
  // forever. This is an IDLE-socket timeout (Node's ClientRequest.setTimeout
  // semantics), not a hard cap on total response duration -- a backend that
  // is merely slow but keeps the connection active would not be cut off
  // mid-response by this alone. It applies ONLY to proxy.web() (plain HTTP
  // proxying); http-proxy's ws pass never reads options.proxyTimeout, so a
  // long-lived websocket upgrade is completely unaffected -- this knob
  // cannot sever one. Default 30s: long enough not to sever a legitimately
  // slow-but-working backend, short enough that a genuinely hung backend
  // recovers automatically well within an operator's patience.
  PROXY_TIMEOUT_MS: readInt('PROXY_TIMEOUT_MS', 30000),
  // Security review (FIX 2, post-Milestone-2): overall wall-clock deadline
  // for TunnelManager.ensureTunnel()'s ENTIRE cold-create path (reconnect
  // loop x port-collision loop x per-attempt connect timeout x backoff
  // sleeps), enforced from inside TunnelManager itself -- see
  // src/tunnel-manager.js's `deadlineAt` threading through `_createTunnel`/
  // `_attemptPortConnect`. Each individual loop/timeout is already bounded,
  // but their product is not (worst case ~175s with CONNECT_TIMEOUT_MS=8000,
  // RECONNECT_MAX_ATTEMPTS=3, MAX_PORT_ATTEMPTS=5, RECONNECT_MAX_DELAY_MS=
  // 5000), and nothing previously capped that product while a visitor's HTTP
  // request sat there waiting. Default 45s: comfortably above a normal
  // successful cold create (one DHT round trip well under
  // CONNECT_TIMEOUT_MS=8000), far below the ~175s worst case.
  ENSURE_TUNNEL_TIMEOUT_MS: readInt('ENSURE_TUNNEL_TIMEOUT_MS', 45000),
}

if (config.TUNNEL_PORT_MIN >= config.TUNNEL_PORT_MAX) {
  throw new Error(
    `Invalid config: TUNNEL_PORT_MIN (${config.TUNNEL_PORT_MIN}) must be less than ` +
    `TUNNEL_PORT_MAX (${config.TUNNEL_PORT_MAX})`
  )
}

// Milestone 2c: fail fast on nonsensical circuit-breaker/reconnect config,
// same rationale as the port-range check above.
if (config.CIRCUIT_FAILURE_THRESHOLD <= 0) {
  throw new Error(
    `Invalid config: CIRCUIT_FAILURE_THRESHOLD (${config.CIRCUIT_FAILURE_THRESHOLD}) must be a positive integer`
  )
}
if (config.CIRCUIT_COOLDOWN_MS <= 0) {
  throw new Error(
    `Invalid config: CIRCUIT_COOLDOWN_MS (${config.CIRCUIT_COOLDOWN_MS}) must be a positive integer`
  )
}
if (config.RECONNECT_MAX_ATTEMPTS < 0) {
  throw new Error(
    `Invalid config: RECONNECT_MAX_ATTEMPTS (${config.RECONNECT_MAX_ATTEMPTS}) must be a non-negative integer`
  )
}
if (config.RECONNECT_BASE_DELAY_MS <= 0) {
  throw new Error(
    `Invalid config: RECONNECT_BASE_DELAY_MS (${config.RECONNECT_BASE_DELAY_MS}) must be a positive integer`
  )
}
if (config.RECONNECT_MAX_DELAY_MS <= 0) {
  throw new Error(
    `Invalid config: RECONNECT_MAX_DELAY_MS (${config.RECONNECT_MAX_DELAY_MS}) must be a positive integer`
  )
}
if (config.RECONNECT_BASE_DELAY_MS > config.RECONNECT_MAX_DELAY_MS) {
  throw new Error(
    `Invalid config: RECONNECT_BASE_DELAY_MS (${config.RECONNECT_BASE_DELAY_MS}) must be <= ` +
    `RECONNECT_MAX_DELAY_MS (${config.RECONNECT_MAX_DELAY_MS})`
  )
}

// Milestone 2d: fail fast on nonsensical health-probe config, same rationale
// as the checks above.
if (config.HEALTH_PROBE_INTERVAL_MS <= 0) {
  throw new Error(
    `Invalid config: HEALTH_PROBE_INTERVAL_MS (${config.HEALTH_PROBE_INTERVAL_MS}) must be a positive integer`
  )
}
if (config.HEALTH_PROBE_TIMEOUT_MS <= 0) {
  throw new Error(
    `Invalid config: HEALTH_PROBE_TIMEOUT_MS (${config.HEALTH_PROBE_TIMEOUT_MS}) must be a positive integer`
  )
}
if (config.HEALTH_PROBE_TIMEOUT_MS >= config.HEALTH_PROBE_INTERVAL_MS) {
  throw new Error(
    `Invalid config: HEALTH_PROBE_TIMEOUT_MS (${config.HEALTH_PROBE_TIMEOUT_MS}) must be well under ` +
    `HEALTH_PROBE_INTERVAL_MS (${config.HEALTH_PROBE_INTERVAL_MS}) -- a probe that can outlive its own ` +
    `interval would stack up behind the next tick instead of settling first`
  )
}

// Milestone 2d (bug fix): fail fast on a nonsensical proxy timeout, same
// rationale as the checks above. No cross-check against CONNECT_TIMEOUT_MS
// is enforced -- the two guard completely different phases (one-time
// tunnel/DHT connect vs. per-request upstream response wait) with no
// ordering requirement between them; either can reasonably be larger than
// the other depending on the backend.
if (config.PROXY_TIMEOUT_MS <= 0) {
  throw new Error(
    `Invalid config: PROXY_TIMEOUT_MS (${config.PROXY_TIMEOUT_MS}) must be a positive integer`
  )
}

// Security review (FIX 2): fail fast on a nonsensical ensureTunnel deadline.
// It must strictly exceed CONNECT_TIMEOUT_MS -- otherwise a single connect
// attempt alone could already exceed the "overall" deadline meant to bound
// the whole reconnect x port-retry x backoff chain.
if (config.ENSURE_TUNNEL_TIMEOUT_MS <= 0) {
  throw new Error(
    `Invalid config: ENSURE_TUNNEL_TIMEOUT_MS (${config.ENSURE_TUNNEL_TIMEOUT_MS}) must be a positive integer`
  )
}
if (config.ENSURE_TUNNEL_TIMEOUT_MS <= config.CONNECT_TIMEOUT_MS) {
  throw new Error(
    `Invalid config: ENSURE_TUNNEL_TIMEOUT_MS (${config.ENSURE_TUNNEL_TIMEOUT_MS}) must exceed ` +
    `CONNECT_TIMEOUT_MS (${config.CONNECT_TIMEOUT_MS}) -- it bounds the whole cold-create chain, ` +
    `which includes at least one full connect attempt`
  )
}

// Security audit S2: fail fast on a nonsensical trusted-hop count. Only
// enforced when TRUST_PROXY is true -- clientIp() never reads
// TRUSTED_PROXY_HOPS otherwise. Must be a finite integer >= 1: 0 (or
// negative) would index at or past the leftmost, attacker-controlled entry,
// defeating the whole point of right-indexing.
if (config.TRUST_PROXY) {
  if (!Number.isFinite(config.TRUSTED_PROXY_HOPS) || config.TRUSTED_PROXY_HOPS < 1) {
    throw new Error(
      `Invalid config: TRUSTED_PROXY_HOPS (${config.TRUSTED_PROXY_HOPS}) must be a finite integer >= 1 ` +
      `when TRUST_PROXY is true -- it is the number of trusted proxies (e.g. Caddy) between the client ` +
      `and this gateway, and clientIp() indexes X-Forwarded-For from the right by this amount`
    )
  }
}

module.exports = Object.freeze(config)
