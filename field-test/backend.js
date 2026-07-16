#!/usr/bin/env node
'use strict'

/**
 * field-test/backend.js
 *
 * Run this on the REMOTE backend machine (machine A). It starts a small
 * local HTTP server (loopback only) and wraps it with a holesail-server
 * tunnel in PUBLIC mode. The printed key is the only thing you need to
 * hand to the probe running on machine B (a different network).
 *
 * Usage:
 *   node field-test/backend.js [--size <MB>] [--seed <64-hex>]
 *
 *   --size <MB>    size of the /payload response in megabytes (default 8)
 *   --seed <hex>   optional 64-hex seed for a stable, reproducible key
 */

const http = require('node:http')
const HolesailServer = require('holesail-server')

// ---------------------------------------------------------------------------
// CLI parsing (manual, no deps)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { size: 8, seed: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--size') {
      const value = argv[++i]
      const size = Number(value)
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`Invalid --size value: ${value}`)
      }
      args.size = size
    } else if (arg === '--seed') {
      const value = argv[++i]
      if (!/^[0-9a-fA-F]{64}$/.test(value || '')) {
        throw new Error('--seed must be a 64-character hex string')
      }
      args.seed = value
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`Argument error: ${err.message}`)
    console.error('Usage: node field-test/backend.js [--size <MB>] [--seed <64-hex>]')
    process.exit(1)
  }

  if (args.help) {
    console.log('Usage: node field-test/backend.js [--size <MB>] [--seed <64-hex>]')
    process.exit(0)
  }

  const payloadBytes = Math.round(args.size * 1024 * 1024)
  // Pre-allocate the payload buffer once so every /payload request is cheap.
  const payloadBuffer = Buffer.alloc(payloadBytes)

  // -------------------------------------------------------------------------
  // Local HTTP server (loopback only, ephemeral port)
  // -------------------------------------------------------------------------
  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      const body = 'holesail field-test backend OK'
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-length': Buffer.byteLength(body)
      })
      res.end(body)
      return
    }

    if (req.method === 'GET' && req.url === '/payload') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payloadBuffer.length
      })
      res.end(payloadBuffer)
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    // 0 = ephemeral port, 127.0.0.1 = loopback only (the holesail-server
    // tunnel is what exposes it to the outside world).
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  const localPort = httpServer.address().port

  // -------------------------------------------------------------------------
  // Wrap with holesail-server (public mode)
  // -------------------------------------------------------------------------
  const holesailServer = new HolesailServer()

  const startOpts = { port: localPort, host: '127.0.0.1' }
  if (args.seed) startOpts.seed = args.seed

  await holesailServer.start(startOpts, () => {
    const key = holesailServer.key
    console.log('')
    console.log('================================================================')
    console.log('  Holesail field-test BACKEND is ready')
    console.log('================================================================')
    console.log(`  Local HTTP server:   http://127.0.0.1:${localPort}`)
    console.log(`  Payload size:        ${args.size} MB (${payloadBytes} bytes)`)
    console.log(`  Public key:          ${key}`)
    console.log('')
    console.log('  On the OTHER machine, run:')
    console.log(`    node field-test/probe.js ${key}`)
    console.log('')
    console.log('  NOTE: for this to actually exercise cross-NAT holepunching,')
    console.log('  the two machines MUST be on DIFFERENT networks (different')
    console.log('  public IPs / different NAT gateways). Running both on the')
    console.log('  same host or LAN only proves the scripts work, not that')
    console.log('  cross-NAT punching succeeds.')
    console.log('================================================================')
    console.log('')
    console.log('Press Ctrl+C to stop.')
  })

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\nShutting down backend...')
    try {
      await holesailServer.destroy()
    } catch (err) {
      console.error(`Error destroying holesail server: ${err.message}`)
    }
    httpServer.close(() => {
      process.exit(0)
    })
    // Failsafe in case close() hangs on lingering sockets.
    setTimeout(() => process.exit(0), 2000).unref()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(`Fatal error: ${err.stack || err.message}`)
  process.exit(1)
})
