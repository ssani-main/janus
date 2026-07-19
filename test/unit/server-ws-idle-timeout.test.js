'use strict'

// Security audit S3 regression test: the websocket idle-timeout ordering
// bug. src/server.js's upgrade handler MUST call `socket.setTimeout(...)`
// AFTER `proxy.ws(...)`, never before -- see the "MUST be set AFTER
// proxy.ws()" comment above that call in src/server.js.
//
// Why: http-proxy's proxy.ws() synchronously calls its internal
// setupSocket(socket) (node_modules/http-proxy/lib/http-proxy/common.js),
// which itself calls `socket.setTimeout(0)` -- i.e. it DISABLES any timeout
// already armed on the socket. A timeout set BEFORE proxy.ws() is therefore
// silently cancelled and never fires, even though nothing in the code
// *looks* wrong at that call site -- this is exactly the ordering bug that
// was fixed. A timeout set AFTER proxy.ws() runs after setupSocket's
// cancellation and sticks.
//
// This test reproduces server.js's actual wiring (http-proxy + ws) without
// holesail -- see test/unit/server-cookie-domain-rewrite.test.js for the
// "drive http-proxy directly against a tiny real backend/front server"
// pattern this borrows, and test/e2e/gateway.e2e.test.js for the `ws`
// client/server usage pattern.
//
// No TUNNEL_PORT_MIN/MAX-style fixed ports are used here (backend/front
// servers bind ephemeral port 0), so this file does not need an entry in
// test/unit/fixtures/port-ranges.js.

const http = require('node:http')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const httpProxy = require('http-proxy')
const WebSocket = require('ws')

const SMALL_MS = 300
// Generous outer cap so a genuine hang fails the test loudly instead of
// timing out node:test's own (much longer) default test timeout.
const CAP_MS = 5000

/**
 * Starts a silent backend `ws` WebSocketServer (never sends anything, never
 * reads/reacts to incoming frames beyond accepting the connection) plus a
 * front http.Server whose 'upgrade' handler proxies to it via http-proxy,
 * applying `socket.setTimeout` either BEFORE or AFTER `proxy.ws(...)`
 * depending on `timeoutOrder`.
 *
 * @param {'before' | 'after'} timeoutOrder
 * @returns {Promise<{ backendServer: http.Server, wss: import('ws').WebSocketServer, front: http.Server, proxy: import('http-proxy'), frontWsUrl: string, close: () => Promise<void> }>}
 */
function startHarness(timeoutOrder) {
  return new Promise((resolve, reject) => {
    const backendServer = http.createServer()
    // Track raw sockets ourselves so close() below can force-destroy
    // anything still open. Once a socket is handed off via the 'upgrade'
    // event, Node's http.Server no longer manages/counts it as a normal
    // connection for close()/closeAllConnections() purposes -- an
    // upgraded-and-idle websocket's underlying TCP socket can otherwise
    // outlive server.close()'s callback forever, hanging cleanup.
    const backendSockets = new Set()
    backendServer.on('connection', (socket) => {
      backendSockets.add(socket)
      socket.on('close', () => backendSockets.delete(socket))
    })
    const wss = new WebSocket.Server({ server: backendServer })
    wss.on('connection', () => {
      // Deliberately silent: never send, never react to incoming frames.
      // The whole point is that ONLY the idle timeout can close this.
    })

    backendServer.listen(0, '127.0.0.1', () => {
      const backendPort = backendServer.address().port
      const proxy = httpProxy.createProxyServer({})
      proxy.on('error', () => {
        // Best-effort: a proxy error here would just mean the socket never
        // got a chance to hit the ws server at all; let the outer assertion
        // (open/close within CAP_MS) surface the failure.
      })

      const front = http.createServer()
      // Same rationale as backendSockets above.
      const frontSockets = new Set()
      front.on('connection', (socket) => {
        frontSockets.add(socket)
        socket.on('close', () => frontSockets.delete(socket))
      })
      front.on('upgrade', (req, socket, head) => {
        const target = `http://127.0.0.1:${backendPort}`
        if (timeoutOrder === 'after') {
          // Exactly server.js's fixed ordering: proxy.ws() first, THEN
          // socket.setTimeout(). setupSocket()'s socket.setTimeout(0) inside
          // proxy.ws() has already run by the time we arm ours, so it
          // sticks.
          proxy.ws(req, socket, head, { target })
          socket.setTimeout(SMALL_MS, () => socket.destroy())
        } else {
          // The OLD, buggy ordering: setTimeout() first, THEN proxy.ws().
          // proxy.ws()'s internal setupSocket() cancels this immediately
          // (socket.setTimeout(0)), so it never fires -- this is the
          // contrast case documenting the bug the fix closes.
          socket.setTimeout(SMALL_MS, () => socket.destroy())
          proxy.ws(req, socket, head, { target })
        }
      })

      front.listen(0, '127.0.0.1', () => {
        const frontPort = front.address().port
        resolve({
          backendServer,
          wss,
          front,
          proxy,
          frontWsUrl: `ws://127.0.0.1:${frontPort}`,
          close() {
            return new Promise((res) => {
              proxy.close()
              // Force-destroy any sockets our own 'connection' trackers
              // above still hold -- see their doc comment for why
              // server.close()'s callback can't be trusted to fire on its
              // own once a socket has been upgraded.
              for (const socket of frontSockets) socket.destroy()
              for (const socket of backendSockets) socket.destroy()
              let pending = 2
              const done = () => {
                pending--
                if (pending === 0) res()
              }
              front.close(done)
              backendServer.close(done)
            })
          },
        })
      })

      front.on('error', reject)
      backendServer.on('error', reject)
    })

    backendServer.on('error', reject)
  })
}

/**
 * Connects a silent `ws` client to `url` and resolves with whichever of
 * 'open' / 'close' happens first, alongside how long it took. Rejects if
 * neither happens within CAP_MS, so a real hang fails loudly instead of
 * dragging out the test run.
 */
function raceOpenOrClose(url) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const client = new WebSocket(url)
    let settled = false

    const capTimer = setTimeout(() => {
      if (settled) return
      settled = true
      client.terminate()
      reject(new Error(`neither 'open' nor 'close' fired within ${CAP_MS}ms -- looks like a real hang`))
    }, CAP_MS)

    client.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(capTimer)
      resolve({ event: 'open', elapsedMs: Date.now() - start, client })
    })

    client.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(capTimer)
      resolve({ event: 'close', elapsedMs: Date.now() - start, client })
    })

    client.on('error', () => {
      // A connection error before 'open'/'close' resolves via 'close'
      // anyway (ws always follows an 'error' with a 'close'); nothing to do
      // here beyond not crashing the test on an unhandled error event.
    })
  })
}

test('idle timeout set AFTER proxy.ws() (server.js ordering) actually fires and closes a silent websocket', async () => {
  let harness
  let client
  try {
    harness = await startHarness('after')

    const opened = await raceOpenOrClose(harness.frontWsUrl)
    assert.equal(opened.event, 'open', 'connection should establish successfully through the proxy')
    client = opened.client

    // Now wait for the idle timeout to close it -- keep the client silent
    // (never send anything) so only socket.setTimeout can close it.
    const closed = await new Promise((resolve, reject) => {
      const capTimer = setTimeout(() => {
        reject(new Error(`client did not close within ${CAP_MS}ms -- idle timeout did not fire`))
      }, CAP_MS)
      client.on('close', () => {
        clearTimeout(capTimer)
        resolve(Date.now())
      })
    })

    assert.ok(closed, 'client should have observed a close event')
    assert.equal(client.readyState, WebSocket.CLOSED)
  } finally {
    if (client) client.terminate()
    if (harness) await harness.close()
  }
})

test('contrast: idle timeout set BEFORE proxy.ws() is cancelled by setupSocket() and never fires (documents the bug the fix closes)', async () => {
  let harness
  let client
  try {
    harness = await startHarness('before')

    const opened = await raceOpenOrClose(harness.frontWsUrl)
    assert.equal(opened.event, 'open', 'connection should establish successfully through the proxy')
    client = opened.client

    // Wait comfortably past SMALL_MS. If the pre-proxy.ws() timeout had
    // stuck, the socket would already be destroyed by now; because
    // setupSocket() cancels it, the connection must still be open.
    await new Promise((resolve) => setTimeout(resolve, SMALL_MS * 2))

    assert.equal(
      client.readyState,
      WebSocket.OPEN,
      'a timeout armed BEFORE proxy.ws() must be cancelled by setupSocket() and never fire -- if this fails, http-proxy behavior changed or the contrast case is no longer valid'
    )
  } finally {
    if (client) client.terminate()
    if (harness) await harness.close()
  }
})
