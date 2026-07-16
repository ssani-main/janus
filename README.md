# Holesail Gateway

Turn any Holesail P2P key into a normal, clickable HTTPS website — no domain, no open ports, and no software for your visitors.

One small always-on VPS with a single wildcard domain becomes the public front door for an arbitrary number of backend projects. Each backend runs anywhere (home PC, laptop, Pi, VPS) with **no domain, no port forwarding, no public IP**, reachable only over Holesail's [HyperDHT](https://github.com/holepunchto/hyperdht) tunnel. The gateway runs the Holesail *client* on the visitor's behalf and reverse-proxies plain HTTPS to it, so visitors just open a link.

> **Status:** ✅ Built and verified end-to-end against live Holesail tunnels — Phase 0 (10/10) · Phase 1 (13/13) · Phase 2 (9/9) · Phase 3 (19/19). See [`GATEWAY_DESIGN.md`](./GATEWAY_DESIGN.md) for the full design and [`TEST_REPORT.md`](./TEST_REPORT.md) for the verification report.

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

- **routing is stateless** — the gateway reads the key from the `Host` header; nothing is persisted, links survive restarts;
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
| `CONNECT_TIMEOUT_MS` | `8000` | cold-connect timeout before giving up on a backend |
| `IDLE_TTL_MS` | `900000` | tear down a tunnel after this long with no requests (15 min) |
| `OPERATOR_NAME` / `OPERATOR_ADDRESS` / `OPERATOR_EMAIL` | `''` | Impressum fields; pages warn until set |
| `ABUSE_EMAIL` | = `OPERATOR_EMAIL` | abuse contact shown on apex/ToS |
| `ADMIN_TOKEN` | *(unset → admin disabled)* | bearer token for the operator kill-switch API |
| `TRUST_PROXY` | `true` | trust `X-Forwarded-For` for client IP (true when behind Caddy) |
| `RATE_WINDOW_MS` | `60000` | rate-limit window |
| `RATE_MAX_REQUESTS` | `120` | max requests per IP per window |
| `RATE_MAX_NEW_TUNNELS` | `10` | max new (cold) tunnels per IP per window |

---

## Operator admin API

Enabled only when `ADMIN_TOKEN` is set. Reachable on the **apex host** under `/_admin`, bearer-authenticated. Lets you respond to an abuse report by killing one session without touching any other.

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

---

## Deployment

See [`DEPLOY.md`](./DEPLOY.md) for the full runbook. In short:

1. **Wildcard DNS** — `gw.yourdomain.com` and `*.gw.yourdomain.com` → the VPS.
2. **Caddy** — terminates TLS with a wildcard cert via **DNS-01** (one cert, no per-subdomain issuance), preserves `Host`, proxies to the Node gateway. See [`Caddyfile`](./Caddyfile).
3. **systemd** — run the gateway as a non-root service with `Restart=always` and `EnvironmentFile=.env`.
4. **Firewall** — UFW allow only 22/80/443.
5. **Health check** — `GET https://gw.yourdomain.com/` returns 200 (apex page), no key required.

---

## Security

- **Public-mode keys only.** The key lives in the hostname (address bar, TLS SNI, `Referer`), so only *connect-only* public keys (`0000…`) are accepted. Secure-mode `s000…` keys (which are the serving seed) are rejected. Every response also sets `Referrer-Policy: no-referrer`.
- **The gateway sees plaintext.** It terminates TLS and re-serves over a raw TCP tunnel — a real trust boundary. Don't route anything through it you wouldn't want passing a proxy you operate.
- **Shared key = bearer secret.** Anyone with a project's key can reach it until the key is rotated on the backend. Per-user access control must live inside the app.
- **Single front door.** If the gateway is down, every project behind it is unreachable — monitor it like real infra.

---

## Project layout

```
.
├── src/
│   ├── config.js         env-driven config + validation
│   ├── key.js            parse/validate hs keys, reject secure-mode
│   ├── routing.js        Host → tenant key classifier
│   ├── port-pool.js      local port allocator
│   ├── rate-limit.js     per-IP request + new-tunnel limiter
│   ├── tunnel-manager.js tunnel pool: LRU eviction, refcount, dedup, blocklist
│   ├── pages.js          apex / Impressum / ToS / 429 pages
│   ├── admin.js          token-auth kill/block API
│   └── server.js         HTTP + WebSocket entrypoint
├── Caddyfile             wildcard TLS (DNS-01)
├── .env.example          all config knobs
├── DEPLOY.md             operator runbook
├── GATEWAY_DESIGN.md     full design document
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
