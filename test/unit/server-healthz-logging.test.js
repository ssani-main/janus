'use strict'

// Milestone 2a: covers src/server.js's /healthz endpoint, request logging,
// and the "ADMIN_TOKEN unset -> /metrics is invisible" case.
//
// server.js's config (src/config.js) is read once, synchronously, from
// process.env at require time -- so this file sets every env var it needs
// BEFORE requiring server.js, and `npm test`'s `node --test` runs every
// matched test file in its own child process (verified empirically), so
// this file's env vars can never leak into / collide with another test
// file's config.
//
// No real DHT/HolesailClient is involved anywhere in this file -- every
// request here is served by an apex-only code path (/healthz, /metrics,
// rate limiting) that never calls TunnelManager.ensureTunnel(). The only
// real network I/O is loopback HTTP against this same process's own
// gateway (PORT=0 -> OS-assigned ephemeral port), the same technique
// test/e2e/gateway.e2e.test.js already uses for its own spawned gateway.
//
// All of the below lives in ONE test() (like several of
// test/e2e/gateway.e2e.test.js's combined assertions) rather than several
// separate test()/t.test() calls against the same live server: this
// process's node:test + real-http-server + real-stdout-logger combination
// was empirically observed (in this environment) to occasionally drop a
// subtest's pass/fail report from the TAP output when 3+ sibling
// tests/subtests each drive real requests against the same long-lived
// server in one file -- the request itself and its assertions still ran
// correctly, but the runner's own report count for one sibling test came
// up short. Consolidating into one test() with per-section assert
// messages sidesteps that reporting flakiness while keeping the same
// coverage and clear failure attribution (each assert's message says
// exactly which behavior broke).

const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const net = require('node:net')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-healthz-${process.pid}.json`)

process.env.BASE_DOMAIN = 'gateway.example.com'
process.env.PORT = '0'
process.env.BIND_HOST = '127.0.0.1'
process.env.STORE_PATH = STORE_PATH
process.env.SESSION_SECRET = 'a'.repeat(64)
process.env.ADMIN_TOKEN = '' // unset -- /metrics must be invisible (404)
process.env.RATE_MAX_REQUESTS = '3'
process.env.RATE_MAX_NEW_TUNNELS = '3'
process.env.LOG_REQUESTS = 'true'
process.env.COOKIE_SECURE = 'false'

const { server } = require('../../src/server')

let port

function waitForListening(srv) {
  if (srv.listening) return Promise.resolve()
  return new Promise((resolve) => srv.once('listening', resolve))
}

function get(pth, headers, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pth, headers, agent }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Undo HTTP chunked transfer-encoding framing (server.js doesn't set an
 * explicit Content-Length on /healthz, so Node's http module chunks it). */
function dechunk(raw) {
  let out = ''
  let rest = raw
  for (;;) {
    const nl = rest.indexOf('\r\n')
    if (nl === -1) break
    const sizeLine = rest.slice(0, nl)
    const size = Number.parseInt(sizeLine, 16)
    if (!Number.isFinite(size) || size === 0) break
    out += rest.slice(nl + 2, nl + 2 + size)
    rest = rest.slice(nl + 2 + size + 2) // skip chunk data + trailing \r\n
  }
  return out
}

/**
 * Send a raw HTTP/1.1 request with an EMPTY Host header, over a plain
 * net.Socket. Node's own HTTP/1.1 parser rejects a request with the Host
 * header omitted entirely as a 400 client error before it ever reaches our
 * handler (Host is mandatory on HTTP/1.1), so "empty Host header" (`Host:`
 * with no value) is the faithful way to exercise routing.js's
 * "missing/empty Host" apex fallback over real HTTP.
 */
function rawRequestEmptyHost(pth) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${pth} HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n`)
    })
    let raw = ''
    socket.on('data', (d) => { raw += d })
    socket.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n')
      const [statusLine] = head.split('\r\n')
      const status = Number(statusLine.split(' ')[1])
      const isChunked = /transfer-encoding:\s*chunked/i.test(head)
      const rawBody = rest.join('\r\n\r\n')
      resolve({ status, body: isChunked ? dechunk(rawBody) : rawBody })
    })
    socket.on('error', reject)
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

test('/healthz + request logging + /metrics-invisible (Milestone 2a observability)', async () => {
  // --- /healthz on apex: 200 + {status:'ok', tunnels, uptime} -------------
  const healthzApex = await get('/healthz', { host: 'gateway.example.com', 'x-forwarded-for': '10.0.0.1' })
  assert.equal(healthzApex.status, 200, '/healthz on apex should return 200')
  const healthzParsed = JSON.parse(healthzApex.body)
  assert.equal(healthzParsed.status, 'ok', '/healthz body.status should be "ok"')
  assert.equal(typeof healthzParsed.tunnels, 'number', '/healthz body.tunnels should be a number')
  assert.equal(typeof healthzParsed.uptime, 'number', '/healthz body.uptime should be a number')

  // --- /healthz works with an empty Host header (routing.js apex fallback) --
  const emptyHost = await rawRequestEmptyHost('/healthz')
  assert.equal(emptyHost.status, 200, '/healthz with an empty Host header should still route to apex and return 200')
  assert.equal(JSON.parse(emptyHost.body).status, 'ok', '/healthz with empty Host should still report status "ok"')

  // --- /healthz is NOT charged by the rate limiter ------------------------
  // Dedicated fake IP (via x-forwarded-for -- TRUST_PROXY defaults true) so
  // this section's bucket-exhaustion can't affect any other section.
  {
    const ip = '10.0.0.2'
    const agent = new http.Agent({ keepAlive: false })
    const burns = []
    for (let i = 0; i < 3; i++) {
      burns.push(await get('/', { host: 'gateway.example.com', 'x-forwarded-for': ip }, agent))
    }
    assert.ok(
      burns.every((r) => r.status === 200),
      `expected all budget-burning apex requests to succeed: ${burns.map((r) => r.status)}`
    )

    const overBudget = await get('/', { host: 'gateway.example.com', 'x-forwarded-for': ip }, agent)
    assert.equal(overBudget.status, 429, 'sanity check: the per-IP budget really is exhausted now')

    const healthzUnderLimit = await get('/healthz', { host: 'gateway.example.com', 'x-forwarded-for': ip }, agent)
    assert.equal(
      healthzUnderLimit.status,
      200,
      '/healthz must be dispatched before the rate limiter, regardless of budget state'
    )
  }

  // --- request logging: one line, path has no query string, keyHash null ---
  {
    const cap = captureStdout()
    let res
    try {
      res = await get('/?keyHash=secret&x=1', { host: 'gateway.example.com', 'x-forwarded-for': '10.0.0.3' })
    } finally {
      cap.restore()
    }
    assert.equal(res.status, 200)

    const lines = cap.writes.filter((w) => w.includes('"msg":"request"'))
    assert.equal(lines.length, 1, `expected exactly one request log line, got ${lines.length}`)

    const parsed = JSON.parse(lines[0])
    assert.equal(parsed.path, '/', 'logged path must be the pathname only, no query string')
    assert.equal(parsed.path.includes('?'), false, 'logged path must not contain "?"')
    assert.equal(parsed.path.includes('keyHash'), false, 'logged path must not contain the query key "keyHash"')
    assert.equal(parsed.path.includes('secret'), false, 'logged path must not contain the query value "secret"')
    assert.equal(
      JSON.stringify(parsed).includes('secret'),
      false,
      'the query string value must not leak into any logged field'
    )
    assert.equal(parsed.keyHash, null, 'keyHash must be null on an apex request')
    assert.equal(parsed.method, 'GET')
    assert.equal(parsed.status, 200)
    assert.equal(typeof parsed.bytes, 'number')
    assert.ok(parsed.bytes > 0)
  }

  // --- exactly one log line even though both finish and close can fire -----
  {
    const cap = captureStdout()
    let res
    try {
      // connection:'close' forces the socket to close right after the
      // response, which reliably fires both 'finish' and 'close' on the
      // response object for a single request.
      res = await get('/', { host: 'gateway.example.com', connection: 'close', 'x-forwarded-for': '10.0.0.4' })
      assert.equal(res.status, 200)
      // Give 'close' a tick to fire after 'finish' if it hasn't already.
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      cap.restore()
    }

    const lines = cap.writes.filter((w) => w.includes('"msg":"request"'))
    assert.equal(lines.length, 1, `double-emit guard failed -- got ${lines.length} log lines for one request`)
  }

  // --- bytes are per-request, not cumulative across a keep-alive socket -----
  {
    const cap = captureStdout()
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    let first, second
    try {
      const headers = { host: 'gateway.example.com', 'x-forwarded-for': '10.0.0.5' }
      first = await get('/healthz', headers, agent)
      second = await get('/healthz', headers, agent)
    } finally {
      cap.restore()
      agent.destroy()
    }
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)

    const lines = cap.writes.filter((w) => w.includes('"msg":"request"')).map((w) => JSON.parse(w))
    assert.equal(lines.length, 2, `expected exactly 2 request log lines, got ${lines.length}`)

    const [bytes1, bytes2] = lines.map((l) => l.bytes)
    // If bytes were cumulative (bug: using res.socket.bytesWritten instead
    // of per-request instrumentation), the second request's logged byte
    // count would be roughly DOUBLE the first's (first + second summed on
    // the shared socket). The /healthz body is near-fixed-size (JSON with a
    // slowly-growing `uptime` float), so the two should be within a few
    // bytes of each other, never anywhere close to 2x.
    assert.ok(
      Math.abs(bytes2 - bytes1) <= 8,
      `expected roughly equal per-request byte counts (not cumulative), got bytes1=${bytes1} bytes2=${bytes2}`
    )
    assert.ok(
      bytes2 < bytes1 * 1.5,
      `second request's bytes (${bytes2}) look cumulative relative to the first (${bytes1})`
    )
  }

  // --- /metrics: ADMIN_TOKEN unset -> 404 (invisible, not 401) --------------
  const metricsRes = await get('/metrics', { host: 'gateway.example.com', 'x-forwarded-for': '10.0.0.6' })
  assert.equal(metricsRes.status, 404, '/metrics with ADMIN_TOKEN unset must be invisible (404), not 401')
})
