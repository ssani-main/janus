# Janus Roadmap & Handoff Notes

This is the working roadmap for Janus feature development. It records the guiding
principle, what's already shipped, and detailed, actionable notes for the next
milestones so work can be resumed on any machine.

## Guiding principle

**Open by default, operator-controlled by exception.**

A backend owner can always share a raw Holesail key and it just works — no
password, no registration, no friction — exactly as before any of these features
existed. Every access control is *optional* operator-set metadata that defaults
to off/open. No feature may break the frictionless raw-key path.

---

## Milestone 1 — DONE ✅

Shipped in commits:
- `feat: persistent store + named aliases (Milestone 1 pt 1)`
- `feat: password-protected links + admin dashboard (Milestone 1 pt 2)`

88/88 unit tests pass. Security-reviewed and verified live end-to-end. Zero new
npm dependencies (Node built-ins only).

| Feature | Summary | Key files |
|---|---|---|
| Persistent store | Dependency-free JSON store, crash-safe atomic writes (temp + rename). Holds operator metadata keyed by keyHash: alias, password hash, block flag. Blocklist migrated here so **blocks survive restarts**. Null-prototype maps. | `src/store.js` |
| Named aliases | `resolveRoute()` maps a nickname subdomain → raw key. Additive: raw keys always win; unresolvable label falls through to a 400 exactly as before. Wired into HTTP + WS upgrade paths. | `src/server.js`, `src/store.js` |
| Password protection | Optional per-key password → Janus login page → signed HttpOnly cookie (HMAC-SHA256, scoped to the key subdomain, bound to `keyHash` + `pwdVersion` so changing/clearing the password revokes sessions). scrypt hashing. | `src/auth.js`, `src/server.js` (`passwordGate`), `src/pages.js` (`loginPage`) |
| Admin dashboard | HTML dashboard at `/_admin` (apex, behind `ADMIN_TOKEN`) alongside the unchanged bearer JSON API. Cookie session (SameSite=Strict, bound to a hash of `ADMIN_TOKEN`), CSRF-protected forms for set/clear alias, set/clear password, block/unblock. All rendered values HTML-escaped. | `src/admin.js`, `src/pages.js` (`adminDashboardPage`, `adminLoginPage`) |

**New env vars** (see `.env.example`): `STORE_PATH`, `SESSION_SECRET`,
`SESSION_TTL_MS`, `COOKIE_SECURE`, `ADMIN_SESSION_TTL_MS`.

**Deploy reminder:** set `SESSION_SECRET` (≥32 chars) explicitly, or sessions
won't survive a restart / won't work across multiple processes. The runtime
store file (`janus-data.json`) holds raw keys + password hashes and is
gitignored — never commit it.

**Shared primitives already available for future work** (`src/auth.js`):
`hashPassword` / `verifyPassword` (scrypt), `signSession` / `verifySession`
(HMAC), `csrfToken` / `verifyCsrf`, `parseCookies` — all timing-safe, Node
built-ins only.

---

## Milestone 2 — NOT STARTED (eyes & reliability)

Goal: make Janus observable and resilient in production.

### 2a. `/healthz` + `/metrics`
- `/healthz` on the apex host: return 200 `{status:"ok", tunnels:<n>, uptime}`.
  Cheap liveness for monitoring/uptime checks.
- `/metrics` in Prometheus text format: active tunnels, total tunnels created,
  evictions, idle sweeps, connect failures, per-IP rate-limit hits, bytes
  proxied. `TunnelManager` already tracks most of this state — add counters.
- Wire both in `src/server.js` apex routing (next to the `/_admin`, `/impressum`,
  `/terms` branches). Keep `/metrics` operator-only (reuse `ADMIN_TOKEN` bearer or
  a bind-address guard) — don't leak tenant counts publicly.
- Add counter fields to `src/tunnel-manager.js` (increment on create/evict/sweep/
  connect-fail) and to `src/rate-limit.js` (limit-hit counter).

### 2b. Structured request logging
- Emit one JSON line per request: timestamp, keyHash (NEVER the raw key), method,
  path, status, latency ms, bytes, client IP. Toggle via a `LOG_REQUESTS` env var.
- Add in `src/server.js` request handler around the proxy call (measure on
  `res.on('finish')`). Reuse the existing `clientIp()` helper.

### 2c. Tunnel auto-reconnect + circuit breaker
- In `src/tunnel-manager.js`: on a tunnel's `holesail-client` dropping/erroring,
  attempt reconnect with exponential backoff instead of failing cold on the next
  request. Track consecutive failures per keyHash; after N failures open a
  circuit (fast-fail with a friendly 502 for a cooldown window) so a dead backend
  doesn't hammer the DHT.
- Add `ConnectError` handling path + a per-record `failures`/`circuitOpenUntil`
  field. Sweeper (`startSweeper`) is a good place to also probe/reset circuits.

### 2d. Backend health checks
- Periodic liveness probe of cached tunnels (reuse the existing `probePort` TCP
  probe in `tunnel-manager.js`). Mark unhealthy tunnels; serve a friendly
  "backend offline" page (extend `errorPage` in `src/server.js`) instead of a
  raw proxy error. Surface health in the admin dashboard rows.

---

## Milestone 3 — NOT STARTED (reach & scale)

### 3a. Secure-mode (`s000…`) key support
- Today `src/key.js` `assertPublic()` **rejects** secure-mode keys, and
  `tunnel-manager.js` hardcodes `secure: false` when constructing `HolesailClient`.
- Let a backend owner use their native Holesail lock: allow the operator to
  register a connector secret for a keyHash (store it in the persistent store,
  encrypted at rest ideally), and pass `secure: true` + the secret to the client.
- This complements per-visitor passwords (3-layer: owner locks the tunnel, gateway
  adds a visitor password). Update `assertPublic` usage and the store schema.

### 3b. Per-key usage accounting & quotas
- Meter bytes + request counts per keyHash (hook the proxy stream, persist
  periodically to the store). Optional daily quota → 429/402 when exceeded.
- Foundation for a hosted/paid Janus. Surface usage in the dashboard.

### 3c. `janus` CLI
- No CLI exists today (only `npm start`). Add a thin CLI over the admin JSON API:
  `janus ls`, `janus alias add <name> <key>`, `janus password set <key>`,
  `janus block <keyHash>`, `janus kill <keyHash>`. Reads `ADMIN_TOKEN` +
  gateway URL from env. New `bin/janus.js`, add a `bin` entry to package.json.

### 3d. Smaller wins
- gzip/brotli compression of proxied responses.
- Per-key rate limiting (not just per-IP) — an abusive backend, not just an
  abusive visitor. Extend `src/rate-limit.js` with a keyHash-keyed bucket.
- Custom branding / nicer error + offline pages (`src/pages.js`).
- Dedicated stricter login-attempt rate limiter keyed by (IP, keyHash), distinct
  from the general request limiter (noted during the M1 security review).

---

## Conventions for continuing this work

- No new npm dependencies unless unavoidable — the 2-dependency footprint
  (`holesail-client`, `http-proxy`) is deliberate. Use Node built-ins.
- Every source module must pass `npm run check` (`node --check`).
- Add unit tests under `test/unit/` (Node's built-in `node:test`); run `npm test`.
- Never log or render raw keys — use keyHash. Escape all HTML with `escapeHtml`.
- Keep the open-by-default principle: new controls are opt-in operator metadata.
