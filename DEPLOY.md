# Deploy runbook

Concise operator checklist for running the gateway on a real box. Not a
substitute for reading `src/config.js` / `.env.example`.

Worked example throughout: **`BASE_DOMAIN=janus.ssani.dev`, DNS on Porkbun**.
Substitute your own domain/provider as needed — nothing here is specific to
that name except the DNS-01 plugin choice in section 2.

> **Run exactly one instance.** The tunnel pool, the local port pool, the rate
> limiter and the JSON store are all per-process (in-memory or single-file).
> Do not template the systemd unit, do not use a cluster manager, do not run
> two boxes against one store file. Two instances fight over tunnel ports and
> interleave writes to the store.

## 0. Before you touch the VPS

**Run the preflight first.** [`deploy/preflight.sh`](./deploy/preflight.sh)
checks everything in this section mechanically and is read-only — it installs
nothing, creates no DNS records, writes no files, and never prints the
credentials you give it. Safe to re-run at any point.

```sh
# on the VPS, from the repo root
deploy/preflight.sh

# to include the Porkbun checks, export credentials first --
# with a LEADING SPACE so they stay out of shell history
 export PB_KEY='pk1_...'
 export PB_SECRET='sk1_...'
deploy/preflight.sh
```

It exits non-zero if anything FAILED. Resolve those before continuing; each
one blocks the deploy. Warnings and skips are tolerated.

The two things it is really there to catch, because both are cheap to check
now and expensive to debug later:

**Outbound UDP must work.** Holesail's holepunching is outbound UDP from this
box to arbitrary peers. No inbound port is needed for it, but a few budget
providers filter or aggressively rate-limit outbound UDP. If they do, the apex
page will look perfectly healthy while *every tunnel* fails — you will spend
the afternoon debugging the wrong layer. Check with your provider, then
confirm empirically in section 6.

**`.dev` is HSTS-preloaded.** The entire `.dev` TLD ships in the browser
preload list, so Chrome/Firefox/Safari refuse plain HTTP for these names with
**no click-through override**. Consequences:

- If the wildcard cert fails to issue, the gateway is not "insecure", it is
  **unreachable**, with no bypass. Get section 2 working before sharing links.
- You cannot smoke-test over plain HTTP in a browser. Use curl on the box:
  `curl -H "Host: 0000<key>.janus.ssani.dev" http://127.0.0.1:3000/`
- `COOKIE_SECURE` must stay `true` (the default). Don't flip it "just to test".

## 1. DNS (Porkbun)

Two records in the `ssani.dev` zone, both pointing at the VPS:

```
janus.ssani.dev      A     <vps-ipv4>      (and AAAA if you have IPv6)
*.janus.ssani.dev    A     <vps-ipv4>
```

The wildcard covers exactly one label, which is exactly what the design needs:
`0000<52-char-key>.janus.ssani.dev` is one level below the base. A key label is
56 characters, comfortably under the 63-char DNS limit.

If you already have a broader `*.ssani.dev` record pointing elsewhere, the more
specific `*.janus.ssani.dev` wins — no conflict.

**Enable API access on the domain.** Porkbun disables its API *per domain* by
default. In the Porkbun panel: `ssani.dev` → Details → toggle **API ACCESS**
on. Skipping this makes every DNS-01 challenge fail with an error that does not
look like a permissions problem. Then generate an API key + secret under
Account → API Access.

## 2. Caddy in front

Caddy terminates TLS and reverse-proxies to `127.0.0.1:$PORT`. The repo ships
[`Caddyfile.example`](./Caddyfile.example) as a provider-agnostic template; the
real `Caddyfile` is gitignored so a live host's domain and DNS credentials
setup never land in version control.

```sh
cp Caddyfile.example Caddyfile
```

Then edit your copy: replace both `gw.example.com` hostnames with
`janus.ssani.dev` and `*.janus.ssani.dev`, and swap the `dns <PROVIDER>` line
for the Porkbun block already shown in the template's comments:

```
	tls {
		dns porkbun {
			api_key {env.PORKBUN_API_KEY}
			api_secret_key {env.PORKBUN_API_SECRET_KEY}
		}
	}
```

**Stock Caddy will not work.** Wildcard certs require a DNS-01 challenge, and
DNS provider plugins are compiled in, not loaded at runtime:

```sh
# build a Caddy with the Porkbun DNS plugin
xcaddy build --with github.com/caddy-dns/porkbun
sudo install -m 0755 ./caddy /usr/bin/caddy
```

Give Caddy the credentials via a systemd drop-in (not a world-readable env
file):

```sh
sudo systemctl edit caddy
```
```ini
[Service]
Environment=PORKBUN_API_KEY=pk1_xxxxxxxx
Environment=PORKBUN_API_SECRET_KEY=sk1_xxxxxxxx
```

Then:

```sh
sudo cp Caddyfile /etc/caddy/Caddyfile   # your edited copy, not the .example
sudo systemctl enable --now caddy
sudo journalctl -u caddy -f     # WATCH THIS until certs actually issue
```

First issuance can take a few minutes (DNS propagation). Do not move on until
you see the wildcard cert obtained — see the HSTS note in section 0 for why.
Renewal is automatic; Caddy's built-in loop handles it, no cron needed.

## 3. The gateway service

### Node.js

`package.json` requires **Node >= 20**. Ubuntu's `apt` package is older than
that on every LTS you are likely to be running, so install from NodeSource:

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # must be >= v20
```

### Deploy the code

```sh
sudo apt install -y git
sudo git clone https://github.com/ssani-main/janus.git /opt/janus
cd /opt/janus
sudo npm ci --omit=dev --ignore-scripts
```

Use `npm ci`, not `npm install`: it installs exactly what
`package-lock.json` pins (which is committed) and refuses to proceed if the
lockfile and `package.json` disagree, instead of silently resolving a
different tree. `--omit=dev` skips `holesail-server` and `ws`, which exist
only for the e2e suite. Install them too if you intend to run
`npm run test:e2e` on the box.

`--ignore-scripts` disables `preinstall`/`install`/`postinstall` lifecycle
scripts. It is safe here: as of this writing, none of the ~73 packages in the
full dependency tree (including `sodium-native` and the other HyperDHT native
addons) define an install-time script — they ship prebuilt binaries under
`prebuilds/` and load them at require time via `require-addon`, not via
`node-gyp`/`node-gyp-build` at install time. Re-verify this (`grep -rl
'"postinstall"\|"install"\|"preinstall"' node_modules/*/package.json`) before
dropping the flag on an upgrade — if a future dependency bump adds a native
module that *does* need a real build step, `--ignore-scripts` would silently
break it rather than fail loudly.

**Why the dependency count matters.** `package.json` deliberately holds only
two runtime dependencies, `holesail-client` and `http-proxy`. That is a
security control, not a style preference: the gateway proxies plaintext
tenant traffic through `http-proxy`, and `holesail-client` (with its own
HyperDHT/sodium-native dependency chain) runs inside the same process with no
sandboxing between it and the gateway's key handling. Every extra transitive
dependency is code that runs with the same privileges. Pin both to exact
versions (no `^`/`~` — already the case in `package.json`) and diff-review any
version bump to `holesail-client` before deploying it: it sits directly on the
plaintext path for every tenant, and a compromised or careless release there
is a compromise of the whole gateway.

### User, permissions, service

Create a dedicated non-root user, and keep secrets owner-only:

```sh
sudo useradd --system --no-create-home holesail
sudo chown -R holesail:holesail /opt/janus
sudo chmod 600 /opt/janus/.env
```

`janus-data.json` (the runtime store) holds plaintext raw Holesail keys, so it
needs the same treatment. The code creates it — and its tmp files — at `0600`
itself, and an atomic rename means an existing `0644` store self-heals to
`0600` the next time anything writes to it. On an already-deployed box, don't
wait for that: run `chmod 600 janus-data.json` immediately after upgrading.

A hardened unit is provided at [`deploy/janus.service`](./deploy/janus.service)
— filesystem/privilege confinement, `MemoryMax`/`TasksMax` so a leak restarts
one service instead of OOMing the box, and a raised journald rate limit so
`LOG_REQUESTS=true` doesn't silently drop lines under load.

```sh
sudo cp deploy/janus.service /etc/systemd/system/janus.service
sudo systemctl daemon-reload
sudo systemctl enable --now janus
sudo journalctl -u janus -f
```

### Minimum viable `.env`

`BASE_DOMAIN` is the only strictly required variable, but a real deploy wants
these. Full annotated reference in [`.env.example`](./.env.example).

```sh
BASE_DOMAIN=janus.ssani.dev

# Trust transparency: publishes the running commit on /healthz so anyone can
# diff this deploy against the public repo. Optional -- capture it at deploy
# time, right before (or as part of) `systemctl restart janus`:
JANUS_COMMIT=$(git rev-parse HEAD)

# Sessions won't survive a restart without this (a random per-process secret
# is generated otherwise). >= 32 chars.
SESSION_SECRET=$(openssl rand -hex 32)

# Enables the admin API + dashboard. Unset disables the admin surface
# entirely. >= 16 chars, enforced at startup; use a real random value.
ADMIN_TOKEN=$(openssl rand -hex 24)

# Impressum / abuse contact. Pages render a "NOT CONFIGURED" warning until set.
OPERATOR_NAME="..."
OPERATOR_ADDRESS="..."
OPERATOR_EMAIL="..."
ABUSE_EMAIL="..."

STORE_PATH=/opt/janus/janus-data.json

# Behind Caddy, which overwrites XFF with the real remote host (see Caddyfile).
TRUST_PROXY=true
TRUSTED_PROXY_HOPS=1
```

Sizing note: `MAX_TUNNELS` defaults to 50, and each live tunnel is a
holesail-client with its own DHT state. On a 1 GB VPS start at the default,
watch `janus_tunnels_active` against memory, and tune `MemoryMax` in the unit
file alongside any increase.

## 4. Firewall

Only what Caddy and SSH need. The Node process stays on loopback
(`BIND_HOST=127.0.0.1`, already the default) and is never exposed directly. The
tunnel port pool (20000–20999) is loopback-only — do not open it.

```sh
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Holesail's own P2P/HyperDHT traffic is **outbound** UDP from this box to peers.
`ufw default deny incoming` does not block it (outbound is allowed by default,
and replies are conntracked). No additional inbound port is needed.

## 5. Backups

The store is the only copy of every alias, password hash, blocklist entry and
aliased raw key. Raw-key URLs are stateless and survive anything; **aliases do
not**. [`deploy/backup-store.sh`](./deploy/backup-store.sh) snapshots it,
validates the JSON parses before keeping it, encrypts to a GPG recipient if you
give it one, and rotates.

```sh
sudo install -d -o holesail -g holesail /var/backups/janus
sudo -u holesail crontab -e
```
```cron
17 3 * * * STORE_PATH=/opt/janus/janus-data.json BACKUP_DIR=/var/backups/janus \
  JANUS_BACKUP_GPG_RECIPIENT=you@example.com \
  /opt/janus/deploy/backup-store.sh >> /var/log/janus-backup.log 2>&1
```

Without `JANUS_BACKUP_GPG_RECIPIENT` the script still runs but warns loudly:
the backup is then a second plaintext copy of every backend's bearer
credential. **A local-only backup does not survive the failure it exists for**
— sync `/var/backups/janus` offsite (restic/rclone/borg to object storage).

## 6. Monitoring

**Liveness.** Point your monitor (UptimeRobot, Healthchecks, cron+curl) at:

```
GET https://janus.ssani.dev/
```

Expect `200` (the apex paste-a-key page). Good check because it needs no key
and exercises DNS → TLS (Caddy) → Node → routing → response. A `502`/`503`/
timeout means Node is down or Caddy can't reach it. `/healthz` is the cheaper
machine-readable equivalent and is exempt from rate limiting.

**Correctness.** Liveness only proves the apex page renders — it says nothing
about whether *tunnels* work, which is the thing that actually breaks. The
single highest-value monitor for this architecture is a **synthetic canary**:
keep one always-on backend with a known key and have an external check fetch
`https://0000<canary-key>.janus.ssani.dev/` every few minutes. That is the only
signal that covers the whole path including the DHT.

**Metrics.** `/metrics` (Prometheus text format, admin-authenticated) already
exposes the signals worth alerting on:

| Signal | Alert when |
|---|---|
| `janus_tunnels_unhealthy` | `> 0` sustained — backends failing liveness probes |
| `janus_circuit_opens_total` | rate increases — repeated cold-create failures |
| `janus_connect_failures_total` | rate spike — DHT/holepunch trouble (see section 0) |
| `janus_ws_rejected_total` | `> 0` — hitting `WS_MAX_SLOTS`/`WS_MAX_PER_IP` caps |
| `janus_tunnels_active` vs `MAX_TUNNELS` | approaching the cap |

## 7. Logs

`LOG_REQUESTS=true` emits one JSON line per request to stdout, captured by
journald. The provided unit raises journald's per-service rate limit so lines
aren't silently dropped under load. Cap total disk use system-wide:

```sh
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\nMaxRetentionSec=30day\n' \
  | sudo tee /etc/systemd/journald.conf.d/janus.conf
sudo systemctl restart systemd-journald
```

## 8. fail2ban (optional, realistic expectations)

The gateway logs rate-limit rejections (429) and admin auth failures (401) to
stdout, which journald captures. There is no built-in fail2ban-ready log file —
if you want IP bans on top of the in-process limiter:

- Point fail2ban at `journalctl -u janus` (a small filter matching
  `RateLimiter` 429 lines or `unauthorized` 401 lines) and have it `ufw deny`
  repeat offenders. Defense in depth, not a requirement — `src/rate-limit.js`
  already bounds abuse per window with no external tooling.
- Alternatively let Caddy's `rate_limit` plugin or a CDN handle L7 abuse —
  often less brittle than parsing journald.

Don't over-invest here on day one. Note the admin login surface already has its
own lockout (`ADMIN_LOGIN_MAX_FAILS` / `ADMIN_LOGIN_LOCKOUT_MS`, S8).

## 9. Two-machine field test

Before calling a deploy done, run the real cross-NAT test from
`TEST_REPORT.md` / `GATEWAY_DESIGN.md`: one machine behind a real
consumer/mobile NAT running `holesail --live <port>` (or the `holesail-server`
snippet in the README), and a *different* network reaching the resulting
`https://0000<key>.janus.ssani.dev/` URL through this gateway. Confirm:

- The holepunch actually completes (not just loopback-to-loopback on the same
  box, which hides NAT traversal failures *and* the outbound-UDP problem from
  section 0).
- Throughput is sane for your use case (`curl -o /dev/null -w '%{speed_download}\n'`
  against a large-ish response is enough of a smoke test).

The `field-test/` kit automates both halves — see
[`field-test/README.md`](./field-test/README.md).
