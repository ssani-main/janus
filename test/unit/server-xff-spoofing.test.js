'use strict'

// Security audit S2 regression: clientIp(req) (src/server.js) used to trust
// the LEFTMOST X-Forwarded-For entry. Caddy's reverse_proxy APPENDS to XFF
// rather than replacing it, so the leftmost entry is attacker-controlled --
// a client could prepend `X-Forwarded-For: <anything>` ahead of the entry
// Caddy itself appends, and the old leftmost-wins code would bucket the
// rate limiter (and log) on that attacker-chosen value instead of the real
// peer.
//
// clientIp() now indexes X-Forwarded-For from the RIGHT by
// config.TRUSTED_PROXY_HOPS (default 1), so the rightmost entry -- the one
// the trusted proxy actually appended -- wins instead. This file proves
// that end-to-end via the request log's `ip` field, the same way
// server-healthz-logging.test.js already asserts on other logged fields.
//
// This file deliberately mirrors server-healthz-logging.test.js's harness
// (same env setup, same PORT=0 real-loopback-HTTP boot, same
// process.stdout.write capture-and-parse approach) rather than inventing a
// new one -- see that file's header comment for the full rationale (env
// isolation via node --test's one-child-process-per-file behavior, no real
// DHT/HolesailClient involved, etc).
//
// TRUSTED_PROXY_HOPS is intentionally left unset below so this test
// exercises the shipped default (1 hop), matching production Caddy
// deployment.

const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-xff-spoofing-${process.pid}.json`)

process.env.BASE_DOMAIN = 'gateway.example.com'
process.env.PORT = '0'
process.env.BIND_HOST = '127.0.0.1'
process.env.STORE_PATH = STORE_PATH
process.env.SESSION_SECRET = 'a'.repeat(64)
process.env.ADMIN_TOKEN = ''
process.env.RATE_MAX_REQUESTS = '100'
process.env.RATE_MAX_NEW_TUNNELS = '100'
process.env.LOG_REQUESTS = 'true'
process.env.COOKIE_SECURE = 'false'
// TRUSTED_PROXY_HOPS deliberately left unset -- default is 1 (src/config.js).

const { server } = require('../../src/server')

let port

function waitForListening(srv) {
  if (srv.listening) return Promise.resolve()
  return new Promise((resolve) => srv.once('listening', resolve))
}

function get(pth, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pth, headers }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

function captureStdout() {
  const writes = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    writes.push(chunk)
    return true
  }
  return {
    writes,
    restore() {
      process.stdout.write = original
    },
  }
}

before(async () => {
  await waitForListening(server)
  port = server.address().port
})

after(() => {
  server.close()
})

test('S2 regression: clientIp() trusts the RIGHTMOST X-Forwarded-For entry, not the spoofable leftmost one', async () => {
  // --- multi-entry XFF: attacker-prepended leftmost entry must be ignored ---
  // Simulates Caddy appending the real peer (203.0.113.9) onto an
  // attacker-supplied XFF that already contains a spoofed leftmost entry
  // (1.2.3.4). Pre-fix, clientIp() read parts[0] and would have logged
  // "1.2.3.4". Post-fix, it indexes from the right by TRUSTED_PROXY_HOPS
  // (default 1) and must log the rightmost entry, "203.0.113.9".
  {
    const cap = captureStdout()
    let res
    try {
      res = await get('/', {
        host: 'gateway.example.com',
        'x-forwarded-for': '1.2.3.4, 203.0.113.9',
      })
    } finally {
      cap.restore()
    }
    assert.equal(res.status, 200)

    const lines = cap.writes.filter((w) => w.includes('"msg":"request"'))
    assert.equal(lines.length, 1, `expected exactly one request log line, got ${lines.length}`)

    const parsed = JSON.parse(lines[0])
    assert.equal(
      parsed.ip,
      '203.0.113.9',
      'clientIp() must trust the RIGHTMOST XFF entry (the trusted proxy\'s own append), not the spoofable leftmost one'
    )
    assert.notEqual(
      parsed.ip,
      '1.2.3.4',
      'clientIp() must NOT trust the attacker-controlled leftmost XFF entry (this is the S2 vulnerability)'
    )
  }

  // --- single-entry XFF: backward compatibility -----------------------------
  // With exactly one hop of trust and exactly one XFF entry, that single
  // entry is both the leftmost AND the rightmost -- it must still be
  // trusted (this is the common case: a single reverse proxy in front of
  // the gateway, e.g. Caddy talking directly to a client).
  {
    const cap = captureStdout()
    let res
    try {
      res = await get('/', {
        host: 'gateway.example.com',
        'x-forwarded-for': '203.0.113.9',
      })
    } finally {
      cap.restore()
    }
    assert.equal(res.status, 200)

    const lines = cap.writes.filter((w) => w.includes('"msg":"request"'))
    assert.equal(lines.length, 1, `expected exactly one request log line, got ${lines.length}`)

    const parsed = JSON.parse(lines[0])
    assert.equal(
      parsed.ip,
      '203.0.113.9',
      'a single-entry XFF must still be trusted (backward compatibility with one trusted hop)'
    )
  }
})
