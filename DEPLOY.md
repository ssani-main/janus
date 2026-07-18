# Deploy runbook (Phase 3)

Concise operator checklist for running the gateway on a real box. Not a
substitute for reading `src/config.js` / `.env.example`.

## 1. systemd unit

```ini
# /etc/systemd/system/janus.service
[Unit]
Description=Janus
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=holesail
Group=holesail
WorkingDirectory=/opt/janus
EnvironmentFile=/opt/janus/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/janus
# S5: belt-and-braces -- any file the process creates (store, tmp files)
# comes out owner-only even if a future code change forgets to pass an
# explicit mode.
UMask=0077

[Install]
WantedBy=multi-user.target
```

Create a dedicated non-root user first (`useradd --system --no-create-home
holesail`), `chown` the deploy directory to it, and keep `.env` readable
only by that user (`chmod 600 .env`).

`janus-data.json` (the runtime store) also holds plaintext raw Holesail
keys, so it needs the same treatment (S5). The code now creates it -- and
its tmp files -- at `0600` itself, and an atomic rename means an existing
`0644` store self-heals to `0600` the next time anything writes to it. On
an already-deployed box, don't wait for that: run `chmod 600
janus-data.json` immediately after upgrading.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now janus
sudo journalctl -u janus -f
```

## 2. Caddy in front

Caddy terminates TLS and reverse-proxies to `127.0.0.1:$PORT` (see the
existing `Caddyfile` in this directory for the wildcard vhost). With a
DNS-01 challenge configured for your DNS provider, wildcard certs
(`*.<BASE_DOMAIN>` + `<BASE_DOMAIN>`) auto-renew -- no cron job needed,
Caddy's built-in renewal loop handles it. Just make sure:

- The DNS-01 plugin/API token Caddy needs is present in its environment.
- `systemctl enable --now caddy` so it survives reboots.
- `sudo journalctl -u caddy -f` to confirm certs actually issue on first
  boot (DNS propagation can take a few minutes).

## 3. Firewall

Only the ports Caddy and SSH need are open; the Node process stays on
loopback (`BIND_HOST=127.0.0.1`, already the default) and is never exposed
directly.

```sh
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Holesail's own P2P/HyperDHT traffic is outbound UDP from the gateway box to
peers -- no additional inbound port needs opening for that.

## 4. fail2ban (optional, realistic expectations)

The gateway logs rate-limit rejections (429) and admin auth failures (401)
to stdout, which systemd/journald captures. There is no built-in
fail2ban-ready log file out of the box -- if you want IP bans on top of the
in-process rate limiter, the simplest realistic option is:

- Point fail2ban at `journalctl -u janus` output (via a small
  filter matching `RateLimiter` 429 lines or `unauthorized` 401 lines) and
  have it `ufw deny` repeat offenders. This is a defense-in-depth nice-to-have,
  not a requirement -- the per-IP `RateLimiter` in `src/rate-limit.js` already
  bounds abuse per window without any external tooling.
- Alternatively, let Caddy's `rate_limit` (via a plugin) or a CDN in front
  handle L7 abuse instead of fail2ban -- often less brittle than parsing
  journald.

Don't over-invest here on day one; the in-process rate limiter is the
primary control.

## 5. Uptime monitoring

Point your monitor (e.g. UptimeRobot, Healthchecks, a cron+curl) at:

```
GET https://<BASE_DOMAIN>/
```

Expect `200` (the apex paste-a-key page). This is a good health check
because it needs no Holesail key and exercises the full path: DNS -> TLS
(Caddy) -> Node -> routing -> response. A `502`/`503`/timeout here means
the Node process is down or Caddy can't reach it.

## 6. Two-machine field test reminder

Before calling a deploy done, run the real cross-NAT test from
`TEST_REPORT.md` / `GATEWAY_DESIGN.md`: one machine behind a real
consumer/mobile NAT running `holesail --live <port>` (or the
`holesail-server` snippet in the README), a *different* network reaching
the resulting `https://0000<key>.<BASE_DOMAIN>/` URL through this gateway.
Confirm:

- The HTTP holepunch actually completes (not just loopback-to-loopback on
  the same box, which hides NAT traversal failures).
- Throughput is sane for your use case (a quick file download or a
  `curl -o /dev/null -w '%{speed_download}\n'` against a large-ish
  response is enough of a smoke test).
