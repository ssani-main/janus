#!/usr/bin/env node
'use strict'

// F-CLI: a thin CLI over the bearer-only /_admin/api/* JSON API in
// src/admin.js (plus the pre-existing /_admin/kill, which already accepts a
// bare bearer token with no CSRF requirement -- see the comment on
// cmdKill below for why this CLI reuses it instead of adding a new API
// route for it). node:http/node:https only -- no new dependencies.
//
// Auth: ADMIN_TOKEN is read from the environment, never accepted as an argv
// argument (argv leaks into shell history and `ps`/process listings on a
// shared box). Same reasoning applies to `janus password set`, which reads
// the password from stdin or JANUS_PASSWORD -- see cmdPasswordSet below.

const http = require('node:http')
const https = require('node:https')

const HELP = `janus -- CLI for the janus admin API

Usage:
  janus ls                              List key metadata
  janus tunnels                         List live tunnels
  janus alias add <name> <key>          Set an alias
  janus alias rm <name>                 Clear an alias
  janus password set <keyHash>          Set a password (reads it from stdin
                                         or the JANUS_PASSWORD env var --
                                         never as an argument)
  janus password clear <keyHash>        Clear a password
  janus block <keyHash>                 Block a key (also tears down its
                                         live tunnel, if any)
  janus unblock <keyHash>                Unblock a key
  janus directory suppress <keyHash>    Hide a key's /directory listing only
                                         (does not affect its site/tunnel)
  janus directory unsuppress <keyHash>  Restore a key's /directory listing
  janus kill <keyHash>                  Tear down a key's live tunnel
  janus rm <keyHash>                    Delete a key's stored record
  janus --help                          Show this help

Environment:
  ADMIN_TOKEN   Required. Bearer token for the admin API.
  JANUS_URL     Optional. Gateway base URL (default: http://127.0.0.1:3000).
  JANUS_PASSWORD  Optional. Password for \`janus password set\`, as an
                  alternative to piping it on stdin.
`

/**
 * @param {string} msg
 * @returns {never}
 */
function fail(msg) {
  process.stderr.write(`${msg}\n`)
  process.exit(1)
}

/**
 * A keyHash is a SHA-256 hex digest -- safe to print in full anywhere (it is
 * a hash, never the raw Holesail key/credential itself). Never print
 * anything that could be a raw key.
 * @param {*} s
 * @returns {boolean}
 */
function isValidKeyHash(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
}

/**
 * Make a single JSON (or query-string) request against the gateway,
 * authenticated with the bearer token. Never logs/echoes the token or any
 * raw key.
 *
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} method
 * @param {string} pathWithQuery
 * @param {?object} [jsonBody]
 * @returns {Promise<{ statusCode: number, body: any, raw: string }>}
 */
function apiRequest(baseUrl, token, method, pathWithQuery, jsonBody) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(pathWithQuery, baseUrl)
    } catch (err) {
      reject(new Error(`Invalid JANUS_URL/path: ${err.message}`))
      return
    }
    const lib = target.protocol === 'https:' ? https : http
    const payload = jsonBody !== undefined ? JSON.stringify(jsonBody) : null
    const headers = { 'Authorization': `Bearer ${token}` }
    if (payload !== null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = lib.request(
      target,
      { method, headers },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          let parsed = null
          if (data) {
            try {
              parsed = JSON.parse(data)
            } catch {
              parsed = null
            }
          }
          resolve({ statusCode: res.statusCode, body: parsed, raw: data })
        })
      }
    )
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/**
 * Wraps apiRequest, throwing a descriptive Error on any non-2xx response.
 *
 * @param {{ baseUrl: string, token: string }} ctx
 * @param {string} method
 * @param {string} pathWithQuery
 * @param {?object} [jsonBody]
 * @returns {Promise<any>}
 */
async function call(ctx, method, pathWithQuery, jsonBody) {
  const res = await apiRequest(ctx.baseUrl, ctx.token, method, pathWithQuery, jsonBody)
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const msg = (res.body && res.body.error) || res.raw || `HTTP ${res.statusCode}`
    throw new Error(`${method} ${pathWithQuery} -> ${res.statusCode}: ${msg}`)
  }
  return res.body
}

/**
 * Read all of stdin as a UTF-8 string. Never used when stdin is a TTY --
 * callers must check `process.stdin.isTTY` first, so this never blocks
 * waiting on interactive input.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i]).length), 0)
  )
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  process.stdout.write(`${fmt(headers)}\n`)
  for (const row of rows) process.stdout.write(`${fmt(row)}\n`)
}

async function cmdLs(ctx) {
  const body = await call(ctx, 'GET', '/_admin/api/keys')
  const keys = (body && body.keys) || []
  if (keys.length === 0) {
    process.stdout.write('No keys.\n')
    return
  }
  printTable(
    ['KEYHASH', 'ALIAS', 'BLOCKED', 'PASSWORD', 'CREATED', 'UPDATED'],
    keys.map((k) => [
      k.keyHash,
      k.alias || '-',
      k.blocked ? 'yes' : 'no',
      k.hasPassword ? 'yes' : 'no',
      k.createdAt ? new Date(k.createdAt).toISOString() : '-',
      k.updatedAt ? new Date(k.updatedAt).toISOString() : '-',
    ])
  )
}

async function cmdTunnels(ctx) {
  const body = await call(ctx, 'GET', '/_admin/api/tunnels')
  const tunnels = (body && body.tunnels) || []
  if (tunnels.length === 0) {
    process.stdout.write('No live tunnels.\n')
    return
  }
  printTable(
    ['KEYHASH', 'PORT', 'HEALTHY', 'INFLIGHT', 'LASTREQUEST'],
    tunnels.map((t) => [
      t.keyHash,
      t.port,
      t.healthy === null || t.healthy === undefined ? '-' : t.healthy ? 'yes' : 'no',
      t.inFlight,
      t.lastRequestAt ? new Date(t.lastRequestAt).toISOString() : '-',
    ])
  )
}

async function cmdAliasAdd(ctx, args) {
  const [name, key] = args
  if (!name || !key) fail('Usage: janus alias add <name> <key>')
  await call(ctx, 'POST', '/_admin/api/alias', { action: 'set', alias: name, rawKey: key })
  process.stdout.write(`Alias "${name}" set.\n`)
}

async function cmdAliasRm(ctx, args) {
  const [name] = args
  if (!name) fail('Usage: janus alias rm <name>')
  await call(ctx, 'POST', '/_admin/api/alias', { action: 'clear', alias: name })
  process.stdout.write(`Alias "${name}" cleared.\n`)
}

async function cmdPasswordSet(ctx, args) {
  const [keyHash] = args
  if (!isValidKeyHash(keyHash)) fail('Usage: janus password set <keyHash> (64 hex chars)')

  let password = process.env.JANUS_PASSWORD
  if (!password) {
    // Never prompt interactively -- if stdin is a TTY there is nothing safe
    // to read without blocking/echoing, so fail with clear instructions
    // instead. This keeps the command scriptable and testable.
    if (process.stdin.isTTY) {
      fail(
        'Refusing to read a password from an interactive terminal.\n' +
        'Pipe it on stdin (e.g. `echo -n mypassword | janus password set <keyHash>`) ' +
        'or set JANUS_PASSWORD.'
      )
    }
    password = (await readStdin()).replace(/\r?\n$/, '')
  }
  if (!password) fail('Password must not be empty.')

  await call(ctx, 'POST', '/_admin/api/password', { action: 'set', keyHash, password })
  process.stdout.write(`Password set for ${keyHash}.\n`)
}

async function cmdPasswordClear(ctx, args) {
  const [keyHash] = args
  if (!isValidKeyHash(keyHash)) fail('Usage: janus password clear <keyHash> (64 hex chars)')
  await call(ctx, 'POST', '/_admin/api/password', { action: 'clear', keyHash })
  process.stdout.write(`Password cleared for ${keyHash}.\n`)
}

async function cmdBlock(ctx, args) {
  const [keyHash] = args
  if (!isValidKeyHash(keyHash)) fail('Usage: janus block <keyHash> (64 hex chars)')
  await call(ctx, 'POST', '/_admin/api/block', { action: 'block', keyHash })
  process.stdout.write(`Blocked ${keyHash}.\n`)
}

async function cmdUnblock(ctx, args) {
  const [keyHash] = args
  if (!isValidKeyHash(keyHash)) fail('Usage: janus unblock <keyHash> (64 hex chars)')
  await call(ctx, 'POST', '/_admin/api/block', { action: 'unblock', keyHash })
  process.stdout.write(`Unblocked ${keyHash}.\n`)
}

/**
 * Directory-only suppression, distinct from block/unblock above: this never
 * tears down or affects the key's tunnel/site at all -- it only hides the
 * key from /directory and /directory.json. See store.js#setDirectorySuppressed.
 */
async function cmdDirectorySuppress(ctx, args) {
  const [keyHash] = args
  if (!isValidKeyHash(keyHash)) fail('Usage: janus directory suppress <keyHash> (64 hex chars)')
  await call(ctx, 'POST', '/_admin/api/directory', { action: 'suppress', keyHash })
  process.stdout.write(`Directory listing suppressed for ${keyHash}. The site itself is unaffected.\n`)
}

async function cmdDirectoryUnsuppress(ctx, args) {
  const [keyHash] = args
  if (!isValidKeyHash(keyHash)) fail('Usage: janus directory unsuppress <keyHash> (64 hex chars)')
  await call(ctx, 'POST', '/_admin/api/directory', { action: 'unsuppress', keyHash })
  process.stdout.write(`Directory listing restored for ${keyHash}.\n`)
}

/**
 * `janus kill` intentionally calls the PRE-EXISTING /_admin/kill endpoint
 * (src/admin.js), not a new /_admin/api/* route -- that endpoint already
 * accepts a bare bearer token with no CSRF requirement (CSRF there only
 * applies to its cookie-session path, which this CLI never uses), and
 * "tear down a live tunnel without touching stored metadata" has no
 * equivalent in the new API's route table. Adding a duplicate route would
 * mean two ways to do the same thing; reusing the existing one keeps this
 * CLI a pure client with zero server-side changes required for this command.
 */
async function cmdKill(ctx, args) {
  const [keyHash] = args
  if (!isValidKeyHash(keyHash)) fail('Usage: janus kill <keyHash> (64 hex chars)')
  const qs = new URLSearchParams({ keyHash })
  await call(ctx, 'POST', `/_admin/kill?${qs.toString()}`)
  process.stdout.write(`Killed tunnel for ${keyHash}.\n`)
}

async function cmdRm(ctx, args) {
  const [keyHash] = args
  if (!isValidKeyHash(keyHash)) fail('Usage: janus rm <keyHash> (64 hex chars)')
  await call(ctx, 'DELETE', `/_admin/api/keys/${keyHash}`)
  process.stdout.write(`Deleted ${keyHash}.\n`)
}

async function main() {
  const argv = process.argv.slice(2)

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP)
    process.exit(argv.length === 0 ? 1 : 0)
  }

  const token = process.env.ADMIN_TOKEN
  if (!token) {
    fail('ADMIN_TOKEN environment variable is required.')
  }
  const baseUrl = process.env.JANUS_URL || 'http://127.0.0.1:3000'
  const ctx = { baseUrl, token }

  const [cmd, ...rest] = argv

  try {
    if (cmd === 'ls') {
      await cmdLs(ctx)
    } else if (cmd === 'tunnels') {
      await cmdTunnels(ctx)
    } else if (cmd === 'alias') {
      const [sub, ...subArgs] = rest
      if (sub === 'add') await cmdAliasAdd(ctx, subArgs)
      else if (sub === 'rm') await cmdAliasRm(ctx, subArgs)
      else fail('Usage: janus alias <add|rm> ...')
    } else if (cmd === 'password') {
      const [sub, ...subArgs] = rest
      if (sub === 'set') await cmdPasswordSet(ctx, subArgs)
      else if (sub === 'clear') await cmdPasswordClear(ctx, subArgs)
      else fail('Usage: janus password <set|clear> <keyHash>')
    } else if (cmd === 'block') {
      await cmdBlock(ctx, rest)
    } else if (cmd === 'unblock') {
      await cmdUnblock(ctx, rest)
    } else if (cmd === 'directory') {
      const [sub, ...subArgs] = rest
      if (sub === 'suppress') await cmdDirectorySuppress(ctx, subArgs)
      else if (sub === 'unsuppress') await cmdDirectoryUnsuppress(ctx, subArgs)
      else fail('Usage: janus directory <suppress|unsuppress> <keyHash>')
    } else if (cmd === 'kill') {
      await cmdKill(ctx, rest)
    } else if (cmd === 'rm') {
      await cmdRm(ctx, rest)
    } else {
      process.stderr.write(`Unknown command: ${cmd}\n\n`)
      process.stderr.write(HELP)
      process.exit(1)
    }
  } catch (err) {
    fail(`Error: ${err.message}`)
  }
}

main()
