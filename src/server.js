'use strict'

const http = require('node:http')
const httpProxy = require('http-proxy')
const config = require('./config')
const { hostToKey } = require('./routing')
const { TunnelManager, CapacityError, ConnectError, KeyError, BlockedError } = require('./tunnel-manager')
const { RateLimiter } = require('./rate-limit')
const { escapeHtml, apexPage, impressumPage, termsPage, rateLimitPage } = require('./pages')
const { handleAdmin } = require('./admin')

const manager = new TunnelManager(config)
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
<title>${code} ${safeTitle} - Holesail Gateway</title>
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
    <p class="code">Holesail Gateway &middot; HTTP ${code}</p>
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

  const route = hostToKey(req.headers.host, config.BASE_DOMAIN)
  if (route.apex) {
    const url = new URL(req.url, 'http://internal')
    if (url.pathname.startsWith('/_admin')) {
      await handleAdmin(req, res, { manager, config })
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

  const route = hostToKey(req.headers.host, config.BASE_DOMAIN)
  if (route.apex || route.invalid) {
    socket.destroy()
    return
  }
  const rawKey = route.rawKey

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
  console.log(`Holesail Gateway (Phase 3) listening on http://${config.BIND_HOST}:${config.PORT} ` +
    `(BASE_DOMAIN=${config.BASE_DOMAIN})`)
  console.log('This process expects Caddy (or another TLS terminator) in front of it -- ' +
    'it is HTTP-only and not meant to face the public internet directly.')
})

module.exports = { server, manager, proxy, limiter }
