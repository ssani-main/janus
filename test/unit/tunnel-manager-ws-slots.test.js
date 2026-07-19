'use strict'

// Security audit S3 regression tests: websocket-slot accounting on
// TunnelManager (canAcceptWs / acquireWs / releaseWs / noteWsRejected /
// destroyTunnel's wsCount interaction). See src/tunnel-manager.js's doc
// comments on those methods (and the `_wsSlotCount` field in the
// constructor) for the full design rationale this guards.
//
// Uses the same hand-rolled-record style as test/unit/tunnel-manager.test.js
// (manager.tunnels.set(...) with a fakeRecord helper) for the pure
// refcounting tests, since none of those touch the network at all. Only the
// double-decrement guard test (which exercises destroyTunnel, and therefore
// a real client.destroy() call) needs a port range, borrowed from this
// file's own slice of test/unit/fixtures/port-ranges.js.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { TunnelManager } = require('../../src/tunnel-manager')

// Port range 20960-20965 -- see test/unit/fixtures/port-ranges.js for the
// full cross-file allocation map (test files run in parallel, so ranges
// must stay disjoint). Only used by the destroyTunnel-based test below,
// which never actually binds these ports (the fake client's destroy() is a
// no-op), but TUNNEL_PORT_MIN/MAX must still be set to something for
// PortPool to construct.
function baseConfig(overrides) {
  return Object.assign(
    {
      MAX_TUNNELS: 5,
      TUNNEL_PORT_MIN: 20960,
      TUNNEL_PORT_MAX: 20965,
      IDLE_TTL_MS: 1e9,
      CONNECT_TIMEOUT_MS: 1000,
      WS_MAX_SLOTS: 5,
    },
    overrides
  )
}

function makeManager(overrides) {
  return new TunnelManager(baseConfig(overrides))
}

// Minimal record shape acquireWs/releaseWs/destroyTunnel need: wsCount plus
// enough of the "real" tunnel record shape (client.destroy, port, keyHash)
// for destroyTunnel to run without throwing.
function fakeWsRecord(overrides) {
  return Object.assign(
    {
      client: { destroy: async () => {} },
      port: 20960,
      keyHash: 'fake-hash',
      lastRequestAt: Date.now(),
      inFlight: 0,
      wsCount: 0,
    },
    overrides
  )
}

test('acquireWs/releaseWs: refcount a single record correctly, only crossing the wsSlots gauge at 0<->1', () => {
  const manager = makeManager()
  const record = { wsCount: 0 }

  manager.acquireWs(record)
  assert.equal(record.wsCount, 1)
  assert.equal(manager.stats().wsSlots, 1)

  // A second live websocket to the SAME record reuses the slot -- wsCount
  // keeps counting individual connections, but wsSlots (distinct
  // ws-pinned tunnels) does not move.
  manager.acquireWs(record)
  assert.equal(record.wsCount, 2)
  assert.equal(manager.stats().wsSlots, 1, 'a second ws on the same record must not consume a second slot')

  manager.releaseWs(record)
  assert.equal(record.wsCount, 1)
  assert.equal(manager.stats().wsSlots, 1, 'slot stays held while one live ws remains')

  manager.releaseWs(record)
  assert.equal(record.wsCount, 0)
  assert.equal(manager.stats().wsSlots, 0, 'last release on the record frees its slot')
})

test('canAcceptWs: enforces WS_MAX_SLOTS for brand-new keys, but always allows reuse of an already-ws-pinned key', () => {
  const manager = makeManager({ WS_MAX_SLOTS: 2 })

  const recordA = fakeWsRecord({ keyHash: 'hash-a' })
  const recordB = fakeWsRecord({ keyHash: 'hash-b' })
  manager.tunnels.set('hash-a', recordA)
  manager.tunnels.set('hash-b', recordB)

  // Fill the cap with two distinct records.
  assert.equal(manager.canAcceptWs('hash-a'), true)
  manager.acquireWs(recordA)
  assert.equal(manager.canAcceptWs('hash-b'), true)
  manager.acquireWs(recordB)

  assert.equal(manager.stats().wsSlots, 2)

  // At the cap: a brand-new keyHash (no cached record, or a cached record
  // with wsCount === 0) must be rejected.
  assert.equal(manager.canAcceptWs('hash-c-never-seen'), false)

  // But reusing an already-ws-pinned slot is always allowed, even at the
  // cap -- it consumes no new slot.
  assert.equal(manager.canAcceptWs('hash-a'), true)
  assert.equal(manager.canAcceptWs('hash-b'), true)
})

test('double-decrement guard: releaseWs on a record already zeroed by destroyTunnel must not drive wsSlots negative', async () => {
  const manager = makeManager()
  const keyHash = 'operator-killed-hash'
  const record = fakeWsRecord({ keyHash })
  manager.tunnels.set(keyHash, record)

  manager.acquireWs(record)
  assert.equal(manager.stats().wsSlots, 1)

  // Simulate an operator kill (or probe-failure eviction): destroyTunnel
  // runs first, while the websocket itself is still open.
  await manager.destroyTunnel(keyHash)
  assert.equal(manager.stats().wsSlots, 0, 'destroyTunnel must free the slot immediately')
  assert.equal(record.wsCount, 0, 'destroyTunnel must zero the record so a later releaseWs is a no-op')

  // The websocket's own 'close' handler fires afterwards (server.js's
  // release() closure still holds a reference to this exact record object)
  // and calls releaseWs on it. Without the wsCount = 0 zeroing in
  // destroyTunnel, this would decrement wsSlots a second time to -1.
  manager.releaseWs(record)
  assert.equal(manager.stats().wsSlots, 0, 'releaseWs after destroyTunnel must be a no-op, not drive wsSlots negative')
})

test('noteWsRejected: increments the cumulative wsRejected counter', () => {
  const manager = makeManager()
  assert.equal(manager.stats().wsRejected, 0)

  manager.noteWsRejected()
  assert.equal(manager.stats().wsRejected, 1)

  manager.noteWsRejected()
  manager.noteWsRejected()
  assert.equal(manager.stats().wsRejected, 3)
})

test('stats(): exposes wsSlotsMax mirroring config.WS_MAX_SLOTS', () => {
  const manager = makeManager({ WS_MAX_SLOTS: 7 })
  assert.equal(manager.stats().wsSlotsMax, 7)
})
