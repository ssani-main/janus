# Janus

[![CI](https://github.com/ssani-main/janus/actions/workflows/ci.yml/badge.svg)](https://github.com/ssani-main/janus/actions/workflows/ci.yml)

**Turn any Holesail P2P key into a normal, clickable HTTPS website.**
No domain, no open ports, no public IP — and nothing for your visitors to install.

```
npx holesail --live 8080 --public          # on your laptop
→ https://0000<key>.gw.yourdomain.com/     # public, HTTPS, works everywhere
```

One small always-on VPS with a single wildcard domain becomes the front door for any number of backends. Each backend runs wherever you like — home PC, laptop, Pi — reachable only over Holesail's [HyperDHT](https://github.com/holepunchto/hyperdht) tunnel. The gateway runs the Holesail *client* on the visitor's behalf and reverse-proxies HTTPS to it.

*(Named for the Roman god of gates and doorways.)*

### Why it's built this way

| | |
|---|---|
| **Stateless routing** | The key lives in the subdomain, so raw-key links need no stored state and survive restarts |
| **Origin isolation** | Every project gets its own browser origin — cookies, localStorage and CORS separate automatically |
| **Open by default** | Share a key and it just works. Passwords, aliases and blocks are opt-in operator metadata, never required |
| **Two dependencies** | `holesail-client` and `http-proxy`. Everything else is Node built-ins, deliberately |

### Status

✅ **Production**, running at [janus.ssani.dev](https://janus.ssani.dev). **261 unit tests + 7 live-DHT e2e tests pass.**

<details>
<summary>What's shipped</summary>

- **Core** — host-based routing, per-key tunnel pool with LRU eviction, rate limiting, operator kill-switch
- **Milestone 1** — persistent store, named aliases, optional per-key passwords, HTML admin dashboard
- **Milestone 2** — `/healthz`, `/metrics`, structured request logging, backoff reconnect, circuit breaker, health probes, offline page
- **Security** — all 13 findings from the 2026-07 audit fixed: cross-tenant cookie isolation, `X-Forwarded-For` hardening, websocket-DoS bounds, `0600` store with fsync durability, credential purge on clear, admin login lockout, per-session CSRF
- **Scale review** — cold-create concurrency cap, egress-amplification fix on error pages, off-event-loop password hashing, port quarantine against late-bind crashes

</details>

**Docs:** [`GATEWAY_DESIGN.md`](./GATEWAY_DESIGN.md) design · [`DEPLOY.md`](./DEPLOY.md) deployment · [`ROADMAP.md`](./ROADMAP.md) open work · [`TEST_REPORT.md`](./TEST_REPORT.md) verification

---

## How it works

```
 visitor's browser ──HTTPS──►  Caddy (wildcard TLS)  ──HTTP──►  Node gateway (this repo)
 https://0000<key>.gw.tld/                                          │
                                                                    │  holesail-client per key
                                                                    ▼
                                                        HyperDHT P2P tunnel (encrypted)
                                                                    ▼
                                                       your backend app (holesail-server)
                                                       no domain · no public IP
```

The Holesail key is **encoded into the subdomain**, so:

- **routing is stateless by default** — the gateway reads the key straight from the `Host` header, so raw-key links need no stored state and survive restarts (the only persisted state is optional operator metadata — aliases, passwords, blocks — in `STORE_PATH`);
- **every project gets its own browser origin** — cookies/localStorage/CORS are isolated per tenant automatically;
- **the backend has a stable public hostname** — its app builds correct absolute URLs;
- **sharing is just a link** — recipients install nothing.

Built on the official Holesail libraries:

| Repo | Role |
|---|---|
| [holesail/holesail](https://github.com/holesail/holesail) | the CLI / umbrella project |
| [holesail/holesail-client](https://github.com/holesail/holesail-client) | client library the gateway embeds (one tunnel per key) |
| [holesail/holesail-server](https://github.com/holesail/holesail-server) | server library each backend runs to get a shareable key |

---

## Quick start

### 1. Run a backend and get its key
On the machine hosting your app (say it listens on `127.0.0.1:8080`):

```bash
npx holesail --live 8080 --public    # prints a public connection key
```

`--public` is **required**. Without it the CLI defaults to a *private* connection string and prints an `s000…` key. The gateway **rejects secure-mode `s000…` keys** on purpose — that form is the seed, and putting it in a URL/TLS-SNI would leak serving capability (see [Security](#security)) — so omitting the flag gets you a `400` with no other explanation.

Everything after `hs://` is the subdomain, `0000` prefix included. There is a walkthrough of this at `/guide` on a running gateway, and a plain-text version at `/llms.txt` for pasting into an AI assistant.

### 2. Configure and run the gateway
On the gateway box:

```bash
npm install
cp .env.example .env
#   set BASE_DOMAIN=gw.yourdomain.com   (required)
#   set OPERATOR_* / ABUSE_EMAIL, ADMIN_TOKEN, rate limits as needed
npm start
```

The gateway is HTTP-only and expects **Caddy (or another TLS terminator) in front of it** — see [Deployment](#deployment).

### 3. Share the link
```
https://0000<your-52-char-key>.gw.yourdomain.com/
```
That's it. Anyone with the link reaches your backend over HTTPS.

### Test locally without DNS or Caddy
```bash
BASE_DOMAIN=gw.example.com npm start
curl -H "Host: 0000<key>.gw.example.com" http://127.0.0.1:3000/
```

---

## Configuration

All via environment variables (see [`.env.example`](./.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `BASE_DOMAIN` | *(required)* | wildcard base, e.g. `gw.yourdomain.com`; the tenant key is the leftmost subdomain label |
| `JANUS_COMMIT` | *(unset)* | optional commit SHA of the running deploy, published on `/healthz` (trust transparency — lets anyone diff the running code against the public repo). If set, must be a 7-40 char hex string; the process fails fast otherwise. Typically `$(git rev-parse HEAD)` at deploy time. |
| `PORT` | `3000` | port the Node gateway listens on (Caddy proxies here) |
| `BIND_HOST` | `127.0.0.1` | interface to bind |
| `MAX_TUNNELS` | `50` | max concurrent live tunnels; LRU-evicts idle ones at capacity. Bounds *finished* tunnels only — see `MAX_CONCURRENT_CREATES` for the in-flight bound |
| `MAX_CONCURRENT_CREATES` | `8` | max cold creates running **concurrently**, process-wide. `MAX_TUNNELS` is checked against completed tunnels, so it places no bound on in-flight creates; without this the only throttle was the per-IP `RATE_MAX_NEW_TUNNELS`, i.e. 10 × (number of client IPs). Each in-flight create holds a HyperDHT node for up to `ENSURE_TUNNEL_TIMEOUT_MS`. Watch `janus_creates_queued` |
| `MAX_CREATE_QUEUE` | `64` | max cold creates that may wait for a slot before new ones are rejected with 503 + `Retry-After`. `0` disables queueing (excess creates fail immediately) |
| `PORT_QUARANTINE_MS` | `15000` | how long a port abandoned by a **timed-out** connect is held out of the pool. holesail-client may `listen()` after our timeout fired; if that late bind hits a reissued port, the `EADDRINUSE` has no pending attempt to claim it and the uncaught-exception guard lets it kill the process. `0` disables. Should be ≥ `CONNECT_TIMEOUT_MS` (a shorter value warns at startup) |
| `TUNNEL_PORT_MIN` / `TUNNEL_PORT_MAX` | `20000` / `20999` | local port pool for tunnels (must be a range) |
| `MAX_PORT_ATTEMPTS` | `5` | how many distinct local ports one cold create may try before giving up. Pool ports are only reserved in-process, so a port held by other software fails to bind (`EADDRINUSE`) and the manager retries immediately onto the next one. Bounds that loop; multiplies into the worst case capped by `ENSURE_TUNNEL_TIMEOUT_MS`. |
| `CONNECT_TIMEOUT_MS` | `8000` | cold-connect timeout before giving up on a backend |
| `IDLE_TTL_MS` | `900000` | tear down a tunnel after this long with no requests (15 min) |
| `OPERATOR_NAME` / `OPERATOR_ADDRESS` / `OPERATOR_EMAIL` | `''` | Impressum fields; pages warn until set |
| `ABUSE_EMAIL` | = `OPERATOR_EMAIL` | abuse contact shown on apex/ToS |
| `ADMIN_TOKEN` | *(unset → admin disabled)* | bearer token for the operator kill-switch API and admin dashboard login. **Must be ≥16 chars when set** — the process fails fast at startup otherwise (S8); use a long random value. |
| `TRUST_PROXY` | `true` | trust `X-Forwarded-For` for client IP (true when behind Caddy) |
| `TRUSTED_PROXY_HOPS` | `1` | number of trusted proxies (e.g. Caddy) in front of the gateway; `clientIp()` reads the `X-Forwarded-For` entry this many positions from the right, so a client-spoofed left-hand entry can't bypass per-IP limits (S2). Only used when `TRUST_PROXY` is true. |
| `RATE_WINDOW_MS` | `60000` | rate-limit window |
| `RATE_MAX_REQUESTS` | `120` | max requests per IP per window |
| `RATE_MAX_NEW_TUNNELS` | `10` | max new (cold) tunnels per IP per window |
| `STORE_PATH` | `./janus-data.json` | JSON file for persistent store: named aliases, per-key passwords, blocklist; survives restarts. Raw keys for aliased entries are stored on disk. |
| `SESSION_SECRET` | *(unset → random per-process)* | secret for signing passworded-key session cookies and admin dashboard cookies. **Strongly recommended:** set explicitly for production (≥32 chars). If unset, sessions won't survive restarts or work across multiple processes. |
| `SESSION_TTL_MS` | `604800000` | how long a visitor's passworded-key session (after login) stays valid, in milliseconds (default 7 days) |
| `COOKIE_SECURE` | `true` | whether session cookies get the Secure attribute (HTTPS-only). Must be `true` in production — only set `false` for local HTTP-only development. |
| `ADMIN_SESSION_TTL_MS` | `43200000` | how long an admin dashboard login session stays valid, in milliseconds (default 12 hours). Rotating `ADMIN_TOKEN` immediately invalidates all outstanding admin sessions. |
| `ADMIN_LOGIN_MAX_FAILS` | `5` | consecutive failed `/_admin/login` attempts (per IP) before lockout begins (S8). |
| `ADMIN_LOGIN_LOCKOUT_MS` | `60000` | base lockout duration once the failure threshold is hit, in milliseconds; each further failure doubles it (capped at 2⁶×) (S8). |
| `LOG_REQUESTS` | `false` | whether to emit a JSON line per request to stdout (Milestone 2a). High volume; opt in explicitly. Set to `true` or `"1"` to enable. |
| `CIRCUIT_FAILURE_THRESHOLD` | `2` | consecutive **failed requests** before a keyHash's circuit opens (Milestone 2c). Once open, further cold creates fast-fail with 503 instead of attempting a DHT round trip. Counted per failed cold create, not per connect attempt — one request that exhausts its whole `RECONNECT_MAX_ATTEMPTS` chain still counts once, so the two knobs stay independent. |
| `CIRCUIT_COOLDOWN_MS` | `30000` | how long a circuit stays open once it trips, in milliseconds (Milestone 2c). |
| `RECONNECT_MAX_ATTEMPTS` | `3` | extra reconnect-with-backoff attempts after the first cold-create fails, before giving up and returning 502 (Milestone 2c). Default 3 = up to 4 total attempts. |
| `RECONNECT_BASE_DELAY_MS` | `250` | base delay for reconnect backoff, in milliseconds; actual delay is exponential with jitter (Milestone 2c). |
| `RECONNECT_MAX_DELAY_MS` | `5000` | cap on reconnect backoff delay, in milliseconds (Milestone 2c). |
| `HEALTH_PROBE_INTERVAL_MS` | `30000` | how often the periodic health probe checks each cached tunnel's liveness, in milliseconds (Milestone 2d). Independent of the 60s idle sweeper. |
| `HEALTH_PROBE_TIMEOUT_MS` | `2000` | per-probe connect timeout, in milliseconds (Milestone 2d). Must be well under `HEALTH_PROBE_INTERVAL_MS` so probes never stack up. |
| `HEALTH_PROBE_UNHEALTHY_STREAK` | `2` | consecutive failed probes before a tunnel is marked unhealthy and destroyed (Milestone 2d) — the "how twitchy is probe-driven eviction" dial. Recovery stays asymmetric: a single successful probe resets the streak immediately. |
| `PROXY_TIMEOUT_MS` | `30000` | http-proxy idle-socket timeout for tunneled requests, in milliseconds (Milestone 2d). Detects hung backends; does NOT apply to WebSocket upgrades. |
| `ENSURE_TUNNEL_TIMEOUT_MS` | `45000` | overall wall-clock deadline on a single `ensureTunnel` cold create, in milliseconds. Bounds the reconnect loop, port-collision retry loop, and all associated timeouts and sleeps; must exceed `CONNECT_TIMEOUT_MS`. |
| `WS_MAX_SLOTS` | `30` (~60% of `MAX_TUNNELS`) | max distinct tunnel slots websockets may pin at once; must be `< MAX_TUNNELS` so HTTP always keeps headroom (S3). A new ws to an already-ws-pinned key is free. |
| `WS_MAX_PER_IP` | `16` | max concurrent websocket connections a single client IP may hold (S3). |
| `WS_IDLE_TIMEOUT_MS` | `3600000` | close a websocket after this long idle in BOTH directions, in milliseconds (default 1h); refreshes on read/write so heartbeating/server-push sockets survive; `0` disables (S3). |

---

## Operator admin API & dashboard

Enabled only when `ADMIN_TOKEN` is set. Reachable on the **apex host** under `/_admin`. Two interfaces:

**JSON API** — bearer-authenticated, for command-line automation. Respond to abuse reports by killing/blocking keys:

```bash
# list live tunnels (sanitized — no raw keys)
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://gw.yourdomain.com/_admin/tunnels

# kill one tunnel and block it from reopening
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://gw.yourdomain.com/_admin/kill?keyHash=<hash>&block=1"

# lift the block
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://gw.yourdomain.com/_admin/unblock?keyHash=<hash>"
```

**HTML dashboard** — log in with `ADMIN_TOKEN` in your browser. View live tunnels and manage:
- **Named aliases** — map friendly subdomains (e.g., `myblog.gw.yourdomain.com`) to keys. Raw key links always work; aliases are additive.
- **Per-key passwords** — set optional password protection on any key. Visitors enter the password once and receive a signed HttpOnly session cookie (TTL: `SESSION_TTL_MS`, default 7 days). Keys without passwords stay fully open. Changing/clearing a password revokes all existing sessions for that key.
- **Blocklist** — manage which keys are blocked.

Dashboard sessions use CSRF protection and SameSite=Strict cookies (TTL: `ADMIN_SESSION_TTL_MS`, default 12 hours). Rotating `ADMIN_TOKEN` immediately invalidates all outstanding admin sessions.

---

## Deployment

See [`DEPLOY.md`](./DEPLOY.md) for the full runbook, and start with
[`deploy/preflight.sh`](./deploy/preflight.sh) — a read-only check for the two
environmental failures that cost the most to diagnose late (a provider that
filters outbound UDP, and DNS-provider API access that is off). In short:

1. **Wildcard DNS** — `gw.yourdomain.com` and `*.gw.yourdomain.com` → the VPS.
2. **Caddy** — terminates TLS with a wildcard cert via **DNS-01** (one cert, no per-subdomain issuance), preserves `Host`, proxies to the Node gateway. Needs a Caddy built with your DNS provider's plugin (`xcaddy build --with github.com/caddy-dns/<provider>`). Copy [`Caddyfile.example`](./Caddyfile.example) to `Caddyfile` and fill it in — the real one is gitignored.
3. **systemd** — run as a non-root service. [`deploy/janus.service`](./deploy/janus.service) is a hardened unit with privilege confinement, `MemoryMax`/`TasksMax`, and a raised journald rate limit.
4. **Firewall** — UFW allow only 22/80/443. The tunnel port pool is loopback-only; Holesail's DHT traffic is outbound UDP (confirm your provider doesn't filter it).
5. **Backups** — [`deploy/backup-store.sh`](./deploy/backup-store.sh) snapshots `STORE_PATH` with JSON validation, optional GPG encryption, and rotation. The store is the only copy of your aliases and their raw keys.
6. **Monitoring** — `GET https://gw.yourdomain.com/` returns 200 (apex page), no key required. Pair it with a **synthetic canary** through a known always-on key: only that exercises the actual tunnel path.

**Run exactly one instance** — the tunnel pool, port pool, rate limiter, and store are all per-process.

---

## Trust model

The gateway terminates visitor TLS at Caddy and re-serves the request over a
plaintext HTTP hop into the tunnel — so the operator running this gateway can
technically observe traffic in transit, the same boundary as any hosting
provider or reverse proxy you don't run yourself. **Don't route anything
through it you wouldn't hand to one.** The HyperDHT tunnel from gateway to
backend is separately encrypted, but that leg was never the boundary in
question — TLS termination is.

What the gateway does *not* do: it never logs or persists a raw key, only a
SHA-256 `keyHash` used to identify a tunnel; it never logs request bodies or
headers (`LOG_REQUESTS` logs method/path/status/bytes/IP only); and a raw key
touches disk only for a tenant who explicitly opts into a named alias or
dashboard password via `STORE_PATH` — a plain `hs://0000…` link is never
stored anywhere.

## Security

- **Public-mode keys only.** The key lives in the hostname (address bar, TLS SNI, `Referer`), so only *connect-only* public keys (`0000…`) are accepted. Secure-mode `s000…` keys (which are the serving seed) are rejected. Every response also sets `Referrer-Policy: no-referrer`.
- **The gateway sees plaintext.** It terminates TLS and re-serves over a raw TCP tunnel — a real trust boundary. Don't route anything through it you wouldn't want passing a proxy you operate.
- **Shared key = bearer secret (by default).** Anyone with a project's key can reach it until the key is rotated on the backend — unless the operator sets an optional per-key password (via the admin dashboard). For per-*user* access control, put it inside the app.
- **Single front door.** If the gateway is down, every project behind it is unreachable — monitor it like real infra.

---

## Project layout

```
.
├── src/
│   ├── config.js         env-driven config + validation
│   ├── key.js            parse/validate hs keys, reject secure-mode
│   ├── routing.js        Host → tenant key classifier
│   ├── store.js          persistent JSON store: aliases, passwords, blocklist
│   ├── auth.js           scrypt password hashing + signed session/CSRF tokens
│   ├── port-pool.js      local port allocator
│   ├── rate-limit.js     per-IP request + new-tunnel limiter
│   ├── tunnel-manager.js tunnel pool: LRU eviction, refcount, dedup, circuit breaker, health probes
│   ├── logger.js         JSON-lines request logger (Milestone 2a)
│   ├── metrics.js        Prometheus text-format metrics renderer (Milestone 2a)
│   ├── fonts.js          self-hosted OFL typefaces as base64 data URIs
│   ├── pages.js          apex / guide / llms.txt / Impressum / ToS / 429 / login / admin pages / offline page
│   ├── admin.js          admin JSON API + HTML dashboard (aliases, passwords, blocks, health status)
│   └── server.js         HTTP + WebSocket entrypoint, alias + password gate, /healthz + /metrics
├── deploy/
│   ├── preflight.sh      read-only pre-deploy environment checks
│   ├── janus.service     hardened systemd unit (confinement + resource caps)
│   └── backup-store.sh   store backup: JSON validation, GPG, rotation
├── Caddyfile.example     wildcard TLS (DNS-01) template; copy to Caddyfile
├── .env.example          all config knobs
├── CLAUDE.md             orientation + conventions for Claude Code sessions
├── DEPLOY.md             operator runbook
├── THIRD_PARTY.md        upstream licences and attribution
├── GATEWAY_DESIGN.md     full design document
├── ROADMAP.md            feature roadmap & handoff notes
└── TEST_REPORT.md        end-to-end verification report
```

---

## Development & testing

```bash
npm run check      # syntax-check every src module
npm test           # fast unit tests (no network) — key parsing, routing, port pool, rate limiter, tunnel-pool logic
npm run test:e2e   # live end-to-end: spawns the real gateway + real Holesail tunnels
npm run test:all   # both
```

Unit tests run in CI (GitHub Actions, Node 20 & 22); the e2e job runs live-DHT tests non-blocking (holepunch can be flaky on hosted runners). See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

**Field test** (`field-test/`) — the two things a single host can't prove (cross-NAT holepunch reliability + real-link throughput):

```bash
# on the remote backend machine:
node field-test/backend.js --size 16      # prints a key
# on the gateway/VPS (different network):
node field-test/probe.js <key>            # reports holepunch OK/FAIL + MB/s
```

See [`field-test/README.md`](./field-test/README.md).

## License

[GPL-3.0-or-later](./LICENSE). The gateway embeds the GPL-3.0 Holesail libraries, so the combined work is GPL-3.0. Operating it as a network service triggers no source-provision obligation (that would be AGPL); *distributing* the gateway code does.

## Notes

- **Legal pages are templates.** The Impressum is config-driven; the ToS in `src/pages.js` is a generic starting point, **not legal advice** — review it for your jurisdiction before going public.
- **Field test before production.** A single-host lab can't exercise cross-NAT holepunching or real-link throughput. Use the `field-test/` kit (above) on two machines on different networks to confirm both.
