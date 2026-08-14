'use strict'

// Phase 1: covers src/pages.js's directoryPage(). `entries` is documented as
// already-sanitized output of Directory#list(), but title/description/tags
// still originate from an arbitrary tenant backend's manifest (not the
// operator), so directoryPage must escape every field itself as defense in
// depth -- these tests drive it directly with raw, attacker-shaped strings
// rather than routing through validateManifest, to pin that the ESCAPING
// happens here regardless of what upstream validation may or may not have
// done.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { directoryPage, guidePage, llmsTxt } = require('../../src/pages')

const VALID_KEY = 'dzyxro8yey8rnkck9sae7med7mquafafrkq9korjn8fyrheac39o'

function fakeConfig(overrides = {}) {
  return Object.assign(
    {
      BASE_DOMAIN: 'gateway.example.com',
      ABUSE_EMAIL: '',
      OPERATOR_EMAIL: '',
      DIRECTORY_ENABLED: false,
      DIRECTORY_RECHECK_MS: 3600000,
    },
    overrides
  )
}

function baseEntry(overrides = {}) {
  return Object.assign(
    {
      keyHash: 'a'.repeat(64),
      rawKey: VALID_KEY,
      title: 'A Project',
      description: 'A description.',
      tags: ['tag1'],
      online: true,
      lastSeenAt: Date.now(),
    },
    overrides
  )
}

test('directoryPage: escapes <script> in the title', () => {
  const html = directoryPage({
    entries: [baseEntry({ title: '<script>alert(1)</script>' })],
    q: '',
    config: fakeConfig(),
  })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('directoryPage: escapes double quotes, single quotes, and ampersands in the description', () => {
  const html = directoryPage({
    entries: [baseEntry({ description: `He said "hi" & she said 'bye'` })],
    q: '',
    config: fakeConfig(),
  })
  assert.doesNotMatch(html, /He said "hi" & she said 'bye'/)
  assert.match(html, /&quot;/)
  assert.match(html, /&#39;/)
  assert.match(html, /&amp;/)
})

test('directoryPage: escapes a closing </a> tag embedded in a tag value', () => {
  const html = directoryPage({
    entries: [baseEntry({ tags: ['</a><script>alert(1)</script>'] })],
    q: '',
    config: fakeConfig(),
  })
  assert.doesNotMatch(html, /<\/a><script>/)
  assert.match(html, /&lt;\/a&gt;&lt;script&gt;/)
})

test('directoryPage: escapes <script> embedded in the search query `q`, reflected into the input value', () => {
  const html = directoryPage({
    entries: [],
    q: '"><script>alert(1)</script>',
    config: fakeConfig(),
  })
  assert.doesNotMatch(html, /"><script>alert\(1\)<\/script>/)
  assert.match(html, /&quot;&gt;&lt;script&gt;/)
})

test('directoryPage: a malformed rawKey does not produce a broken or injectable href, and is skipped', () => {
  const html = directoryPage({
    entries: [baseEntry({ rawKey: '"><script>alert(1)</script>' })],
    q: '',
    config: fakeConfig(),
  })
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.doesNotMatch(html, /href="[^"]*<script/)
  // A malformed entry is skipped entirely -- its title must not render either.
  assert.doesNotMatch(html, /A Project/)
})

test('directoryPage: a valid rawKey renders an https://0000<key>.<domain>/ href', () => {
  const html = directoryPage({
    entries: [baseEntry({ rawKey: VALID_KEY })],
    q: '',
    config: fakeConfig(),
  })
  assert.match(html, new RegExp(`href="https://0000${VALID_KEY}\\.gateway\\.example\\.com/"`))
})

test('directoryPage: the offline badge renders when online is false, and not when true', () => {
  const offlineHtml = directoryPage({ entries: [baseEntry({ online: false })], q: '', config: fakeConfig() })
  assert.match(offlineHtml, /\(offline\)/)

  const onlineHtml = directoryPage({ entries: [baseEntry({ online: true })], q: '', config: fakeConfig() })
  assert.doesNotMatch(onlineHtml, /\(offline\)/)
})

test('directoryPage: empty entries with no query renders the generic empty state', () => {
  const html = directoryPage({ entries: [], q: '', config: fakeConfig() })
  assert.match(html, /No projects are listed yet/)
})

test('directoryPage: empty entries with a query renders a "no matches" message including the (escaped) query', () => {
  const html = directoryPage({ entries: [], q: 'nonexistent<script>', config: fakeConfig() })
  assert.match(html, /No listed projects match/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('directoryPage: renders using the shared STYLE + footer, consistent with other pages', () => {
  const html = directoryPage({ entries: [], q: '', config: fakeConfig() })
  assert.match(html, /color-scheme: light dark/)
  assert.match(html, /<footer>/)
})

test('directoryPage: always points a visitor at the guide, regardless of query results', () => {
  const withResults = directoryPage({ entries: [baseEntry()], q: '', config: fakeConfig() })
  assert.match(withResults, /href="\/guide"/)

  const empty = directoryPage({ entries: [], q: '', config: fakeConfig() })
  assert.match(empty, /href="\/guide"/)
})

// Phase 1: the manifest opt-in (guidePage/llmsTxt) is documented only when
// the operator has actually enabled the directory -- otherwise the guide
// would send a reader at a feature that 404s. Mirrors apexPage's existing
// DIRECTORY_ENABLED-gated directoryLink.

test('guidePage: documents the manifest opt-in when DIRECTORY_ENABLED is true', () => {
  const html = guidePage(fakeConfig({ DIRECTORY_ENABLED: true }))
  assert.match(html, /\.well-known\/janus-index\.json/)
  assert.match(html, /"list":\s*true/)
  assert.match(html, /publishes your raw key/i)
  assert.match(html, /password/i)
})

test('guidePage: omits the manifest opt-in section when DIRECTORY_ENABLED is false', () => {
  const html = guidePage(fakeConfig({ DIRECTORY_ENABLED: false }))
  assert.doesNotMatch(html, /janus-index\.json/)
  assert.doesNotMatch(html, /Get listed in the directory/)
})

test('llmsTxt: documents the manifest opt-in when DIRECTORY_ENABLED is true', () => {
  const txt = llmsTxt(fakeConfig({ DIRECTORY_ENABLED: true }))
  assert.match(txt, /\.well-known\/janus-index\.json/)
  assert.match(txt, /"list": true/)
  assert.match(txt, /application\/json/)
  assert.doesNotMatch(txt, /<\/[a-z]+>/i, 'llms.txt must not contain HTML tags')
})

test('llmsTxt: omits the manifest opt-in section when DIRECTORY_ENABLED is false', () => {
  const txt = llmsTxt(fakeConfig({ DIRECTORY_ENABLED: false }))
  assert.doesNotMatch(txt, /janus-index\.json/)
})
