'use strict'

// Phase 3: tiny JSON admin API -- list live tunnels, kill (and optionally
// block) a key, unblock a key. Only reachable at all when ADMIN_TOKEN is
// set (server.js routes /_admin/* here on the apex host only).

function sendJson(res, code, body) {
  const json = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(json)
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ manager: any, config: any }} deps
 */
async function handleAdmin(req, res, { manager, config }) {
  if (!config.ADMIN_TOKEN) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const authHeader = req.headers['authorization'] || ''
  const expected = `Bearer ${config.ADMIN_TOKEN}`
  if (authHeader !== expected) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }

  const url = new URL(req.url, 'http://internal')
  const pathname = url.pathname

  if (pathname === '/_admin/tunnels' && req.method === 'GET') {
    const tunnels = manager.list()
    sendJson(res, 200, { tunnels, count: tunnels.length })
    return
  }

  if (pathname === '/_admin/kill' && req.method === 'POST') {
    const keyHash = url.searchParams.get('keyHash')
    const block = url.searchParams.get('block') === '1'
    if (!keyHash) {
      sendJson(res, 400, { error: 'missing keyHash query parameter' })
      return
    }
    await manager.destroyTunnel(keyHash)
    if (block) manager.block(keyHash)
    sendJson(res, 200, { killed: keyHash, blocked: block })
    return
  }

  if (pathname === '/_admin/unblock' && req.method === 'POST') {
    const keyHash = url.searchParams.get('keyHash')
    if (!keyHash) {
      sendJson(res, 400, { error: 'missing keyHash query parameter' })
      return
    }
    manager.unblock(keyHash)
    sendJson(res, 200, { unblocked: keyHash })
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

module.exports = { handleAdmin }
