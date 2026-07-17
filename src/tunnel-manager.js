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

// Max number of distinct ports we'll try for a single ensureTunnel() cold
// create before giving up and surfacing a ConnectError. Bounds the retry
// loop below so a badly-fragmented pool can't turn one request into an
// unbounded scan.
const MAX_PORT_ATTEMPTS = 5

/**
 * Cheap pre-flight check: bind a throwaway net.Server on host:port and
 * immediately close it. If something else already holds the port this
 * rejects with the OS's EADDRINUSE (caught normally, since *we* attach the
 * 'error' listener on our own server -- no crash risk here). This shrinks,
 * but cannot eliminate, the TOCTOU window between "port looked free" and
 * "holesail-client actually binds it" -- see connectWithPortGuard() below
 * for how we cover the residual race.
 */
function probeFree(port, host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', (err) => {
      reject(err)
    })
    srv.listen(port, host, () => {
      srv.close(() => resolve())
    })
  })
}

function isPortCollisionError(err) {
  return !!err && err.code === 'EADDRINUSE'
}

/**
 * Process-wide registry of in-flight connect attempts that are guarding
 * against an EADDRINUSE crash, keyed by the port each attempt is trying to
 * bind. There is exactly ONE 'uncaughtException' listener for the whole
 * process (installed once, below), not one per attempt -- see the bug this
 * replaced: `process.on('uncaughtException', ...)` fires *every* registered
 * listener for *every* uncaught error, so N concurrent per-attempt listeners
 * each saw every other attempt's error too. Attempt A (port 20000) would
 * receive attempt B's EADDRINUSE(20001), fail the `err.port === port` check,
 * remove itself, and re-throw -- permanently hanging A's promise (leaking
 * its port) while still crashing the process once zero listeners remained.
 *
 * With a single shared registry, an EADDRINUSE for port X can only ever
 * settle the one attempt that registered X, so an error on port Y can never
 * affect an in-flight attempt on port X.
 * @type {Map<number, (err: Error) => void>}
 */
const pendingPorts = new Map()

/**
 * The one and only 'uncaughtException' listener installed for the lifetime
 * of this process (added once at module load, never removed while a real,
 * unhandled bug is in flight -- see below). Installing it once here, rather
 * than lazily on first pending port and removing it when the registry
 * drains, avoids a re-entrant add/remove race with concurrent attempts and
 * costs nothing when the registry is empty (the handler is a no-op fast
 * path in that case, immediately re-throwing).
 */
function onUncaughtPortGuard(err) {
  if (isPortCollisionError(err) && pendingPorts.has(err.port)) {
    const reject = pendingPorts.get(err.port)
    pendingPorts.delete(err.port)
    reject(err)
    return
  }
  // Not a failure mode any pending attempt is guarding against -- this is a
  // real, unhandled bug. Remove ourselves first so the re-thrown error has
  // zero listeners left and Node performs its normal fatal-crash behavior,
  // exactly as if this guard didn't exist. Do NOT swallow it.
  process.removeListener('uncaughtException', onUncaughtPortGuard)
  queueMicrotask(() => {
    throw err
  })
}
process.on('uncaughtException', onUncaughtPortGuard)

/**
 * Wrap client.connect() so a port collision can never crash the process.
 *
 * Why this is needed (see node_modules/holesail-client/index.js:45-58 and
 * node_modules/@holesail/hyper-cmd-lib-net/index.js:246-252): HolesailClient
 * is a plain class, NOT an EventEmitter -- it never emits 'error' and never
 * forwards errors from the internal net.Server it creates in handleTCP().
 * That internal server is created via libNet.createTcpProxy(), which calls
 * `net.createServer().listen(port, host, onListen)` with *no* 'error'
 * listener attached anywhere in the chain. When listen() fails
 * asynchronously (e.g. EADDRINUSE), Node emits 'error' on that server with
 * zero listeners, which escalates straight to uncaughtException and kills
 * the whole gateway process -- this is exactly the crash in the bug report.
 *
 * There is no public API on HolesailClient to observe or intercept that
 * server's errors (no getter for the proxy is exposed before `connect()`'s
 * callback/rejection path, and the internal server reference is only set
 * *after* an internal DHT round-trip inside connect() -- by which point
 * listen() has often already been called). So the only way to prevent the
 * crash for this specific, well-understood failure mode is to register this
 * attempt's port + reject function in the shared `pendingPorts` registry
 * for the duration of the attempt; the single process-wide
 * `onUncaughtPortGuard` listener (see above) routes an EADDRINUSE for that
 * exact port to this attempt's rejection, and anything else is re-thrown
 * asynchronously so it still crashes the process as before -- real bugs are
 * not masked. The registry entry is always removed when this attempt
 * settles (success, timeout, sync throw, or EADDRINUSE match), so no entry
 * can leak and a port-X failure can never affect an in-flight attempt on
 * port Y.
 */
function connectWithPortGuard(client, options, timeoutMs) {
  const port = options.port
  return new Promise((resolve, reject) => {
    let settled = false

    function cleanupAndSettle(fn, arg) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pendingPorts.get(port) === onPortError) {
        pendingPorts.delete(port)
      }
      fn(arg)
    }

    function onPortError(err) {
      cleanupAndSettle(reject, err)
    }

    const timer = setTimeout(() => {
      cleanupAndSettle(reject, new Error(`connect timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    pendingPorts.set(port, onPortError)

    try {
      client.connect(options, () => {
        cleanupAndSettle(resolve, undefined)
      })
    } catch (err) {
      cleanupAndSettle(reject, err)
    }
  })
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
  /**
   * @param {object} config
   * @param {{ isBlocked(keyHash: string): boolean, setBlocked(keyHash: string, blocked: boolean): void }} [store]
   * @param {(opts: { key: string, secure: boolean }) => any} [clientFactory] Constructs a
   *   HolesailClient-compatible instance. Defaults to `new HolesailClient(opts)`. Overridable
   *   purely so unit tests can exercise the port-collision retry logic without a real DHT
   *   backend -- see test/unit/tunnel-manager-port-retry.test.js.
   */
  constructor(config, store, clientFactory) {
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
    this.clientFactory = clientFactory || ((opts) => new HolesailClient(opts))
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

    // A port handed out by PortPool is only reserved *in this process* --
    // see src/port-pool.js. It never checks whether the OS actually has the
    // port free, so anything else already bound to it (another process,
    // an old orphaned tunnel, etc.) makes the real listen() fail. That
    // failure must never be allowed to escalate to uncaughtException and
    // take down every other tenant's tunnel with it, so we retry onto the
    // next pool port a bounded number of times instead of propagating a
    // raw crash.
    let lastErr
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      let port
      try {
        port = this.portPool.acquire()
      } catch (err) {
        // Pool exhausted -- no point retrying further.
        throw new ConnectError(`failed to connect tunnel for key: ${err.message}`, err)
      }

      let client
      try {
        // Shrinks (does not eliminate) the TOCTOU window before we ask
        // holesail-client to bind this exact port itself.
        await probeFree(port, '127.0.0.1')

        client = this.clientFactory({ key: parsed.key, secure: false })
        await connectWithPortGuard(client, { port, host: '127.0.0.1' }, this.config.CONNECT_TIMEOUT_MS)
        await probePort(port, '127.0.0.1', this.config.CONNECT_TIMEOUT_MS)
      } catch (err) {
        // Clean up whatever partially succeeded before deciding whether to
        // retry or surface the error.
        try {
          if (client) await client.destroy()
        } catch {
          // best-effort cleanup; ignore secondary errors
        }
        this.portPool.release(port)
        lastErr = err

        if (isPortCollisionError(err) && attempt < MAX_PORT_ATTEMPTS - 1) {
          // Try the next port from the pool. Do NOT evict another tunnel to
          // free one up -- that causes eviction thrash; just move on.
          continue
        }
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

    // Unreachable in practice (the loop above always either returns or
    // throws), but keeps the function's return type honest for tooling.
    throw new ConnectError(
      `failed to connect tunnel for key: exhausted ${MAX_PORT_ATTEMPTS} port attempts`,
      lastErr
    )
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
