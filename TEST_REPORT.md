# Janus — Primitive Test Report

**Date:** 2026-07-16
**Environment:** Windows 11 x64, Node v24.11.1, `holesail-server@2.4.0`, `holesail-client@2.3.0` (the exact versions the design targets)
**Method:** Real npm packages, real backends, real HyperDHT tunnels. Two backends exposed via `holesail-server`, each tunneled by an embedded `holesail-client` in a **single Node process**, driven exactly as the gateway would drive them.
**Result: 18 / 18 functional checks PASSED.**

---

## Automated test suite (as of 2026-07-19)

Beyond the primitive library verification documented below, the repository now ships an in-repo automated suite: **261 unit tests** (`npm test`) and **7 live-DHT end-to-end tests** (`npm run test:e2e`), all passing. Two of the 261 are skipped off Linux (`store-permissions.test.js` asserts POSIX mode bits, which do not apply on win32); on the Linux deploy target and in CI all 261 run. Coverage spans the full feature set — host routing, key parsing, tunnel lifecycle / LRU eviction, circuit breaker, health probes, rate limiting, the persistent store, and the admin dashboard/API — plus the complete security audit backlog: all 13 findings (S1–S13) fixed with dedicated regression tests, and the S7 full-record-deletion feature (`store.deleteKey` / `POST /_admin/delete`). The most recent additions cover the unclaimed-tunnel eviction race (`tunnel-manager-eviction-race.test.js`), per-request circuit-failure accounting, and the two newly operator-tunable knobs (`MAX_PORT_ATTEMPTS`, `HEALTH_PROBE_UNHEALTHY_STREAK`). See [`ROADMAP.md`](./ROADMAP.md) for the per-finding detail and [`README.md`](./README.md) for the feature summary.

---

## What was proven

| Area | Check | Result | Measured |
|------|-------|--------|----------|
| Key generation | Server produces a shareable key | ✅ | 52-char **z-base-32**, matches the subdomain-encoding assumption exactly |
| Server startup | `server.start()` → `server.key` (v2 API) | ✅ | ~1.3–1.8 s (one-time, backend side, not user-facing) |
| **Cold connect** | `client.connect()` opens local tunnel port | ✅ | **~0.8–0.9 s** (this is the user-facing cold-hit latency) |
| Multi-tunnel | 2 clients, 2 keys, **one process**, no global-state clash | ✅ | isolated, no cross-wiring |
| HTTP over tunnel | Requests reach the right backend | ✅ | correct bodies both tunnels |
| **Host preservation** | Backend receives the public Host verbatim (v3 requirement) | ✅ | `host=0000abc.gateway.domain.com` echoed by backend |
| Gateway proxy hop | Host→port routing + `Referrer-Policy: no-referrer` injection | ✅ | routed correctly, header injected |
| **WebSockets** | WS upgrade + echo over the **raw TCP** tunnel | ✅ | echo returned intact (this was flagged risk #2) |
| Throughput | 5 MB pulled through the tunnel | ✅ | 20.4 MB/s **(loopback — see caveats)** |
| Teardown | `client.destroy()` frees the local port | ✅ | port closed, resources released |
| Memory | RSS per tunnel | ✅ | **~1.6 MB** both-sides; gateway (client only) **≤~1 MB / project** |

Every mechanism the v3 design depends on was exercised against the live library and worked on the first run:
- the library **embeds** and runs many tunnels in one process (no singleton/global state) ✅
- the tunnel carries **HTTP and websockets** transparently ✅
- **Host header passes through** so backends can build correct absolute URLs ✅
- the key is a **DNS-safe 52-char z32 string**, so encoding it in a subdomain is valid ✅
- `destroy()` **cleans up**, so the LRU/idle-timeout lifecycle is implementable ✅
- per-project cost is **tiny in RAM** → the ceiling is sockets/FDs, not memory ✅

---

## The one thing this did NOT test (and it's the important one)

**Cross-NAT holepunching between two different networks.** Both peers ran on the same machine. That still exercised the full stack — DHT bootstrap over the public internet, announce, lookup, holepunch, encrypted tunnel — and it all worked, which proves the library is correct and the environment isn't blocking the DHT. **But same-host punching is the easy case.** The real question for your use case is:

> Will a backend on a random home/office/mobile network reliably punch through to the gateway VPS?

For most NATs: yes. For **symmetric NAT / CGNAT** (some ISPs, most mobile networks, some budget VPS providers): holepunching can fail, and you fall back to a relay (slower) or don't connect at all. This is a property of the *backend's network*, not of the code — so it can only be answered by a **two-machine field test**: run `holesail --live` on the actual backend machine you intend to use, and connect to its key from the actual gateway VPS.

**Also caveat the throughput number:** 20.4 MB/s is loopback. Over the real internet it will be bounded by the slower of {backend uplink, gateway link} and the DHT tunnel overhead — expect meaningfully less. This is a property of the gateway itself, independent of what's tunneled: *all* traffic for every tenant funnels through the one gateway VPS (backend → tunnel → gateway → visitor), with the gateway paying egress on every byte. Bandwidth-heavy tenants stress this most, but the ceiling is the gateway's, not any tenant's.

---

## Confidence update

- **Claim A — "Holesail lets you share a project via a key":** was ~99%, now **empirically confirmed.** The core primitive works exactly as the design assumes.
- **Claim B — "the gateway makes it work for browser-only visitors":** was ~80–85%. The **software mechanics are now proven (~95%).** Everything that could be verified in a lab passed. The remaining, genuinely-unresolved risk is **two field questions, not code questions**:
  1. Cross-NAT holepunch reliability for the specific backend networks you'll use.
  2. Real-internet throughput/latency through the gateway (bounded by the tunnel + the VPS link, whatever the tenant).

---

## Recommendation

The design is buildable and the primitive is solid — **green light for Phase 0.** One thing to fold in first:

1. **Do the two-machine field test.** 15 minutes: `holesail --live <port>` on a real remote backend box, connect to its key from the VPS, and pull a sizeable file through the tunnel. That converts the last two unknowns (cross-NAT punch reliability, real-link throughput) from "probably fine" to "measured." This is a gateway property — use any backend; the tenant type is irrelevant.

---

## Reproducibility

Test scripts live in the scratchpad:
- `gateway-test.js` — the 18-check end-to-end suite
- `mem-test.js` — per-tunnel memory measurement

Run with `node gateway-test.js` after `npm install holesail-server holesail-client ws`.
