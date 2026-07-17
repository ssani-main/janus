'use strict'

// Milestone 2a: covers src/logger.js's zero-dep JSON-lines request logger.
// Captures process.stdout.write instead of asserting against real stdout so
// these tests can run headless/in parallel with other suites.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLogger } = require('../../src/logger')

/**
 * Temporarily replaces process.stdout.write, recording every call's raw
 * argument. Returns { writes, restore() }.
 */
function captureStdout() {
  const writes = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    writes.push(chunk)
    return true
  }
  return {
    writes,
    restore() {
      process.stdout.write = original
    },
  }
}

test('disabled logger: logRequest emits nothing to stdout', () => {
  const cap = captureStdout()
  try {
    const logger = createLogger({ enabled: false })
    logger.logRequest({
      keyHash: 'abc123',
      method: 'GET',
      path: '/',
      status: 200,
      durMs: 1.2,
      bytes: 100,
      ip: '1.2.3.4',
    })
    assert.deepEqual(cap.writes, [])
  } finally {
    cap.restore()
  }
})

test('enabled logger: logRequest emits exactly one line, valid JSON, with the expected field set', () => {
  const cap = captureStdout()
  try {
    const logger = createLogger({ enabled: true })
    logger.logRequest({
      keyHash: 'abc123',
      method: 'GET',
      path: '/x',
      status: 200,
      durMs: 3.4,
      bytes: 512,
      ip: '1.2.3.4',
    })

    assert.equal(cap.writes.length, 1, 'expected exactly one write() call')
    const raw = cap.writes[0]
    assert.equal(raw.endsWith('\n'), true, 'each line must be newline-terminated')
    assert.equal((raw.match(/\n/g) || []).length, 1, 'must be exactly one line')

    const parsed = JSON.parse(raw)
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['bytes', 'durMs', 'ip', 'keyHash', 'level', 'method', 'msg', 'path', 'status', 'ts'].sort()
    )
    assert.equal(parsed.level, 'info')
    assert.equal(parsed.msg, 'request')
    assert.equal(parsed.keyHash, 'abc123')
    assert.equal(parsed.method, 'GET')
    assert.equal(parsed.path, '/x')
    assert.equal(parsed.status, 200)
    assert.equal(parsed.durMs, 3.4)
    assert.equal(parsed.bytes, 512)
    assert.equal(parsed.ip, '1.2.3.4')
    assert.equal(typeof parsed.ts, 'string')
    assert.doesNotThrow(() => new Date(parsed.ts).toISOString())
  } finally {
    cap.restore()
  }
})

test('enabled logger: keyHash is null on apex requests (no key involved)', () => {
  const cap = captureStdout()
  try {
    const logger = createLogger({ enabled: true })
    logger.logRequest({
      keyHash: null,
      method: 'GET',
      path: '/',
      status: 200,
      durMs: 1,
      bytes: 10,
      ip: '9.9.9.9',
    })
    const parsed = JSON.parse(cap.writes[0])
    assert.equal(parsed.keyHash, null)
  } finally {
    cap.restore()
  }
})

// --- Security-critical: the raw Holesail key can never reach the logger's
// output -- createLogger's signature only accepts keyHash, so even a caller
// that (incorrectly) stuffs a raw key into some other field must not have it
// echoed back untouched into a field named/interpreted as a key.

test('security: a raw key value passed in any field never appears verbatim as a keyHash in the output', () => {
  const cap = captureStdout()
  try {
    const RAW_KEY = 'oz6fcu4bexs7rm13y8qihdkta9gpw5njoz6fcu4bexs7rm13y8qi'
    const logger = createLogger({ enabled: true })
    // Simulate a caller mistake: pass the raw key as if it were the keyHash.
    // logRequest has no way to distinguish this from a real keyHash -- the
    // guarantee this test protects is narrower and structural: there is no
    // parameter/code path in logger.js that accepts a "raw key" field
    // distinct from keyHash, so a raw key can only ever end up in the
    // keyHash slot verbatim if the CALLER puts it there (a caller bug, not a
    // logger bug). What logger.js guarantees is that it never derives or
    // fabricates a raw key from anything else, and passes through nothing
    // beyond the fixed field set below.
    logger.logRequest({
      keyHash: 'realkeyhash',
      method: 'GET',
      path: '/',
      status: 200,
      durMs: 1,
      bytes: 10,
      ip: '1.1.1.1',
      rawKey: RAW_KEY, // not part of the accepted field set -- must be dropped
    })
    const raw = cap.writes[0]
    const parsed = JSON.parse(raw)
    assert.ok(!('rawKey' in parsed), 'logger must not pass through an unrecognized rawKey field')
    assert.equal(raw.includes(RAW_KEY), false, 'the raw key string must never appear in the log line')
    assert.equal(parsed.keyHash, 'realkeyhash')
  } finally {
    cap.restore()
  }
})

test('a stdout write that throws must not propagate -- swallowed by design', () => {
  const original = process.stdout.write
  process.stdout.write = () => {
    throw new Error('EPIPE: simulated broken pipe')
  }
  try {
    const logger = createLogger({ enabled: true })
    assert.doesNotThrow(() => {
      logger.logRequest({
        keyHash: 'abc',
        method: 'GET',
        path: '/',
        status: 200,
        durMs: 1,
        bytes: 1,
        ip: '1.1.1.1',
      })
    })
  } finally {
    process.stdout.write = original
  }
})
