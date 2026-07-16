# Janus — Design Document

**Status:** ✅ **Built & verified v3** — all four phases implemented under `src/` and tested end-to-end against live Holesail tunnels (Phase 0: 10/10 · Phase 1: 13/13 · Phase 2: 9/9 · Phase 3: 19/19). Subdomain-per-key model; pinned to holesail v2 / holesail-client 2.3.x / holesail-server 2.4.x.
**Scope:** General-purpose, reusable gateway. Transport- and tenant-agnostic — it never knows or cares what kind of app sits behind a key.
**Owner:** Sonni

**Build status by phase:**
- **Phase 0** — tunnel + reverse-proxy + lifecycle ✅ verified live
- **Phase 1** — Host-based multi-tenant routing (key-in-subdomain) ✅ verified live
- **Phase 2** — LRU eviction + reference-counting + concurrent-create dedup ✅ verified live
- **Phase 3** — Impressum/ToS pages + per-IP rate limiting + token-auth admin kill-switch ✅ verified live

**Remaining before public deployment (off-code):** fill operator legal details in `.env` + review the ToS template in `src/pages.js`, set `ADMIN_TOKEN`, configure the Caddyfile DNS-01 provider (see `DEPLOY.md`), and run the **two-machine field test** (cross-NAT holepunch reliability + real-link throughput) — the one thing a single-host lab can't confirm.

> **v2 → v3 (the big change):** v2 still routed by cookie on a single shared origin, which is a cross-tenant isolation hole and breaks apps that build absolute URLs. v3 **encodes the Holesail key into the subdomain**, giving every project its own origin, a stable public hostname, and stateless routing — and turning a shared project into a plain clickable HTTPS link. This deletes cookie-pinning entirely. See §11 for the full delta.

---

## 1. Purpose

One small, permanently-online VPS with **one wildcard domain** acts as the single public entry point for an arbitrary number of backend projects, each of which:

- Runs on its own machine (VPS, home PC, laptop, Pi — anything), with **no domain, no open ports, no static IP**
- Is reachable only via Holesail (HyperDHT-based P2P tunnel)
- Is exposed to end users through the gateway as a normal HTTPS website — **a project becomes a clickable link, no software or paste needed by the visitor**

The core win: you never buy or configure a domain again for a new side project. Spin up a backend, generate a public Holesail key, share the resulting link. Temporary or permanent, local machine or server — same flow.

---

## 2. Architecture

```
  Visitor clicks a link:
  https://s000<52-char-z32-key>.gateway.domain.com/
                    │
                    ▼
 ┌───────────────────────────────────────────────────────────────┐
 │                      gateway.domain.com (VPS)                    │
 │                                                                  │
 │  [A] Caddy — TLS ONLY                                            │
 │      - wildcard cert *.gateway.domain.com (DNS-01, one cert)     │
 │      - reverse_proxy → 127.0.0.1:3000, preserves Host            │
 │                    │                                             │
 │                    ▼                                             │
 │  [B] Node tunnel-manager (:3000) — HTTP, no TLS                  │
 │      1. read key from req.headers.host                           │
 │      2. ensureTunnel(keyHash)  → LRU cache of clients            │
 │      3. http-proxy → 127.0.0.1:<per-key local port>             │
 │      4. inject Referrer-Policy: no-referrer                      │
 │                    │                                             │
 │                    ▼                                             │
 │  [C] holesail-client instance (one per DISTINCT key)            │
 │      - new HolesailClient({ key, secure:false })               │
 │      - connect({ port }) → binds 127.0.0.1:<port> (raw TCP)     │
 │      - own HyperDHT node                                        │
 └────────────────────────────────┬────────────────────────────────┘
                                   │ HyperDHT P2P tunnel (raw TCP payload)
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
           ┌──────────────┐┌──────────────┐┌──────────────┐
           │ Project A     ││ Project B     ││ Project C     │
           │ holesail-serv ││ holesail-serv ││ holesail-serv │
           │  → local HTTP ││  → local HTTP ││  → local HTTP │
           │ public-mode   ││ public-mode   ││ public-mode   │
           │ key, no domain││ key, no domain││ key, no domain│
           └──────────────┘└──────────────┘└──────────────┘
```

**Two load-bearing corrections carried from v2, plus the v3 subdomain move:**
- holesail-client `[C]` does **zero HTTP** — it hands `[B]` a raw TCP socket. All HTTP (TLS, Host, WS, cookies) is the gateway's job.
- Each tunnel owns its **own HyperDHT node** → dedupe by key, cap the count, tear down when idle.
- **The key lives in the subdomain**, so routing is stateless and every project has its own browser origin + stable public hostname.

---

## 3. Components

### 3.1 Gateway VPS
- New, dedicated VPS (separate from the Contabo box — see §6).
- **Caddy** ([A]): terminates TLS with a **wildcard cert** for `gateway.domain.com` + `*.gateway.domain.com`, issued via **DNS-01** (one cert covers every subdomain — no per-key issuance, no Let's Encrypt rate-limit trouble). Reverse-proxies all hosts to `127.0.0.1:3000`, preserving `Host` and adding `X-Forwarded-Proto: https`.
- **Node tunnel-manager** ([B]/[C]): one process. Reads the key from the Host header, manages an LRU cache of `holesail-client` instances (one per distinct key), and HTTP-proxies to the tunnel's local port.
- Needs: wildcard DNS `*.gateway.domain.com` + apex → VPS IP; a DNS provider API token for DNS-01; UFW; fail2ban.

### 3.2 Project backends
- Each project = a normal local HTTP app + a `holesail-server` process pointed at its local port.
- No domain, no port forwarding, no public IP.
- **Public-mode keys only** (`hs://0000…` → the gateway uses the `s000`/`0000` prefix on the subdomain; see §7 for why secure-mode keys are rejected). The key is a **connect-only** public key.
- **Stable key across machines / permanent shares:** persist the 64-char hex `seed`, pass it to `server.start({ seed })`; the public key — and therefore the share link — stays identical when the project moves.
- **Temporary shares:** omit the seed; a fresh random key each run; the link dies when the process stops.

### 3.3 Stateless by design — routing is in the hostname
The gateway persists nothing. It reads the key from `req.headers.host`, so:
- Direct/bookmarked visits to a share link work with no lookup and survive gateway restarts.
- No registry, no JSON of key→name mappings, nothing to dump or back up.
- The only in-memory state is the LRU cache of *live* tunnels (§5.1) and the abuse table (§6a) — both ephemeral, both rebuildable from traffic.

---

## 4. Request flow

1. Someone shares `https://s000<z32key>.gateway.domain.com/` (or a visitor pastes a raw key on the apex homepage and is redirected to that URL).
2. Caddy terminates TLS (wildcard cert), forwards to Node `:3000` with `Host` preserved.
3. Node extracts the label, validates it: 4-char mode prefix + 52-char z32. **Reject `s000`… (secure) with an explainer page (§7); accept `0000`… (public).** Compute `keyHash`.
4. `ensureTunnel(keyHash)`:
   - **Hit:** reuse the cached client + local port, bump `lastRequestAt`.
   - **Miss:** allocate a free local port, `new HolesailClient({ key, secure:false })`, `connect({ port })` **wrapped in a timeout** (§5.4); probe the port is live; insert into LRU. On timeout/failure serve a branded "backend unreachable" page.
   - **Cache full:** evict the LRU-idle tunnel; if none idle, `503` "gateway at capacity."
5. HTTP-proxy the request to `127.0.0.1:<port>` with `X-Forwarded-Proto/Host/For` set and **`Referrer-Policy: no-referrer`** added to the response. Upgrade/Connection headers passed through for websockets.
6. Backend's `holesail-server` forwards the raw TCP to the local app, which sees a stable public hostname and correct forwarded headers.
7. Idle sweeper `destroy()`s tunnels whose `lastRequestAt` is older than the TTL (§5.1), releasing the port + DHT node. No trace remains.

---

## 5. Design questions — resolved

### 5.1 Lifecycle — LRU cache + idle TTL (no refcounting)
Because routing is stateless (no cookies/sessions), tunnels are an **LRU cache keyed by `keyHash`**:
- `lastRequestAt` bumped on every proxied request — a *real* activity signal, not an unfalsifiable tab-close guess.
- A sweeper runs every minute and `client.destroy()`s any tunnel idle > **TTL (10–15 min)**, freeing its port + HyperDHT node.
- Optionally keep hot keys `pause()`d instead of destroyed to cut cold-reopen latency, `resume()` on next hit.

### 5.2 Routing / multi-tenant — by hostname, deduped by key
- `keyHash = hash(normalizedLabel)`; **one tunnel per distinct key**, shared across all visitors of that project. Caps HyperDHT nodes at *distinct hot keys*, not concurrent browsers.
- **Origin isolation is automatic:** each key is its own subdomain → its own browser origin (cookies/localStorage/SW/CORS/CSP isolated). No cross-tenant bleed.
- In-memory maps: `tunnels: Map<keyHash, {client, port, lastRequestAt}>`, `ports: free-list` over a reserved loopback range (e.g. 20000–20999).

### 5.3 Key entry UX — link-first, paste-optional
- Primary: recipients get a **plain HTTPS link**; nothing to paste, nothing to install.
- Convenience: apex `gateway.domain.com` hosts a paste box → validates the key → `window.location = https://<prefix><key>.gateway.domain.com/`.

### 5.4 Cold-connect health
`connect` is wrapped in a timeout (e.g. 8 s). On success, a quick TCP/HEAD probe confirms the backend is actually answering before the tunnel is cached and used. On timeout/probe-fail: branded error page, tunnel not cached (so the next attempt retries cleanly). Prevents pinning traffic to a dead backend.

### 5.5 Admission control — hard cap + eviction
Concurrent tunnels capped at `MAX_TUNNELS` (config, sized to FD/RAM in §9). Cold miss when full → evict LRU-idle; none idle → `503`. Bounds resource use deterministically.

### 5.6 Revocation
Unchanged: no per-person kill lever at the gateway. Cut access = rotate the key on the project's `holesail-server` (new seed → new link; old link dead). Per-user control = a login inside the app.

---

## 6. Isolation principle — decided (unchanged)

Gateway VPS is a **dead-end box**: no SSH/VPN into Contabo or other infra, no shared DB, no credentials unlocking anything beyond itself. Compromise blast radius = "reach whatever's behind a live public key," not "inside your other systems." Hence a separate VPS.

---

## 6a. Open Sharing tier — decided (retained)

Publicly reachable ⇒ operate it responsibly:
- **Impressum** page linked from the apex homepage.
- **In-memory abuse table** `{ keyHash, firstSeenAt, lastRequestAt }` (already the LRU cache) — lets you see and kill a live tunnel. Never on disk, wiped on restart.
- **Abuse contact** on the Impressum; killing a project = `destroy()` its tunnel + optionally add its `keyHash` to an in-memory blocklist so it can't immediately reopen.
- **Brief ToS** prohibiting the worst categories; states cooperation with legitimate legal requests.
- **Rate limiting** (§below).
- Deliberately excluded: age verification, content scanning, accounts. (Operator has accepted the abuse/IP-reputation trade-off; the gateway's IP/domain may land on blocklists — acceptable per project goals.)

**Rate limiting:** per-IP limits at Caddy on new-tunnel creation and per-connection bandwidth, so one actor can't exhaust tunnels/DHT nodes for everyone.

---

## 7. Security notes (corrected for the subdomain model)

- **Public-mode keys only — secure-mode keys are rejected.** The key sits in the hostname, so it appears in the browser address bar, in **TLS SNI (plaintext on the wire)**, and could leak via Referer. A *public-mode* key is connect-only — leaking it merely lets someone else connect, which is what sharing already does. A *secure-mode* key is the **seed** (serve/impersonate capable); exposing that via SNI is unacceptable. The gateway detects the `s000` prefix and serves an explainer ("re-share this project in public mode") instead of proxying.
- **`Referrer-Policy: no-referrer` on every response** so the key isn't leaked to third-party sites the app links to.
- **The gateway sees plaintext.** It terminates TLS and re-serves over a raw TCP tunnel — a real trust boundary. Don't route anything through it you wouldn't want passing a proxy you operate.
- **HTTP correctness is the gateway's job.** Raw TCP tunnel ⇒ use a battle-tested proxy (Caddy TLS + `http-proxy`/`fastify-http-proxy` in Node), not hand-rolled HTTP parsing. Test websocket upgrades and redirects explicitly.
- **Backend URL correctness:** the gateway preserves the public Host and sets `X-Forwarded-*`; apps must trust those (standard framework setting). Apps hard-coding `http://localhost:port` in absolute URLs will misbehave — documented as a backend-config requirement, not a gateway fix.
- **Single point of failure** for everything behind it — monitor with uptime checks.
- **No app-level auth included** — build login inside the project if it needs to know *who*.
- **Licensing:** holesail\* are GPL-3.0. Operating a network service triggers no source-provision duty (that's AGPL); only *distributing* the gateway code invokes GPL. No blocker.

---

## 8. Phased build plan

**Phase 0 — One hardcoded key, end-to-end**
- Caddy wildcard-TLS (can start with a staging/self-signed cert) → Node `:3000`.
- Node: hardcode one public key, `new HolesailClient({key, secure:false})` → `connect({port:20000}, cb)` (wrap in a Promise) → `http-proxy` to `127.0.0.1:20000`, preserve Host, `Referrer-Policy: no-referrer`.
- Prove tunnel + proxy work with any simple backend, **including a websocket endpoint and at least one redirect/login flow** — the two things most likely to break over raw TCP proxying.

**Phase 1 — Subdomain routing + tunnel pool**
- Wildcard DNS + real DNS-01 wildcard cert.
- Extract key from `Host`, validate prefix+z32, reject `s000`, dedupe by `keyHash`, LRU cache + port allocator (§5.1/5.2). Test: two different keys = isolated origins; same key from two browsers = one shared tunnel.

**Phase 2 — Lifecycle, health, admission control**
- Idle sweeper + TTL teardown, connect timeout + probe (§5.4), `MAX_TUNNELS` cap + LRU eviction + `503` (§5.5).

**Phase 3 — Apex UX + Open Sharing tier**
- Apex paste box + redirect, Impressum, ToS, abuse contact + in-memory kill/blocklist, per-IP rate limiting at Caddy, uptime monitoring, fail2ban.

---

## 9. Sizing (answered)

Binding constraint = **HyperDHT nodes + file descriptors per *distinct hot key*** (tunnels are deduped and each owns a DHT node), not per browser. With dedupe + 10–15 min TTL + `MAX_TUNNELS` cap, a 1–2 GB VPS comfortably serves **dozens of simultaneously-hot projects**; visitors-per-project are cheap. Set `MAX_TUNNELS` from `ulimit -n` headroom and observed per-tunnel RAM. Question for you: rough ceiling on **distinct concurrently-hot projects** (not visitors)?

---

## 10. Concrete API reference

**Gateway (Node, per key):**
```js
const HolesailClient = require('holesail-client')
// host = "s000<z32>.gateway.domain.com" → prefix="s000"(reject) | "0000"(accept); key=<z32>
const client = new HolesailClient({ key, secure: false })          // public mode only
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('connect timeout')), 8000)
  client.connect({ port, host: '127.0.0.1' }, () => { clearTimeout(t); res() })
})
// ... http-proxy 127.0.0.1:port, preserve Host, add Referrer-Policy: no-referrer ...
await client.destroy()      // frees DHT node + proxy on idle; .pause()/.resume() optional
```
Constructor `{ key, secure, logger }`; readiness is **callback-only** — wrap it. `connect` opts = `{ port, host, udp }` only (no http/udx). Pass an explicit `port` (client won't report an OS-assigned one). No global state → many instances OK.

**Backend (project, public mode, stable link):**
```js
const HolesailServer = require('holesail-server')
const server = new HolesailServer()
await server.start({ port: APP_PORT, host: '127.0.0.1', seed /* 64-hex, optional for stable key */ }, () => {
  const key = server.key                     // 52-char z32 public key
  console.log(`share:  https://0000${key}.gateway.domain.com/`)
})
```
v2 API is `.start()` + `server.key` (not v1 `.serve()`/`.getPublicKey()`). Public mode (default, no `secure:true`) → `key` is the connect-only public key — correct for gateway sharing. Reuse the hex seed for a permanent link.

---

## 11. v2 → v3 delta

| # | v2 | v3 | Why |
|---|----|----|-----|
| 1 | Cookie pins browser to tunnel on one shared origin | **Key encoded in subdomain**; routing stateless | Fixes cross-tenant origin bleed; deletes cookie-pinning |
| 2 | Rewrite Host → 127.0.0.1 | Preserve public Host + `X-Forwarded-*` | Backend gets a stable hostname → correct redirects/OAuth/assets |
| 3 | Everyone must paste the key | **Share a plain HTTPS link**; paste is optional | Recipients need nothing; better UX |
| 4 | Session→tunnel refcount over cookies | **LRU cache + idle TTL** on real request activity | Tab-close is unfalsifiable; request time isn't |
| 5 | No admission control | **`MAX_TUNNELS` cap + LRU eviction + 503** | Bounds FD/DHT-node usage |
| 6 | Cold-connect could pin a dead tunnel | **Connect timeout + liveness probe** before caching | No hanging on unreachable backends |
| 7 | Secure/public mode unspecified | **Public-mode keys only; reject `s000`** | Key is in SNI/URL; only connect-only keys are safe to expose |
| — | (carried from v1→v2) Holesail does HTTP | Raw TCP only; gateway does all HTTP | v2 reality |
| — | (carried) tunnels are cheap | Each tunnel = its own HyperDHT node | v2 reality |

---

## 12. Open items

- Ceiling on distinct concurrently-hot projects (sizes `MAX_TUNNELS`, RAM, FDs)?
- DNS provider for DNS-01 wildcard issuance (Cloudflare/deSEC/etc.) — determines the Caddy DNS plugin.
- Everything else (routing model, isolation, statelessness, key handling) is decided — ready for Phase 0.
