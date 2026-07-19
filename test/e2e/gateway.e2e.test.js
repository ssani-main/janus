'use strict'

// Real gateway process + real Holesail tunnels. Ported from the live-e2e
// phase1/2/3 scripts. Requires live DHT (UDP) connectivity -- run via
// `npm run test:e2e`, NOT part of `npm test`.

const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const HolesailServer = require('holesail-server')
const WebSocket = require('ws')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const BASE = 'gateway.example.com'
const TIMEOUT = 30000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function get(port, pth, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pth, headers }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

function request(port, { method = 'GET', pth = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pth, method, headers }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('timeout')))
    req.end()
  })
}

function backend(marker, port, { ws = false } = {}) {
  const app = http.createServer((req, res) => {
    res.writeHead(200)
    res.end(`${marker}|host=${req.headers.host}`)
  })
  if (ws) {
    new WebSocket.Server({ server: app }).on('connection', (socket) => {
      socket.on('message', (m) => socket.send(`${marker}-echo:${m}`))
    })
  }
  return new Promise((resolve) => app.listen(port, '127.0.0.1', () => resolve(app)))
}

function serve(port) {
  const s = new HolesailServer()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve timeout')), 30000)
    s.start({ port, host: '127.0.0.1' }, () => {
      clearTimeout(timer)
      resolve({ s, key: s.key })
    }).catch(reject)
  })
}

function spawnGateway(env) {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'server.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, BASE_DOMAIN: BASE, BIND_HOST: '127.0.0.1', ...env },
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const up = new Promise((resolve) => {
    const iv = setInterval(() => {
      if (/listening on/i.test(log)) {
        clearInterval(iv)
        resolve(true)
      }
    }, 100)
    setTimeout(() => {
      clearInterval(iv)
      resolve(false)
    }, 15000)
  })
  return { child, up, log: () => log }
}

function openWS(port, host) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { host } })
    s.on('open', () => resolve(s))
    s.on('error', reject)
    setTimeout(() => reject(new Error('ws open timeout')), 12000)
  })
}

async function killGateway(gw) {
  if (!gw) return
  gw.child.kill('SIGINT')
  await sleep(800)
}

// ---------------------------------------------------------------------------
// Shared fixtures: 2 backends (A: plain, B: with a ws echo) exposed over
// Holesail, held for the whole file. A single long-lived gateway (GW1) is
// used for routing/isolation/pages/websocket coverage; individual tests spin
// up their own short-lived gateway instances where distinct env vars
// (RATE_MAX_REQUESTS, ADMIN_TOKEN, ...) are required.
// ---------------------------------------------------------------------------

let appA, appB
let A, B
let gw1

before(async () => {
  appA = await backend('BACKEND-A', 18091)
  appB = await backend('BACKEND-B', 18092, { ws: true })
  A = await serve(18091)
  B = await serve(18092)

  gw1 = spawnGateway({
    PORT: '18101',
    TUNNEL_PORT_MIN: '21000',
    TUNNEL_PORT_MAX: '21099',
  })
  const up = await gw1.up
  assert.equal(up, true, `gateway (GW1) did not start listening:\n${gw1.log()}`)
})

after(async () => {
  await killGateway(gw1)
  try { await A.s.destroy() } catch { /* best-effort */ }
  try { await B.s.destroy() } catch { /* best-effort */ }
  appA.close()
  appB.close()
})

test('routes two distinct keys to their own backends, isolated', { timeout: TIMEOUT }, async () => {
  const hostA = `0000${A.key}.${BASE}`
  const hostB = `0000${B.key}.${BASE}`

  const rA = await get(18101, '/x', { host: hostA })
  const rB = await get(18101, '/x', { host: hostB })

  assert.equal(rA.status, 200)
  assert.ok(rA.body.startsWith('BACKEND-A'), rA.body)
  assert.equal(rB.status, 200)
  assert.ok(rB.body.startsWith('BACKEND-B'), rB.body)
})

test('bare key (no 0000 prefix) also routes', { timeout: TIMEOUT }, async () => {
  const r = await get(18101, '/x', { host: `${A.key}.${BASE}` })
  assert.equal(r.status, 200)
  assert.ok(r.body.startsWith('BACKEND-A'))
})

test('public Host header is preserved to the backend + Referrer-Policy: no-referrer is injected', { timeout: TIMEOUT }, async () => {
  const hostA = `0000${A.key}.${BASE}`
  const r = await get(18101, '/x', { host: hostA })
  assert.equal(r.status, 200)
  assert.ok(r.body.includes(`host=${hostA}`))
  assert.equal(r.headers['referrer-policy'], 'no-referrer')
})

test('websocket echo is routed by Host to the correct backend', { timeout: TIMEOUT }, async () => {
  const hostB = `0000${B.key}.${BASE}`
  const result = await new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const timer = setTimeout(() => finish({ ok: false, err: 'ws timeout' }), 15000)
    const socket = new WebSocket(`ws://127.0.0.1:18101`, { headers: { host: hostB } })
    socket.on('open', () => socket.send('ping'))
    socket.on('message', (m) => {
      clearTimeout(timer)
      socket.close()
      finish({ ok: String(m) === 'BACKEND-B-echo:ping', got: String(m) })
    })
    socket.on('error', (e) => { clearTimeout(timer); finish({ ok: false, err: e.message }) })
  })
  assert.equal(result.ok, true, result.err || result.got)
})

test('apex, /impressum, /terms return 200; foreign host 404; malformed key 400; secure key 400', { timeout: TIMEOUT }, async () => {
  const apex = await get(18101, '/', { host: BASE })
  assert.equal(apex.status, 200)
  assert.ok(/html/i.test(apex.headers['content-type'] || ''))

  const impressum = await get(18101, '/impressum', { host: BASE })
  assert.equal(impressum.status, 200)

  const terms = await get(18101, '/terms', { host: BASE })
  assert.equal(terms.status, 200)

  const foreign = await get(18101, '/', { host: 'evil.com' })
  assert.equal(foreign.status, 404)

  const malformed = await get(18101, '/', { host: `zzz.${BASE}` })
  assert.equal(malformed.status, 400)

  const secure = await get(18101, '/', { host: `s000${A.key}.${BASE}` })
  assert.equal(secure.status, 400)
})

test('per-IP request rate limit returns 429 once exceeded', { timeout: TIMEOUT }, async () => {
  const gw = spawnGateway({
    PORT: '18102',
    RATE_MAX_REQUESTS: '5',
    RATE_MAX_NEW_TUNNELS: '100',
    TUNNEL_PORT_MIN: '21100',
    TUNNEL_PORT_MAX: '21199',
  })
  try {
    const up = await gw.up
    assert.equal(up, true, `rate-limit gateway did not start:\n${gw.log()}`)

    const shots = []
    for (let i = 0; i < 8; i++) {
      shots.push(await request(18102, { pth: '/', headers: { host: BASE, 'x-forwarded-for': '9.9.9.9' } }))
    }
    const ok200 = shots.filter((s) => s.status === 200).length
    const got429 = shots.filter((s) => s.status === 429).length
    assert.equal(ok200, 5, `expected 5 ok responses, got statuses ${shots.map((s) => s.status).join(',')}`)
    assert.ok(got429 > 0, 'expected at least one 429')
    const rejected = shots.find((s) => s.status === 429)
    assert.ok(rejected.headers['retry-after'] !== undefined)
  } finally {
    await killGateway(gw)
  }
})

test('admin API: 401 without token, 200 with token, kill+block -> 403, unblock -> 200 again', { timeout: TIMEOUT }, async () => {
  const gw = spawnGateway({
    PORT: '18103',
    ADMIN_TOKEN: 'secret-secret-secret',
    TUNNEL_PORT_MIN: '21200',
    TUNNEL_PORT_MAX: '21299',
  })
  try {
    const up = await gw.up
    assert.equal(up, true, `admin gateway did not start:\n${gw.log()}`)

    const hostA = `0000${A.key}.${BASE}`
    // Warm a tunnel for A so it shows up in the admin listing.
    const warm = await request(18103, { pth: '/', headers: { host: hostA } })
    assert.equal(warm.status, 200)

    const noAuth = await request(18103, { pth: '/_admin/tunnels', headers: { host: BASE } })
    assert.equal(noAuth.status, 401)

    const listed = await request(18103, { pth: '/_admin/tunnels', headers: { host: BASE, authorization: 'Bearer secret-secret-secret' } })
    assert.equal(listed.status, 200)
    const parsed = JSON.parse(listed.body)
    assert.ok(parsed.count >= 1)
    assert.ok(parsed.tunnels[0].keyHash)

    const keyHash = parsed.tunnels[0].keyHash
    const killed = await request(18103, {
      method: 'POST',
      pth: `/_admin/kill?keyHash=${keyHash}&block=1`,
      headers: { host: BASE, authorization: 'Bearer secret-secret-secret' },
    })
    assert.equal(killed.status, 200)
    assert.equal(JSON.parse(killed.body).blocked, true)

    await sleep(300)
    const blocked = await request(18103, { pth: '/', headers: { host: hostA } })
    assert.equal(blocked.status, 403)

    const unblocked = await request(18103, {
      method: 'POST',
      pth: `/_admin/unblock?keyHash=${keyHash}`,
      headers: { host: BASE, authorization: 'Bearer secret-secret-secret' },
    })
    assert.equal(unblocked.status, 200)

    const reopened = await request(18103, { pth: '/', headers: { host: hostA } })
    assert.equal(reopened.status, 200)
    assert.ok(reopened.body.startsWith('BACKEND-A'))
  } finally {
    await killGateway(gw)
  }
})
