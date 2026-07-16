#!/usr/bin/env node
'use strict'

/**
 * field-test/probe.js
 *
 * Run this on the GATEWAY/VPS machine (or any machine on a DIFFERENT
 * network from the backend). It connects to the holesail-server key
 * printed by field-test/backend.js, measures holepunch (connect) time,
 * and then measures real throughput by downloading /payload through the
 * established tunnel.
 *
 * Usage:
 *   node field-test/probe.js <key>
 *
 * <key> may be a bare 52-char z32 key, or prefixed with "hs://" and/or a
 * leading "0000" (public-mode marker used by some holesail tooling).
 */

const http = require('node:http')
const HolesailClient = require('holesail-client')

const CONNECT_TIMEOUT_MS = 25_000

// ---------------------------------------------------------------------------
// Key normalization
// ---------------------------------------------------------------------------
function normalizeKey(raw) {
  if (!raw) {
    throw new Error('No key provided')
  }
  let key = raw.trim()

  // Strip an optional hs:// scheme prefix.
  if (key.startsWith('hs://')) {
    key = key.slice('hs://'.length)
  }

  // "s000" prefix marks a *secure* (private) mode key, which this probe
  // does not support -- warn loudly rather than silently mis-connecting.
  if (key.startsWith('s000')) {
    console.warn(
      'WARNING: key has an "s000" prefix, which indicates SECURE/private mode.'
    )
    console.warn(
      'This probe only supports PUBLIC mode keys (as produced by field-test/backend.js).'
    )
    console.warn('Connection will likely fail.')
  }

  // "0000" prefix marks public mode -- strip it, it is not part of the
  // underlying z32 key.
  if (key.startsWith('0000')) {
    key = key.slice(4)
  }

  return key
}

// ---------------------------------------------------------------------------
// HTTP helpers (against the local tunnel port)
// ---------------------------------------------------------------------------
function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = []
      let bytes = 0
      res.on('data', (chunk) => {
        chunks.push(chunk)
        bytes += chunk.length
      })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          bytes,
          body: Buffer.concat(chunks)
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const rawKey = process.argv[2]
  if (!rawKey) {
    console.error('Usage: node field-test/probe.js <key>')
    process.exit(1)
  }

  let key
  try {
    key = normalizeKey(rawKey)
  } catch (err) {
    console.error(`Key error: ${err.message}`)
    process.exit(1)
  }

  // Bind the local tunnel to an explicit, unlikely port so it never collides
  // with the backend's advertised loopback port (which is the client's default)
  // when the probe runs on the same host. Override with PROBE_LOCAL_PORT.
  const LOCAL_PORT = Number(process.env.PROBE_LOCAL_PORT) || 42999
  const client = new HolesailClient({ key, secure: false })

  console.log(`Connecting to key: ${key}`)
  console.log(`(holepunch timeout: ${CONNECT_TIMEOUT_MS / 1000}s)`)

  const connectStart = process.hrtime.bigint()

  let connectMs
  try {
    connectMs = await withTimeout(
      new Promise((resolve, reject) => {
        client.connect({ port: LOCAL_PORT, host: '127.0.0.1' }, () => {
          const connectEnd = process.hrtime.bigint()
          resolve(Number(connectEnd - connectStart) / 1e6)
        })
        // connect() itself is not expected to reject via promise (it uses a
        // callback), but guard in case the underlying call throws sync.
      }),
      CONNECT_TIMEOUT_MS
    )
  } catch (err) {
    console.log('')
    console.log('================================================================')
    console.log('  VERDICT: holepunch FAIL')
    console.log('================================================================')
    console.log(
      `  No direct connection within ${CONNECT_TIMEOUT_MS / 1000}s -- likely`
    )
    console.log(
      '  symmetric NAT / CGNAT on one side, or DHT blocked (firewall/UDP).'
    )
    console.log('  This is a network condition, not a code bug.')
    console.log('================================================================')
    try {
      await client.destroy()
    } catch {
      // best effort cleanup
    }
    process.exit(1)
  }

  const localPort = client.info.port
  console.log(`Connected. Local tunnel listening on 127.0.0.1:${localPort}`)

  // -------------------------------------------------------------------------
  // Liveness check
  // -------------------------------------------------------------------------
  let liveness
  try {
    liveness = await httpGet(localPort, '/')
  } catch (err) {
    console.error(`Liveness check (GET /) failed: ${err.message}`)
    await client.destroy()
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // Payload / throughput measurement
  // -------------------------------------------------------------------------
  const payloadStart = process.hrtime.bigint()
  let payload
  try {
    payload = await httpGet(localPort, '/payload')
  } catch (err) {
    console.error(`Payload request (GET /payload) failed: ${err.message}`)
    await client.destroy()
    process.exit(1)
  }
  const payloadEnd = process.hrtime.bigint()

  const elapsedSeconds = Number(payloadEnd - payloadStart) / 1e9
  const receivedBytes = payload.bytes
  const expectedBytes = Number(payload.headers['content-length'] || 0)
  const mbps = elapsedSeconds > 0 ? receivedBytes / 1024 / 1024 / elapsedSeconds : 0

  const truncated = expectedBytes > 0 && receivedBytes !== expectedBytes

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  let bucket
  if (mbps >= 20) bucket = 'heavy'
  else if (mbps >= 5) bucket = 'medium'
  else if (mbps >= 1) bucket = 'light'
  else bucket = 'very light / unreliable'

  console.log('')
  console.log('================================================================')
  console.log('  Field-test PROBE report')
  console.log('================================================================')
  console.log(`  holepunch:          OK (${connectMs.toFixed(1)} ms)`)
  console.log(
    `  liveness (GET /):    ${liveness.statusCode === 200 ? 'OK' : `unexpected status ${liveness.statusCode}`}`
  )
  console.log(
    `  payload bytes:       ${receivedBytes}${expectedBytes ? ` / expected ${expectedBytes}` : ''}${truncated ? '  [WARNING: TRUNCATED]' : ''}`
  )
  console.log(`  elapsed:             ${elapsedSeconds.toFixed(3)} s`)
  console.log(`  throughput:          ${mbps.toFixed(2)} MB/s`)
  console.log('')
  console.log(
    `  VERDICT: Direct P2P tunnel established; ${mbps.toFixed(2)} MB/s -- ` +
      `suitable for ${bucket} use (rough thresholds: <1=very light/unreliable, ` +
      '1-5=light, 5-20=medium, 20+=heavy).'
  )
  console.log('================================================================')
  console.log('')

  try {
    await client.destroy()
  } catch (err) {
    console.error(`Error destroying client: ${err.message}`)
  }

  process.exit(truncated ? 1 : 0)
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

main().catch((err) => {
  console.error(`Fatal error: ${err.stack || err.message}`)
  process.exit(1)
})
