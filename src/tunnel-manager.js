'use strict'

const net = require('node:net')
const HolesailClient = require('holesail-client')
const { parseKey, assertPublic } = require('./key')
const PortPool = require('./port-pool')

// Thrown when MAX_TUNNELS is reached and no idle (inFlight === 0) tunnel is
// available to evict -- every cached tunnel is actively serving a request.
class CapacityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CapacityError'
  }
}

// Thrown when a holesail-client fails to connect / become live within
// CONNECT_TIMEOUT_MS.
class ConnectError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'ConnectError'
    if (cause !== undefined) this.cause = cause
  }
}

// Thrown when the supplied key is malformed or not allowed (secure-mode).
class KeyError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'KeyError'
    if (cause !== undefined) this.cause = cause
  }
}

// Thrown when a key has been blocked by the operator via the Phase 3 admin
// kill-switch (/_admin/kill?...&block=1).
class BlockedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BlockedError'
  }
}

/**
 * Minimal in-memory fallback used when TunnelManager is constructed without
 * a store (e.g. existing tests calling `new TunnelManager(config)`
 * directly). Implements just enough of the Store surface that
 * TunnelManager needs.
 * @returns {{ isBlocked(keyHash: string): boolean, setBlocked(keyHash: string, blocked: boolean): void }}
 */
function _inMemoryStoreShim() {
  const blocklist = new Set()
  return {
    isBlocked(keyHash) {
      return blocklist.has(keyHash)
    },
    setBlocked(keyHash, blocked) {
      if (blocked) blocklist.add(keyHash)
      else blocklist.delete(keyHash)
    },
  }
}

/**
 * Quick liveness probe: open a TCP connection to 127.0.0.1:port and confirm
 * something is actually listening before we cache/use the tunnel. Prevents
 * pinning traffic to a tunnel that "connected" but isn't really serving.
 */
function probePort(port, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`liveness probe timed out for 127.0.0.1:${port}`))
    }, timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve()
    })

    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Reusable core piece: manages one holesail-client tunnel per distinct key,
 * dedupe by keyHash, with connect timeout + liveness probe before caching,
 * and an idle-TTL sweeper.
 *
 * Phase 0 drives this with a single hardcoded key. It is already keyed by
 * keyHash and capacity-bounded so Phase 1 (Host-derived key per request,
 * many concurrent tenants) is a drop-in -- no reshaping needed here.
 */
class TunnelManager {
  constructor(config, store) {
    this.config = config
    this.portPool = new PortPool(config.TUNNEL_PORT_MIN, config.TUNNEL_PORT_MAX)
    /** @type {Map<string, { client: any, port: number, keyHash: string, lastRequestAt: number, inFlight: number }>} */
    this.tunnels = new Map()
    /** @type {Map<string, Promise<{ client: any, port: number, keyHash: string, lastRequestAt: number, inFlight: number }>>} */
    this.pending = new Map()
    this._sweeperHandle = null
    // Milestone 1: blocklist state now lives in the persistent store so it
    // survives restarts. If no store is supplied (e.g. existing tests that
    // construct `new TunnelManager(config)` directly), fall back to an
    // in-memory-only shim with the same isBlocked/setBlocked surface.
    this.store = store || _inMemoryStoreShim()
  }

  /**
   * Ensure a live tunnel exists for the given raw key, creating one if
   * necessary. Returns the cached tunnel record with one reference retained
   * on behalf of the caller -- the caller MUST call `release(record)` when
   * it is done with the tunnel (request finished / socket closed).
   *
   * @param {string} rawKey
   * @returns {Promise<{ client: any, port: number, keyHash: string, lastRequestAt: number, inFlight: number }>}
   */
  async ensureTunnel(rawKey) {
    let parsed
    try {
      parsed = parseKey(rawKey)
      assertPublic(parsed)
    } catch (err) {
      throw new KeyError(err.message, err)
    }

    const keyHash = parsed.keyHash

    if (this.store.isBlocked(keyHash)) {
      throw new BlockedError('this key has been blocked by the operator')
    }

    const existing = this.tunnels.get(keyHash)
    if (existing) {
      existing.lastRequestAt = Date.now()
      existing.inFlight++
      return existing
    }

    if (this.pending.has(keyHash)) {
      const record = await this.pending.get(keyHash)
      record.lastRequestAt = Date.now()
      record.inFlight++
      return record
    }

    const p = this._createTunnel(parsed)
    this.pending.set(keyHash, p)
    let record
    try {
      record = await p
    } finally {
      this.pending.delete(keyHash)
    }
    record.lastRequestAt = Date.now()
    record.inFlight++
    return record
  }

  /**
   * Create a brand-new tunnel for a parsed key, evicting an idle tunnel to
   * make room if the gateway is at capacity. Not exposed directly --
   * callers go through `ensureTunnel`, which dedupes concurrent cold-creates
   * for the same key via `this.pending`.
   *
   * Note: concurrent cold-creates of DISTINCT new keys can momentarily
   * overshoot MAX_TUNNELS by the number of in-flight creations, since
   * pending (not-yet-cached) tunnels aren't counted in `this.tunnels.size`.
   * This is acceptable and documented, not a bug.
   *
   * @param {{ key: string, keyHash: string }} parsed
   */
  async _createTunnel(parsed) {
    if (this.tunnels.size >= this.config.MAX_TUNNELS) {
      const victim = this._pickEvictable()
      if (!victim) {
        throw new CapacityError(
          `gateway at capacity (${this.config.MAX_TUNNELS} tunnels), all active; try again shortly`
        )
      }
      await this.destroyTunnel(victim.keyHash)
    }

    const port = this.portPool.acquire()
    let client
    try {
      client = new HolesailClient({ key: parsed.key, secure: false })

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`connect timed out after ${this.config.CONNECT_TIMEOUT_MS}ms`))
        }, this.config.CONNECT_TIMEOUT_MS)

        try {
          client.connect({ port, host: '127.0.0.1' }, () => {
            clearTimeout(timer)
            resolve()
          })
        } catch (err) {
          clearTimeout(timer)
          reject(err)
        }
      })

      await probePort(port, '127.0.0.1', this.config.CONNECT_TIMEOUT_MS)
    } catch (err) {
      // Clean up whatever partially succeeded before surfacing the error.
      try {
        if (client) await client.destroy()
      } catch {
        // best-effort cleanup; ignore secondary errors
      }
      this.portPool.release(port)
      throw new ConnectError(`failed to connect tunnel for key: ${err.message}`, err)
    }

    const record = {
      client,
      port,
      keyHash: parsed.keyHash,
      firstSeenAt: Date.now(),
      lastRequestAt: Date.now(),
      inFlight: 0,
    }
    this.tunnels.set(parsed.keyHash, record)
    return record
  }

  /**
   * Pick the least-recently-used tunnel that has no in-flight work (i.e. is
   * safe to evict without cutting off an active request/websocket). Returns
   * null if every cached tunnel is currently active.
   */
  _pickEvictable() {
    let victim = null
    for (const record of this.tunnels.values()) {
      if (record.inFlight > 0) continue
      if (!victim || record.lastRequestAt < victim.lastRequestAt) {
        victim = record
      }
    }
    return victim
  }

  /**
   * Release one reference previously acquired via `ensureTunnel`. Bumps
   * lastRequestAt so a just-finished tunnel isn't the instant next eviction
   * victim.
   * @param {{ inFlight: number, lastRequestAt: number }} record
   */
  release(record) {
    if (record && record.inFlight > 0) {
      record.inFlight--
      record.lastRequestAt = Date.now()
    }
  }

  /**
   * Bump the last-activity timestamp for a cached tunnel (used by the idle
   * sweeper's real-activity signal).
   * @param {string} keyHash
   */
  touch(keyHash) {
    const record = this.tunnels.get(keyHash)
    if (record) record.lastRequestAt = Date.now()
  }

  /**
   * Whether a raw key parses to a currently-cached (live) tunnel, i.e.
   * whether a request for it would be a cheap reuse rather than a cold
   * create. Used by the Phase 3 rate limiter to decide whether to charge
   * against the (stricter) new-tunnel budget. Returns false for a key that
   * fails to parse -- that request will be rejected downstream by
   * `ensureTunnel` anyway, not charged against the new-tunnel budget.
   * @param {string} rawKey
   * @returns {boolean}
   */
  isCached(rawKey) {
    try {
      const parsed = parseKey(rawKey)
      return this.tunnels.has(parsed.keyHash)
    } catch {
      return false
    }
  }

  /**
   * Sanitized snapshots of every live tunnel for the admin API -- no raw
   * key, no client object.
   * @returns {Array<{ keyHash: string, port: number, firstSeenAt: number, lastRequestAt: number, inFlight: number }>}
   */
  list() {
    return [...this.tunnels.values()].map((record) => ({
      keyHash: record.keyHash,
      port: record.port,
      firstSeenAt: record.firstSeenAt,
      lastRequestAt: record.lastRequestAt,
      inFlight: record.inFlight,
    }))
  }

  /**
   * Operator kill-switch: block a key hash from ever getting a new tunnel
   * again (existing cached tunnel, if any, is destroyed separately by the
   * caller -- see src/admin.js).
   * @param {string} keyHash
   */
  block(keyHash) {
    this.store.setBlocked(keyHash, true)
  }

  /**
   * Reverse of `block`.
   * @param {string} keyHash
   */
  unblock(keyHash) {
    this.store.setBlocked(keyHash, false)
  }

  /**
   * Tear down and remove a single tunnel.
   * @param {string} keyHash
   */
  async destroyTunnel(keyHash) {
    const record = this.tunnels.get(keyHash)
    if (!record) return
    this.tunnels.delete(keyHash)
    try {
      await record.client.destroy()
    } catch {
      // best-effort; the port is released regardless
    }
    this.portPool.release(record.port)
  }

  /**
   * Start the 60s sweeper that destroys tunnels idle longer than
   * IDLE_TTL_MS. Idle is judged by real proxied-request activity
   * (lastRequestAt), not by a client-side timer.
   */
  startSweeper() {
    if (this._sweeperHandle) return
    this._sweeperHandle = setInterval(() => {
      const now = Date.now()
      for (const [keyHash, record] of this.tunnels) {
        if (record.inFlight === 0 && now - record.lastRequestAt > this.config.IDLE_TTL_MS) {
          this.destroyTunnel(keyHash).catch(() => {})
        }
      }
    }, 60000)
    if (this._sweeperHandle.unref) this._sweeperHandle.unref()
  }

  stopSweeper() {
    if (this._sweeperHandle) {
      clearInterval(this._sweeperHandle)
      this._sweeperHandle = null
    }
  }

  /**
   * Stop the sweeper and tear down every live tunnel. Call on graceful
   * shutdown.
   */
  async shutdown() {
    this.stopSweeper()
    const keyHashes = [...this.tunnels.keys()]
    await Promise.all(keyHashes.map((keyHash) => this.destroyTunnel(keyHash)))
  }
}

module.exports = { TunnelManager, CapacityError, ConnectError, KeyError, BlockedError }
