'use strict'

// Milestone 1, Feature 1: a tiny persistent JSON-file store for per-key
// metadata (blocklist, aliases, dashboard passwords). Node built-ins only --
// no new dependencies. Writes are synchronous (admin actions are rare) and
// atomic: write to a pid-scoped tmp file, then rename over the real path, so
// a crash mid-write never corrupts the store.

const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const { parseKey } = require('./key')

const VERSION = 1
const ALIAS_RE = /^[a-z0-9-]{1,63}$/

/**
 * S6: best-effort removal of crash-orphaned tmp files left behind by a
 * previous process that died between _persist()'s open() and rename() (e.g.
 * OOM-killed, `kill -9`, power loss). Because each tmp file now gets a
 * random suffix (see _persist(), S5), an orphan is never overwritten
 * in-place by a later write -- it just sits there forever holding a stale
 * copy of every raw key, unless something sweeps it. This sweep is that
 * something. It's safe to run unconditionally at startup because the
 * gateway is single-instance (one systemd process owns the store file) and
 * load() always runs before any writer becomes active, so there's no
 * concurrent writer whose live tmp file we could race and delete out from
 * under it.
 *
 * @param {string} filePath
 */
function _sweepOrphanTmps(filePath) {
  try {
    const dir = path.dirname(filePath)
    const prefix = `${path.basename(filePath)}.tmp.`
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(prefix)) {
        try {
          fs.unlinkSync(path.join(dir, name))
        } catch {
          // best-effort: another actor may have already removed it
        }
      }
    }
  } catch {
    // best-effort: never block startup on an unreadable/missing directory
  }
}

/**
 * @returns {{ version: number, keys: object, aliases: object }}
 */
function emptyShape() {
  // Null-prototype maps: even if a caller ever skips keyHash/alias
  // validation, a stray '__proto__'/'constructor' key can't touch
  // Object.prototype through these maps.
  return { version: VERSION, keys: Object.create(null), aliases: Object.create(null) }
}

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function _isValidKey(candidate) {
  try {
    parseKey(candidate)
    return true
  } catch {
    return false
  }
}

class Store {
  /**
   * @param {string} filePath
   * @param {{ version: number, keys: object, aliases: object }} data
   */
  constructor(filePath, data) {
    this.path = filePath
    this.data = data
  }

  /**
   * Load the store from disk, synchronously, at startup. A missing file
   * (ENOENT) starts from an empty default shape -- that's the normal
   * first-run case, not an error. A file that exists but fails to parse
   * throws (fail-fast, same rationale as config.js: a corrupt store should
   * never be silently treated as empty).
   *
   * @param {string} filePath
   * @returns {Store}
   */
  static load(filePath) {
    // S6: reclaim any tmp file orphaned by a prior crash before we even
    // attempt to read the real store, so it happens on every startup path
    // including first-run (ENOENT) below.
    _sweepOrphanTmps(filePath)

    let raw
    try {
      raw = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') {
        return new Store(filePath, emptyShape())
      }
      throw err
    }

    let data
    try {
      data = JSON.parse(raw)
    } catch (err) {
      throw new Error(`Invalid store file at ${filePath}: ${err.message}`)
    }

    if (!data || typeof data !== 'object') {
      throw new Error(`Invalid store file at ${filePath}: expected a JSON object`)
    }
    // Normalize keys/aliases to null-prototype objects, defense in depth
    // against prototype pollution via a '__proto__'/'constructor' entry
    // even if it somehow ended up in the on-disk JSON.
    data.keys = Object.assign(Object.create(null), data.keys && typeof data.keys === 'object' ? data.keys : {})
    data.aliases = Object.assign(Object.create(null), data.aliases && typeof data.aliases === 'object' ? data.aliases : {})
    if (!data.version) data.version = VERSION

    return new Store(filePath, data)
  }

  /**
   * Persist the current in-memory state to disk atomically: write to a
   * pid-and-random-scoped tmp file, then rename over the real path. Cleans
   * up the tmp file on failure.
   *
   * S5: this store holds plaintext raw Holesail keys (live credentials), so
   * the tmp file -- and therefore the real file, via rename -- must never
   * be created world-readable. Two things matter here:
   *
   *  (a) `mode` on fs.open()/writeFileSync() is only honoured by open(2)
   *      when the call actually CREATES the file. If the tmp path were
   *      reused (e.g. just `${path}.tmp.${pid}`) and it already existed as
   *      a crash-orphan from a previous run, opening it for write would
   *      truncate-in-place and silently keep that orphan's old mode (often
   *      0o644 from before this fix) -- the requested 0o600 would never
   *      apply. Using `wx` (O_CREAT | O_EXCL | O_WRONLY) plus a random
   *      suffix guarantees every _persist() call creates a brand-new inode,
   *      so the 0o600 mode is always actually applied.
   *  (b) `renameSync` preserves the mode of the new (tmp) inode, not the
   *      old one -- so the real store file ends up 0o600 too. As a bonus,
   *      this means an already-deployed store that's currently 0o644
   *      self-heals to 0o600 the very next time anything writes to it.
   *
   * S10: `writeFileSync`/`renameSync` returning does NOT mean the write is
   * durable -- both can complete at the page cache without ever reaching
   * the physical disk, so an acknowledged admin action (block a tenant,
   * clear a password) can silently vanish on power loss and fail OPEN.
   * This method now fsyncs the tmp file's data before the rename, and
   * best-effort fsyncs the parent directory after the rename, so the write
   * survives a crash immediately after _persist() returns.
   */
  _persist() {
    const rnd = crypto.randomBytes(6).toString('hex')
    const tmpPath = `${this.path}.tmp.${process.pid}.${rnd}`
    const json = JSON.stringify(this.data, null, 2)
    let fd
    try {
      fd = fs.openSync(tmpPath, 'wx', 0o600)
      fs.writeFileSync(fd, json, 'utf8')
      // S10 -- writeFileSync only reaches the page cache; fsync the fd so
      // the store contents are durable before the rename makes them visible.
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      fs.renameSync(tmpPath, this.path)

      // S10: the file data is durable (fsync above), but the rename that
      // makes it the live store is only durable once the parent directory
      // entry is flushed too. Best-effort + guarded: opening a directory for
      // fsync fails on some platforms (e.g. Windows dev boxes); the Linux
      // deploy target -- the one that matters for durability -- supports it.
      let dirFd
      try {
        dirFd = fs.openSync(path.dirname(this.path), 'r')
        fs.fsyncSync(dirFd)
      } catch {
        // best-effort: platform can't fsync a directory handle
      } finally {
        if (dirFd !== undefined) {
          try { fs.closeSync(dirFd) } catch {}
        }
      }
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          // best-effort cleanup; ignore secondary errors
        }
      }
      try {
        fs.unlinkSync(tmpPath)
      } catch {
        // best-effort cleanup; ignore secondary errors
      }
      throw err
    }
  }

  /**
   * @param {string} keyHash
   * @returns {{ rawKey: ?string, alias: ?string, password: ?object, blocked: boolean, createdAt: number, updatedAt: number } | undefined}
   */
  getKey(keyHash) {
    return this.data.keys[keyHash]
  }

  /**
   * @param {string} keyHash
   * @returns {boolean}
   */
  isBlocked(keyHash) {
    const record = this.data.keys[keyHash]
    return !!(record && record.blocked)
  }

  /**
   * Create a bare record for `keyHash` if none exists (rawKey stays null --
   * we may only ever have seen the key via its hash, e.g. through the admin
   * API), then set its blocked flag.
   *
   * @param {string} keyHash
   * @param {boolean} blocked
   */
  setBlocked(keyHash, blocked) {
    const record = this._ensureRecord(keyHash)
    record.blocked = !!blocked
    record.updatedAt = Date.now()
    this._persist()
  }

  /**
   * @param {string} label
   * @returns {{ keyHash: string, rawKey: string } | undefined}
   */
  getByAlias(label) {
    const keyHash = this.data.aliases[String(label).toLowerCase()]
    if (!keyHash) return undefined
    const record = this.data.keys[keyHash]
    if (!record || !record.rawKey) return undefined
    return { keyHash, rawKey: record.rawKey }
  }

  /**
   * Point a human-friendly label at a raw key. Raw keys always take
   * precedence over aliases at resolution time (see server.js), which is
   * why an alias is rejected if it would itself parse as a valid key --
   * that ambiguity could never be reached anyway.
   *
   * @param {string} label
   * @param {string} rawKey
   */
  setAlias(label, rawKey) {
    const normalized = String(label).toLowerCase()

    if (!ALIAS_RE.test(normalized)) {
      throw new Error(
        `Invalid alias "${label}": must match ${ALIAS_RE} (lowercase letters, digits, hyphens, 1-63 chars)`
      )
    }
    if (normalized.startsWith('-') || normalized.endsWith('-')) {
      throw new Error(`Invalid alias "${label}": must not start or end with '-'`)
    }
    if (normalized === 'www') {
      throw new Error(`Invalid alias "${label}": "www" is reserved`)
    }
    if (_isValidKey(normalized)) {
      throw new Error(
        `Invalid alias "${label}": parses as a valid key itself, which would make it ` +
        'unreachable (raw keys always take precedence over aliases)'
      )
    }

    const parsed = parseKey(rawKey)
    const keyHash = parsed.keyHash

    const existing = this.data.aliases[normalized]
    if (existing && existing !== keyHash) {
      throw new Error(`Alias "${label}" is already assigned to a different key`)
    }

    const record = this._ensureRecord(keyHash)
    record.rawKey = rawKey
    record.alias = normalized
    record.updatedAt = Date.now()
    this.data.aliases[normalized] = keyHash
    this._persist()
  }

  /**
   * @param {string} label
   */
  clearAlias(label) {
    const normalized = String(label).toLowerCase()
    const keyHash = this.data.aliases[normalized]
    if (!keyHash) return
    delete this.data.aliases[normalized]
    const record = this.data.keys[keyHash]
    if (record && record.alias === normalized) {
      record.alias = null
      record.updatedAt = Date.now()
    }
    this._persist()
  }

  /**
   * @param {string} keyHash
   * @param {?string} rawKey
   * @param {string} passwordHash
   * @param {string} salt
   */
  setPassword(keyHash, rawKey, passwordHash, salt) {
    const record = this._ensureRecord(keyHash)
    if (rawKey) record.rawKey = rawKey
    // pwdVersion is a monotonic counter that survives clears (tracked on
    // the record, not just inside the `password` sub-object) so that a
    // clear-then-reset-password cycle can never reissue a version number a
    // stale cookie already holds.
    record.pwdVersion = (record.pwdVersion || 0) + 1
    record.password = { hash: passwordHash, salt, pwdVersion: record.pwdVersion }
    record.updatedAt = Date.now()
    this._persist()
  }

  /**
   * Clear the password, bumping pwdVersion so cookies issued against the
   * old password stop validating even if a new password is set later.
   * @param {string} keyHash
   */
  clearPassword(keyHash) {
    const record = this.data.keys[keyHash]
    if (!record || !record.password) return
    record.pwdVersion = (record.pwdVersion || 0) + 1
    record.password = null
    record.updatedAt = Date.now()
    this._persist()
  }

  /**
   * @param {string} keyHash
   * @returns {{ hash: string, salt: string, pwdVersion: number } | undefined}
   */
  getPassword(keyHash) {
    const record = this.data.keys[keyHash]
    if (!record) return undefined
    return record.password || undefined
  }

  /**
   * @returns {Array<object>}
   */
  listMetadata() {
    return Object.keys(this.data.keys).map((keyHash) => ({
      keyHash,
      ...this.data.keys[keyHash],
    }))
  }

  /**
   * @param {string} keyHash
   * @returns {object}
   */
  _ensureRecord(keyHash) {
    let record = this.data.keys[keyHash]
    if (!record) {
      record = {
        rawKey: null,
        alias: null,
        password: null,
        pwdVersion: 0,
        blocked: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      this.data.keys[keyHash] = record
    }
    return record
  }
}

/**
 * @param {string} filePath
 * @returns {Store}
 */
function load(filePath) {
  return Store.load(filePath)
}

module.exports = { Store, load }
