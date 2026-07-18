'use strict'

// Regression test for Security audit S1: cross-tenant cookie injection.
//
// src/server.js sets `cookieDomainRewrite: ''` on the SHARED
// httpProxy.createProxyServer() options (see the comment above that call,
// "Security audit S1"). Tenant backends are UNTRUSTED -- anyone can run one
// and share their key -- and without this option, http-proxy copies a
// backend's Set-Cookie headers verbatim. A malicious backend could send
// `Set-Cookie: pwned=1; Domain=<BASE_DOMAIN>; Path=/` and have that cookie
// apply to the apex and every sibling tenant subdomain (cross-tenant cookie
// injection / session fixation, see RFC 6265). Setting cookieDomainRewrite
// to '' strips the Domain attribute, forcing host-only cookies.
//
// The full server proxies to 127.0.0.1:${tunnel.port} via a real holesail
// tunnel, which is too heavy for a unit test. Instead this test drives
// http-proxy directly -- the same dependency and the same relevant option
// src/server.js configures -- against a tiny real backend and a tiny real
// front server, so the assertion is about http-proxy's actual behavior with
// Janus's exact option, not a mock of it. See server-proxy-error.test.js's
// top comment for the general "exercise the real thing directly" rationale
// used across this test directory.

const http = require('node:http')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const httpProxy = require('http-proxy')

const MALICIOUS_COOKIE = 'pwned=1; Domain=gw.example.com; Path=/'

// Starts a backend that always responds with the malicious Set-Cookie
// header, and a front proxy server (using the given proxy options) that
// forwards every request to that backend. Returns { backend, front, proxy,
// frontUrl } so the caller can make a request and clean everything up.
function startBackendAndFront(proxyOptions) {
  return new Promise((resolve, reject) => {
    const backend = http.createServer((req, res) => {
      res.writeHead(200, { 'Set-Cookie': MALICIOUS_COOKIE })
      res.end('ok')
    })

    backend.listen(0, '127.0.0.1', () => {
      const backendPort = backend.address().port
      const proxy = httpProxy.createProxyServer(proxyOptions)
      proxy.on('error', (err, req, res) => {
        res.writeHead(502)
        res.end(String(err))
      })

      const front = http.createServer((req, res) => {
        proxy.web(req, res, {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: false,
        })
      })

      front.listen(0, '127.0.0.1', () => {
        const frontPort = front.address().port
        resolve({
          backend,
          front,
          proxy,
          frontUrl: `http://127.0.0.1:${frontPort}`,
        })
      })

      front.on('error', reject)
      backend.on('error', reject)
    })

    backend.on('error', reject)
  })
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume() // drain, we only care about headers
      res.on('end', () => resolve(res))
    })
    req.on('error', reject)
  })
}

function closeAll(...servers) {
  return Promise.all(
    servers.map(
      (s) =>
        new Promise((resolve) => {
          if (s && typeof s.close === 'function') {
            s.close(() => resolve())
          } else {
            resolve()
          }
        })
    )
  )
}

test('http-proxy with cookieDomainRewrite: "" (Janus\'s S1 fix) strips Domain= from a backend Set-Cookie header', async () => {
  let ctx
  try {
    // Same relevant option src/server.js sets on the shared proxy.
    ctx = await startBackendAndFront({ xfwd: true, cookieDomainRewrite: '' })

    const res = await get(ctx.frontUrl + '/')
    const setCookie = res.headers['set-cookie']

    assert.ok(setCookie, 'expected a set-cookie header to be forwarded')
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie

    assert.match(
      cookieHeader,
      /pwned=1/,
      'the cookie itself must still pass through -- cookieDomainRewrite only strips Domain, it does not drop the cookie'
    )
    assert.doesNotMatch(
      cookieHeader,
      /domain=/i,
      'S1 regression: Domain= attribute must be stripped, forcing a host-only cookie'
    )
  } finally {
    if (ctx) {
      ctx.proxy.close()
      await closeAll(ctx.front, ctx.backend)
    }
  }
})

test('contrast: http-proxy WITHOUT cookieDomainRewrite passes a cross-tenant Domain= attribute through unchanged', async () => {
  let ctx
  try {
    // No cookieDomainRewrite option at all -- this is what src/server.js
    // would be vulnerable to without the S1 fix, documented here to make
    // the regression test above meaningful (it shows the option is not a
    // no-op).
    ctx = await startBackendAndFront({ xfwd: true })

    const res = await get(ctx.frontUrl + '/')
    const setCookie = res.headers['set-cookie']

    assert.ok(setCookie, 'expected a set-cookie header to be forwarded')
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie

    assert.match(
      cookieHeader,
      /pwned=1/,
      'sanity check: the cookie is still forwarded'
    )
    assert.match(
      cookieHeader,
      /domain=gw\.example\.com/i,
      'without cookieDomainRewrite, http-proxy passes Domain= through verbatim -- this is exactly the cross-tenant cookie injection S1 fixes'
    )
  } finally {
    if (ctx) {
      ctx.proxy.close()
      await closeAll(ctx.front, ctx.backend)
    }
  }
})
