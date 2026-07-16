'use strict'

// Milestone 1, Feature 1: a tiny persistent JSON-file store for per-key
// metadata (blocklist, aliases, dashboard passwords). Node built-ins only --
// no new dependencies. Writes are synchronous (admin actions are rare) and
// atomic: write to a pid-scoped tmp file, then rename over the real path, so
// a crash mid-write never corrupts the store.

const fs = require('node:fs')
const { parseKey } = require('./key')

const VERSION = 1
const ALIAS_RE = /^[a-z0-9-]{1,63}$/

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
   * pid-scoped tmp file, then rename over the real path. Cleans up the tmp
   * file on failure.
   */
  _persist() {
    const tmpPath = `${this.path}.tmp.${process.pid}`
    const json = JSON.stringify(this.data, null, 2)
    try {
      fs.writeFileSync(tmpPath, json, 'utf8')
      fs.renameSync(tmpPath, this.path)
    } catch (err) {
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
