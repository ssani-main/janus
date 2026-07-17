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

// Milestone 2c: thrown when a keyHash's circuit is open (repeated recent
// connect failures) and we deliberately refuse to attempt a cold create --
// see the manager-level `this.circuits` Map and `recordFailure`/
// `recordSuccess` below. `circuitOpenUntil` (epoch ms) is attached so
// server.js can compute an honest Retry-After header.
class CircuitOpenError extends Error {
  constructor(message, circuitOpenUntil, cause) {
    super(message)
    this.name = 'CircuitOpenError'
    this.circuitOpenUntil = circuitOpenUntil
    if (cause !== undefined) this.cause = cause
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

// Milestone 2c: fallback defaults used ONLY when `config` doesn't define
// these fields at all (`undefined`, not merely falsy/0). src/config.js
// always sets them, but several existing unit tests construct minimal,
// hand-rolled config objects directly (predating Milestone 2c) that don't
// include them -- without a fallback, `attempt >= undefined` is always
// `false`, so the reconnect loop below would retry forever instead of
// surfacing ConnectError once, and `reconnectDelayMs(attempt, undefined,
// undefined)` would compute NaN and call `setTimeout(fn, NaN)`. These
// defaults make TunnelManager degrade to pre-2c behavior (no circuit, no
// reconnect retries) for any config that simply doesn't mention them,
// rather than hanging.
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = Infinity // circuit can never open
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30000
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 0 // no reconnect retries -- fail on first attempt, exactly like pre-2c
const DEFAULT_RECONNECT_BASE_DELAY_MS = 250
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5000
// Milestone 2d: same fallback rationale as the 2c defaults above -- several
// existing hand-rolled test configs predate the health-probe knobs entirely.
// Falling back to src/config.js's own defaults keeps those tests' behavior
// unchanged (health probing simply never gets *started* unless a caller
// explicitly calls startHealthProbing(), so an absent config field is
// harmless either way -- these defaults only matter if a caller does start
// it against a minimal config object).
const DEFAULT_HEALTH_PROBE_INTERVAL_MS = 30000
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2000

// Milestone 2d: "open by default" -- a single flaky/failed liveness probe
// must never be enough to gate traffic away from an otherwise-working
// backend (a one-off blip, a momentary GC pause in the backend process,
// etc. is not the same thing as "down"). A record's `healthy` flag only
// flips to `false` after this many CONSECUTIVE failed probes in a row;
// recovery is the opposite trade-off -- a single successful probe is enough
// to flip it back to `true` immediately, since staying falsely "unhealthy"
// after the backend has recovered is the costlier mistake (it would keep
// serving the friendlier-but-still-an-error offline page to real, working
// traffic).
const HEALTH_PROBE_UNHEALTHY_STREAK = 2

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Milestone 2c: exponential backoff with EQUAL jitter for the reconnect
 * loop in `_createTunnel`. `attempt` is zero-indexed (0 = first reconnect,
 * after the initial cold-create attempt already failed once).
 *
 * Equal jitter (delay uniformly random in [cap/2, cap]), not full jitter
 * ([0, cap]) -- chosen so the *minimum* possible delay still grows
 * monotonically with `attempt`, which is both a real backoff guarantee
 * (not just "usually longer on average") and makes the growth easy to
 * assert in tests. Jitter itself still exists specifically to stop N
 * concurrent tunnels to the same dead backend from resynchronizing their
 * retries and hammering the DHT in lockstep -- the entire reason the
 * circuit breaker exists.
 *
 * Exported (not just used internally) so tests can assert on cap growth
 * and jitter bounds directly, without needing to drive a full reconnect
 * chain through TunnelManager.
 *
 * @param {number} attempt zero-indexed reconnect attempt number
 * @param {number} baseDelayMs
 * @param {number} maxDelayMs
 * @returns {number} delay in milliseconds
 */
function reconnectDelayMs(attempt, baseDelayMs, maxDelayMs) {
  const exp = baseDelayMs * Math.pow(2, attempt)
  const capped = Math.min(exp, maxDelayMs)
  const half = capped / 2
  return half + Math.random() * half
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

    // client.connect() only ever throws SYNCHRONOUSLY in the "faithful
    // stand-in" shape used by our tests; the real HolesailClient fails via
    // the internal-server 'error' event this whole function exists to
    // guard against, not a rejection. But connect() is declared `async` on
    // some client shapes, so it can also return a rejected Promise (a
    // failure occurring after its first `await`, never reaching the sync
    // throw path below). Without capturing and `.catch`ing that returned
    // value, such a rejection would become an unhandled rejection instead
    // of a wrapped ConnectError -- a latent correctness gap found during
    // 2a/2b testing, fixed here. `cleanupAndSettle`'s `settled` guard makes
    // this safe to attach unconditionally: if the callback already resolved
    // us, a later rejection on the same returned promise is a no-op.
    let maybePromise
    try {
      maybePromise = client.connect(options, () => {
        cleanupAndSettle(resolve, undefined)
      })
    } catch (err) {
      cleanupAndSettle(reject, err)
    }
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.catch((err) => {
        cleanupAndSettle(reject, err)
      })
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
    // Milestone 2c: circuit-breaker state, keyed by keyHash, living at the
    // MANAGER level -- deliberately NOT a per-tunnel-record field. A record
    // in `this.tunnels` is deleted by `destroyTunnel` exactly when a backend
    // dies, so per-record circuit state would vanish at the one moment it's
    // needed and could never fast-fail the next cold create. Surviving
    // record destruction is the entire point of this Map.
    // @type {Map<string, { failures: number, circuitOpenUntil: number, lastFailureAt: number }>}
    this.circuits = new Map()
    this._sweeperHandle = null
    // Milestone 2d: separate interval handle for the periodic health probe
    // -- deliberately NOT folded into the 60s sweeper interval, which is too
    // coarse for liveness checking and has a different job (idle-eviction +
    // circuit-entry expiry).
    this._healthProbeHandle = null
    // Milestone 1: blocklist state now lives in the persistent store so it
    // survives restarts. If no store is supplied (e.g. existing tests that
    // construct `new TunnelManager(config)` directly), fall back to an
    // in-memory-only shim with the same isBlocked/setBlocked surface.
    this.store = store || _inMemoryStoreShim()
    this.clientFactory = clientFactory || ((opts) => new HolesailClient(opts))
    // Milestone 2a: cumulative, monotonically-increasing counters for the
    // /metrics endpoint -- unlike `this.tunnels`, these never shrink, so an
    // operator can see totals across the process lifetime, not just current
    // state.
    this.counters = {
      created: 0,
      evicted: 0,
      swept: 0,
      connectFailures: 0,
      portRetries: 0,
      // Milestone 2c: cumulative circuit-breaker / reconnect counters.
      circuitOpens: 0,
      reconnectAttempts: 0,
      reconnectSuccesses: 0,
      // Milestone 2d: cumulative health-probe counters.
      healthProbes: 0,
      healthProbeFailures: 0,
    }
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

    // Milestone 2c circuit-breaker fast-fail. Deliberately placed AFTER the
    // cached-tunnel check above, not before it (even though it sits
    // "alongside" the blocklist check conceptually): a circuit only ever
    // opens in response to COLD-CREATE failures (see recordFailure, called
    // from _createTunnel's reconnect loop and server.js's proxy error
    // handler for the reactive trigger). By the time it's open we already
    // know a *fresh connect* to that backend has been failing -- but a
    // tunnel that is already cached and being returned above is proof the
    // backend is alive RIGHT NOW. Honoring "open by default", a stale
    // circuit must never kill an already-healthy, already-established
    // tunnel; it only ever gates the expensive cold-create path (DHT round
    // trip + connect + liveness probe), which is exactly the cost this
    // check exists to avoid paying against a backend we already know is
    // down.
    const circuit = this.circuits.get(keyHash)
    if (circuit && circuit.circuitOpenUntil > Date.now()) {
      const retryAfterMs = circuit.circuitOpenUntil - Date.now()
      throw new CircuitOpenError(
        `circuit open for this key after repeated connect failures; retry in ${Math.ceil(retryAfterMs / 1000)}s`,
        circuit.circuitOpenUntil
      )
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
      this.counters.evicted++
    }

    // Milestone 2c reconnect-with-backoff loop. This is a COMPLETELY
    // DIFFERENT concern from `_attemptPortConnect`'s port-collision retry
    // loop below: that one retries IMMEDIATELY, with no backoff, onto the
    // NEXT pool port, because EADDRINUSE is bind contention, not a dead
    // backend. THIS loop only fires when an entire `_attemptPortConnect()`
    // call fails with ConnectError (every port attempt exhausted, or a
    // non-collision failure like a liveness-probe timeout) -- i.e. the
    // backend itself looks unreachable -- and it backs off exponentially
    // with jitter before retrying the *same* key, so N concurrent requests
    // to one dead backend don't resynchronize and hammer the DHT in
    // lockstep. This entire loop runs inside the single Promise `ensureTunnel`
    // stores in `this.pending` for this keyHash, so concurrent callers for
    // the same key share this one retry/backoff chain instead of each
    // kicking off their own.
    let lastErr
    for (let attempt = 0; ; attempt++) {
      try {
        const record = await this._attemptPortConnect(parsed)
        if (attempt > 0) this.counters.reconnectSuccesses++
        this.recordSuccess(parsed.keyHash)
        return record
      } catch (err) {
        lastErr = err
        this.recordFailure(parsed.keyHash)
        const maxAttempts = this.config.RECONNECT_MAX_ATTEMPTS ?? DEFAULT_RECONNECT_MAX_ATTEMPTS
        if (attempt >= maxAttempts) {
          throw lastErr
        }
        this.counters.reconnectAttempts++
        const delayMs = reconnectDelayMs(
          attempt,
          this.config.RECONNECT_BASE_DELAY_MS ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
          this.config.RECONNECT_MAX_DELAY_MS ?? DEFAULT_RECONNECT_MAX_DELAY_MS
        )
        await sleep(delayMs)
      }
    }
  }

  /**
   * Single cold-create attempt: the pre-existing port-collision retry loop,
   * unchanged in behavior from before Milestone 2c -- extracted verbatim so
   * `_createTunnel` can wrap it in the reconnect-with-backoff loop above.
   * Not exposed directly; only called from `_createTunnel`.
   *
   * A port handed out by PortPool is only reserved *in this process* -- see
   * src/port-pool.js. It never checks whether the OS actually has the port
   * free, so anything else already bound to it (another process, an old
   * orphaned tunnel, etc.) makes the real listen() fail. That failure must
   * never be allowed to escalate to uncaughtException and take down every
   * other tenant's tunnel with it, so we retry onto the next pool port a
   * bounded number of times instead of propagating a raw crash.
   *
   * @param {{ key: string, keyHash: string }} parsed
   */
  async _attemptPortConnect(parsed) {
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
          this.counters.portRetries++
          continue
        }
        this.counters.connectFailures++
        throw new ConnectError(`failed to connect tunnel for key: ${err.message}`, err)
      }

      const record = {
        client,
        port,
        keyHash: parsed.keyHash,
        firstSeenAt: Date.now(),
        lastRequestAt: Date.now(),
        inFlight: 0,
        // Milestone 2d: per-record, transient health-probe state -- unlike
        // circuit-breaker state (this.circuits, manager-level), this
        // describes *this* tunnel instance specifically and should die with
        // it, not survive into whatever tunnel eventually replaces it.
        healthy: true,
        lastProbeAt: null,
        // Internal-only bookkeeping (not part of the sanitized `list()`
        // shape below) -- consecutive failed-probe streak used to decide
        // when `healthy` actually flips false; see
        // HEALTH_PROBE_UNHEALTHY_STREAK above.
        _probeFailStreak: 0,
      }
      this.tunnels.set(parsed.keyHash, record)
      this.counters.created++
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
   * Milestone 2c: record a cold-create (or reactive, proxy-error-triggered)
   * failure for a keyHash, opening its circuit once consecutive failures
   * reach CIRCUIT_FAILURE_THRESHOLD. Re-arms `circuitOpenUntil` on every
   * threshold-or-above failure (not just the first) so a backend that fails
   * again right after its cooldown expires re-opens the circuit instead of
   * silently falling back to "closed" forever.
   *
   * Callers, by design: a cold-create ConnectError (`_createTunnel`'s
   * reconnect loop, below) and a real proxied-request error
   * (proxy.on('error') in server.js). Both are strong signals -- an actual
   * attempt to reach the real backend failed. The periodic health probe
   * (Milestone 2d, `_probeOne` below) is deliberately NOT a caller: a
   * loopback TCP connect to our own holesail-client proxy port is too weak a
   * signal to open a circuit against a backend that may not have failed a
   * single real request. See `_probeOne`'s doc comment for what a probe
   * failure streak does instead (destroys the tunnel, letting the next
   * request's cold-create -- which DOES feed this breaker -- decide honestly
   * whether the backend is really down).
   *
   * @param {string} keyHash
   */
  recordFailure(keyHash) {
    let circuit = this.circuits.get(keyHash)
    if (!circuit) {
      circuit = { failures: 0, circuitOpenUntil: 0, lastFailureAt: 0 }
      this.circuits.set(keyHash, circuit)
    }
    circuit.failures++
    circuit.lastFailureAt = Date.now()
    const threshold = this.config.CIRCUIT_FAILURE_THRESHOLD ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD
    if (circuit.failures >= threshold) {
      const now = Date.now()
      const wasOpen = circuit.circuitOpenUntil > now
      circuit.circuitOpenUntil = now + (this.config.CIRCUIT_COOLDOWN_MS ?? DEFAULT_CIRCUIT_COOLDOWN_MS)
      if (!wasOpen) this.counters.circuitOpens++
    }
  }

  /**
   * Milestone 2c: record a success for a keyHash -- either a successful
   * cold create (called from `_createTunnel` above) or a successful
   * proxied response through an already-cached tunnel (called from
   * server.js's `proxy.on('proxyRes', ...)`). Simply deletes the circuit
   * entry: an absent entry is treated identically to
   * `{ failures: 0, circuitOpenUntil: 0 }` everywhere else in this file, and
   * dropping it here (rather than zeroing its fields) also means a healthy,
   * steadily-succeeding key never accumulates unbounded circuit state.
   *
   * @param {string} keyHash
   */
  recordSuccess(keyHash) {
    this.circuits.delete(keyHash)
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
      // Milestone 2d: health-probe state -- purely additive, every
      // pre-existing field above is untouched.
      healthy: record.healthy,
      lastProbeAt: record.lastProbeAt,
    }))
  }

  /**
   * Snapshot of current + cumulative tunnel stats for the /metrics endpoint.
   * Returns a copy (not the live counters object) so callers can't mutate
   * our internal state.
   * @returns {{ active: number, pending: number, maxTunnels: number, circuitsOpen: number, created: number, evicted: number, swept: number, connectFailures: number, portRetries: number, circuitOpens: number, reconnectAttempts: number, reconnectSuccesses: number }}
   */
  stats() {
    // circuitsOpen is a live GAUGE (unlike the cumulative counters spread in
    // below), so it's computed fresh here rather than tracked incrementally
    // -- it must reflect circuits that are open RIGHT NOW, including ones
    // whose cooldown has since expired without a fresh failure/success.
    const now = Date.now()
    let circuitsOpen = 0
    for (const circuit of this.circuits.values()) {
      if (circuit.circuitOpenUntil > now) circuitsOpen++
    }
    // Milestone 2d: unhealthy, like circuitsOpen above, is a live GAUGE --
    // computed fresh from current tunnel state rather than tracked
    // incrementally, so it always reflects reality right now (a tunnel that
    // recovers or is torn down must stop counting immediately).
    let unhealthy = 0
    for (const record of this.tunnels.values()) {
      if (!record.healthy) unhealthy++
    }
    return {
      active: this.tunnels.size,
      pending: this.pending.size,
      maxTunnels: this.config.MAX_TUNNELS,
      circuitsOpen,
      unhealthy,
      ...this.counters,
    }
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
          this.destroyTunnel(keyHash)
            .then(() => {
              this.counters.swept++
            })
            .catch(() => {})
        }
      }
      this._sweepCircuits(now)
    }, 60000)
    if (this._sweeperHandle.unref) this._sweeperHandle.unref()
  }

  /**
   * Milestone 2c: drop circuit-breaker entries from `this.circuits` that
   * are no longer doing any useful work, so the Map doesn't grow unbounded
   * across the process lifetime (same rationale/shape as
   * src/rate-limit.js's bucket sweep). An entry is dropped when its circuit
   * is NOT currently open AND it has been at least CIRCUIT_COOLDOWN_MS
   * since its last recorded failure -- i.e. it's been quiet for a full
   * cooldown window with nothing to fast-fail. An entry whose circuit IS
   * currently open is always kept (it's actively doing its job); one that
   * failed recently (within a cooldown window) is also kept, since another
   * failure right now should count toward re-opening it rather than
   * starting the failure count over from zero.
   * @param {number} now
   */
  _sweepCircuits(now) {
    const cooldownMs = this.config.CIRCUIT_COOLDOWN_MS ?? DEFAULT_CIRCUIT_COOLDOWN_MS
    for (const [keyHash, circuit] of this.circuits) {
      const isOpen = circuit.circuitOpenUntil > now
      const quietLongEnough = now - circuit.lastFailureAt > cooldownMs
      if (!isOpen && quietLongEnough) {
        this.circuits.delete(keyHash)
      }
    }
  }

  stopSweeper() {
    if (this._sweeperHandle) {
      clearInterval(this._sweeperHandle)
      this._sweeperHandle = null
    }
  }

  /**
   * Milestone 2d: start the periodic health-probe interval. Deliberately a
   * SEPARATE interval from the 60s sweeper (startSweeper above) -- that
   * interval is hardcoded and too coarse for liveness checking, and mixing
   * "idle eviction + circuit expiry" with "is this backend still alive"
   * into one tick would couple two unrelated tuning knobs together.
   */
  startHealthProbing() {
    if (this._healthProbeHandle) return
    const intervalMs = this.config.HEALTH_PROBE_INTERVAL_MS ?? DEFAULT_HEALTH_PROBE_INTERVAL_MS
    this._healthProbeHandle = setInterval(() => {
      this._probeTunnels().catch(() => {
        // _probeTunnels/_probeOne already handle their own per-record
        // failures (recordFailure, marking unhealthy) -- this catch only
        // guards against something unexpected escaping Promise.all so a
        // single bad tick can never kill the interval.
      })
    }, intervalMs)
    if (this._healthProbeHandle.unref) this._healthProbeHandle.unref()
  }

  stopHealthProbing() {
    if (this._healthProbeHandle) {
      clearInterval(this._healthProbeHandle)
      this._healthProbeHandle = null
    }
  }

  /**
   * Probe every currently-cached tunnel once. Not exposed as public API --
   * called by the interval above, and directly by tests.
   */
  async _probeTunnels() {
    const timeoutMs = this.config.HEALTH_PROBE_TIMEOUT_MS ?? DEFAULT_HEALTH_PROBE_TIMEOUT_MS
    const records = [...this.tunnels.values()]
    await Promise.all(records.map((record) => this._probeOne(record, timeoutMs)))
  }

  /**
   * Probe a single tunnel record's port and update its health state.
   *
   * Do NOT probe a tunnel with `inFlight > 0` -- it is demonstrably alive
   * (it's actively serving a request right now), so probing it is wasted
   * work that only adds extra connection churn against the backend.
   *
   * Probes deliberately do NOT touch the manager-level circuit breaker in
   * either direction -- neither `recordFailure` nor `recordSuccess`. A
   * passing/failing loopback TCP connect to our own holesail-client proxy
   * port only proves (or fails to prove) that OUR port is accepting
   * connections; it says nothing about whether the real backend behind it
   * is up, so it is too weak a signal to open OR close a circuit that gates
   * real traffic. See `recordFailure`'s doc comment for which signals are
   * strong enough to do that.
   *
   * Instead, a probe failure streak reaching HEALTH_PROBE_UNHEALTHY_STREAK
   * destroys the tunnel outright (see destroyTunnel below) rather than just
   * flipping `healthy` and leaving the dead record cached indefinitely --
   * that is precisely what used to pin a dead backend's tunnel forever (no
   * idle-sweep would ever fire because visitors kept refreshing and bumping
   * lastRequestAt, and nothing else ever acted on `healthy`). Destroying it
   * frees the port and lets the NEXT request cold-create through the
   * existing backoff + circuit-breaker machinery, which IS driven by a
   * strong signal (a real ConnectError) -- so a truly dead backend still
   * legitimately opens the circuit, and a recovered backend just works,
   * automatically, with no operator action.
   *
   * `healthy` still survives as an observability-only signal (admin
   * dashboard column, `janus_tunnels_unhealthy` gauge) -- it's just a
   * short-lived transient now, since the record it describes is destroyed
   * almost immediately after flipping false.
   *
   * @param {object} record
   * @param {number} timeoutMs
   */
  async _probeOne(record, timeoutMs) {
    // This guard is only sound BECAUSE src/server.js's proxy now sets
    // proxyTimeout (config.PROXY_TIMEOUT_MS): a hung backend's proxied
    // request eventually errors out on its own, which drains `inFlight`
    // back to 0 via the existing release() wiring. Do NOT remove the
    // timeout without removing/rethinking this guard too -- without it, an
    // in-flight request against a backend that hangs forever would never
    // release, this skip would never let a probe run, and the tunnel would
    // pin forever (the exact bug this guard's timeout dependency closes).
    if (record.inFlight > 0) return
    this.counters.healthProbes++
    record.lastProbeAt = Date.now()
    try {
      await probePort(record.port, '127.0.0.1', timeoutMs)
      record._probeFailStreak = 0
      record.healthy = true
    } catch {
      this.counters.healthProbeFailures++
      record._probeFailStreak = (record._probeFailStreak || 0) + 1
      // "Open by default": a single failed probe must never be enough to
      // mark a tunnel unhealthy and start gating traffic away from a
      // working backend -- see HEALTH_PROBE_UNHEALTHY_STREAK's doc comment.
      if (record._probeFailStreak >= HEALTH_PROBE_UNHEALTHY_STREAK) {
        record.healthy = false
        // Re-check inFlight (and that this exact record is still the one
        // cached for its keyHash) immediately before destroying -- a
        // request can arrive and start using this tunnel in the time
        // between this probe starting (the inFlight===0 check at the top
        // of this function) and its async probePort() settling here. Same
        // inFlight guard the idle sweeper already applies before evicting.
        if (record.inFlight === 0 && this.tunnels.get(record.keyHash) === record) {
          await this.destroyTunnel(record.keyHash)
        }
      }
    }
  }

  /**
   * Stop the sweeper + health probe and tear down every live tunnel. Call
   * on graceful shutdown.
   */
  async shutdown() {
    this.stopSweeper()
    this.stopHealthProbing()
    const keyHashes = [...this.tunnels.keys()]
    await Promise.all(keyHashes.map((keyHash) => this.destroyTunnel(keyHash)))
  }
}

module.exports = {
  TunnelManager,
  CapacityError,
  ConnectError,
  KeyError,
  BlockedError,
  CircuitOpenError,
  // Exported purely so unit tests can assert on backoff-cap growth and
  // jitter bounds directly -- see test/unit/tunnel-manager-circuit.test.js.
  reconnectDelayMs,
}
