'use strict'

// Phase 3: fixed-window per-IP rate limiting. Two independent counters per
// IP per window -- overall requests (cheap DoS/abuse guard) and NEW
// (cold) tunnel creations (the expensive path: HolesailClient connect +
// liveness probe), so one metric can't starve the other's budget.

class RateLimiter {
  constructor({ windowMs, maxRequests, maxNewTunnels }) {
    this.windowMs = windowMs
    this.maxRequests = maxRequests
    this.maxNewTunnels = maxNewTunnels
    /** @type {Map<string, { windowStart: number, requests: number, newTunnels: number }>} */
    this.buckets = new Map()
    this._sweepHandle = null
    // Milestone 2a: cumulative deny counts for the /metrics endpoint, one
    // per limiter dimension. Only incremented on the DENY path -- a hit
    // here means a real client was actually throttled, not just that the
    // bucket was touched.
    this.hits = { request: 0, newTunnel: 0 }
  }

  _getBucket(ip) {
    const now = Date.now()
    let bucket = this.buckets.get(ip)
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      bucket = { windowStart: now, requests: 0, newTunnels: 0 }
      this.buckets.set(ip, bucket)
    }
    return bucket
  }

  /**
   * @param {string} ip
   * @returns {{ ok: boolean, retryAfterMs: number }}
   */
  allowRequest(ip) {
    const bucket = this._getBucket(ip)
    bucket.requests++
    const ok = bucket.requests <= this.maxRequests
    if (!ok) this.hits.request++
    const retryAfterMs = ok ? 0 : bucket.windowStart + this.windowMs - Date.now()
    return { ok, retryAfterMs: Math.max(0, retryAfterMs) }
  }

  /**
   * @param {string} ip
   * @returns {{ ok: boolean, retryAfterMs: number }}
   */
  allowNewTunnel(ip) {
    const bucket = this._getBucket(ip)
    bucket.newTunnels++
    const ok = bucket.newTunnels <= this.maxNewTunnels
    if (!ok) this.hits.newTunnel++
    const retryAfterMs = ok ? 0 : bucket.windowStart + this.windowMs - Date.now()
    return { ok, retryAfterMs: Math.max(0, retryAfterMs) }
  }

  /**
   * Snapshot of cumulative deny counts + current bucket count for the
   * /metrics endpoint. Returns a copy, not the live counters object.
   * @returns {{ request: number, newTunnel: number, buckets: number }}
   */
  stats() {
    return {
      request: this.hits.request,
      newTunnel: this.hits.newTunnel,
      buckets: this.buckets.size,
    }
  }

  /**
   * Drop buckets whose window has fully expired -- keeps the Map from
   * growing unboundedly with one-off/drive-by IPs.
   */
  sweep() {
    const now = Date.now()
    for (const [ip, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) {
        this.buckets.delete(ip)
      }
    }
  }

  start() {
    if (this._sweepHandle) return
    this._sweepHandle = setInterval(() => this.sweep(), this.windowMs)
    if (this._sweepHandle.unref) this._sweepHandle.unref()
  }

  stop() {
    if (this._sweepHandle) {
      clearInterval(this._sweepHandle)
      this._sweepHandle = null
    }
  }
}

module.exports = { RateLimiter }
