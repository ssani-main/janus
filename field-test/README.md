# Holesail field-test kit

A minimal two-machine kit for measuring the two things a single-host lab
setup cannot tell you about a Holesail-based gateway:

1. **Cross-NAT holepunch reliability** -- does a direct P2P connection
   actually establish between two machines that are behind *different*
   NATs/firewalls (e.g. a home network and a cloud VPS), or does it need a
   relay / fail outright (symmetric NAT, CGNAT, blocked DHT traffic)?
2. **Real-link throughput** -- once connected, how much bandwidth does the
   tunnel actually deliver over the real internet path between those two
   machines, as opposed to loopback/localhost numbers which are meaningless
   for this purpose.

Both of these depend on the actual network topology between two distinct
hosts. Running everything on one machine (or two processes on the same
host) never crosses a NAT boundary and never touches a real internet link,
so it cannot validate either property -- it can only prove the scripts
themselves work.

This kit exercises the exact hop Janus relies on: a
`holesail-server` tunnel wrapping a backend, and a `holesail-client` tunnel
on the other side. A healthy result here means the gateway will work
between those two machines, because it uses the same underlying tunnel.

## Step 1 -- machine A (backend)

On the backend machine (the one that would normally run behind the
gateway):

```
node field-test/backend.js --size 16
```

- `--size <MB>` sets the size of the `/payload` test response (default 8
  MB). Use a larger size for a more stable throughput measurement on fast
  links, or a smaller size on slow/metered links.
- `--seed <64-hex>` is optional; pass it to get a stable, reproducible
  public key across runs.

When it starts, it prints a block containing the **public key**. Copy that
key.

## Step 2 -- machine B (gateway / probe)

On a **different network** (a VPS, a different home connection, mobile
tethering, etc.) run:

```
node field-test/probe.js <key>
```

The probe connects to the backend's key, times how long the holepunch
takes, downloads the test payload through the resulting tunnel, and prints
a report.

## Reading the output

- **`holepunch: OK (N ms)`** -- a direct P2P connection was established.
  Lower is better; a few hundred ms to a couple seconds is normal for a
  first connection over the DHT.
- **`holepunch FAIL`** (non-zero exit, printed after the 25s timeout) --
  no direct connection could be made. This almost always means one side is
  behind a **symmetric NAT or CGNAT** (common on mobile carriers and some
  ISPs), or UDP/DHT traffic is being blocked by a firewall. **This is a
  network condition, not a code bug** -- re-test from a different network
  (e.g. a cloud VPS, which typically has a public IP and no NAT) before
  assuming something is broken.
- **`throughput: N MB/s`** -- real, measured download speed through the
  tunnel for the payload. The VERDICT line buckets this into rough,
  clearly-labeled categories (`<1 MB/s` = very light/unreliable, `1-5` =
  light, `5-20` = medium, `20+` = heavy). These thresholds are intentionally
  simple and approximate -- use the raw MB/s number for anything precise.
- **`payload bytes`** -- should match the expected size from the
  `content-length` header. A `[WARNING: TRUNCATED]` marker means fewer
  bytes were received than advertised, which points to a connection issue
  during transfer rather than at holepunch time.

## Notes

- This kit only requires packages already present in the repo
  (`holesail-server`, `holesail-client`) plus Node built-ins. No new
  dependencies, no changes to `package.json` or `src/`.
- Both scripts use public mode (`secure: false`) for simplicity. A `s000`-
  prefixed (secure/private) key will trigger a warning in the probe and is
  not supported by this kit.
- Stop the backend with `Ctrl+C`; it cleans up the holesail-server tunnel
  and the local HTTP listener on exit.
