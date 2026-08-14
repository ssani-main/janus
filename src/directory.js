'use strict'

// Phase 1: opt-in project directory. A tenant backend opts in by serving a
// manifest file (`/.well-known/janus-index.json`) with `"list": true` -- the
// manifest fetch itself IS the consent signal, so there is no account, no
// public submission form, and nothing an operator has to moderate up front.
//
// Every method here is called from the hot request path (server.js) or from
// a fire-and-forget background fetch, so nothing may ever throw to its
// caller -- every failure mode is swallowed, but NOT all treated the same
// way. Content-level failures (oversized body, bad JSON, wrong
// content-type, non-200 incl. 404, `list: false`) mean the backend
// answered and disqualified itself -- treated as "no manifest" / de-listing.
// Transport-level failures (connection refused/reset, socket timeout,
// connection never established) mean we never got an answer at all -- that
// is an outage, not a withdrawal of consent, so the entry is marked
// offline and stays listed instead of being deleted. See
// _fetchManifestBody's discriminated return and maybeFetchManifest's
// handling of it.

const http = require('node:http')
const { parseKey } = require('./key')

const TAG_RE = /^[a-z0-9][a-z0-9-]*$/i
const MAX_TAGS = 8
const MAX_TAG_LEN = 24
const MAX_TITLE_LEN = 80
const MAX_DESC_LEN = 200

// _lastCheckedAt has no per-entry eviction path wired from every place a key
// can go away (tunnel-manager owns idle/circuit/shutdown eviction and has no
// Directory reference -- see the comment on _sweepLastCheckedAt below for why
// that isn't threaded through instead). Once the map crosses this many
// entries, maybeFetchManifest opportunistically sweeps out anything older
// than DIRECTORY_RECHECK_MS so the steady-state size stays bounded even
// without an explicit forget() call for every eviction path.
const LAST_CHECKED_SWEEP_MULTIPLIER = 4

// Module-level, not per-Directory-instance: this guards a one-time warning
// about a holesail-client internal shape change, which is a process-wide
// fact, not a per-instance one (and Directory has exactly one instance per
// process in practice, but this makes that assumption explicit either way).
let warnedMissingSeed = false

// Control characters (excluding nothing -- even tab/newline are stripped,
// since these strings are rendered on a single-line-ish directory listing,
// not free text) stripped from every manifest string field before any other
// validation runs.
function stripControlChars(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1f\x7f]/g, '')
}

/**
 * Strict validation of a parsed manifest body against the Phase 1 schema.
 * Rejects rather than coerces: any field of the wrong TYPE fails the whole
 * manifest (for `list`/`title`) or is silently dropped (for the optional
 * `description`/`tags`), per the design.
 *
 * @param {*} manifest parsed JSON body
 * @returns {{ title: string, description: string, tags: string[] } | null}
 *   null means "not listed" (list !== true, or title invalid)
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  if (manifest.list !== true) return null

  if (typeof manifest.title !== 'string') return null
  const title = stripControlChars(manifest.title).trim()
  if (title.length < 1 || title.length > MAX_TITLE_LEN) return null

  let description = ''
  if (typeof manifest.description === 'string') {
    const trimmed = stripControlChars(manifest.description).trim()
    if (trimmed.length <= MAX_DESC_LEN) description = trimmed
    // else: invalid length -- drop the field, keep listing (per spec)
  }

  let tags = []
  if (Array.isArray(manifest.tags)) {
    const seen = new Set()
    for (const raw of manifest.tags) {
      if (tags.length >= MAX_TAGS) break
      if (typeof raw !== 'string') continue
      const cleaned = stripControlChars(raw).trim()
      if (cleaned.length < 1 || cleaned.length > MAX_TAG_LEN) continue
      if (!TAG_RE.test(cleaned)) continue
      const lower = cleaned.toLowerCase()
      if (seen.has(lower)) continue
      seen.add(lower)
      tags.push(lower)
    }
  }

  return { title, description, tags }
}

class Directory {
  /**
   * @param {{ config: object, store: import('./store').Store }} deps
   */
  constructor({ config, store }) {
    this.config = config
    this.store = store
    // Per-process recheck cache: keyHash -> timestamp of the last fetch
    // attempt (successful or not). Deliberately in-memory only -- a restart
    // just means every key gets rechecked once on its next request, which is
    // fine (manifest fetches are cheap, local-tunnel HTTP requests).
    this._lastCheckedAt = new Map()
  }

  /**
   * Fetch and process `record`'s manifest, if due. Never throws.
   *
   * @param {{ port: number, keyHash: string }} record a tunnel record from
   *   tunnel-manager (only `port`/`keyHash` are read)
   * @returns {Promise<void>}
   */
  async maybeFetchManifest(record) {
    try {
      if (!this.config.DIRECTORY_ENABLED) return
      if (!record || !record.keyHash || !record.port) return

      const keyHash = record.keyHash
      const now = Date.now()
      const last = this._lastCheckedAt.get(keyHash)
      if (last !== undefined && now - last < this.config.DIRECTORY_RECHECK_MS) return
      this._lastCheckedAt.set(keyHash, now)
      this._sweepLastCheckedAt(now)

      const result = await this._fetchManifestBody(record.port)
      if (result.kind === 'unreachable') {
        // Transport-level failure (ECONNREFUSED/ECONNRESET/EPIPE/socket
        // timeout/connection never established) -- this is an OUTAGE, not a
        // revocation of consent. De-listing here would be wrong: the tunnel
        // is alive but the tenant's actual backend is down or slow, and the
        // manifest fetch never even got an answer to disqualify on. Mark the
        // existing entry offline (a no-op if there is no entry -- do not
        // create a phantom listing for a key nobody opted into) and leave it
        // listed so it can recover on the next successful recheck.
        //
        // A timeout is deliberately bucketed here too, not with the
        // "backend answered but disqualified itself" cases below: a slow
        // backend might still be alive, and wrongly de-listing a
        // live-but-slow tenant is worse than briefly showing it offline
        // (which is also self-correcting on the next visit either way).
        await this.markOffline(keyHash)
        return
      }
      if (result.kind === 'invalid') {
        // The backend ANSWERED but the answer disqualifies listing (non-200
        // incl. 404, wrong content-type, or oversized body) -- treat as "no
        // manifest": de-list if previously listed.
        this._deleteEntrySafe(keyHash)
        return
      }

      const body = result.body

      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        this._deleteEntrySafe(keyHash)
        return
      }

      const validated = validateManifest(parsed)
      if (!validated) {
        this._deleteEntrySafe(keyHash)
        return
      }

      // Eligibility is also enforced at LIST time (see list() below), but
      // there is no point persisting a listing for a key that can never be
      // eligible to show -- skip storing it entirely rather than storing
      // then immediately hiding it forever.
      if (!this._eligibleNow(keyHash)) {
        this._deleteEntrySafe(keyHash)
        return
      }

      // The tenant URL is `0000<normalized-52-char-key>.<BASE_DOMAIN>`
      // (routing.js/key.js convention). `record.client.seed` is set by
      // HolesailClient's constructor from the exact `parsed.key` value
      // tunnel-manager passed it (see clientFactory({ key: parsed.key, ... })
      // in _createTunnel) -- already normalized, no scheme/prefix -- so no
      // re-parsing is needed. Falling back to a stored key record is a
      // defensive path only; it should not normally be reached, since a
      // successfully-ensured tunnel always has a live client.
      const normalizedKey = (record.client && record.client.seed) || this._normalizedKeyFromStore(keyHash)
      if (!normalizedKey) {
        // No key material available to render a URL from -- nothing useful
        // to list. `record.client.seed` reaches into a holesail-client
        // internal (see the module comment on _normalizedKeyFromStore); if a
        // future upgrade renames it, this branch is how that silently turns
        // into "nothing is ever listed" -- warn once so it's discoverable.
        this._warnMissingSeedOnce(keyHash)
        return
      }

      // Stored as the bare, normalized 52-char key (no "0000"/"hs://"
      // prefix) -- pages.js composes the tenant URL as `0000<rawKey>.
      // <BASE_DOMAIN>` directly, mirroring routing.js's convention.
      this.store.setDirectoryEntry(keyHash, normalizedKey, validated)
    } catch {
      // Never throw to the caller -- this runs fire-and-forget off the
      // request path (see server.js).
    }
  }

  /**
   * @param {number} port
   * @returns {Promise<{ kind: 'ok', body: string } | { kind: 'unreachable' } | { kind: 'invalid' }>}
   *   'ok' -- got a 200 with an acceptable content-type and a body within
   *     the size cap; 'unreachable' -- transport-level failure (connection
   *     refused/reset, socket timeout, connection never established) --
   *     i.e. we never got an answer to judge; 'invalid' -- the backend
   *     DID answer but the answer disqualifies listing (bad status,
   *     wrong content-type, or oversized body).
   */
  _fetchManifestBody(port) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/.well-known/janus-index.json',
        method: 'GET',
        timeout: this.config.DIRECTORY_MANIFEST_TIMEOUT_MS,
      }, (res) => {
        const contentType = String(res.headers['content-type'] || '')
        if (res.statusCode !== 200 || !contentType.includes('application/json')) {
          // finish() BEFORE destroy(): destroying the response can
          // synchronously emit 'error'/'aborted' on some platforms, which
          // would otherwise race this settlement and get misclassified as
          // 'unreachable' by the handlers below (settled guards against a
          // second finish(), but only if this one wins the race).
          finish({ kind: 'invalid' })
          res.destroy()
          return
        }

        let total = 0
        const chunks = []
        let aborted = false
        res.on('data', (chunk) => {
          if (aborted) return
          total += chunk.length
          if (total > this.config.DIRECTORY_MANIFEST_MAX_BYTES) {
            aborted = true
            finish({ kind: 'invalid' })
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (aborted) return
          finish({ kind: 'ok', body: Buffer.concat(chunks).toString('utf8') })
        })
        // A response-level error/abort after headers were already accepted
        // (e.g. the connection drops mid-body) never got a full answer
        // either -- treat it as unreachable, not a disqualifying answer.
        res.on('error', () => finish({ kind: 'unreachable' }))
        res.on('aborted', () => finish({ kind: 'unreachable' }))
      })

      // Timeout is deliberately treated as unreachable, not invalid -- see
      // the comment in maybeFetchManifest on why an ambiguous "might still
      // be alive, just slow" case must not de-list.
      req.on('timeout', () => {
        req.destroy()
        finish({ kind: 'unreachable' })
      })
      req.on('error', () => finish({ kind: 'unreachable' }))
      req.end()
    })
  }

  /**
   * Defensive fallback for the (normally unreachable) case where
   * `record.client.seed` is unavailable -- re-derives the normalized key
   * from any raw key the store already has on file for this keyHash (e.g.
   * from an alias or password).
   *
   * @param {string} keyHash
   * @returns {?string}
   */
  _normalizedKeyFromStore(keyHash) {
    const stored = this.store.getKey(keyHash)
    if (!stored || !stored.rawKey) return null
    try {
      return parseKey(stored.rawKey).key
    } catch {
      return null
    }
  }

  /**
   * @param {string} keyHash
   */
  _deleteEntrySafe(keyHash) {
    try {
      this.store.clearDirectoryEntry(keyHash)
    } catch {
      // best-effort
    }
  }

  /**
   * Evict `keyHash`'s recheck-cache entry, if any. Called wherever a key is
   * known to have gone away for good (deleted via the admin dashboard) so
   * `_lastCheckedAt` doesn't carry a permanent entry for a key that can
   * never be looked up again. Never throws.
   *
   * Tunnel eviction (idle/circuit/shutdown, in tunnel-manager.js) does NOT
   * call this: tunnel-manager has no Directory reference, and giving it one
   * just to forget a cache entry on every routine idle-eviction would couple
   * a hot lifecycle path to an opt-in, disabled-by-default feature for no
   * real benefit -- an idle-evicted tunnel's key is still valid and will
   * just get re-added to `_lastCheckedAt` on its next request anyway. That
   * path instead relies on `_sweepLastCheckedAt`'s bound below.
   *
   * @param {string} keyHash
   */
  forget(keyHash) {
    try {
      if (!keyHash) return
      this._lastCheckedAt.delete(keyHash)
    } catch {
      // never throw
    }
  }

  /**
   * Opportunistic bound on `_lastCheckedAt`'s steady-state size: once it
   * crosses `DIRECTORY_MAX_ENTRIES * LAST_CHECKED_SWEEP_MULTIPLIER` entries,
   * drop everything stale (older than DIRECTORY_RECHECK_MS -- i.e. already
   * due for a recheck anyway, so dropping it costs nothing but one extra
   * fetch next time it's seen). Runs inline on the request path but only
   * once every `DIRECTORY_MAX_ENTRIES * LAST_CHECKED_SWEEP_MULTIPLIER + 1`
   * calls in the worst case, so the amortized cost is negligible.
   *
   * @param {number} now
   */
  _sweepLastCheckedAt(now) {
    const bound = this.config.DIRECTORY_MAX_ENTRIES * LAST_CHECKED_SWEEP_MULTIPLIER
    if (this._lastCheckedAt.size <= bound) return
    for (const [keyHash, checkedAt] of this._lastCheckedAt) {
      if (now - checkedAt >= this.config.DIRECTORY_RECHECK_MS) {
        this._lastCheckedAt.delete(keyHash)
      }
    }
  }

  /**
   * One-time (process-wide, not per-request) warning that `record.client
   * .seed` is missing/unusable AND the store fallback also failed -- see the
   * module comment on `warnedMissingSeed`. Never logs the raw key, only the
   * keyHash.
   *
   * @param {string} keyHash
   */
  _warnMissingSeedOnce(keyHash) {
    if (warnedMissingSeed) return
    warnedMissingSeed = true
    console.warn(
      `[directory] no usable key material for keyHash=${keyHash} -- ` +
      '"record.client.seed" is missing and no stored key was found either. ' +
      'This likely means a holesail-client upgrade renamed/removed the ' +
      '"seed" property this code relies on; directory listings will ' +
      'silently stop working for keys without a stored alias/password ' +
      'until directory.js is updated to match. (This warning is logged once ' +
      'per process.)'
    )
  }

  /**
   * Eligibility rules that don't depend on the manifest content itself
   * (blocked / password-protected / operator-suppressed). Re-checked at LIST
   * time too -- see list() -- so this is only an early-out to avoid
   * persisting a listing that could never render.
   *
   * directorySuppressed lives on the KEY record (data.keys[keyHash]), not on
   * the directory entry itself (data.directory[keyHash]) -- see
   * store.js#setDirectorySuppressed and the matching CLAUDE.md entry for why:
   * the directory entry is created/overwritten/deleted by this class's own
   * passive manifest fetch, so a moderation decision stored there could be
   * silently cleared by the tenant's own next visit. Checking it here means
   * suppression takes effect immediately at render time (list()) with no
   * refetch required, exactly like blocked/password, and re-checking it here
   * before persisting also means maybeFetchManifest never (re)persists a
   * listing for a suppressed key.
   *
   * @param {string} keyHash
   * @returns {boolean}
   */
  _eligibleNow(keyHash) {
    if (this.store.isBlocked(keyHash)) return false
    if (this.store.getPassword(keyHash) !== undefined) return false
    if (this.store.isDirectorySuppressed(keyHash)) return false
    return true
  }

  /**
   * @param {string} keyHash
   */
  async markOnline(keyHash) {
    try {
      if (!keyHash) return
      this.store.touchDirectoryLiveness(keyHash, true)
    } catch {
      // never throw -- called from the request path
    }
  }

  /**
   * @param {string} keyHash
   */
  async markOffline(keyHash) {
    try {
      if (!keyHash) return
      this.store.touchDirectoryLiveness(keyHash, false)
    } catch {
      // never throw -- called from the request path / proxy error handler
    }
  }

  /**
   * Sanitized, sorted, eligibility-filtered listing for rendering.
   *
   * @param {{ q?: string }} [opts]
   * @returns {Array<{ keyHash: string, rawKey: string, title: string, description: string, tags: string[], online: boolean, lastSeenAt: number }>}
   */
  list({ q } = {}) {
    try {
      if (!this.config.DIRECTORY_ENABLED) return []

      let entries = this.store.listDirectory().filter((e) => this._eligibleNow(e.keyHash))

      const query = typeof q === 'string' ? q.trim().toLowerCase() : ''
      if (query) {
        entries = entries.filter((e) => {
          const haystack = [e.title, e.description, ...(e.tags || [])].join(' ').toLowerCase()
          return haystack.includes(query)
        })
      }

      entries.sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1
        return (b.lastSeenAt || 0) - (a.lastSeenAt || 0)
      })

      return entries.slice(0, this.config.DIRECTORY_MAX_ENTRIES).map((e) => ({
        keyHash: e.keyHash,
        rawKey: e.rawKey,
        title: e.title,
        description: e.description || '',
        tags: Array.isArray(e.tags) ? e.tags : [],
        online: !!e.online,
        lastSeenAt: e.lastSeenAt,
      }))
    } catch {
      return []
    }
  }
}

module.exports = { Directory, validateManifest }
