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

## Security backlog (audit 2026-07-17)

These findings came from a multi-dimension audit of the code as of commit
c503e04; **S1 and S2 were fixed on 2026-07-18; S3 and S4-mitigation were fixed on 2026-07-19; S8, S9, S11, S12, S13 were fixed on 2026-07-19 — the entire security backlog (S1–S13, plus S4-as-mitigated) is now resolved; no findings remain open**, and all severities assume the Linux deploy
target documented in [DEPLOY.md](./DEPLOY.md).

### CRITICAL

#### S1. ✅ FIXED (2026-07-18) — Cross-tenant cookie injection (no `cookieDomainRewrite`)

> **Resolved 2026-07-18:** `cookieDomainRewrite: ''` is now set on the shared `httpProxy.createProxyServer()` options in `src/server.js`, so every `proxy.web()` strips the `Domain=` attribute from backend `Set-Cookie` headers (host-only cookies). Regression test: `test/unit/server-cookie-domain-rewrite.test.js`.

**Where:** `src/server.js` — the `proxy.web()` and `proxy.ws()` call sites;
`httpProxy.createProxyServer` options.

**Issue:** Tenant backends are UNTRUSTED (anyone can run one and share a key).
http-proxy's `web-outgoing.js` copies every backend response header verbatim,
including `Set-Cookie`, unless `cookieDomainRewrite` is set. It is not set on
either call. A malicious tenant backend responds `Set-Cookie: pwned=1;
Domain=<BASE_DOMAIN>; Path=/`. Per RFC 6265 that cookie is then valid for the
apex AND every sibling tenant subdomain. **Cross-tenant session fixation:**
attacker plants a chosen cookie value via their own tenant page; the victim
later visits tenant B's app, which reads that cookie name as its own session.

Sub-case: a backend can also emit `janus_admin`/`janus_auth` cookies scoped to
the apex. It cannot forge a VALID signed value (the HMAC secret is unknown to
backends), so that specific sub-case is nuisance-level — forces spurious
re-auth — not an auth bypass. The general cross-tenant app-cookie leak is the
real issue.

**Reproduced:** a local http-proxy instance configured exactly as Janus
configures it (`{xfwd: true, proxyTimeout: 30000}`) passed `Set-Cookie:
pwned=1; Domain=gw.example.com; Path=/` through to the visitor unmodified.

**Fix:** pass `cookieDomainRewrite: ''` on BOTH `proxy.web()` and `proxy.ws()`
— http-proxy supports this natively and it strips `Domain=`, forcing
host-only cookies. Consider `cookiePathRewrite` as defence-in-depth against
`/_admin` path collisions.

#### S2. ✅ FIXED (2026-07-18) — Rate limiter buckets on an attacker-controlled value (X-Forwarded-For spoofing)

> **Resolved 2026-07-18:** fixed at both layers — the `Caddyfile` now sets `header_up X-Forwarded-For {remote_host}` (Caddy overwrites rather than appends), and `clientIp()` in `src/server.js` now reads the XFF entry indexed from the RIGHT by the new `TRUSTED_PROXY_HOPS` config (default 1, validated `>= 1` when `TRUST_PROXY`), so a client-spoofed leftmost entry can't win even if Caddy is misconfigured. Regression test: `test/unit/server-xff-spoofing.test.js`.

**Where:** `src/server.js` `clientIp()` (~:142-150); `src/config.js`
`TRUST_PROXY` (~:62, defaults **true**); `Caddyfile` (~:43-45).

**Issue:** `clientIp()` returns `String(xff).split(',')[0].trim()` — the
LEFTMOST XFF entry — whenever TRUST_PROXY is true. Caddy's `reverse_proxy`
APPENDS to an existing X-Forwarded-For rather than replacing it, and the
shipped Caddyfile sets no `trusted_proxies` and no `header_up
X-Forwarded-For` override. So a client-supplied XFF stays leftmost all the way
to Node.

**Reproduced against the real server:** sent `X-Forwarded-For: 6.6.6.6` from
127.0.0.1; the gateway's own JSON request log recorded `"ip":"6.6.6.6"` and
bucketed the request under it. Every per-IP limit (`RATE_MAX_REQUESTS`,
`RATE_MAX_NEW_TUNNELS`) is bypassable by rotating a fake header per request.

The code comment at config.js:55 states the safety assumption — "a proxy we
control ... that overwrites/sets X-Forwarded-For itself" — which the shipped
Caddyfile does not implement.

**This is a force multiplier: it is what escalates S4 from IMPORTANT to
CRITICAL.** Fix this one first.

**Fix:** either set `header_up X-Forwarded-For {remote_host}` in the Caddyfile
so Caddy overwrites rather than appends, or configure `trusted_proxies`, or
change `clientIp()` to index from the RIGHT by a configured trusted-hop count.
The Caddyfile fix is smallest; the `clientIp()` fix is the one that's robust
to a misconfigured deployment.

#### S3. ✅ FIXED (2026-07-19) — Websockets pin tunnels permanently — gateway-wide DoS

> **Resolved 2026-07-19 (both parts, per the decided fix):** (a) websockets can now pin at most `WS_MAX_SLOTS` distinct tunnel slots (default ~60% of `MAX_TUNNELS`, validated `< MAX_TUNNELS` so HTTP always keeps headroom) plus a per-IP cap `WS_MAX_PER_IP` (default 16); a new ws to an already-ws-pinned key is free, so a legit app with many connections to ONE key is unaffected — only the many-distinct-keys attack shape is capped. Slot accounting lives on `TunnelManager` (`canAcceptWs`/`acquireWs`/`releaseWs`, per-record `wsCount`, `destroyTunnel` decrements safely). (b) An idle timeout `WS_IDLE_TIMEOUT_MS` (default 3600000 = 1h, `0` disables) reclaims genuinely-silent sockets via `socket.setTimeout` (refreshes on read AND write, so heartbeating/server-push sockets are never cut) — set AFTER `proxy.ws()` because http-proxy's setupSocket calls `socket.setTimeout(0)`. New `/metrics`: `janus_ws_slots`, `janus_ws_slots_max`, `janus_ws_rejected_total`. Regression tests: `test/unit/tunnel-manager-ws-slots.test.js` and `test/unit/server-ws-idle-timeout.test.js`. NOTE: with S1, S2, S3, S4-mitigation, S5, S6, S7, S10 done, S3 was the last CRITICAL.

**Where:** `src/tunnel-manager.js` — `inFlight` increments at ~:435 (cached
reuse), ~:465 (pending reuse), ~:487 (cold-create); `manager.release()`
~:764-769; `_pickEvictable` ~:750; sweeper ~:906-922. `src/server.js` — ws
upgrade handler ~:626, release wiring ~:638-645.

**Issue:** `inFlight` is decremented ONLY by `socket.on('close')`. For a
websocket the attacker holds open, that never fires — there is no timer, no
periodic re-check, no idle kill. `PROXY_TIMEOUT_MS` deliberately does not apply
to ws (http-proxy's ws pass never reads `proxyTimeout`; this was intentional,
so long-lived connections survive), and there is no `socket.setTimeout()` on
the upgrade path.

`inFlight > 0` blocks BOTH reclamation paths: `_pickEvictable` skips it under
capacity pressure, and the idle sweeper requires `inFlight === 0`. Nothing in
the codebase reclaims a tunnel with `inFlight > 0` except the operator's
`/_admin/kill`.

Attacker cost, precisely: `MAX_TUNNELS` default 50. Each ws occupies one tunnel
record, keyed by keyHash, so 50 slots needs 50 DISTINCT keys that each
genuinely cold-create — i.e. 50 real, self-run holesail-client backends
(trivially scriptable, no victim infrastructure, but real). Fake keys do NOT
work here (they fail the cold create and never produce a record).
`RATE_MAX_NEW_TUNNELS` (10/60s/IP) gates the RATE but not the outcome: a single
un-spoofed IP fills all 50 slots in ~5 minutes. With S2, instantly.

**Decided fix (both, per operator decision):** (a) cap the tunnel slots
websockets may occupy, per key and/or per IP, so ws can never starve HTTP
traffic; AND (b) add an idle timeout driven by ws frame activity, closing
genuinely-idle connections. The cap bounds blast radius without touching
existing connection lifetimes; the idle timeout actually reclaims a pinned
tunnel. The idle window must be generous or heartbeat-aware — a legitimate
notifications socket can be silent for hours, and severing it would be a real
regression.

#### S4. Port-pool exhaustion via fake-key cold-creates — severity derived from S2

> **Update 2026-07-18:** with S2 now fixed, S4 is demoted from CRITICAL to IMPORTANT — the single-source escalation depended on S2's spoofable per-IP limiter. The finding itself remains open.

**Where:** `src/tunnel-manager.js` `_createTunnel` ~:507-574,
`_attemptPortConnect` ~:595-685 (`portPool.acquire()` ~:612, `release()` ~:642);
`src/key.js` `parseKey` ~:27-68.

**Issue:** `parseKey` validates only length (52) and z-base-32 alphabet —
never the DHT. So a random 52-char subdomain "parses", yields a fresh
never-seen keyHash, and drives a full cold create. `portPool.acquire()`
reserves a real port BEFORE any network I/O.

Precise mechanics: one port is held per attempt for up to `CONNECT_TIMEOUT_MS`
(8s default), then released; the port-collision retry loop does NOT engage
(the failure isn't EADDRINUSE), so never multiple ports at once per request. Up
to 4 attempts with backoff gaps where no port is held. `ENSURE_TUNNEL_TIMEOUT_MS`
(45s) bounds total request duration — NOT continuous port occupancy.

Pool = `TUNNEL_PORT_MIN` 20000..`TUNNEL_PORT_MAX` 20999 = 1000 ports.
Exhaustion therefore needs ~1000 CONCURRENT in-flight attempts each inside its
~8s window — not 1000 total over time.

`pending` dedupe gives zero mitigation (it's per-keyHash; the attack uses a
distinct key per request). The circuit breaker gives zero mitigation: one
`ensureTunnel` calls `recordFailure` at most 4 times (attempts 0..3) but
`CIRCUIT_FAILURE_THRESHOLD` is 5 — **4 < 5, so a single-use fake key's circuit
never opens**, and its stale entry is swept after the cooldown.

Victim experience: a legitimate tenant's cold create hits
`portPool.acquire()` throwing "port pool exhausted", wrapped into
`ConnectError` → HTTP 502 with the generic message — indistinguishable from a
genuinely dead backend.

**Severity is contingent, state this plainly:** with an honest per-IP limiter
this needs ~100 real source IPs (IMPORTANT). **With S2 present — the
codebase's current actual state — it collapses to a single-source attack
(CRITICAL).** Fixing S2 demotes this to IMPORTANT without touching
tunnel-manager.js or port-pool.js at all.

**Fix directions:** cap concurrent in-flight cold-creates globally (not just
per-IP), and/or require some proof-of-liveness before reserving a pool port.

### HIGH

#### S5. Store file is world-readable and holds plaintext raw keys

**Where:** `src/store.js` `_persist` (~:94-108, `fs.writeFileSync(tmpPath,
json, 'utf8')` ~:98 — no `mode`); [DEPLOY.md](./DEPLOY.md) (~:8-34).

**Issue:** Node's `'w'` opens O_CREAT at 0o666 & ~umask; the systemd unit sets
no `UMask=`, so systemd's default 0022 applies → **0644, world-readable**.
`renameSync` preserves the inode's mode, so the final file is 0644 too.
DEPLOY.md says `chmod 600 .env` and says nothing about `janus-data.json` —
which holds strictly more dangerous material.

Contents: `record.rawKey`, the plaintext public-mode Holesail key, plus scrypt
password hash+salt. Any local unprivileged user, sidecar, backup agent, or
container sharing the volume reads it and reaches every aliased tenant's
backend DIRECTLY via `holesail --connect <key>` — bypassing the blocklist, the
password gate, rate limiting, logging, and the admin kill switch (all of which
are gateway-side; the DHT knows nothing about them). The password-hash exposure
is dominated by this — no point cracking scrypt when the key beside it grants
direct access.

Storing rawKey IS required (`getByAlias` must return a dialable key; a hash
can't be reversed). Encrypting at rest just moves the secret and is defeated by
the same local reader. **File permissions are the correct and sufficient
control — this is a fix, not a mitigation.**

Two subtleties that MUST survive into the writeup:

1. **`chmod`-after-write does not close the window.** Unix checks permissions at
   `open(2)`, not per `read(2)`. An attacker who wins the race by a microsecond
   holds a valid fd on that inode forever and re-reads at leisure, after your
   chmod and after the rename. The race is "once won, permanently won", not
   "narrow".

2. **A random tmp suffix is mandatory, not cosmetic.** Node applies `mode` only
   when O_CREAT actually creates the file. A leftover `.tmp.<pid>` from a crash
   — routine under `Restart=always`, and pids get reused — means `writeFileSync`
   truncates and writes but silently keeps the old 0644. A fixed `.tmp.<pid>`
   name PLUS a `mode:` argument therefore still ships a world-readable store,
   intermittently, which is the worst possible failure mode for a permissions
   bug.

**Fix:** create the tmp file with `mode: 0o600` AND a random suffix
(`.tmp.<pid>.<random>`); add `UMask=0077` to the systemd unit as
defence-in-depth; add a `chmod 600 janus-data.json` line to DEPLOY.md for
already-deployed boxes (the code fix only governs newly created files).

#### S6. Orphaned tmp files survive crashes with full plaintext

**Where:** `src/store.js` ~:94-108; the `unlinkSync` cleanup at ~:102 runs
ONLY in the catch — i.e. only if the write throws and the process survives.

**Issue:** SIGKILL/OOM/power-loss between `writeFileSync` and `renameSync`
leaves `janus-data.json.tmp.<pid>` at 0644 with a complete copy of every
rawKey. Nothing ever removes it: no startup sweep in `Store.load`, no reaper.
`Restart=always` makes crash cycles routine.

Amplifies S5 past operator remediation: an operator who runs `chmod 600
janus-data.json` believes they're fixed; the orphan beside it is still 0644 and
still holds every key. `.gitignore` does carry `*.json.tmp.*`, so these don't
reach the repo — the repo lifetime was considered; the on-disk lifetime wasn't.

**Fix:** S5's `mode: 0o600` makes orphans inert at creation. Add a
best-effort sweep in `Store.load` for `<basename>.tmp.`-prefixed siblings —
with random tmp names a sweep becomes the only way orphans are ever reclaimed.

#### S7. ✅ FIXED (2026-07-18) — `clearAlias` never clears `rawKey` — the plaintext secret cannot be deleted through any interface

> **Resolved 2026-07-18 (purge-on-clear):** `clearAlias` in `src/store.js` now nulls `record.rawKey` when the record has no password (`if (!record.password) record.rawKey = null`), and `clearPassword` symmetrically nulls it when the record has no alias (`if (!record.alias) record.rawKey = null`) — so clearing a tenant's alias (or password) now actually removes the live credential from disk once no other feature still needs it. The asymmetric guards are required because `setAlias` and `setPassword` both store `rawKey`. The fuller `deleteKey()` + dashboard-button variant (full record removal, a bound on record growth) was intentionally deferred per operator decision; note it as remaining follow-up. Regression tests: `test/unit/store.test.js`.

**Where:** `src/store.js` `clearAlias` ~:203-214. Sets `record.alias = null`
but leaves `record.rawKey` untouched. `rawKey` is set at ~:192-193 (`setAlias`)
and ~:224 (`setPassword`) and **nothing in the codebase ever sets it back to
null. There is no `deleteKey`/`removeRecord` method at all** — records are
append-only for life.

**Issue:** Clearing alias/blocked/password but not rawKey looks deliberate
(keep record identity), but rawKey is the one field that is a LIVE CREDENTIAL
and it gets the same treatment as inert metadata.

Scenario: tenant offboards, operator clicks "Clear alias", reasonably reports
the data is gone. It isn't — rawKey remains verbatim, forever, at 0644 (S5). A
local attacker harvests keys for tenants who left months ago, whose backends
are still reachable (a Holesail public key stays valid until rotated, and an
offboarded tenant has no reason to rotate). No operator action short of
hand-editing the JSON removes it. Also a data-retention/GDPR problem for an
operator running an Impressum page.

**Fix:** in `clearAlias`, when the record retains no other reason to hold the
key, drop it — `if (!record.password) record.rawKey = null`. The
`!record.password` guard is REQUIRED: `setPassword` legitimately stores rawKey
independently of aliasing, so an unconditional null-out breaks a passworded
non-aliased key. Fuller fix: add `deleteKey(keyHash)` dropping the record and
its alias entry, exposed as a dashboard button — also the only real bound on
record growth.

### IMPORTANT

#### S8. ✅ FIXED (2026-07-19) — No login rate limiting; failed login returns 200; no ADMIN_TOKEN entropy check

> **Resolved 2026-07-19:** `/_admin/login` now enforces a per-IP failed-attempt lockout with exponential backoff (`ADMIN_LOGIN_MAX_FAILS` default 5, `ADMIN_LOGIN_LOCKOUT_MS` default 60000, capped at 2^6×), returns **401** (not 200) on a wrong token and **429 + Retry-After** while locked, logs failures (ip + timestamp + count, never the token), and `config.js` fail-fasts if a set `ADMIN_TOKEN` is < 16 chars. Regression tests in `test/unit/admin.test.js`.

**Where:** `src/admin.js` ~:179-194.

**Issue:** `/_admin/login` shares the generic per-IP budget (120/min) with
every route — no per-endpoint lockout, no backoff, no failed-attempt logging
anywhere in `handleAdmin`. Failure returns `sendHtml(res, 200, ...)`, not 401,
so log-based brute-force detection can't distinguish a failed login from a page
render. No minimum-length/entropy check on ADMIN_TOKEN in config.js. With S2,
the per-IP budget isn't even a real bound.

**Fix:** dedicated failed-login counter with exponential lockout, log failures
(IP + timestamp, never the token), return 401, and fail-fast in config.js if
ADMIN_TOKEN is short.

#### S9. ✅ FIXED (2026-07-19) — CSRF token is static per ADMIN_TOKEN, not per session

> **Resolved 2026-07-19:** login now mints a per-session random `sid` carried in the signed admin cookie, and every CSRF token is bound to `session.sid` instead of the static `tokenHash`, so a leaked token isn't valid across sessions or after re-login. Tests assert cross-session isolation in `test/unit/admin.test.js`.

**Where:** `src/auth.js` `csrfToken` ~:133-135; call sites `src/admin.js`
~:213, ~:288, ~:326, ~:346 all pass `tokenHash` (sha256 of ADMIN_TOKEN) —
never a per-login nonce or timestamp. Every operator session, past and
present, gets the identical CSRF value until ADMIN_TOKEN is rotated. A single
leak (referrer, browser history sync, a screenshot, log scraping) is valid
forever, and it can't be invalidated without rotating the admin token itself.

**Not exploitable today without a leak vector** — SameSite=Strict is doing
the real work — but it's a static shared secret shaped like a nonce.

**Fix:** bind to `iat` plus a random per-login value stored in the session
payload, generated fresh at login.

#### S10. ✅ FIXED (2026-07-18) — No fsync — an acknowledged admin action can silently vanish, failing OPEN

> **Resolved 2026-07-18:** `_persist()` in `src/store.js` now `fsync`s the tmp file's fd before the rename (durable data) and best-effort `fsync`s the parent directory after the rename (durable directory entry), so an acknowledged admin action survives an immediate power loss. The dir fsync is guarded for platforms that can't fsync a directory handle (e.g. Windows); the Linux deploy target supports it. Folded into the S5 `openSync`-based write. Regression test: `test/unit/store-permissions.test.js`.

**Where:** `src/store.js` ~:98-99.

**Issue:** `writeFileSync` returns at the page cache; no fsync on the fd, none
on the parent dir. `renameSync` is atomic w.r.t. concurrent readers but is not
durable. The module comment at ~:3-7 claims a crash mid-write "never corrupts
the store" — true for CORRUPTION, false for DURABILITY, and the gap isn't
acknowledged.

Scenario: operator blocks an abusive tenant, gets a 302 back (a UI
acknowledgement), box loses power seconds later, store reverts, tunnel is
serving again unblocked, silently. Same for `clearPassword` — a revocation
that silently un-revokes. Fails open, with no signal.

**Fix:** `openSync` with mode (folds in S5), `fsyncSync` the fd, then rename,
then fsync the parent dir — guard the dir fsync for Windows dev. Admin
actions are rare; the cost is nil.

#### S11. ✅ FIXED (2026-07-19) — `listMetadata()` returns rawKey and password material

> **Resolved 2026-07-19:** `store.listMetadata()` now projects onto a strict allowlist (`keyHash`, `alias`, `blocked`, `hasPassword` boolean, `createdAt`, `updatedAt`) at the source, so `rawKey` and password hash/salt can never leak through the admin API even if a caller spreads it. `admin.js` buildRows reads the `hasPassword` boolean. Test in `test/unit/store.test.js`.

**Where:** `src/store.js` ~:262-267 spreads the whole record — `rawKey`,
`password.hash`, `password.salt`.

**No leak today**, and say so explicitly: the only consumer, `buildRows`
(`src/admin.js` ~:126-151), projects onto a strict allowlist and passes
`hasPassword` as a boolean. The finding is that the boundary is one careless
line from collapsing and the method name gives no warning — `sendJson(res, 200,
store.listMetadata())` is the most natural thing a future contributor writes
when asked for a JSON dashboard, and it would dump every tenant's raw key over
the network.

**Fix:** project inside `listMetadata` so the allowlist is enforced by the API
rather than by convention at one call site (note `admin.js:140` needs
`hasPassword` passed through explicitly, since `!!undefined` would silently
become false).

#### S12. ✅ FIXED (2026-07-19) — No `Cache-Control: no-store` on admin responses

> **Resolved 2026-07-19:** `admin.js` `sendHtml`/`sendJson` now set `Cache-Control: no-store` on every admin response. Test in `test/unit/admin.test.js`.

**Where:** `src/admin.js` — every `sendHtml`/`sendJson` omits it (the only
`no-store` in the tree is `/metrics` in server.js). The dashboard renders
keyHashes, aliases, ports, and the live CSRF token. Back/forward cache on a
shared machine, or a misconfigured intermediate cache, exposes it.

**Fix:** add to `sendHtml`/`sendJson`.

#### S13. ✅ FIXED (2026-07-19) — `/_admin/logout` does not verify CSRF

> **Resolved 2026-07-19:** `/_admin/logout` now applies the same `verifyCsrf` gate as the other mutating form endpoints (bound to `session.sid`). Test in `test/unit/admin.test.js`.

**Where:** `src/admin.js` ~:196-203, though the form in pages.js does send one.

**Issue:** Inert today (SameSite=Strict blocks the cross-site POST), but the
header comment at `admin.js` ~:11-16 claims all cookie-reachable endpoints are
CSRF-protected, which is false for this one.

**Fix:** add the same `verifyCsrf` gate the other form endpoints use.

### Cleared by the audit — do NOT re-litigate

The following were traced and found SOUND. This records what stopped the next
reader wasting effort or breaking something:

- **Client aborts cannot open a circuit against a healthy backend.** Verified
  with real loopback repro scripts across four scenarios (abort pre-response,
  abort mid-stream, abort mid-chunked-upload, malformed chunked body).
  http-proxy's own guard in `web-incoming.js` (`if (req.socket.destroyed &&
  err.code === 'ECONNRESET') return`) absorbs them, so `proxy.on('error')`
  → `recordFailure` is never reached. This was the top design concern for
  Milestone 2's breaker; it's a real mitigation, not luck.

- **Session forgery:** `verifySession` recomputes the HMAC over the literal
  received string before touching JSON, length-guards before `timingSafeEqual`,
  try/catches decode/parse, and requires a finite `iat`. No crash path, no
  bypass.

- **Token binding:** rotating ADMIN_TOKEN changes `tokenHash` and invalidates
  every outstanding session. `session.th` uses plain string equality, but `th`
  is a public hash — no usable timing channel.

- **`pwdVersion` monotonicity is airtight:** the counter lives on the record
  and is bumped BEFORE `password` is nulled, so it outlives the object it
  describes; set→1, clear→2, set→3. A cookie at pv=1 can never revalidate.
  Residual (LOW): pwdVersion lives only in the store while SESSION_SECRET is
  stable across restarts, so restoring a store from backup within the 7-day
  SESSION_TTL_MS resurrects revoked sessions — worth a DEPLOY.md line saying
  rotate SESSION_SECRET after a store restore.

- **Websockets cannot bypass a per-key password gate** — the ws path
  independently verifies the session before `ensureTunnel`; no divergence from
  HTTP.

- **Cookie scoping:** `janus_admin` has no `Domain` attribute, so it's
  host-only to the apex; a tenant subdomain cannot read or set it. (Note this
  is exactly what S1 threatens from the other direction.)

- **Concurrent admin writes have no lost-update race** — every store mutator
  is fully synchronous with no `await` inside, so Node's event loop can't
  interleave two. **This is a correctness property, not a perf shortcut: do not
  "optimize" `_persist` into `fs.promises`** — that would introduce the race
  that doesn't exist today.

- **Load fail-fast is correct** and temp+rename genuinely prevents torn reads:
  `this.path` is only mutated by `renameSync`, so a reader sees the complete
  old inode or the complete new one.

- **Prototype pollution is not exploitable — but not for the reason the
  comments claim, and this is a live refactor hazard.** `ALIAS_RE =
  /^[a-z0-9-]{1,63}$/` **accepts `constructor`**, `prototype`, `toString`,
  `valueOf`. It rejects `__proto__` only incidentally (`_` isn't in the
  character class). The regex is NOT what stops this — `Object.create(null)`
  on `data.keys`/`data.aliases` (`store.js` ~:22, re-normalized on load
  ~:82-83) is the SOLE defence. The comment at `src/admin.js` ~:41-45 claims
  keyHash validation guards the alias path; it does not — `admin.js` ~:279
  passes `form.get('alias')` to `setAlias` with no KEYHASH_RE check, correctly,
  since an alias isn't a hash. **Anyone who reads that comment and concludes
  the null-prototype maps are redundant would reintroduce the vulnerability
  instantly. Correcting that comment is the actual action item here.**

- **Alias shadowing of infrastructure hostnames** is not reachable: aliases
  need an authenticated admin (no squatting attacker); explicit DNS records beat
  the wildcard, so a `mail` alias never sees that traffic; `_`-prefixed names
  (`_acme-challenge`, `_dmarc`) are rejected by ALIAS_RE, which incidentally
  protects Caddy's DNS-01 challenge; `www` is reserved for reachability, not
  security; the 63-char cap matches the DNS label limit.

- **Store growth is not attacker-reachable:** every growth path
  (`setBlocked`/`setAlias`/`setPassword`) is admin-authenticated; the visitor
  path is read-only. No unauthenticated DoS ceiling exists.

### Recommended fix order

1. **S2 (XFF)** — smallest fix, and it demotes S4 from CRITICAL to IMPORTANT
   for free.
2. **S1 (cookieDomainRewrite)** — one option on two call sites, closes a
   confirmed cross-tenant compromise.
3. **S5 + S6** — `mode: 0o600` + random tmp suffix. One-line-ish change
   closing a full tenant-compromise primitive.
4. **S7** — null rawKey in clearAlias. Highest value per line after the above.
5. **S3** — websockets: cap slots AND idle-timeout (decided).
6. **S10, S11, S8, S9, S12, S13** — the rest.
7. **Comment corrections** (`admin.js` ~:41-45 prototype-pollution overclaim;
   `store.js` ~:3-7 atomicity-vs-durability; `store.js` ~:5
   sync-writes-are-correctness). No behaviour change, but these are what stop
   S1–S7 being reintroduced by a well-meaning refactor.

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
