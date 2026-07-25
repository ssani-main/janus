# Janus

[![CI](https://github.com/ssani-main/janus/actions/workflows/ci.yml/badge.svg)](https://github.com/ssani-main/janus/actions/workflows/ci.yml)

**Janus** is a gateway that turns any Holesail P2P key into a normal, clickable HTTPS website — no domain, no open ports, and no software for your visitors. *(Named for the Roman god of gates and doorways.)*

One small always-on VPS with a single wildcard domain becomes the public front door for an arbitrary number of backend projects. Each backend runs anywhere (home PC, laptop, Pi, VPS) with **no domain, no port forwarding, no public IP**, reachable only over Holesail's [HyperDHT](https://github.com/holepunchto/hyperdht) tunnel. The gateway runs the Holesail *client* on the visitor's behalf and reverse-proxies plain HTTPS to it, so visitors just open a link.

> **Status:** ✅ Built and verified end-to-end against live Holesail tunnels — Phase 0 (10/10) · Phase 1 (13/13) · Phase 2 (9/9) · Phase 3 (19/19). **Milestone 1** adds a persistent store, named aliases, optional per-key passwords, and an HTML admin dashboard. **Milestone 2** adds observability (`/healthz`, `/metrics`, structured request logging) and resilience (exponential-backoff reconnect, circuit breaker, periodic health probes, friendly offline page). **Security:** all 13 findings from the 2026-07 audit are fixed — cross-tenant cookie isolation, X-Forwarded-For hardening, websocket-DoS bounds, `0600` store with fsync durability, credential purge on clear, and admin login lockout + per-session CSRF. **218 unit tests + 7 live-DHT e2e tests pass.** See [`GATEWAY_DESIGN.md`](./GATEWAY_DESIGN.md) for the full design, [`ROADMAP.md`](./ROADMAP.md) for the audit backlog and what's next, and [`TEST_REPORT.md`](./TEST_REPORT.md) for the verification report.

---

## How it works

```
 visitor's browser ──HTTPS──►  Caddy (wildcard TLS)  ──HTTP──►  Node gateway (this repo)
 https://0000<key>.gw.tld/                                          │
                                                                    │  holesail-client per key
                                                                    ▼
                                                        HyperDHT P2P tunnel (raw TCP, E2E)
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
npx holesail --live 8080          # prints a public connection key
```

Use the **public** key (the `0000…` / secure-off form). The gateway **rejects secure-mode `s000…` keys** on purpose — that form is the seed, and putting it in a URL/TLS-SNI would leak serving capability (see [Security](#security)).

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
| `PORT` | `3000` | port the Node gateway listens on (Caddy proxies here) |
| `BIND_HOST` | `127.0.0.1` | interface to bind |
| `MAX_TUNNELS` | `50` | max concurrent live tunnels; LRU-evicts idle ones at capacity |
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
| `CIRCUIT_FAILURE_THRESHOLD` | `5` | consecutive **failed requests** before a keyHash's circuit opens (Milestone 2c). Once open, further cold creates fast-fail with 503 instead of attempting a DHT round trip. Counted per failed cold create, not per connect attempt — one request that exhausts its whole `RECONNECT_MAX_ATTEMPTS` chain still counts once, so the two knobs stay independent. |
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

See [`DEPLOY.md`](./DEPLOY.md) for the full runbook. In short:

1. **Wildcard DNS** — `gw.yourdomain.com` and `*.gw.yourdomain.com` → the VPS.
2. **Caddy** — terminates TLS with a wildcard cert via **DNS-01** (one cert, no per-subdomain issuance), preserves `Host`, proxies to the Node gateway. Needs a Caddy built with your DNS provider's plugin (`xcaddy build --with github.com/caddy-dns/<provider>`). Copy [`Caddyfile.example`](./Caddyfile.example) to `Caddyfile` and fill it in — the real one is gitignored.
3. **systemd** — run as a non-root service. [`deploy/janus.service`](./deploy/janus.service) is a hardened unit with privilege confinement, `MemoryMax`/`TasksMax`, and a raised journald rate limit.
4. **Firewall** — UFW allow only 22/80/443. The tunnel port pool is loopback-only; Holesail's DHT traffic is outbound UDP (confirm your provider doesn't filter it).
5. **Backups** — [`deploy/backup-store.sh`](./deploy/backup-store.sh) snapshots `STORE_PATH` with JSON validation, optional GPG encryption, and rotation. The store is the only copy of your aliases and their raw keys.
6. **Monitoring** — `GET https://gw.yourdomain.com/` returns 200 (apex page), no key required. Pair it with a **synthetic canary** through a known always-on key: only that exercises the actual tunnel path.

**Run exactly one instance** — the tunnel pool, port pool, rate limiter, and store are all per-process.

---

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
│   ├── pages.js          apex / Impressum / ToS / 429 / login / admin pages / offline page
│   ├── admin.js          admin JSON API + HTML dashboard (aliases, passwords, blocks, health status)
│   └── server.js         HTTP + WebSocket entrypoint, alias + password gate, /healthz + /metrics
├── deploy/
│   ├── janus.service     hardened systemd unit (confinement + resource caps)
│   └── backup-store.sh   store backup: JSON validation, GPG, rotation
├── Caddyfile.example     wildcard TLS (DNS-01) template; copy to Caddyfile
├── .env.example          all config knobs
├── DEPLOY.md             operator runbook
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
