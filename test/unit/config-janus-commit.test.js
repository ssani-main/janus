'use strict'

// Tier 0 (trust transparency): covers src/config.js's optional JANUS_COMMIT
// knob. config.js reads process.env synchronously at require time and
// throws on invalid values, so each case below needs its own process --
// spawned as a subprocess via `node -e`, same technique used elsewhere for
// exercising config.js's fail-fast throws (see
// test/unit/tunnel-manager-port-quarantine.test.js's subprocess fixtures).
//
// No TCP ports are bound anywhere in this file, so it needs no entry in
// fixtures/port-ranges.js.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.join(__dirname, '..', '..')
const REQUIRE_CONFIG = "require('./src/config')"

function runWithEnv(extraEnv) {
  return spawnSync(process.execPath, ['-e', REQUIRE_CONFIG], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      BASE_DOMAIN: 'gateway.example.com',
    }, extraEnv),
  })
}

test('JANUS_COMMIT: absent -> config loads fine, JANUS_COMMIT is null', () => {
  const result = runWithEnv({ JANUS_COMMIT: '' })
  assert.equal(result.status, 0, `expected clean exit with JANUS_COMMIT unset:\n${result.stderr}`)
})

test('JANUS_COMMIT: a valid full 40-char hex SHA is accepted', () => {
  const result = runWithEnv({ JANUS_COMMIT: 'a'.repeat(40) })
  assert.equal(result.status, 0, `expected a full hex SHA to be accepted:\n${result.stderr}`)
})

test('JANUS_COMMIT: a valid short 7-char hex SHA is accepted', () => {
  const result = runWithEnv({ JANUS_COMMIT: 'abc1234' })
  assert.equal(result.status, 0, `expected a short hex SHA to be accepted:\n${result.stderr}`)
})

test('JANUS_COMMIT: too short (< 7 chars) is rejected -- fails fast', () => {
  const result = runWithEnv({ JANUS_COMMIT: 'abc12' })
  assert.notEqual(result.status, 0, 'a too-short JANUS_COMMIT should throw at startup')
  assert.match(result.stderr, /Invalid config: JANUS_COMMIT/)
})

test('JANUS_COMMIT: too long (> 40 chars) is rejected -- fails fast', () => {
  const result = runWithEnv({ JANUS_COMMIT: 'a'.repeat(41) })
  assert.notEqual(result.status, 0, 'a too-long JANUS_COMMIT should throw at startup')
  assert.match(result.stderr, /Invalid config: JANUS_COMMIT/)
})

test('JANUS_COMMIT: non-hex characters are rejected -- fails fast', () => {
  const result = runWithEnv({ JANUS_COMMIT: 'not-a-sha!' })
  assert.notEqual(result.status, 0, 'a non-hex JANUS_COMMIT should throw at startup')
  assert.match(result.stderr, /Invalid config: JANUS_COMMIT/)
})
