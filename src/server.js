'use strict'

const crypto = require('node:crypto')
const http = require('node:http')
const httpProxy = require('http-proxy')
const config = require('./config')
const { hostToKey } = require('./routing')
const { parseKey } = require('./key')
const { load: loadStore } = require('./store')
const { TunnelManager, CapacityError, ConnectError, KeyError, BlockedError } = require('./tunnel-manager')
const { RateLimiter } = require('./rate-limit')
const { escapeHtml, apexPage, impressumPage, termsPage, rateLimitPage, loginPage } = require('./pages')
const { handleAdmin } = require('./admin')
const { hashPassword, verifyPassword, signSession, verifySession, parseCookies } = require('./auth')

const store = loadStore(config.STORE_PATH)

// Milestone 1, Feature 3/4: session secret used to sign/verify the
// password-gate and (later) admin dashboard cookies. config.js stays
// pure/synchronous, so the random-fallback generation (and warning) happens
// here at boot instead.
let sessionSecret = config.SESSION_SECRET
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex')
  console.warn(
    'SESSION_SECRET is not set -- generated a random secret for this process. ' +
    'Password-protected keys and admin dashboard sessions will not survive a ' +
    'restart, and will not work correctly if this gateway runs as multiple ' +
    'processes/instances. Set SESSION_SECRET in your environment to avoid this.'
  )
} else if (sessionSecret.length < 32) {
  console.warn(
    'SESSION_SECRET is shorter than 32 characters -- for a secure session/CSRF ' +
    'HMAC, SESSION_SECRET should be at least 32 characters (256 bits) long.'
  )
}

const COOKIE_NAME = 'janus_auth'
const LOGIN_PATH = '/__janus_login'
const LOGIN_BODY_MAX_BYTES = 4096

const manager = new TunnelManager(config, store)
manager.startSweeper()

const limiter = new RateLimiter({
  windowMs: config.RATE_WINDOW_MS,
  maxRequests: config.RATE_MAX_REQUESTS,
  maxNewTunnels: config.RATE_MAX_NEW_TUNNELS,
})
limiter.start()

// xfwd: true adds X-Forwarded-For / X-Forwarded-Port / X-Forwarded-Proto.
// changeOrigin defaults to false, which is what we want: the backend must
// see the public Host, not 127.0.0.1:<port>.
const proxy = httpProxy.createProxyServer({ xfwd: true })

// Strip the key out of anything that might reach an app the visitor didn't
// share the key with themselves.
proxy.on('proxyRes', (proxyRes) => {
  proxyRes.headers['referrer-policy'] = 'no-referrer'
})

// A backend hiccup (tunnel died mid-request, ECONNRESET, etc.) must not
// crash the gateway process.
proxy.on('error', (err, req, res) => {
  console.error('proxy error:', err.message)
  if (res && !res.headersSent && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(errorPage(502, 'Bad Gateway', 'The backend tunnel closed unexpectedly.'))
  } else if (res && typeof res.destroy === 'function') {
    // res is actually a raw socket (websocket upgrade path)
    res.destroy()
  }
})

function errorPage(code, title, msg) {
  const safeTitle = escapeHtml(title)
  const safeMsg = escapeHtml(msg)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${code} ${safeTitle} - Janus</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0b0d12; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  .card { max-width: 32rem; padding: 2rem; border: 1px solid #2a2f3a; border-radius: 0.75rem; background: #12151c; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; color: #7dd3fc; }
  p { margin: 0; color: #b8bec9; line-height: 1.5; }
  .code { color: #64748b; font-size: 0.85rem; margin-top: 1rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMsg}</p>
    <p class="code">Janus &middot; HTTP ${code}</p>
  </div>
</body>
</html>`
}

// Phase 3: per-IP rate limiting needs a client IP. TRUST_PROXY should only
// be true when the gateway sits behind a proxy we control (Caddy) that
// overwrites/sets X-Forwarded-For itself -- otherwise a client could spoof
// it to dodge the limiter.
function clientIp(req) {
  if (config.TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for']
    if (xff) {
      return String(xff).split(',')[0].trim()
    }
  }
  return req.socket.remoteAddress
}

function statusForError(err) {
  if (err instanceof CapacityError) return 503
  if (err instanceof ConnectError) return 502
  if (err instanceof KeyError) return 400
  if (err instanceof BlockedError) return 403
  return 500
}

/**
 * Milestone 1, Feature 2: resolve a routing decision's `rawKey` label
 * against named aliases. Raw keys always win -- if the label already
 * parses as a valid Holesail key it is returned unchanged without ever
 * consulting the store. Only when it does NOT parse do we treat it as an
 * alias lookup. src/routing.js stays pure (host classification only); this
 * lives in server.js because it needs the store.
 *
 * @param {{ apex: true } | { rawKey: string } | { invalid: true }} route
 * @param {import('./store').Store} store
 * @returns {{ apex: true } | { rawKey: string } | { invalid: true }}
 */
function resolveRoute(route, store) {
  if (route.apex || route.invalid) return route

  try {
    parseKey(route.rawKey)
    return route
  } catch {
    // Not a parseable key -- fall through to alias resolution.
  }

  const entry = store.getByAlias(route.rawKey)
  if (entry) return { rawKey: entry.rawKey }
  // No alias match: leave the route untouched so a malformed/unknown label
  // flows to ensureTunnel -> KeyError -> 400, exactly as before aliases
  // existed. Aliases are purely additive -- they only change routing when the
  // alias is actually registered.
  return route
}

/**
 * Read a request body up to `maxBytes`, rejecting (destroying the request)
 * if it's exceeded. Resolves to the collected string, or null if the
 * request errored/aborted.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<?string>}
 */
function readBodyCapped(req, maxBytes) {
  return new Promise((resolve) => {
    let total = 0
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > maxBytes) {
        req.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
    req.on('aborted', () => finish(null))
  })
}

/**
 * Validate a post-login redirect target: must be a same-origin local path
 * (starts with a single '/'), never a scheme-relative ("//host/...") or
 * backslash-prefixed value, both of which browsers can treat as absolute.
 *
 * @param {?string} next
 * @returns {string}
 */
function safeNextPath(next) {
  if (
    typeof next === 'string' &&
    next.startsWith('/') &&
    !next.startsWith('//') &&
    !next.includes('\\')
  ) {
    return next
  }
  return '/'
}

/**
 * Milestone 1, Feature 3: optional per-key password gate. A key with no
 * password set is left completely untouched -- this must be checked and
 * return 'proceed' before any tunnel/cold-start work happens, so an
 * unauthenticated visitor can never trigger tunnel creation for a
 * password-protected key.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} rawKey
 * @returns {Promise<'proceed' | 'handled'>}
 */
async function passwordGate(req, res, rawKey) {
  let keyHash
  try {
    keyHash = parseKey(rawKey).keyHash
  } catch {
    // Not a parseable key -- let ensureTunnel produce the normal KeyError.
    return 'proceed'
  }

  const pw = store.getPassword(keyHash)
  if (!pw) return 'proceed'

  const url = new URL(req.url, 'http://internal')

  if (req.method === 'POST' && url.pathname === LOGIN_PATH) {
    const contentType = String(req.headers['content-type'] || '')
    if (!contentType.startsWith('application/x-www-form-urlencoded')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(loginPage({ error: 'Incorrect password.', next: '/', config }))
      return 'handled'
    }

    const body = await readBodyCapped(req, LOGIN_BODY_MAX_BYTES)
    if (body === null) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(loginPage({ error: 'Incorrect password.', next: '/', config }))
      return 'handled'
    }

    const form = new URLSearchParams(body)
    const password = form.get('password') || ''
    const next = safeNextPath(form.get('next'))

    if (verifyPassword(password, pw.salt, pw.hash)) {
      const cookieVal = signSession(sessionSecret, { kh: keyHash, pv: pw.pwdVersion, iat: Date.now() })
      const secureAttr = config.COOKIE_SECURE ? '; Secure' : ''
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE_NAME}=${cookieVal}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(config.SESSION_TTL_MS / 1000)}${secureAttr}`,
        'Location': next,
      })
      res.end()
      return 'handled'
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(loginPage({ error: 'Incorrect password.', next, config }))
    return 'handled'
  }

  const cookies = parseCookies(req.headers.cookie)
  const session = verifySession(sessionSecret, cookies[COOKIE_NAME], { maxAgeMs: config.SESSION_TTL_MS })
  if (session && session.kh === keyHash && session.pv === pw.pwdVersion) {
    return 'proceed'
  }

  const next = req.method === 'GET' ? req.url : '/'
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(loginPage({ error: null, next, config }))
  return 'handled'
}

function titleForStatus(code) {
  switch (code) {
    case 503: return 'Service Unavailable'
    case 502: return 'Bad Gateway'
    case 400: return 'Bad Request'
    case 403: return 'Forbidden'
    default: return 'Internal Server Error'
  }
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req)
  const rl = limiter.allowRequest(ip)
  if (!rl.ok) {
    res.writeHead(429, {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)),
    })
    res.end(rateLimitPage())
    return
  }

  const route = resolveRoute(hostToKey(req.headers.host, config.BASE_DOMAIN), store)
  if (route.apex) {
    const url = new URL(req.url, 'http://internal')
    if (url.pathname.startsWith('/_admin')) {
      await handleAdmin(req, res, { manager, config, store, sessionSecret })
      return
    }
    if (url.pathname === '/impressum') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(impressumPage(config))
      return
    }
    if (url.pathname === '/terms') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(termsPage(config))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(apexPage(config))
    return
  }
  if (route.invalid) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(errorPage(404, 'Not Found', 'Unknown host.'))
    return
  }
  const rawKey = route.rawKey

  const gate = await passwordGate(req, res, rawKey)
  if (gate === 'handled') return

  const cold = !manager.isCached(rawKey)
  if (cold) {
    const t = limiter.allowNewTunnel(ip)
    if (!t.ok) {
      res.writeHead(429, {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': String(Math.ceil(t.retryAfterMs / 1000)),
      })
      res.end(rateLimitPage())
      return
    }
  }

  let tunnel
  try {
    tunnel = await manager.ensureTunnel(rawKey)
  } catch (err) {
    const code = statusForError(err)
    console.error(`${err.name || 'Error'} handling ${req.method} ${req.url}: ${err.message}`)
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(errorPage(code, titleForStatus(code), err.message))
    return
  }

  let released = false
  const release = () => {
    if (!released) {
      released = true
      manager.release(tunnel)
    }
  }
  res.on('close', release)
  res.on('finish', release)

  proxy.web(req, res, {
    target: `http://127.0.0.1:${tunnel.port}`,
    changeOrigin: false, // preserve the incoming Host for the backend
  })
})

server.on('upgrade', async (req, socket, head) => {
  const ip = clientIp(req)
  const rl = limiter.allowRequest(ip)
  if (!rl.ok) {
    socket.destroy()
    return
  }

  const route = resolveRoute(hostToKey(req.headers.host, config.BASE_DOMAIN), store)
  if (route.apex || route.invalid) {
    socket.destroy()
    return
  }
  const rawKey = route.rawKey

  let keyHash
  try {
    keyHash = parseKey(rawKey).keyHash
  } catch {
    // Not a parseable key -- let ensureTunnel produce the normal KeyError below.
  }
  if (keyHash) {
    const pw = store.getPassword(keyHash)
    if (pw) {
      const cookies = parseCookies(req.headers.cookie)
      const session = verifySession(sessionSecret, cookies[COOKIE_NAME], { maxAgeMs: config.SESSION_TTL_MS })
      if (!session || session.kh !== keyHash || session.pv !== pw.pwdVersion) {
        socket.destroy()
        return
      }
    }
  }

  const cold = !manager.isCached(rawKey)
  if (cold) {
    const t = limiter.allowNewTunnel(ip)
    if (!t.ok) {
      socket.destroy()
      return
    }
  }

  let tunnel
  try {
    tunnel = await manager.ensureTunnel(rawKey)
  } catch (err) {
    console.error(`${err.name || 'Error'} handling websocket upgrade: ${err.message}`)
    socket.destroy()
    return
  }

  let released = false
  const release = () => {
    if (!released) {
      released = true
      manager.release(tunnel)
    }
  }
  socket.on('close', release)

  proxy.ws(req, socket, head, {
    target: `http://127.0.0.1:${tunnel.port}`,
    changeOrigin: false,
  })
})

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\nReceived ${signal}, shutting down gracefully...`)
  server.close(() => {
    console.log('HTTP server closed.')
  })
  limiter.stop()
  try {
    await manager.shutdown()
    console.log('All tunnels torn down.')
  } catch (err) {
    console.error('Error during tunnel shutdown:', err.message)
  } finally {
    process.exit(0)
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

server.listen(config.PORT, config.BIND_HOST, () => {
  console.log(`Janus (Phase 3) listening on http://${config.BIND_HOST}:${config.PORT} ` +
    `(BASE_DOMAIN=${config.BASE_DOMAIN})`)
  console.log('This process expects Caddy (or another TLS terminator) in front of it -- ' +
    'it is HTTP-only and not meant to face the public internet directly.')
})

module.exports = { server, manager, proxy, limiter, store, resolveRoute }
