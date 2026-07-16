'use strict'

// Tiny local TCP port allocator over an inclusive [min, max] range, backed
// by a Set of currently-used ports. One instance is meant to be shared by
// the TunnelManager for the lifetime of the process.
class PortPool {
  constructor(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
      throw new Error(`Invalid port range: [${min}, ${max}]`)
    }
    this.min = min
    this.max = max
    this.used = new Set()
    this._cursor = min
  }

  /**
   * Reserve and return a free port in the range. Throws if the pool is
   * exhausted.
   * @returns {number}
   */
  acquire() {
    const size = this.max - this.min + 1
    for (let i = 0; i < size; i++) {
      const candidate = this.min + ((this._cursor - this.min + i) % size)
      if (!this.used.has(candidate)) {
        this.used.add(candidate)
        this._cursor = candidate + 1
        return candidate
      }
    }
    throw new Error('port pool exhausted')
  }

  /**
   * Return a previously-acquired port to the pool.
   * @param {number} port
   */
  release(port) {
    this.used.delete(port)
  }
}

module.exports = PortPool
