'use strict'

// Phase 1: table-driven coverage of src/directory.js's validateManifest --
// the pure schema validator run against an arbitrary tenant backend's
// manifest JSON. No TCP ports, no store, no I/O -- pure function in, value
// out. See directory-fetch.test.js for the HTTP-fetch side and
// pages-directory.test.js for how the validated output gets rendered.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateManifest } = require('../../src/directory')

// --- list: must be strictly boolean true -------------------------------
// The manifest fetch itself is the consent signal (see directory.js's top
// comment) -- any truthy-but-not-`true` value (1, "true", "yes") must NOT
// be treated as consent, or a backend could opt in by accident via a loose
// truthy value in whatever language/serializer it used.
const LIST_CASES = [
  { list: true, listed: true },
  { list: undefined, listed: false },
  { list: false, listed: false },
  { list: 1, listed: false },
  { list: 'true', listed: false },
  { list: 'yes', listed: false },
]

for (const c of LIST_CASES) {
  test(`validateManifest: list=${JSON.stringify(c.list)} is ${c.listed ? 'accepted' : 'rejected'}`, () => {
    const manifest = { title: 'A Fine Project' }
    if (c.list !== undefined) manifest.list = c.list
    const result = validateManifest(manifest)
    if (c.listed) {
      assert.ok(result, 'expected list:true + valid title to be accepted')
    } else {
      assert.equal(result, null)
    }
  })
}

test('validateManifest: a non-object manifest is rejected', () => {
  assert.equal(validateManifest(null), null)
  assert.equal(validateManifest(undefined), null)
  assert.equal(validateManifest('not an object'), null)
  assert.equal(validateManifest(42), null)
  assert.equal(validateManifest([]), null) // Array.isArray -> typeof 'object', but has no .list
})

// --- title -----------------------------------------------------------
const TITLE_CASES = [
  { title: undefined, ok: false, label: 'missing' },
  { title: '', ok: false, label: 'empty' },
  { title: '   ', ok: false, label: 'whitespace-only' },
  { title: 'a'.repeat(81), ok: false, label: '81 chars' },
  { title: 'a', ok: true, label: '1 char' },
  { title: 'a'.repeat(80), ok: true, label: '80 chars' },
  { title: 42, ok: false, label: 'non-string (number)' },
]

for (const c of TITLE_CASES) {
  test(`validateManifest: title ${c.label} -> ${c.ok ? 'accepted' : 'rejected'}`, () => {
    const manifest = { list: true }
    if (c.title !== undefined) manifest.title = c.title
    const result = validateManifest(manifest)
    if (c.ok) {
      assert.ok(result)
      assert.equal(result.title.length, c.title.length)
    } else {
      assert.equal(result, null)
    }
  })
}

test('validateManifest: title is trimmed', () => {
  const result = validateManifest({ list: true, title: '  Hello World  ' })
  assert.ok(result)
  assert.equal(result.title, 'Hello World')
})

test('validateManifest: title control characters are stripped before length/trim checks', () => {
  const result = validateManifest({ list: true, title: '\x01Hello\x1f' })
  assert.ok(result)
  assert.equal(result.title, 'Hello')
})

// --- description -------------------------------------------------------
// Deliberate asymmetry vs title: an invalid description doesn't reject the
// whole manifest -- it's dropped (defaults to '') and the listing survives.
test('validateManifest: description over 200 chars is dropped, listing survives', () => {
  const result = validateManifest({ list: true, title: 'OK', description: 'x'.repeat(201) })
  assert.ok(result, 'listing must survive an invalid description')
  assert.equal(result.description, '')
})

test('validateManifest: a non-string description is dropped, listing survives', () => {
  const result = validateManifest({ list: true, title: 'OK', description: 12345 })
  assert.ok(result)
  assert.equal(result.description, '')
})

test('validateManifest: a description of exactly 200 chars is kept', () => {
  const desc = 'y'.repeat(200)
  const result = validateManifest({ list: true, title: 'OK', description: desc })
  assert.ok(result)
  assert.equal(result.description, desc)
})

test('validateManifest: description control characters stripped and trimmed', () => {
  const result = validateManifest({ list: true, title: 'OK', description: '  \x07hi there\x00  ' })
  assert.ok(result)
  assert.equal(result.description, 'hi there')
})

test('validateManifest: an absent description defaults to empty string, listing survives', () => {
  const result = validateManifest({ list: true, title: 'OK' })
  assert.ok(result)
  assert.equal(result.description, '')
})

// --- tags ----------------------------------------------------------------
test('validateManifest: a non-array tags value results in an empty tags list', () => {
  for (const bad of [undefined, null, 'tag1,tag2', 42, { 0: 'tag' }]) {
    const manifest = { list: true, title: 'OK' }
    if (bad !== undefined) manifest.tags = bad
    const result = validateManifest(manifest)
    assert.ok(result)
    assert.deepEqual(result.tags, [], `tags=${JSON.stringify(bad)} must yield []`)
  }
})

test('validateManifest: more than 8 tags are truncated to the first 8 valid ones', () => {
  const tags = Array.from({ length: 12 }, (_, i) => `tag${i}`)
  const result = validateManifest({ list: true, title: 'OK', tags })
  assert.ok(result)
  assert.equal(result.tags.length, 8)
  assert.deepEqual(result.tags, tags.slice(0, 8))
})

test('validateManifest: tag entries failing the [a-z0-9][a-z0-9-]* pattern are dropped individually', () => {
  const result = validateManifest({
    list: true,
    title: 'OK',
    tags: ['good-tag', 'BAD! tag', 'also_bad', '-leading-hyphen', 'ok2', ''],
  })
  assert.ok(result)
  assert.deepEqual(result.tags, ['good-tag', 'ok2'])
})

test('validateManifest: a non-string tag entry is dropped individually, others survive', () => {
  const result = validateManifest({ list: true, title: 'OK', tags: ['fine', 42, null, { x: 1 }, 'also-fine'] })
  assert.ok(result)
  assert.deepEqual(result.tags, ['fine', 'also-fine'])
})

test('validateManifest: tags are lowercased', () => {
  const result = validateManifest({ list: true, title: 'OK', tags: ['JavaScript', 'NODE'] })
  assert.ok(result)
  assert.deepEqual(result.tags, ['javascript', 'node'])
})

test('validateManifest: tags are deduped (case-insensitively)', () => {
  const result = validateManifest({ list: true, title: 'OK', tags: ['Node', 'node', 'NODE', 'other'] })
  assert.ok(result)
  assert.deepEqual(result.tags, ['node', 'other'])
})

test('validateManifest: a tag over 24 chars is dropped, one at exactly 24 chars is kept', () => {
  const tag24 = 'a'.repeat(24)
  const tag25 = 'b'.repeat(25)
  const result = validateManifest({ list: true, title: 'OK', tags: [tag24, tag25] })
  assert.ok(result)
  assert.deepEqual(result.tags, [tag24])
})

test('validateManifest: control characters are stripped from tag entries before validation', () => {
  const result = validateManifest({ list: true, title: 'OK', tags: ['\x01clean\x1f-tag'] })
  assert.ok(result)
  assert.deepEqual(result.tags, ['clean-tag'])
})

test('validateManifest: the >8 truncation counts only entries that end up valid (break happens after 8 accepted)', () => {
  // 6 valid tags interleaved with invalid ones, plus more valid tags after --
  // the truncation should still cap at 8 VALID tags, not stop after the
  // 8th raw array entry.
  const tags = ['a1', 'BAD!', 'a2', 'a3', 'BAD!', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']
  const result = validateManifest({ list: true, title: 'OK', tags })
  assert.ok(result)
  assert.equal(result.tags.length, 8)
  assert.deepEqual(result.tags, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])
})
