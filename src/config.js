'use strict'

// Central config, read once from process.env with sane defaults.
// Fails fast (throws) if a required value is missing, so a bad deploy
// never silently boots into a broken state.

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
  RATE_WINDOW_MS: readInt('RATE_WINDOW_MS', 60000),
  RATE_MAX_REQUESTS: readInt('RATE_MAX_REQUESTS', 120),
  RATE_MAX_NEW_TUNNELS: readInt('RATE_MAX_NEW_TUNNELS', 10),
}

if (config.TUNNEL_PORT_MIN >= config.TUNNEL_PORT_MAX) {
  throw new Error(
    `Invalid config: TUNNEL_PORT_MIN (${config.TUNNEL_PORT_MIN}) must be less than ` +
    `TUNNEL_PORT_MAX (${config.TUNNEL_PORT_MAX})`
  )
}

module.exports = Object.freeze(config)
