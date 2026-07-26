'use strict'

// Measures the real resident-memory cost of a live Janus tunnel, so
// MAX_TUNNELS can be set against the systemd MemoryMax in deploy/janus.service
// instead of guessed at.
//
// WHY THIS EXISTS: each cached tunnel holds a HolesailClient, and each of
// those is a HyperDHT node with its own UDP socket, routing table and
// keepalive traffic. deploy/janus.service ships MemoryMax=768M with the note
// "nothing bounds how much memory each one's DHT state consumes" -- this
// script turns that unknown into a number. If per-tunnel RSS x MAX_TUNNELS
// approaches MemoryMax, the process gets OOM-killed under load and systemd
// restarts it, dropping every live tenant at once.
//
// RUN IT ON THE VPS, not a laptop: HyperDHT holepunching behaviour (and
// therefore memory) depends on the network path, and the VPS is the machine
// whose limit you are setting. Requires devDependencies (holesail-server).
//
//   node deploy/measure-tunnel-memory.js [tunnelCount]
//
// Reads nothing from .env and starts no gateway: it drives TunnelManager
// directly against locally-served backends, so it is safe to run alongside a
// live gateway PROVIDED you keep the port range below off the live one.

const net = require('node:net')
const path = require('node:path')
const HolesailServer = require('holesail-server')
const { TunnelManager } = require(path.join(__dirname, '..', 'src', 'tunnel-manager.js'))

const COUNT = Number.parseInt(process.argv[2] || '10', 10)

// Deliberately NOT the default 20000-20999 range, so this can run next to a
// live gateway without fighting it for ports.
const TUNNEL_PORT_MIN = 24000
const TUNNEL_PORT_MAX = 24200

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1)
}

/** RSS after giving V8 a chance to collect, so we measure retention not garbage. */
async function settledRss() {
  if (global.gc) {
    global.gc()
    global.gc()
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
  return process.memoryUsage().rss
}

function startBackend() {
  const server = net.createServer((sock) => sock.end('ok'))
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  )
}

function serve(port) {
  const s = new HolesailServer()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('holesail serve timed out after 30s')), 30000)
    s.start({ port, host: '127.0.0.1' }, () => {
      clearTimeout(timer)
      resolve({ s, key: s.key })
    }).catch(reject)
  })
}

async function main() {
  if (!global.gc) {
    console.log('NOTE: run with --expose-gc for cleaner numbers:')
    console.log('      node --expose-gc deploy/measure-tunnel-memory.js\n')
  }
  console.log(`Measuring RSS across ${COUNT} live tunnels.\n`)

  const config = {
    MAX_TUNNELS: Math.max(COUNT + 5, 10),
    TUNNEL_PORT_MIN,
    TUNNEL_PORT_MAX,
    CONNECT_TIMEOUT_MS: 15000,
    ENSURE_TUNNEL_TIMEOUT_MS: 60000,
    IDLE_TTL_MS: 3600000,
    MAX_PORT_ATTEMPTS: 5,
    RECONNECT_MAX_ATTEMPTS: 1,
    RECONNECT_BASE_DELAY_MS: 250,
    RECONNECT_MAX_DELAY_MS: 5000,
    WS_MAX_SLOTS: Math.max(COUNT, 5),
    MAX_CONCURRENT_CREATES: 4,
    MAX_CREATE_QUEUE: 64,
    PORT_QUARANTINE_MS: 15000,
  }

  const manager = new TunnelManager(config)
  const backends = []
  const servers = []

  const baseline = await settledRss()
  console.log(`baseline RSS (manager only, no tunnels): ${mb(baseline)} MB\n`)

  console.log('  n   RSS(MB)   delta(MB)   per-tunnel(MB)')
  console.log('  --  --------  ----------  --------------')

  let established = 0
  for (let i = 0; i < COUNT; i++) {
    let key
    try {
      const b = await startBackend()
      backends.push(b)
      const served = await serve(b.port)
      servers.push(served.s)
      key = served.key
    } catch (err) {
      console.log(`  backend ${i + 1} failed to announce: ${err.message}`)
      console.log('  -> if every one fails, outbound UDP is filtered; see DEPLOY.md preflight.')
      break
    }

    try {
      await manager.ensureTunnel(key)
      established++
    } catch (err) {
      console.log(`  tunnel ${i + 1} failed to connect: ${err.message}`)
      continue
    }

    const rss = await settledRss()
    const delta = rss - baseline
    console.log(
      `  ${String(established).padStart(2)}  ${mb(rss).padStart(8)}  ${mb(delta).padStart(10)}  ` +
      `${mb(delta / established).padStart(14)}`
    )
  }

  const finalRss = await settledRss()
  console.log('')
  if (established === 0) {
    console.log('No tunnels established -- nothing to measure. Check outbound UDP first.')
  } else {
    const perTunnel = (finalRss - baseline) / established
    console.log(`per-tunnel RSS (mean over ${established}): ${mb(perTunnel)} MB`)
    console.log('')
    const memoryMaxMb = 768 // deploy/janus.service
    const projected = (perTunnel * 50) / 1024 / 1024 + baseline / 1024 / 1024
    console.log(`Projection at the shipped MAX_TUNNELS=50:`)
    console.log(`  ~${projected.toFixed(0)} MB vs MemoryMax=${memoryMaxMb}M in deploy/janus.service`)
    if (projected > memoryMaxMb * 0.8) {
      console.log(`  ⚠ WITHIN 20% OF THE LIMIT -- lower MAX_TUNNELS or raise MemoryMax.`)
    } else {
      console.log(`  OK -- comfortable headroom.`)
    }
    console.log('')
    console.log('Caveat: this measures IDLE tunnels. Proxied traffic adds buffer memory')
    console.log('on top, so treat the projection as a floor, not a ceiling.')
  }

  await manager.shutdown()
  await Promise.all(servers.map((s) => s.destroy().catch(() => {})))
  await Promise.all(backends.map((b) => new Promise((r) => b.server.close(r))))
  process.exit(0)
}

main().catch((err) => {
  console.error('measurement failed:', err && err.stack)
  process.exit(1)
})
