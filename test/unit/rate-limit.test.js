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

// --- Milestone 2a: cumulative hit counters (this.hits) for /metrics --------

test('stats().request: does NOT increment on allowed requests, only on denies', () => {
  const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 3, maxNewTunnels: 10 })
  const ip = '5.5.5.5'
  limiter.allowRequest(ip)
  limiter.allowRequest(ip)
  limiter.allowRequest(ip)
  assert.equal(limiter.stats().request, 0, 'no denies yet -- hits.request must stay 0')

  limiter.allowRequest(ip) // 4th request, over budget -- denied
  assert.equal(limiter.stats().request, 1)

  limiter.allowRequest(ip) // still denied
  assert.equal(limiter.stats().request, 2)
})

test('stats().newTunnel: does NOT increment on allowed new-tunnel creates, only on denies', () => {
  const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 100, maxNewTunnels: 2 })
  const ip = '6.6.6.6'
  limiter.allowNewTunnel(ip)
  limiter.allowNewTunnel(ip)
  assert.equal(limiter.stats().newTunnel, 0, 'no denies yet -- hits.newTunnel must stay 0')

  limiter.allowNewTunnel(ip) // 3rd, over budget -- denied
  assert.equal(limiter.stats().newTunnel, 1)
})

test('stats().request and stats().newTunnel are independent counters', () => {
  const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 1, maxNewTunnels: 1 })
  const ip = '7.7.7.7'
  limiter.allowRequest(ip)
  limiter.allowRequest(ip) // denied -> hits.request++
  limiter.allowNewTunnel(ip)
  // second allowNewTunnel is denied -> hits.newTunnel++, but must not touch hits.request
  limiter.allowNewTunnel(ip)

  const stats = limiter.stats()
  assert.equal(stats.request, 1)
  assert.equal(stats.newTunnel, 1)
})

test('stats(): returns a fresh object each call -- mutating the result cannot corrupt internal counters', () => {
  const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 1, maxNewTunnels: 1 })
  const ip = '8.8.8.8'
  limiter.allowRequest(ip)
  limiter.allowRequest(ip) // denied

  const first = limiter.stats()
  assert.equal(first.request, 1)
  first.request = 9999
  first.buckets = 9999

  const second = limiter.stats()
  assert.equal(second.request, 1, 'mutating a previous stats() snapshot must not affect a later one')
  assert.notEqual(first, second, 'stats() must not return the same object reference twice')
})

test('stats().buckets: reflects the current number of active per-IP buckets', () => {
  const limiter = new RateLimiter({ windowMs: 10000, maxRequests: 100, maxNewTunnels: 100 })
  assert.equal(limiter.stats().buckets, 0)
  limiter.allowRequest('9.9.9.1')
  limiter.allowRequest('9.9.9.2')
  limiter.allowRequest('9.9.9.1') // same IP, same bucket
  assert.equal(limiter.stats().buckets, 2)
})
