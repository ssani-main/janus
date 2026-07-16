'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const PortPool = require('../../src/port-pool')

test('PortPool: acquire() returns distinct ports within range', () => {
  const pool = new PortPool(20000, 20002) // 3 ports: 20000, 20001, 20002
  const a = pool.acquire()
  const b = pool.acquire()
  const c = pool.acquire()
  assert.equal(new Set([a, b, c]).size, 3)
  for (const p of [a, b, c]) {
    assert.ok(p >= 20000 && p <= 20002)
  }
})

test('PortPool: throws once exhausted', () => {
  const pool = new PortPool(20000, 20001) // 2 ports
  pool.acquire()
  pool.acquire()
  assert.throws(() => pool.acquire(), /port pool exhausted/)
})

test('PortPool: release() then acquire() reuses the freed port', () => {
  const pool = new PortPool(20000, 20000) // 1 port only
  const a = pool.acquire()
  assert.throws(() => pool.acquire())
  pool.release(a)
  const b = pool.acquire()
  assert.equal(b, a)
})

test('PortPool: constructor throws on invalid range', () => {
  assert.throws(() => new PortPool(20005, 20000))
  assert.throws(() => new PortPool(1.5, 20000))
})
