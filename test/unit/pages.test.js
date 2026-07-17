'use strict'

// Milestone 2d: covers errorPage (moved here from server.js -- see that
// commit's rationale: it used to hardcode a dark theme that never picked up
// STYLE/footer) and the new offlinePage.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { errorPage, offlinePage } = require('../../src/pages')

function fakeConfig(overrides = {}) {
  return Object.assign(
    {
      BASE_DOMAIN: 'gateway.example.com',
      ABUSE_EMAIL: '',
      OPERATOR_EMAIL: '',
    },
    overrides
  )
}

test('errorPage: renders the requested code/title/message, escaped, using the shared STYLE + footer', () => {
  const html = errorPage(502, 'Bad Gateway', 'The backend tunnel closed unexpectedly.', fakeConfig())
  assert.match(html, /<h1>Bad Gateway<\/h1>/)
  assert.match(html, /The backend tunnel closed unexpectedly\./)
  assert.match(html, /Janus &middot; HTTP 502/)
  // Picked up the shared theme -- no more hardcoded dark-only colors.
  assert.match(html, /color-scheme: light dark/)
  assert.doesNotMatch(html, /#0b0d12/, 'must not still contain the old hardcoded dark background')
  // Shares the common footer (Impressum/Terms links).
  assert.match(html, /<footer>/)
})

test('errorPage: escapes an attacker-controllable title/message', () => {
  const html = errorPage(400, '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', fakeConfig())
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/)
  assert.match(html, /&lt;script&gt;/)
})

test('offlinePage: renders a friendly message and includes a Retry-After-style hint when given', () => {
  const html = offlinePage({ config: fakeConfig(), retryAfterSec: 30 })
  assert.match(html, /Backend unavailable/)
  assert.match(html, /try again in about 30 seconds/)
  assert.match(html, /Janus &middot; HTTP 502/)
})

test('offlinePage: falls back to a generic "try again shortly" when retryAfterSec is absent/invalid', () => {
  const html = offlinePage({ config: fakeConfig(), retryAfterSec: undefined })
  assert.match(html, /try again shortly/)
  assert.doesNotMatch(html, /try again in about/)

  const html2 = offlinePage({ config: fakeConfig(), retryAfterSec: -5 })
  assert.match(html2, /try again shortly/)
})

test('offlinePage: leaks no internals -- no keyHash, port, or failure-count language', () => {
  const suspiciousKeyHash = 'deadbeef'.repeat(8)
  const html = offlinePage({ config: fakeConfig(), retryAfterSec: 10 })
  assert.doesNotMatch(html, new RegExp(suspiciousKeyHash))
  assert.doesNotMatch(html, /keyHash/i)
  assert.doesNotMatch(html, /\bport\b/i) // word-boundary: the shared STYLE's "@supports" CSS rule legitimately contains "port"
  assert.doesNotMatch(html, /circuit/i)
  assert.doesNotMatch(html, /\bfailures?\b/i)
})

test('offlinePage: singular "1 second" grammar when retryAfterSec rounds to 1', () => {
  const html = offlinePage({ config: fakeConfig(), retryAfterSec: 0.4 })
  assert.match(html, /try again in about 1 second\./)
})
