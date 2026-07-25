'use strict'

// Covers guidePage() / llmsTxt() -- the "how do I get a key at all?" half of
// the apex experience -- plus the footer link that reaches them.
//
// The load-bearing assertion in here is the `--public` one. `holesail --live
// <port>` without that flag emits an s000 secure-mode key, which key.js
// rejects with a 400; a guide that omitted the flag would send every reader
// into that exact dead end. If these tests are ever "simplified", keep that.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { guidePage, llmsTxt, apexPage, errorPage } = require('../../src/pages')

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

test('guidePage: documents the --public flag and why omitting it fails', () => {
  const html = guidePage(fakeConfig())
  assert.match(html, /npx holesail --live 3000 --public/)
  assert.match(html, /s000/, 'must name the secure-mode prefix the reader will otherwise get')
  assert.match(html, /400/, 'must connect the missing flag to the status code it produces')
})

test('guidePage: shows the URL shape using the configured base domain', () => {
  const html = guidePage(fakeConfig())
  assert.match(html, /0000&lt;your-key&gt;\.gateway\.example\.com/)
})

test('guidePage: escapes the base domain rather than interpolating it raw', () => {
  const html = guidePage(fakeConfig({ BASE_DOMAIN: '"><script>alert(1)</script>' }))
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('guidePage: covers the three areas a stuck visitor needs', () => {
  const html = guidePage(fakeConfig())
  // Security: the key is the only credential.
  assert.match(html, /SNI/)
  // Troubleshooting: the codes the gateway actually emits.
  for (const code of ['400', '502', '503', '429']) {
    assert.match(html, new RegExp(`<code>${code}</code>`), `missing status ${code}`)
  }
  // Network reality, so a holepunch failure isn't misread as an app bug.
  assert.match(html, /CGNAT/)
  // Framework notes.
  assert.match(html, /allowedHosts/)
  assert.match(html, /X-Forwarded-Proto/)
})

test('llmsTxt: is plain text carrying the same load-bearing facts', () => {
  const txt = llmsTxt(fakeConfig())
  // Not `/<[a-z]+>/` -- the text legitimately uses <port>/<key> as
  // placeholders. Closing tags and a doctype are the real HTML tells.
  assert.doesNotMatch(txt, /<\/[a-z]+>/i, 'llms.txt must not contain HTML tags')
  assert.doesNotMatch(txt, /<!doctype/i)
  assert.match(txt, /--public/)
  assert.match(txt, /s000/)
  assert.match(txt, /gateway\.example\.com/)
  assert.match(txt, /400\s+Key malformed/)
})

test('llmsTxt: tells the reader the 0000 prefix is part of the subdomain', () => {
  const txt = llmsTxt(fakeConfig())
  assert.match(txt, /0000.*prefix included/s)
})

test('apexPage: points a keyless visitor at both the guide and llms.txt', () => {
  const html = apexPage(fakeConfig())
  assert.match(html, /href="\/guide"/)
  assert.match(html, /href="\/llms\.txt"/)
})

test('footer: links the guide absolutely, so it still resolves from a tenant error page', () => {
  // A 400 is rendered on <key>.BASE_DOMAIN, where a relative /guide would
  // 404 against the tenant's own backend instead of reaching the gateway.
  const html = errorPage(400, 'Bad Request', 'The key in this address is malformed.', fakeConfig())
  assert.match(html, /href="https:\/\/gateway\.example\.com\/guide"/)
})
