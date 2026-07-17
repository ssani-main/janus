'use strict'

// Milestone 2a: zero-dep JSON-lines request logger. Deliberately accepts
// `keyHash` only -- there is no parameter or code path here that could ever
// carry a raw Holesail key into a log line. This is a security property,
// not an accident: the roadmap requires keyHash NEVER the raw key in any
// persisted/logged output, so the safest enforcement is to make the raw
// key structurally unreachable from this function's signature.

/**
 * @param {{ enabled: boolean }} opts
 * @returns {{ logRequest(fields: object): void }}
 */
function createLogger({ enabled }) {
  return {
    logRequest(fields) {
      // Check the flag first and build nothing when disabled -- this must
      // be cheap enough to call unconditionally on every request.
      if (!enabled) return

      try {
        const line = {
          ts: new Date().toISOString(),
          level: 'info',
          msg: 'request',
          keyHash: fields.keyHash,
          method: fields.method,
          path: fields.path,
          status: fields.status,
          durMs: fields.durMs,
          bytes: fields.bytes,
          ip: fields.ip,
        }
        process.stdout.write(JSON.stringify(line) + '\n')
      } catch {
        // A logging failure must never take down a request -- this is
        // best-effort observability, not a critical path. Swallow and move
        // on; losing one log line is far better than a crashed request.
      }
    },
  }
}

module.exports = { createLogger }
