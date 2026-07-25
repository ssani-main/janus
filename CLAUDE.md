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
npm test           # 226 unit tests, no network
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
