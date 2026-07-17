'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { TunnelManager, BlockedError } = require('../../src/tunnel-manager')
const { parseKey } = require('../../src/key')

// Port range 20000-20010 -- see test/unit/fixtures/port-ranges.js for the
// full cross-file allocation map (test files run in parallel, so ranges
// must stay disjoint).
const FAKE_CONFIG = {
  MAX_TUNNELS: 2,
  TUNNEL_PORT_MIN: 20000,
  TUNNEL_PORT_MAX: 20010,
  IDLE_TTL_MS: 1e9,
  CONNECT_TIMEOUT_MS: 1000,
}

// Two distinct real 52-char z-base-32 keys for hashing purposes.
const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'
const KEY_B = 'ejkmcpqxot1uwiszh76934abndrfg8ejkmcpqxot1uwisza3456y'

function makeManager() {
  return new TunnelManager(FAKE_CONFIG)
}

// Minimal fake store matching the isBlocked/setBlocked surface TunnelManager
// needs -- lets the block/unblock tests assert against `manager.store`
// directly instead of the removed in-memory `manager.blocklist` Set.
function fakeStore() {
  const blocked = new Set()
  return {
    isBlocked(keyHash) {
      return blocked.has(keyHash)
    },
    setBlocked(keyHash, isBlocked) {
      if (isBlocked) blocked.add(keyHash)
      else blocked.delete(keyHash)
    },
  }
}

function fakeRecord(overrides) {
  return Object.assign(
    {
      client: { destroy: async () => {} },
      port: 20000,
      keyHash: 'fake-hash',
      lastRequestAt: Date.now(),
      inFlight: 0,
    },
    overrides
  )
}

test('_pickEvictable: returns the lowest-lastRequestAt record among inFlight===0', () => {
  const manager = makeManager()
  const oldest = fakeRecord({ keyHash: 'oldest', lastRequestAt: 100, inFlight: 0 })
  const middle = fakeRecord({ keyHash: 'middle', lastRequestAt: 200, inFlight: 0 })
  const busy = fakeRecord({ keyHash: 'busy', lastRequestAt: 50, inFlight: 1 }) // busiest but ineligible
  manager.tunnels.set('oldest', oldest)
  manager.tunnels.set('middle', middle)
  manager.tunnels.set('busy', busy)

  const victim = manager._pickEvictable()
  assert.equal(victim, oldest)
})

test('_pickEvictable: returns null when every cached tunnel has inFlight > 0', () => {
  const manager = makeManager()
  manager.tunnels.set('a', fakeRecord({ keyHash: 'a', inFlight: 1 }))
  manager.tunnels.set('b', fakeRecord({ keyHash: 'b', inFlight: 2 }))

  assert.equal(manager._pickEvictable(), null)
})

test('release: decrements inFlight and bumps lastRequestAt', () => {
  const manager = makeManager()
  const record = fakeRecord({ inFlight: 1, lastRequestAt: 1 })
  manager.release(record)
  assert.equal(record.inFlight, 0)
  assert.ok(record.lastRequestAt > 1)
})

test('release: no-op when inFlight is already 0', () => {
  const manager = makeManager()
  const record = fakeRecord({ inFlight: 0, lastRequestAt: 12345 })
  manager.release(record)
  assert.equal(record.inFlight, 0)
  assert.equal(record.lastRequestAt, 12345) // unchanged
})

test('block + ensureTunnel: a blocked key rejects with BlockedError before any network connect', async () => {
  const manager = new TunnelManager(FAKE_CONFIG, fakeStore())
  const { keyHash } = parseKey(KEY_A)
  manager.block(keyHash)

  await assert.rejects(() => manager.ensureTunnel(KEY_A), BlockedError)
})

test('unblock: reverses block (store.isBlocked reports false again)', () => {
  const manager = new TunnelManager(FAKE_CONFIG, fakeStore())
  const { keyHash } = parseKey(KEY_A)
  manager.block(keyHash)
  assert.equal(manager.store.isBlocked(keyHash), true)
  manager.unblock(keyHash)
  assert.equal(manager.store.isBlocked(keyHash), false)
})

test('block/unblock also work against the default in-memory store shim (no store supplied)', () => {
  const manager = makeManager()
  const { keyHash } = parseKey(KEY_A)
  assert.equal(manager.store.isBlocked(keyHash), false)
  manager.block(keyHash)
  assert.equal(manager.store.isBlocked(keyHash), true)
  manager.unblock(keyHash)
  assert.equal(manager.store.isBlocked(keyHash), false)
})

test('isCached: false for a key with no cached tunnel', () => {
  const manager = makeManager()
  assert.equal(manager.isCached(KEY_B), false)
})

test('isCached: false for a garbage/unparseable key (parse error swallowed)', () => {
  const manager = makeManager()
  assert.equal(manager.isCached('not-a-valid-key'), false)
})

test('isCached: true once a tunnel is cached for that key', () => {
  const manager = makeManager()
  const { keyHash } = parseKey(KEY_A)
  manager.tunnels.set(keyHash, fakeRecord({ keyHash }))
  assert.equal(manager.isCached(KEY_A), true)
})

test('list(): returns sanitized snapshots without client or raw key', () => {
  const manager = makeManager()
  const record = fakeRecord({
    keyHash: 'somehash',
    port: 20005,
    inFlight: 2,
    firstSeenAt: 111,
    lastRequestAt: 222,
  })
  manager.tunnels.set('somehash', record)

  const list = manager.list()
  assert.equal(list.length, 1)
  const [entry] = list
  assert.equal(entry.keyHash, 'somehash')
  assert.equal(entry.port, 20005)
  assert.equal(entry.inFlight, 2)
  assert.equal(entry.firstSeenAt, 111)
  assert.equal(entry.lastRequestAt, 222)
  assert.ok(!('client' in entry))
  assert.ok(!('key' in entry))
})

test('list(): keeps every existing field and additionally carries healthy/lastProbeAt (Milestone 2d)', () => {
  const manager = makeManager()
  const record = fakeRecord({
    keyHash: 'anotherhash',
    port: 20006,
    inFlight: 0,
    firstSeenAt: 333,
    lastRequestAt: 444,
    healthy: false,
    lastProbeAt: 555,
  })
  manager.tunnels.set('anotherhash', record)

  const [entry] = manager.list()
  // Pre-existing shape, untouched.
  assert.equal(entry.keyHash, 'anotherhash')
  assert.equal(entry.port, 20006)
  assert.equal(entry.inFlight, 0)
  assert.equal(entry.firstSeenAt, 333)
  assert.equal(entry.lastRequestAt, 444)
  // New health fields.
  assert.equal(entry.healthy, false)
  assert.equal(entry.lastProbeAt, 555)
})
