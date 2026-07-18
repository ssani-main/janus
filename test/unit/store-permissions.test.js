'use strict'

// Regression tests for three security fixes to src/store.js:
//
//   S5 -- _persist() now creates its tmp file via fs.openSync(tmpPath, 'wx',
//         0o600) with a random suffix (${path}.tmp.${pid}.${randomHex}), then
//         renames over the real path. Because renameSync preserves the new
//         (tmp) inode's mode, the real store file ends up 0o600 too -- even
//         self-healing an already-deployed 0o644 store on its next write.
//   S6 -- Store.load() sweeps and unlinks any sibling `${basename}.tmp.*`
//         file before reading, reclaiming tmp files orphaned by a process
//         that crashed between _persist()'s open() and rename().
//   S10 -- _persist() now fsyncs the tmp file's data (fs.fsyncSync(fd))
//         before closing/renaming, and best-effort fsyncs the parent
//         directory after the rename, so an acknowledged admin write can't
//         silently vanish on power loss (fail-open). True power-loss
//         durability isn't unit-testable, so this test instead verifies the
//         fsync CALLS happen by counting invocations of fs.fsyncSync on the
//         same cached `node:fs` module object that store.js requires.
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

// --- S10: fsync durability on every persist --------------------------------

test('S10: _persist() calls fs.fsyncSync at least once for the tmp file data, and (non-win32) again for the parent directory', () => {
  const p = tmpStorePath('fsync-durability')
  const store = load(p)
  const { keyHash } = parseKey(KEY_A)

  // Node caches the `node:fs` module object, and store.js does
  // `const fs = require('node:fs')` -- so wrapping fsyncSync on this same
  // `fs` object (required above) intercepts store.js's calls too. The
  // try/finally is critical: leaking a wrapped fsyncSync into other tests
  // would corrupt their behavior/timing.
  const originalFsyncSync = fs.fsyncSync
  let fsyncCount = 0
  fs.fsyncSync = function wrappedFsyncSync(...args) {
    fsyncCount += 1
    return originalFsyncSync.apply(this, args)
  }

  try {
    store.setBlocked(keyHash, true)
  } finally {
    fs.fsyncSync = originalFsyncSync
  }

  // Unconditional: the tmp file's data is always fsynced before rename.
  assert.ok(fsyncCount >= 1, `expected fs.fsyncSync to be called at least once, got ${fsyncCount}`)

  if (process.platform !== 'win32') {
    // Non-Windows: the best-effort parent-directory fsync also succeeds, so
    // we expect a second call (data fd + dir fd).
    assert.ok(fsyncCount >= 2, `expected fs.fsyncSync to be called at least twice on ${process.platform}, got ${fsyncCount}`)
  }

  // Confirm the fsync wrapping didn't disturb the actual persisted data.
  const reloaded = load(p)
  assert.equal(reloaded.isBlocked(keyHash), true)
})
