'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { RateLimiter } = require('../../src/rate-limit')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('allowRequest: allows up to maxRequests, then rejects', () => {
  const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 2, maxNewTunnels: 1 })
  const ip = '1.2.3.4'
  assert.equal(limiter.allowRequest(ip).ok, true)
  assert.equal(limiter.allowRequest(ip).ok, true)
  const third = limiter.allowRequest(ip)
  assert.equal(third.ok, false)
  assert.ok(third.retryAfterMs >= 0)
})

test('allowRequest: different IPs have independent buckets', () => {
  const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 2, maxNewTunnels: 1 })
  const ipA = '1.1.1.1'
  const ipB = '2.2.2.2'
  assert.equal(limiter.allowRequest(ipA).ok, true)
  assert.equal(limiter.allowRequest(ipA).ok, true)
  assert.equal(limiter.allowRequest(ipA).ok, false) // ipA exhausted
  // ipB is unaffected by ipA's usage
  assert.equal(limiter.allowRequest(ipB).ok, true)
  assert.equal(limiter.allowRequest(ipB).ok, true)
})

test('allowNewTunnel: allows up to maxNewTunnels, then rejects', () => {
  const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 100, maxNewTunnels: 1 })
  const ip = '3.3.3.3'
  assert.equal(limiter.allowNewTunnel(ip).ok, true)
  assert.equal(limiter.allowNewTunnel(ip).ok, false)
})

test('window reset: counter resets to allowing again after windowMs elapses', async () => {
  const limiter = new RateLimiter({ windowMs: 40, maxRequests: 1, maxNewTunnels: 1 })
  const ip = '4.4.4.4'
  assert.equal(limiter.allowRequest(ip).ok, true)
  assert.equal(limiter.allowRequest(ip).ok, false)
  await sleep(60)
  assert.equal(limiter.allowRequest(ip).ok, true)
})

after(() => {
  // no sweeper interval was ever started (limiter.start() never called in
  // this file), so there's nothing to stop -- kept as documentation that
  // this suite intentionally avoids the sweeper to let the test process exit.
})
