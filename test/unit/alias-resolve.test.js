'use strict'

// Unit tests for the `resolveRoute` helper exported by src/server.js.
// server.js is the process entrypoint (binds an HTTP port, opens the live
// Store, starts the rate-limit + idle-tunnel sweepers) so it has real
// startup side effects on require. To exercise the pure `resolveRoute`
// export without polluting the repo (writing a real store file) or leaking
// listeners across test files, we point every side-effecting piece at
// throwaway/ephemeral config via env vars BEFORE requiring it, then tear
// everything down in `after`.

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')

const STORE_PATH = path.join(
  os.tmpdir(),
  `janus-alias-resolve-store-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
)
process.env.BASE_DOMAIN = process.env.BASE_DOMAIN || 'gateway.example.com'
process.env.PORT = '0' // let the OS pick a free ephemeral port
process.env.STORE_PATH = STORE_PATH

const { resolveRoute, server, manager, limiter } = require('../../src/server')

// A real 52-char z-base-32 key (bare/public form).
const VALID_KEY = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

after(async () => {
  manager.stopSweeper()
  limiter.stop()
  await new Promise((resolve) => server.close(() => resolve()))
  try {
    fs.unlinkSync(STORE_PATH)
  } catch {
    // best-effort
  }
})

function fakeStore(aliasMap) {
  return {
    getByAlias(label) {
      return aliasMap[label]
    },
  }
}

test('resolveRoute: an apex route passes through unchanged', () => {
  const route = { apex: true }
  assert.equal(resolveRoute(route, fakeStore({})), route)
})

test('resolveRoute: an invalid route passes through unchanged', () => {
  const route = { invalid: true }
  assert.equal(resolveRoute(route, fakeStore({})), route)
})

test('resolveRoute: a valid raw key wins even when the store has an alias for it', () => {
  // If VALID_KEY were (impossibly) also registered as an alias label, the
  // raw-key parse must still win without ever consulting the store.
  const store = fakeStore({ [VALID_KEY]: { keyHash: 'irrelevant', rawKey: 'should-not-be-used' } })
  assert.deepEqual(resolveRoute({ rawKey: VALID_KEY }, store), { rawKey: VALID_KEY })
})

test('resolveRoute: an unparseable label resolves through a known alias', () => {
  const store = fakeStore({ myblog: { keyHash: 'somehash', rawKey: VALID_KEY } })
  assert.deepEqual(resolveRoute({ rawKey: 'myblog' }, store), { rawKey: VALID_KEY })
})

test('resolveRoute: an unparseable label with no matching alias is left unchanged (400 downstream)', () => {
  const store = fakeStore({})
  // Aliases are additive: with no alias registered, the route passes through
  // untouched so ensureTunnel rejects the malformed key with a 400, matching
  // pre-alias behaviour (rather than a 404).
  const route = { rawKey: 'nope' }
  assert.equal(resolveRoute(route, store), route)
})
