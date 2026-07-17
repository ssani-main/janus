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

## Milestone 2 — DONE ✅

Shipped in commits:
- `feat(metrics,logger): observability (2a+2b): /healthz + /metrics + structured request logging`
- `feat(circuit-breaker,health-probe): reliability (2c+2d): exponential-backoff reconnect, circuit breaker, periodic health probes, offline page`

88/88 unit tests pass (inclusive of M2's circuit/reconnect tests). Zero new npm
dependencies (Node built-ins only).

### 2a. `/healthz` + `/metrics`

| Feature | Summary | Key files |
|---|---|---|
| `/healthz` endpoint | GET on apex host returns 200 `{status:"ok", tunnels:<n>, uptime}` for monitoring/uptime checks. Dispatched *before* rate limiting — always reachable. | `src/server.js` (line 407–414), `src/tunnel-manager.js` `stats()` |
| `/metrics` Prometheus format | Gauges: active, pending, max tunnels, circuits open, tunnels unhealthy, uptime, rate-limit buckets. Counters: created, evicted, swept, connect failures, port retries, circuit opens, reconnect attempts/successes, health probes/failures, rate-limit hits (request + new-tunnel). Bearer-gated with `ADMIN_TOKEN`. | `src/metrics.js`, `src/server.js` (line 449–475), `src/tunnel-manager.js` `stats()`, `src/rate-limit.js` `stats()` |
| Cumulative counters | Every `TunnelManager` + `RateLimiter` event increments monotonic counters so operators can see process-lifetime totals (not just current state). | `src/tunnel-manager.js` `this.counters`, `src/rate-limit.js` `this.hits` |

**New env vars** (see `.env.example`): `LOG_REQUESTS`.

### 2b. Structured request logging

| Feature | Summary | Key files |
|---|---|---|
| JSON-lines logging | Per-request: timestamp, keyHash (never raw key), method, path, status, durMs, bytes, client IP. Opt-in via `LOG_REQUESTS` env var. | `src/logger.js`, `src/server.js` (line 394–400) |

**New env vars** (see `.env.example`): `LOG_REQUESTS`.

### 2c. Tunnel auto-reconnect + circuit breaker

| Feature | Summary | Design note | Key files |
|---|---|---|---|
| Exponential backoff reconnect | On cold-create failure, retry with backoff (base delay, exponential cap, jitter) instead of failing immediately. Shared across concurrent requests to the same key. | Jitter prevents lockstep DHT hammering when N clients target one dead backend. | `src/tunnel-manager.js` `reconnectDelayMs()`, `_createTunnel()`, `config.RECONNECT_*` |
| Circuit breaker | Manager-level (not per-tunnel-record) state keyed by keyHash. After N consecutive failures opens a circuit: fast-fails cold-create with 503 + `Retry-After` for a cooldown window. | Circuit check is deliberately AFTER the cached-tunnel return (line 433–454): a stale circuit never kills a currently-healthy tunnel; it only gates the expensive cold-create path. Cached tunnels proving the backend is alive now always bypass the circuit. | `src/tunnel-manager.js` `this.circuits` Map, `ensureTunnel()`, `recordFailure()`, `recordSuccess()`, `CircuitOpenError` |
| Port-collision guard | Wraps `client.connect()` with process-wide uncaughtException listener to catch EADDRINUSE before it crashes the gateway. Retries onto the next pool port (bounded by `MAX_PORT_ATTEMPTS`). | HolesailClient's internal net.Server has no error listener; bind failures escalate to uncaughtException unless guarded. | `src/tunnel-manager.js` `connectWithPortGuard()`, `onUncaughtPortGuard`, `pendingPorts` registry |

**New env vars** (see `.env.example`): `CIRCUIT_FAILURE_THRESHOLD`, `CIRCUIT_COOLDOWN_MS`, `RECONNECT_MAX_ATTEMPTS`, `RECONNECT_BASE_DELAY_MS`, `RECONNECT_MAX_DELAY_MS`.

### 2d. Backend health checks + offline page

| Feature | Summary | Design note | Key files |
|---|---|---|---|
| Periodic health probing | Separate interval (not folded into the 60s idle sweeper) probes each cached tunnel's loopback TCP port. Recycles failed probes as unwilling to close circuits (too weak a signal). | A loopback TCP connect only proves our proxy port is up, not that the real backend works. Health probes mark a tunnel unhealthy only after `HEALTH_PROBE_UNHEALTHY_STREAK` consecutive failures, then destroy it (not pin it). Recovery is automatic: the next request cold-creates, feeding strong signals (actual ConnectError) to the circuit breaker. | `src/tunnel-manager.js` `startHealthProbing()`, `_probeTunnels()`, `_probeOne()`, `HEALTH_PROBE_UNHEALTHY_STREAK` |
| Proxy timeout | http-proxy's idle-socket timeout; detects hung backends that accept the connection but never respond. Essential: without it, a backend hanging forever never errors, so `inFlight` never drains, probes never run (skipped if inFlight > 0), and the tunnel pins with `healthy === true`. | This is NOT a hard response-time cap — a slow backend that keeps sending/receiving data is never cut off. WebSocket upgrades are exempt (long-lived sockets). | `src/server.js` line 76, `config.PROXY_TIMEOUT_MS` |
| Friendly offline page | When proxy errors and the tunnel context exists, serve `offlinePage()` (honest: backend is offline/unreachable, visitor did nothing wrong) instead of generic `errorPage(502)`. | Unlike the previous probe-driven logic (checking `tunnel.healthy === false`), this now fires on ANY proxy error with tunnel context: probes have already destroyed the tunnel by the time an error reaches this handler, so `healthy` would almost never still be false. The offline page is the strong, immediate signal. | `src/pages.js` `offlinePage()`, `src/server.js` `proxy.on('error')` (line 104–131) |
| Admin dashboard health column | Tunnels list shows `healthy` status (live gauge, updated by probes). | Transient: a destroyed unhealthy tunnel's record vanishes; health state does not outlive the tunnel it describes. | `src/pages.js` `adminDashboardPage()`, `src/tunnel-manager.js` `list()` |

**New env vars** (see `.env.example`): `HEALTH_PROBE_INTERVAL_MS`, `HEALTH_PROBE_TIMEOUT_MS`, `PROXY_TIMEOUT_MS`.

---

## Milestone 2 — Known gaps & follow-ups

Improvements deferred intentionally (low impact, addressed if reported in production):

### Port-recycling probe race (low probability, narrow window)
When `_probeTunnels()` snapshots records then probes them asynchronously,
`destroyTunnel()` can release a port mid-probe and `PortPool.acquire()` can
immediately reissue that exact port to a different key. A stale probe's result
could be attributed to the wrong tunnel. No port generation/version tag exists
to detect reuse. **Mitigation:** probe failure streaks destroy tunnels
immediately, so most stale results are irrelevant; risk is only if a port is
recycled *and* a stale probe succeeds wrongly. Not observed in testing.

### Dual keyHash for `0000<X>` and `s000<X>` keys (operator awareness only)
`parseKey()` hashes only the 52-char key suffix, stripping the 4-char mode
prefix. Two keys with identical material — one public (`0000…`), one secure
(`s000…`) — collide to the same keyHash. An operator setting a password on a
public key also gates the same-material secure-mode key (if someone tries to
share it). **Not a bypass:** secure-mode keys are rejected at the parse stage
(line 78–87, `assertPublic()`), so the collision is observable only if an
operator explicitly tries. **Directly relevant to M3's secure-mode-key work:**
if M3 removes `assertPublic()`, these collisions become a real aliasing bug —
the path forward is including the mode prefix in the keyHash when secure-mode
support lands.

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
- **M2 handoff note:** `parseKey()` currently hashes only the 52-char key suffix,
  so `0000<X>` and `s000<X>` collide to the same keyHash. Not a current issue
  (secure-mode is rejected), but when removing `assertPublic()` in this task,
  include the 4-char mode prefix in the hash so aliases/passwords don't
  accidentally gate the wrong key material. See **Known gaps** above.

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
