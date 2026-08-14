# Janus — working notes for Claude Code

Gateway that turns a Holesail P2P key into a public HTTPS site. The key is
encoded into the subdomain (`0000<52-char-key>.<BASE_DOMAIN>`), so routing is
stateless, every tenant gets its own browser origin, and visitors install
nothing. Node 20+, CommonJS, deliberately only two runtime dependencies
(`holesail-client`, `http-proxy`).

Read [`GATEWAY_DESIGN.md`](./GATEWAY_DESIGN.md) for the design,
[`ROADMAP.md`](./ROADMAP.md) for open work and the audit backlog.

## If you are here to deploy

Follow [`DEPLOY.md`](./DEPLOY.md) top to bottom. **Start with
`deploy/preflight.sh`** — it is read-only and catches the two environmental
failures that otherwise cost an afternoon each:

- **Outbound UDP filtered by the provider.** HyperDHT holepunching then never
  works *while the apex page looks perfectly healthy*, so the gateway gets
  blamed for a network problem.
- **Porkbun API access is off.** It is gated per domain and ships disabled, so
  every DNS-01 challenge fails with an error that looks like a broken Caddy
  config.

Target deployment is `BASE_DOMAIN=janus.ssani.dev`, DNS on Porkbun, Caddy in
front for wildcard TLS. Two things bite people here:

- `.dev` is **HSTS-preloaded as a whole TLD**. Browsers refuse plain HTTP with
  no click-through. If the cert fails to issue the gateway is *unreachable*,
  not merely insecure — watch `journalctl -u caddy -f` until certs actually
  issue before sharing any link. Test locally with curl and an explicit `Host`
  header, never a browser.
- The real `Caddyfile` is **gitignored**. Copy `Caddyfile.example` and edit it;
  do not expect a tracked one.

**Run exactly one instance.** The tunnel pool, port pool, rate limiter and
JSON store are all per-process — in memory or a single file. Two instances
fight over tunnel ports and interleave writes to the store.

## Commands

```sh
npm run check      # node --check every src module (no build step exists)
npm test           # 273 unit tests, no network (2 skip off Linux: POSIX mode bits)
npm run test:e2e   # 7 tests against real Holesail tunnels; needs devDependencies
```

CI runs unit tests on Node 20 and 22; the e2e job is non-blocking because
holepunch is flaky on hosted runners.

## Conventions

- **No new npm dependencies unless unavoidable.** The two-dependency footprint
  is a deliberate design constraint, not an accident. Use Node built-ins.
- **Never log or render a raw key** — use `keyHash`. A raw key is the bearer
  credential for its backend.
- **All HTML rendering lives in `src/pages.js`**, which owns `escapeHtml`.
  `admin.js` deliberately builds no markup of its own — it calls
  `adminLoginPage` / `adminDashboardPage`. Keep it that way so escaping has
  exactly one home.
- Every source module must pass `npm run check`.
- New tests go in `test/unit/` using `node:test`. If a test binds TCP ports,
  register its range in `test/unit/fixtures/port-ranges.js` — test files run in
  parallel and `port-ranges.test.js` mechanically enforces that ranges are
  disjoint and match the literals in each file.
- Keep the **open-by-default** principle: new controls are opt-in operator
  metadata, and a single failed health probe must never gate real traffic.
- Config is env-driven via `src/config.js`, which **fails fast** on nonsensical
  values. Add validation alongside any new knob, and document it in both
  `.env.example` and the README table.

## Things that look like bugs but are not

- **A key from `holesail --live <port>` gets a 400 — that is correct.** The CLI
  defaults to a *private* connection string and prints an `s000…` key, which
  `key.js:assertPublic` rejects on purpose (it is the serve credential). You
  must pass `--public` to get the `0000…` key the gateway accepts. This looks
  exactly like a broken gateway and is not; `/guide` and `/llms.txt` exist
  largely to stop visitors falling into it.
- `src/tunnel-manager.js` installs a process-wide `uncaughtException` handler.
  It is a deliberate workaround: `HolesailClient` is not an EventEmitter and
  never forwards `EADDRINUSE` from the `net.Server` it creates internally, so
  without it a port collision kills the whole gateway. It re-throws anything it
  is not specifically guarding, so real bugs still crash.
- `_probeOne` skipping tunnels with `inFlight > 0` is only sound *because*
  `PROXY_TIMEOUT_MS` is set. Do not remove one without rethinking the other.
- `console.log` in `src/server.js` is graceful-shutdown logging, and in
  `test/unit/fixtures/port-guard-*.js` it is subprocess pass/fail signalling.
  Neither is a debug leftover.
- **`errorPage`/`offlinePage`/`rateLimitPage` use font-free styles on purpose.**
  `pages.js` splits `STYLE` into `FONT_FACES + BASE_STYLE`; those three use
  `LEAN_STYLE`/`MINIMAL_STYLE` instead. It looks like an inconsistency and is
  not: the fonts are ~33KB of base64, and a 116-byte request to any
  nonexistent subdomain used to return 37,280 bytes — a 321x egress amplifier
  needing no key and no auth. Caddy's gzip does **not** mitigate it (the
  caller picks the encoding; `Accept-Encoding: identity` gets the full body).
  The 429 page matters most: it is the only response with no per-IP cap on how
  often it can be elicited. Do not "restore consistency" here.
- **Never put an `await` between `ensureTunnel`'s `pending.has()` check and its
  `pending.set()`.** That window must stay synchronous or two concurrent
  callers for the same key each start their own cold create, defeating the
  dedupe. This is why the cold-create semaphore is acquired inside
  `_createGated` (whose body runs synchronously up to its first internal
  await) rather than in `ensureTunnel` itself. Regression test:
  `tunnel-manager-create-concurrency.test.js`.
- **`MAX_TUNNELS` does not bound in-flight cold creates.** It is checked
  against `this.tunnels.size`, and a record only lands there after a connect
  succeeds. `MAX_CONCURRENT_CREATES` is the knob that bounds concurrency;
  measured cost is ~4MB RSS per live tunnel (`deploy/measure-tunnel-memory.js`),
  so unbounded creates walk the process into its systemd `MemoryMax` and
  restart it, dropping every tenant.
- **Every cookie-authenticated `/_admin/*` mutation checks the `Origin`
  header, not just SameSite.** `src/admin.js`'s `isOriginAllowed` rejects a
  present-but-mismatched Origin even though the session cookie is
  `SameSite=Strict`. That looks redundant and is not: SameSite is scoped to
  the registrable domain (eTLD+1), not the origin, and with
  `BASE_DOMAIN=janus.ssani.dev` the admin origin
  (`https://janus.ssani.dev`) and every tenant origin
  (`https://0000<key>.janus.ssani.dev`) are the SAME SITE. Tenants serve
  attacker-controlled HTML on those subdomains, so a tenant page can
  auto-submit a same-site cross-origin POST straight to `/_admin/kill` and
  the browser still attaches the cookie. `/_admin/kill` and `/_admin/unblock`
  predate the dashboard (they're the original Bearer-only Phase 3 API) and
  had no CSRF/Origin protection at all until this was found -- `cookieValid`
  had been OR'd into their auth check without either. An absent Origin is
  still allowed on purpose (non-browser clients like curl or the CLI never
  send one and aren't CSRF-exploitable); do not tighten that without
  breaking the documented Bearer API.
- **A timed-out connect's port is quarantined, not released.** holesail-client
  may `listen()` after our timeout fired; if that late bind hits a reissued
  port, the `EADDRINUSE` has no pending attempt to claim it and
  `onUncaughtPortGuard` correctly treats it as a real bug and crashes. The
  quarantine keeps the port out of circulation and absorbs a late collision on
  it. The absorption is deliberately narrow — an `EADDRINUSE` on any
  non-quarantined port must still crash, or genuine bind bugs get hidden.
  Both halves have regression tests, including subprocess fixtures.
- **A malformed POST to the password gate deliberately does NOT count toward
  the lockout.** `passwordGate`'s wrong-Content-Type and oversized/aborted-body
  branches return the same generic "Incorrect password." page as a real failure
  but never call `pwNoteFailure`, because neither reached `verifyPassword`. It
  looks like an inconsistency (three branches, same page, only one counts) and
  is not: counting them would let anyone lock a visitor out of a key by
  spraying malformed POSTs, without ever making a password guess. Regression
  test: `server-password-lockout.test.js`.
- **`Semaphore.release()` skipping a `settled` waiter is not dead code.**
  `release()` hands its slot straight to the next waiter *without*
  decrementing `active`. A waiter that already timed out normally splices
  itself out via `_drop`, so the `settled` check should never fire — but if a
  timer and a release ever land in the same tick and the slot went to a settled
  waiter, its `settle()` would be a no-op and the slot would vanish while
  `active` still counted it, permanently shrinking the create gate by one on
  every timeout. Do not "simplify" this to a bare `shift()`. Regression test:
  `tunnel-manager-create-concurrency.test.js` ("a timed-out waiter must not
  consume the slot").
- **Directory suppression lives on `data.keys[keyHash]`
  (`store.directorySuppressed`), not on `data.directory[keyHash]`.** It looks
  like it belongs on the directory entry -- that's the record the feature is
  about -- and it deliberately does not. `data.directory[keyHash]` is created,
  overwritten, and deleted entirely by the passive manifest fetch
  (`directory.js#maybeFetchManifest`, driven by `store.setDirectoryEntry`/
  `clearDirectoryEntry`): the tenant's own backend controls its existence and
  contents just by answering `/.well-known/janus-index.json` differently on
  its next visit. A moderation decision stored on that row would be silently
  cleared the moment the owner's site is next visited (or de-listed and
  wiped outright if their manifest ever fails validation) -- handing the
  tenant the ability to clear their own suppression by editing their own
  manifest, which defeats the entire point of an operator-only lever. Storing
  it on the key record instead (same pattern as `blocked`) means it survives
  every manifest churn, and `directory.js`'s `_eligibleNow` -- which `list()`
  filters through on every call -- checks it live, so suppressing/
  unsuppressing takes effect immediately with no refetch, exactly like block/
  password. Do not "simplify" this by moving it onto the directory entry.
- **The websocket upgrade path has no password lockout, on purpose.** It does
  its own inline cookie check rather than calling `passwordGate`, so the
  `KEY_LOGIN_*` lockout does not apply there. That asymmetry looks like an
  oversight and is not: the upgrade path only *validates an already-issued*
  session cookie and never accepts a password submission, so there is no
  guessing surface to throttle.
- **The directory page renders raw keys, deliberately violating the "never render a raw key" rule.** `pages.js`'s `directoryPage()` composes the tenant URL directly from `entry.rawKey` in a hyperlink. This is not a carve-out from laziness — it is because the key IS the URL, so a directory entry cannot exist without publishing the raw key. Listing requires explicit owner opt-in via a file on their own backend and password-protected keys are ineligible, so any entry that appears in the directory was knowingly published by the owner. The carve-out is the directory page only; logging a raw key anywhere else is still forbidden.
- **`markOnline` does not persist on every call, on purpose.** `store._persist()` is a synchronous fsync+rename and `markOnline` sits on the proxied-request path. Persisting every request would put a blocking fsync in front of every proxied response. Only an actual online/offline flip persists, so `lastSeenAt` drifts in memory between flips. That is display-only data and the drift is accepted.
- **A malformed, oversized, or non-JSON manifest de-lists rather than erroring — but only if the backend actually answered.** `directory.js`'s `maybeFetchManifest` splits its failure handling into two branches, not one, via `_fetchManifestBody`'s discriminated `{ kind }` result. Content-level failures — wrong Content-Type, response larger than `DIRECTORY_MANIFEST_MAX_BYTES`, non-200 status (incl. 404), invalid/malformed JSON, or `list !== true` — mean the backend answered and disqualified itself, so they converge on de-listing (`_deleteEntrySafe`): the manifest is the consent signal, and consent cannot be confirmed, so the safe default is "not listed." Transport-level failures — connection refused/reset, a socket error, or the connect never completing — mean we never got an answer at all. That is an outage, not a withdrawal of consent, so these instead call `markOffline` and deliberately leave the entry listed (a live tenant behind a dead-but-tunnelled backend must not vanish from the directory the moment it stumbles, and `server.js`'s `proxy.on('error')` handler is already the source of truth for "offline but still listed" on the actual proxied path). **A timeout counts as a transport-level failure (`unreachable`), not a content-level one, on purpose:** a slow backend might still be alive, and wrongly de-listing a live-but-slow tenant is worse than briefly showing it offline, which self-corrects on the next recheck either way. If a transport-level failure hits a key with no existing directory entry, `markOffline`/`touchDirectoryLiveness` is a no-op — no phantom offline entry is created for a key nobody opted into. No error is surfaced to the operator or visitor in either case; both are silent. Regression tests: `directory-fetch.test.js`.
