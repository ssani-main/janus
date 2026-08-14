'use strict'

// F2 regression: the per-key password gate (src/server.js's passwordGate) had
// no lockout of any kind. The ONLY throttle on guessing a tenant's password
// was the general RATE_MAX_REQUESTS limiter -- ~120 guesses per minute per
// IP, indefinitely, and scaling with the attacker's IP count. The admin gate
// has had a per-IP lockout since S8; this file pins the equivalent on the
// visitor-facing gate.
//
// Two properties are load-bearing and each has its own test below:
//
//  1. The lockout is keyed on (ip, keyHash), NOT on ip alone. A brute-forcer
//     must burn a separate lockout for every key they attack, and one
//     attacker behind a shared NAT/CGNAT must not be able to lock legitimate
//     visitors out of every OTHER passworded key on the gateway.
//  2. Only a genuinely wrong password counts. A malformed POST (wrong
//     Content-Type, oversized/aborted body) never reaches verifyPassword, so
//     counting it would let a bystander's broken client lock a visitor out
//     without a single guess being made.
//
// Harness mirrors server-xff-spoofing.test.js / server-healthz-logging.test.js
// exactly (same env setup, same PORT=0 real-loopback boot) -- see those files
// for the full rationale. No DHT or HolesailClient is involved: every request
// here is answered by the password gate before any tunnel work happens, which
// is itself the property that makes the gate worth protecting.
//
// NOT registered in fixtures/port-ranges.js, deliberately, and this is the
// thing to re-check if you extend this file: it binds no TUNNEL_PORT_* ports,
// so it has no range to declare. `passwordGate` returns 'handled' on every
// path exercised here (including the successful 302 login), so control never
// reaches ensureTunnel and the PortPool -- left on its default 20000-20999,
// which WOULD overlap other files' registered ranges -- never hands out a
// port. Same precedent as server-xff-spoofing.test.js. If you ever add a case
// that lets a request through to a real cold create, give this file its own
// disjoint TUNNEL_PORT_MIN/MAX and register it.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const { parseKey } = require('../../src/key')
const { hashPassword } = require('../../src/auth')

const STORE_PATH = path.join(os.tmpdir(), `janus-test-store-pw-lockout-${process.pid}.json`)

// Two distinct valid public keys, so the per-key isolation test has a second
// target that shares the attacker's IP. z-base-32 alphabet, 52 chars each.
const KEY_A = '0000' + 'y'.repeat(52)
const KEY_B = '0000' + 'b'.repeat(52)
const HASH_A = parseKey(KEY_A).keyHash
const HASH_B = parseKey(KEY_B).keyHash

const PASSWORD = 'correct-horse-battery-staple'
const MAX_FAILS = 3
const LOCKOUT_MS = 60000

// The store must exist before src/server.js is required -- it loads it once,
// synchronously, at module scope.
function seedStore() {
  const salt = crypto.randomBytes(16).toString('hex')
  // hashPassword is async; this file needs the digest before require() runs,
  // so precompute synchronously with the same parameters auth.js uses.
  const hash = crypto.scryptSync(PASSWORD, salt, 64).toString('hex')
  const record = (keyHash, rawKey) => ({
    rawKey,
    alias: null,
    password: { hash, salt, pwdVersion: 1 },
    pwdVersion: 1,
    blocked: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  fs.writeFileSync(
    STORE_PATH,
    JSON.stringify({
      version: 1,
      keys: { [HASH_A]: record(HASH_A, KEY_A), [HASH_B]: record(HASH_B, KEY_B) },
      aliases: {},
    }),
    'utf8'
  )
}
seedStore()

process.env.BASE_DOMAIN = 'gateway.example.com'
process.env.PORT = '0'
process.env.BIND_HOST = '127.0.0.1'
process.env.STORE_PATH = STORE_PATH
process.env.SESSION_SECRET = 'a'.repeat(64)
process.env.ADMIN_TOKEN = ''
// Keep the general limiter far out of the way -- this file is about the
// password lockout specifically, and a RATE_MAX_REQUESTS trip would produce
// the same 429 for an entirely different reason and silently hollow out
// every assertion below.
process.env.RATE_MAX_REQUESTS = '10000'
process.env.RATE_MAX_NEW_TUNNELS = '10000'
process.env.COOKIE_SECURE = 'false'
process.env.TRUST_PROXY = 'true'
process.env.KEY_LOGIN_MAX_FAILS = String(MAX_FAILS)
process.env.KEY_LOGIN_LOCKOUT_MS = String(LOCKOUT_MS)

const { server } = require('../../src/server')

let port

function waitForListening(srv) {
  if (srv.listening) return Promise.resolve()
  return new Promise((resolve) => srv.once('listening', resolve))
}

/**
 * POST a password attempt to the tenant login path as `ip`, for `rawKey`.
 * TRUST_PROXY=true + a single XFF entry is how this file controls the client
 * IP the lockout buckets on (clientIp() indexes XFF from the right).
 */
function attempt(rawKey, ip, password, { contentType = 'application/x-www-form-urlencoded' } = {}) {
  const body = `password=${encodeURIComponent(password)}&next=/`
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/__janus_login',
        method: 'POST',
        headers: {
          host: `${rawKey}.gateway.example.com`,
          'content-type': contentType,
          'content-length': Buffer.byteLength(body),
          'x-forwarded-for': ip,
        },
      },
      (res) => {
        let out = ''
        res.on('data', (d) => { out += d })
        res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

before(async () => {
  await waitForListening(server)
  port = server.address().port
})

after(() => {
  server.close()
  try { fs.unlinkSync(STORE_PATH) } catch {}
})

test('F2: repeated wrong passwords for one key from one IP trigger a 429 lockout with Retry-After', async () => {
  const ip = '203.0.113.10'

  // Up to the threshold, each wrong guess gets the ordinary 200 login page
  // again -- not a lockout, and deliberately not a distinguishable status.
  for (let i = 0; i < MAX_FAILS; i++) {
    const res = await attempt(KEY_A, ip, 'wrong-guess')
    assert.equal(res.status, 200, `attempt ${i + 1} should still render the login page`)
    assert.match(res.body, /Incorrect password/, `attempt ${i + 1} should say the password was wrong`)
  }

  // The next attempt is refused before the password is even checked.
  const locked = await attempt(KEY_A, ip, 'wrong-guess')
  assert.equal(locked.status, 429, 'once past KEY_LOGIN_MAX_FAILS the gate must lock out, not keep hashing')
  assert.match(locked.body, /Too many attempts/)
  const retryAfter = Number(locked.headers['retry-after'])
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, `Retry-After must be a positive number, got ${locked.headers['retry-after']}`)
  assert.ok(retryAfter <= Math.ceil(LOCKOUT_MS / 1000), 'Retry-After must not exceed the configured base lockout')
})

test('F2: a locked-out IP is refused even when it finally submits the CORRECT password', async () => {
  // This is the property that makes the lockout worth having: it must not be
  // possible to keep guessing and have a lucky correct guess sail through.
  const ip = '203.0.113.11'
  for (let i = 0; i < MAX_FAILS; i++) {
    await attempt(KEY_A, ip, 'wrong-guess')
  }
  const res = await attempt(KEY_A, ip, PASSWORD)
  assert.equal(res.status, 429, 'a locked-out client must be refused regardless of what it submits')
  assert.doesNotMatch(res.body, /Set-Cookie/i)
  assert.equal(res.headers['set-cookie'], undefined, 'no session cookie may be issued to a locked-out client')
})

test('F2: the lockout is scoped per (ip, keyHash) -- locking one key must not lock a sibling key from the same IP', async () => {
  const ip = '203.0.113.12'

  // Burn KEY_A's budget from this IP.
  for (let i = 0; i < MAX_FAILS; i++) {
    await attempt(KEY_A, ip, 'wrong-guess')
  }
  const lockedA = await attempt(KEY_A, ip, 'wrong-guess')
  assert.equal(lockedA.status, 429, 'KEY_A must be locked out for this IP')

  // KEY_B, same IP, must be untouched. Keying the lockout on IP alone (the
  // way the admin gate does) would fail here -- and in production that would
  // let one attacker behind a shared NAT deny every other passworded tenant
  // to everyone else behind that NAT.
  const b = await attempt(KEY_B, ip, 'wrong-guess')
  assert.equal(b.status, 200, 'a DIFFERENT key from the same IP must not inherit the lockout')
  assert.match(b.body, /Incorrect password/)
})

test('F2: the lockout is scoped per IP -- one attacker must not lock a different visitor out of the same key', async () => {
  const attacker = '203.0.113.13'
  const bystander = '203.0.113.14'

  for (let i = 0; i < MAX_FAILS; i++) {
    await attempt(KEY_A, attacker, 'wrong-guess')
  }
  const lockedAttacker = await attempt(KEY_A, attacker, 'wrong-guess')
  assert.equal(lockedAttacker.status, 429)

  // The bystander's correct password must still work: a successful login is
  // the strongest possible proof the gate is still open for them.
  const ok = await attempt(KEY_A, bystander, PASSWORD)
  assert.equal(ok.status, 302, 'an unrelated IP must still be able to log in')
  assert.ok(ok.headers['set-cookie'], 'a successful login must still issue its session cookie')
})

test('F2: a malformed POST (wrong Content-Type) never reaches the password check and must not count toward a lockout', async () => {
  const ip = '203.0.113.15'

  // Far more than the threshold, all malformed. None reached verifyPassword,
  // so none may count -- otherwise a bystander's broken client (or a trivial
  // unauthenticated request) could lock a visitor out without ever making a
  // guess.
  for (let i = 0; i < MAX_FAILS * 3; i++) {
    const res = await attempt(KEY_A, ip, PASSWORD, { contentType: 'text/plain' })
    assert.equal(res.status, 200)
  }

  // The correct password must still be accepted.
  const ok = await attempt(KEY_A, ip, PASSWORD)
  assert.equal(ok.status, 302, 'malformed POSTs must not have consumed this IP\'s attempt budget')
  assert.ok(ok.headers['set-cookie'])
})

test('F2: a correct password clears the accumulated failure count', async () => {
  const ip = '203.0.113.16'

  // One short of the threshold, then succeed -- which must reset the counter.
  for (let i = 0; i < MAX_FAILS - 1; i++) {
    await attempt(KEY_A, ip, 'wrong-guess')
  }
  const ok = await attempt(KEY_A, ip, PASSWORD)
  assert.equal(ok.status, 302)

  // A full fresh budget must be available again; without the reset, the
  // very first of these would already trip the lockout.
  for (let i = 0; i < MAX_FAILS; i++) {
    const res = await attempt(KEY_A, ip, 'wrong-guess')
    assert.equal(res.status, 200, `post-success attempt ${i + 1} must not be locked out`)
  }
})

test('F2: hashPassword/verifyPassword agree with the digest this file seeds the store with', async () => {
  // Guards the harness itself: seedStore() precomputes the scrypt digest
  // synchronously (it must exist before src/server.js is required), while the
  // gate verifies with src/auth.js's async path. If those two ever diverged,
  // every "correct password" assertion above would silently become a
  // wrong-password assertion and the suite would still look green.
  const salt = crypto.randomBytes(16).toString('hex')
  const { hash } = await hashPassword(PASSWORD, salt)
  assert.equal(hash, crypto.scryptSync(PASSWORD, salt, 64).toString('hex'))
})
