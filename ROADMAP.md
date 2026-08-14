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

## Scale review (2026-07-26) — DONE ✅

Driven by the question "what happens if a lot of people use this, and is it
safe for the VPS?". 273/273 unit tests pass. Zero new npm dependencies.

| Finding | Fix | Key files |
|---|---|---|
| **Egress amplification, 321x.** Every page embedded ~33KB of base64 font, error pages included. A 116-byte request to any nonexistent subdomain returned 37,280 bytes, needing no key and no auth. Caddy's gzip does not mitigate it — the caller picks the encoding. Worst of all, the **429 page was itself 37KB**, and it is the one response with no per-IP cap on how often it can be elicited, so rate limiting *increased* egress instead of shedding it. | Split `STYLE` into `FONT_FACES + BASE_STYLE`. `errorPage`/`offlinePage` use `LEAN_STYLE` (~4.1KB, 9x smaller); `rateLimitPage` gets a bespoke `MINIMAL_STYLE` (837 bytes, 44x smaller). Pages a visitor deliberately navigates to keep their fonts. | `src/pages.js` |
| **`scryptSync` stalled the whole gateway.** Measured ~30ms per call on the single Node thread, so every password verification froze all tenants' traffic. At `RATE_MAX_REQUESTS=120` one IP could buy ~3.7s of event-loop stall per minute against any password-protected key. | Converted `hashPassword`/`verifyPassword` to async `crypto.scrypt` (libuv threadpool). Max event-loop lag under 8 concurrent verifies: 30ms → **0.8ms**. | `src/auth.js`, `src/server.js`, `src/admin.js` |
| **No bound on concurrent cold creates.** `MAX_TUNNELS` counts *finished* tunnels; `pending` dedupes only same-key creates. The real ceiling was `RATE_MAX_NEW_TUNNELS` × (number of IPs) — unbounded. At a measured ~4MB RSS per tunnel, a distributed burst walks the process into `MemoryMax=768M` and turns a flood into an OOM restart loop. | `MAX_CONCURRENT_CREATES=8` / `MAX_CREATE_QUEUE=64` semaphore in `_createGated`, plus `janus_creates_*` gauges. Queue-full fast-fails 503 + `Retry-After` instead of admitting an unbounded backlog. | `src/tunnel-manager.js`, `src/config.js`, `src/metrics.js` |
| **Late-bind crash after a connect timeout.** `connectWithPortGuard` drops its `pendingPorts` entry on timeout, but holesail-client may still `listen()` afterwards. A late `EADDRINUSE` on a reissued port has no pending attempt to claim it, so the guard classifies it as a real bug and kills the gateway — triggered precisely by the filtered-outbound-UDP condition DEPLOY.md warns about. | `PORT_QUARANTINE_MS=15000` holds timed-out ports out of the pool and absorbs a late collision on them. Scoped narrowly: an `EADDRINUSE` on any non-quarantined port still crashes. Both halves covered by subprocess fixtures. | `src/tunnel-manager.js` |
| **Per-tunnel memory was an unknown.** `deploy/janus.service` shipped `MemoryMax=768M` with the note "nothing bounds how much memory each one's DHT state consumes". | `deploy/measure-tunnel-memory.js` measures it against real backends. **~4.1MB per idle tunnel**, 87.7MB baseline → ~294MB projected at `MAX_TUNNELS=50`, comfortable against 768M. Re-run on the VPS; DHT behaviour is network-dependent. | `deploy/measure-tunnel-memory.js` |
| **Caddy had no compression or slowloris guard.** | `encode zstd gzip`, `read_header 10s`. `read_body`/`write`/`idle` deliberately left unset — they would cut off large uploads, SSE, and the long-lived websockets this gateway supports on purpose. Optional `rate_limit` block documented (needs an xcaddy plugin). | `Caddyfile.example` |

**New env vars** (see `.env.example`): `MAX_CONCURRENT_CREATES`,
`MAX_CREATE_QUEUE`, `PORT_QUARANTINE_MS`.

**Still open from this review:** the Public Suffix List submission — see
"Still open" above. It is the one item that cannot be fixed in code.

---

## Phase 1 — Opt-in project directory — DONE ✅

Shipped in commit: `feat(directory): Phase 1 opt-in listing with manifest opt-in`

An optional directory endpoint (`/directory`, `/directory.json`) listing projects
whose owners opt in via a manifest file on their own backend. Off by default —
operator must set `DIRECTORY_ENABLED=true`. Zero new npm dependencies.

| Feature | Summary | Key files |
|---|---|---|
| Manifest schema + validation | Tenant backends serve `/.well-known/janus-index.json` with `list: true`, title (1–80 chars), optional description (≤200 chars) and tags (max 8, matching `[a-z0-9][a-z0-9-]*`). All failures (timeout, oversized, bad JSON, non-200) de-list rather than error. | `src/directory.js` `validateManifest()` |
| Fire-and-forget manifest fetch | `maybeFetchManifest()` called on every proxied request (with recheck cache so busy tunnels don't re-fetch every request). Fetches over the loopback tunnel port, never the public internet. Swallows all errors — runs off the request path. | `src/directory.js`, `src/server.js` (~:765-771) |
| Liveness tracking | `markOnline`/`markOffline` called on request success/failure. Updates in-memory immediately; only persists when `online` actually flips, so `lastSeenAt` can drift between flips (display-only data, acceptable). | `src/directory.js`, `src/server.js` (~:228, 228, 754, 771), `src/store.js` `touchDirectoryLiveness` |
| `/directory` endpoint | HTML listing, searchable by title/description/tags. Online entries sort first, then by last-seen recency. Offline entries stay listed with timestamps. Entries become visible lazily (first request). | `src/pages.js` `directoryPage()`, `src/server.js` (~:678-691) |
| `/directory.json` | JSON API (same data as `/directory`, same filtering). Enabled/disabled with `DIRECTORY_ENABLED`. | `src/server.js` (~:692-705) |
| Automatic filtering | Password-protected and blocked keys are structurally ineligible and filtered on every render, so blocking or passwording a key de-lists it immediately. | `src/directory.js` `_eligibleNow()`, `list()` |

**New env vars** (see `.env.example`): `DIRECTORY_ENABLED`, `DIRECTORY_MANIFEST_TIMEOUT_MS`,
`DIRECTORY_MANIFEST_MAX_BYTES`, `DIRECTORY_RECHECK_MS`, `DIRECTORY_MAX_ENTRIES`.

**Design notes:** The directory publishes raw keys (unavoidable — the key IS the URL). Listing
is permanent once public and uncrawlable (manifest is consent signal; no takedown path exists
until Phase 2). The only revocation is key rotation, which changes the URL entirely. This is
why listing requires explicit owner opt-in via their own backend file, not an operator form.

**Phase 2 deferred intentionally:** a separate crawler process for full-text search would
require a moderation queue and takedown path BEFORE any crawl begins, not after. That ordering
(policy + human review → then crawl) is the point, and it's explicitly a hard prerequisite, not
a nice-to-have. Phase 1 launches without Phase 2 so listing can work today.

---

## Milestone 2 — Known gaps & follow-ups

### RESOLVED (post-M2 hardening pass)

- **Unclaimed-tunnel eviction race.** `_pickEvictable` only required
  `inFlight === 0`, but `_attemptPortConnect` publishes a new record into
  `this.tunnels` with `inFlight: 0` and the caller only claims it after
  `ensureTunnel`'s `await` resumes. At `MAX_TUNNELS` with every other tunnel
  busy, that unclaimed record was the sole eviction candidate, so a concurrent
  cold create for a different key could destroy it out from under its caller
  (which then proxied through a destroyed client → 502). **Fixed:**
  `_pickEvictable` now also skips records whose keyHash is still in
  `this.pending`, which exactly covers the unclaimed window. Regression tests
  in `test/unit/tunnel-manager-eviction-race.test.js`.
- **Circuit threshold silently coupled to reconnect attempts.**
  `recordFailure` fired once per reconnect *attempt*, so with shipped defaults
  (`RECONNECT_MAX_ATTEMPTS=3` → 4 attempts, then-default
  `CIRCUIT_FAILURE_THRESHOLD=5`) a
  single failed request contributed 4 failures — the circuit opened partway
  through the *second* failed request, and raising `RECONNECT_MAX_ATTEMPTS`
  silently made the breaker more trigger-happy. **Fixed:** exactly one
  `recordFailure` per rejected `_createTunnel`, so the threshold counts failed
  requests as its name and docs claim. The two knobs are now independent.
- **Hardcoded tuning constants promoted to config.** `MAX_PORT_ATTEMPTS` and
  `HEALTH_PROBE_UNHEALTHY_STREAK` were module constants in a codebase where 25+
  less consequential values are env-driven; the latter is the "how twitchy is
  probe-driven eviction" dial. Both are now in `src/config.js` with fail-fast
  validation, keeping their previous values as defaults.

### Still open

Improvements deferred intentionally (low impact, addressed if reported in production):

#### Public Suffix List submission for `BASE_DOMAIN` — ACTION REQUIRED, long lead time

**Status: not started. Needs the operator (GitHub account + a DNS record on the
domain); cannot be done from inside the codebase.** See [`deploy/PSL_SUBMISSION.md`](./deploy/PSL_SUBMISSION.md) for the complete step-by-step runbook.

Every tenant is a subdomain of one registrable domain. Browsers therefore treat
them as *related* sites unless the PSL says otherwise, and the gateway cannot
override that from the server side.

`cookieDomainRewrite: ''` (src/server.js) already strips `Domain=` from
backend `Set-Cookie` **headers**, which closes the header-based half. It cannot
touch cookies a tenant's own JavaScript sets:

```js
document.cookie = 'x=…; domain=.janus.ssani.dev'   // visible to apex + every sibling tenant
```

Tenants are untrusted by design ("anyone can run one and share their key"), so
this is reachable. Consequences, in severity order:

- **Cookie-bombing → cross-tenant DoS.** A tenant writes many large cookies on
  the parent domain; every sibling tenant *and the apex* then send them on
  every request and get rejected with oversized request headers. One tenant can
  deny service to all of them.
- **Admin cookie clobbering → operator lockout.** A tenant can overwrite
  `janus_admin` on the parent domain. `parseCookies` is last-write-wins, and
  browsers do not guarantee host-only cookies are sent before domain cookies.
  **Not privilege escalation** — the session HMAC still fails, and the cookie is
  `HttpOnly` + `SameSite=Strict` + `Path=/_admin`, so it can be neither read nor
  forged — but the operator can be forced out of the dashboard.

**The fix is the PSL.** This is exactly what its private section exists for and
what `*.github.io`, `*.vercel.app` etc. rely on. Once listed, browsers refuse
to set cookies on the parent domain and each tenant becomes a true site
boundary.

Steps (allow **weeks to months** — it must ship in a browser release before it
takes effect anywhere, which is why this should be started early, not when it
is needed):

1. Fork `https://github.com/publicsuffix/list`.
2. Add to the **PRIVATE DOMAINS** section of `public_suffix_list.dat`, in the
   correct alphabetical position:

   ```
   // Janus : https://janus.ssani.dev
   // Submitted by <your name> <ssani.main@gmail.com>
   janus.ssani.dev
   ```

3. Open the PR, then add the `_psl` TXT record they require to prove control:

   ```
   _psl.janus.ssani.dev.  TXT  "https://github.com/publicsuffix/list/pull/<PR-NUMBER>"
   ```

   (Porkbun DNS panel; the record must exist before maintainers will merge.)
4. After merge, rollout is on browser vendors' schedules. Track it at
   `https://publicsuffix.org/list/public_suffix_list.dat`.

**Until it lands**, treat the apex admin dashboard as reachable-but-spammable by
any tenant and prefer the bearer-token JSON API (`Authorization: Bearer
$ADMIN_TOKEN`) over the cookie dashboard for anything important — the bearer
path does not depend on a cookie a tenant can clobber.

#### Port-recycling probe race (low probability, narrow window)
When `_probeTunnels()` snapshots records then probes them asynchronously,
`destroyTunnel()` can release a port mid-probe and `PortPool.acquire()` can
immediately reissue that exact port to a different key. A stale probe's result
could be attributed to the wrong tunnel. No port generation/version tag exists
to detect reuse. **Mitigation:** probe failure streaks destroy tunnels
immediately, so most stale results are irrelevant; risk is only if a port is
recycled *and* a stale probe succeeds wrongly. Not observed in testing.

#### Dual keyHash for `0000<X>` and `s000<X>` keys (operator awareness only)
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

#### Store persistence blocks the event loop, and its cost grows with the store

`store.js#_persist` is synchronous end to end — `openSync` + `writeFileSync` +
`fsyncSync` + `renameSync` + a directory fsync — and it re-serializes the
**entire** store (`JSON.stringify(this.data, null, 2)`) on every mutation.

The file header justifies this with "admin actions are rare," which is true
today and why nothing here needs changing yet. The part worth tracking is that
`data.keys` grows **monotonically**: `_ensureRecord` is called by `setBlocked`,
and the only path that ever removes a record is the explicit `/_admin/delete`
(`store.deleteKey`). So the write cost is a function of every tenant ever
blocked or passworded, not of current activity. At a few thousand records each
admin write becomes a multi-millisecond whole-file fsync **on the event loop**,
stalling every proxied tenant for its duration.

Deliberately not changed: the fsync is load-bearing for durability (S10 — an
acknowledged block that silently vanishes on power loss fails OPEN), so this
must not be "fixed" by weakening it. If it ever needs addressing, the shape is
an append-only journal or a debounced async writer, not a dropped fsync.

**Watch for:** admin dashboard actions feeling sluggish, or `janus_*` request
latencies spiking in lockstep with admin writes.

#### `http-proxy` is unmaintained, and the dependency surface is wider than "two"

Two separate things that both read as more reassuring than they are:

- **`http-proxy@1.18.1` is "latest" only because it is the final release.**
  Published 2020; the newer registry timestamp is metadata, not a release. It
  is clean today (`npm audit` → 0 vulnerabilities) and sits directly on every
  request path. Under the deliberate no-new-dependencies constraint there is no
  drop-in replacement, so this is a **standing, accepted risk to monitor**, not
  a task — but "we're on the latest version" will keep being technically true
  forever, which is exactly why it needs writing down.
- **"Two dependencies" is true of *direct* dependencies only.** A fresh
  `npm install` resolves **73 packages**; the tree under `holesail-client` is
  deep (`hyperdht`, `dht-rpc`, `udx-native`, the whole `bare-*` family, native
  addons via `require-addon`). The two-direct-dep rule is real and worth
  keeping — but the *audited surface* is not two packages, and README/
  THIRD_PARTY.md should not leave a reader believing otherwise.

Upside: the Pear/Holepunch stack underneath is actively maintained — `hyperdht`
last published 2026-08-12. Transitive DHT versions float within
`holesail-client`'s `^` ranges, so `npm update` lifts them with no manifest
change; do it deliberately and run `npm run test:e2e`, since that layer carries
every tenant's traffic.

#### Per-key password lockout map has no hard size cap (low)

`server.js`'s `pwFails` map (F2) is bounded only by its prune rule, not by a
size limit. Self-limiting in practice: a locked-out attempt returns 429
**without** calling `pwNoteFailure`, so `lastAt` is not refreshed while locked
— an attacker can only keep an entry alive by waiting out each
exponentially-growing lockout and spending a fresh counted failure, which costs
the same as simply attacking. Structurally identical to `admin.js`'s
`loginFails` (S8) and `rate-limit.js`'s `buckets`, both already accepted.

The more interesting half is **CPU, not memory**: the prune is an O(n) scan of
the whole map on every password POST — a path whose frequency an attacker
controls. `admin.js` has the same shape, so this is a pre-existing pattern
rather than something F2 introduced. Now observable via
`janus_pw_lockout_entries`; add a size cap with LRU eviction only if that gauge
is ever seen climbing in production.

---

## Security backlog (audit 2026-07-17)

These findings came from a multi-dimension audit of the code as of commit
c503e04; **S1 and S2 were fixed on 2026-07-18; S3 and S4-mitigation were fixed on 2026-07-19; S8, S9, S11, S12, S13 were fixed on 2026-07-19 — the entire original backlog (S1–S13, plus S4-as-mitigated) was resolved as of 2026-07-19. S14 (`/_admin/kill`/`/_admin/unblock` missing CSRF/Origin protection) was found and fixed separately on 2026-07-27** — no findings remain open, and all severities assume the Linux deploy
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

> **Arithmetic updated (post-M2 hardening):** `recordFailure` now fires once
> per failed `ensureTunnel`, not once per attempt, and the default threshold
> is 2. The numbers above are the state at audit time. **The conclusion is
> unchanged and if anything stronger:** 1 < 2, so a single-use fake key —
> each request using a distinct key — still never opens its own circuit. A
> per-keyHash breaker cannot mitigate an attack whose whole shape is one key
> per request; the mitigation is the per-IP new-tunnel limiter, as stated
> below.

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

> **Resolved 2026-07-18 (purge-on-clear):** `clearAlias` in `src/store.js` now nulls `record.rawKey` when the record has no password (`if (!record.password) record.rawKey = null`), and `clearPassword` symmetrically nulls it when the record has no alias (`if (!record.alias) record.rawKey = null`) — so clearing a tenant's alias (or password) now actually removes the live credential from disk once no other feature still needs it. The asymmetric guards are required because `setAlias` and `setPassword` both store `rawKey`. **Update 2026-07-19:** the fuller fix is now also implemented — `store.deleteKey(keyHash)` fully removes a stored record (the only bound on record growth) and is exposed as a CSRF-protected `POST /_admin/delete` with a 'Delete' button per dashboard row. A **blocked** record is preserved (credential/alias/password purged, `blocked` flag kept) so deleting an abusive tenant can't silently un-block them. Regression tests in `test/unit/store.test.js` and `test/unit/admin.test.js`.

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
non-aliased key. Fuller fix (implemented 2026-07-19): `deleteKey(keyHash)` drops the record and
its alias entry, exposed as a CSRF-protected dashboard delete button — also the only real bound on
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

#### S14. ✅ FIXED (2026-07-27) — `/_admin/kill` and `/_admin/unblock` had no CSRF/Origin check at all, and SameSite=Strict does not actually stop it

> **Resolved 2026-07-27:** unlike S13, this one is NOT inert under
> SameSite=Strict. SameSite is scoped to the registrable domain (eTLD+1), not
> the origin, and with `BASE_DOMAIN` in play the admin origin
> (`https://<BASE_DOMAIN>`) and every tenant origin
> (`https://0000<key>.<BASE_DOMAIN>`) are the SAME SITE. Tenants serve
> attacker-controlled HTML on those subdomains, so a tenant page can
> auto-submit a same-site cross-origin POST directly to `/_admin/kill` — both
> endpoints take their params from `url.searchParams`, so no request body is
> even needed — and the browser still attaches the `SameSite=Strict` cookie.
> Fixed by adding `isOriginAllowed()` (`src/admin.js`) to every
> cookie-authenticated mutating endpoint (kill, unblock, alias, password,
> block, delete, logout), and additionally requiring a valid CSRF token
> (bound to `session.sid`, passed as a query param) on the cookie path for
> kill/unblock specifically. The Bearer path is untouched for all of the
> above — bearer tokens are never auto-attached by a browser, so they cannot
> be CSRF-driven, and requiring Origin/CSRF from bearer scripts would break
> the documented API for no security benefit. Tests in
> `test/unit/admin-origin-csrf.test.js`, including the regression case (a
> same-site sibling-subdomain Origin must be rejected, not just a foreign
> one).

**Where:** `src/admin.js` — the `/_admin/kill` and `/_admin/unblock`
handlers, which predate the dashboard (they're the original Bearer-only
Phase 3 JSON API); `cookieValid` was later OR'd into their auth check without
either endpoint ever gaining CSRF or Origin protection.

**Issue:** a password-protected tenant, or any tenant whose operator embeds
attacker-supplied content, could serve a page that POSTs to
`https://<BASE_DOMAIN>/_admin/kill?keyHash=...&block=1` and have it succeed
against any admin who is currently logged into the dashboard in the same
browser — full tunnel takedown/block with zero interaction beyond visiting a
tenant page.

**Fix:** `isOriginAllowed()` (exact scheme+host+port match, no
suffix/BASE_DOMAIN comparison — a suffix match would accept the exact
attacker origin this exists to reject) plus a CSRF token requirement on the
cookie path for kill/unblock.

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
