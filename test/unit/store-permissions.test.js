'use strict'

// Regression tests for two security fixes to src/store.js:
//
//   S5 -- _persist() now creates its tmp file via fs.openSync(tmpPath, 'wx',
//         0o600) with a random suffix (${path}.tmp.${pid}.${randomHex}), then
//         renames over the real path. Because renameSync preserves the new
//         (tmp) inode's mode, the real store file ends up 0o600 too -- even
//         self-healing an already-deployed 0o644 store on its next write.
//   S6 -- Store.load() sweeps and unlinks any sibling `${basename}.tmp.*`
//         file before reading, reclaiming tmp files orphaned by a process
//         that crashed between _persist()'s open() and rename().
//
// This file mirrors the harness in store.test.js (tmpStorePath() helper +
// a single after() hook that best-effort cleans up every temp path used).

const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { load } = require('../../src/store')
const { parseKey } = require('../../src/key')

// Same real 52-char z-base-32 key used across the other store tests.
const KEY_A = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

// Collect every temp path we create so a single after() hook cleans them all
// up, even if an individual test throws before reaching its own cleanup.
const tmpPaths = []
function tmpStorePath(label) {
  const p = path.join(os.tmpdir(), `janus-store-perm-test-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  tmpPaths.push(p)
  return p
}

after(() => {
  for (const p of tmpPaths) {
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort
    }
    try {
      fs.unlinkSync(`${p}.tmp.${process.pid}`)
    } catch {
      // best-effort
    }
  }
})

// --- S5: tmp file / real file created at mode 0o600 -----------------------

test('S5: a mutation that triggers _persist() leaves the store file at mode 0o600', (t) => {
  if (process.platform === 'win32') {
    // Windows has no POSIX mode bits; fs.statSync(...).mode is meaningless
    // for permission checks there.
    t.skip('POSIX mode bits not applicable on win32')
    return
  }

  const p = tmpStorePath('perm-0600')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)
  store.setBlocked(keyHash, true)

  assert.equal(fs.existsSync(p), true)
  const mode = fs.statSync(p).mode & 0o777
  assert.equal(mode, 0o600)
})

test('S5: self-heals an already-deployed 0o644 store file to 0o600 on its next persist', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits not applicable on win32')
    return
  }

  const p = tmpStorePath('perm-selfheal')
  // Simulate a store file that predates the S5 fix: created world-readable.
  fs.writeFileSync(p, JSON.stringify({ version: 1, keys: {}, aliases: {} }), 'utf8')
  fs.chmodSync(p, 0o644)
  assert.equal(fs.statSync(p).mode & 0o777, 0o644)

  const store = load(p)
  const { keyHash } = parseKey(KEY_A)
  store.setBlocked(keyHash, true)

  // The atomic rename in _persist() replaces the old (0o644) inode with a
  // freshly-created 0o600 one, so the on-disk mode must have upgraded.
  const mode = fs.statSync(p).mode & 0o777
  assert.equal(mode, 0o600)
})

// --- S6: startup sweep of crash-orphaned tmp files -------------------------

test('S6: load() sweeps an orphaned .tmp file left behind by a crashed prior process', () => {
  const p = tmpStorePath('sweep-orphan')
  const orphan = `${p}.tmp.99999.deadbeefcafe`
  tmpPaths.push(orphan)
  fs.writeFileSync(orphan, 'stale crash-orphaned content, never a real store file', 'utf8')
  assert.equal(fs.existsSync(orphan), true)

  load(p)

  assert.equal(fs.existsSync(orphan), false)
})

test('S6: the sweep leaves unrelated sibling files alone and real store data still loads', () => {
  const p = tmpStorePath('sweep-safety')
  const { keyHash } = parseKey(KEY_A)

  // Seed a real, persisted store first.
  const store1 = load(p)
  store1.setBlocked(keyHash, true)

  // Plant a crash-orphaned tmp file plus an unrelated sibling that merely
  // shares a path prefix (does NOT match the `${basename}.tmp.` sweep
  // pattern) -- the sweep must only touch the former.
  const orphan = `${p}.tmp.12345.abc123def456`
  tmpPaths.push(orphan)
  fs.writeFileSync(orphan, 'stale crash-orphaned content', 'utf8')

  const unrelated = `${p}.backup`
  tmpPaths.push(unrelated)
  fs.writeFileSync(unrelated, 'do not touch me', 'utf8')

  const store2 = load(p)

  assert.equal(fs.existsSync(orphan), false)
  assert.equal(fs.existsSync(unrelated), true)
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'do not touch me')
  // The sweep must not have interfered with reading the real store data.
  assert.equal(store2.isBlocked(keyHash), true)
})
