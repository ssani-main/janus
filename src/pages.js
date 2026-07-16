'use strict'

// Phase 3: legal pages (Impressum, ToS) + the apex landing page, all
// sharing a small dark-theme style consistent with server.js's errorPage.
// All dynamic values are escaped before being interpolated into HTML.

// The key can come from the attacker-controllable Host header (Phase 1), so
// any dynamic value reflected into HTML (error messages, titles, operator
// config) must be escaped -- otherwise a malformed value could carry
// HTML/JS straight from the request/config into the response.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function configuredOrPlaceholder(value, fieldName) {
  if (value && String(value).trim() !== '') return escapeHtml(value)
  return `<span class="warn">&#9888; NOT CONFIGURED &mdash; operator must set ${escapeHtml(fieldName)}</span>`
}

const STYLE = `
  body { font-family: system-ui, sans-serif; background: #0b0d12; color: #e6e6e6; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 2rem 1rem; box-sizing: border-box; }
  .card { max-width: 40rem; padding: 2rem; border: 1px solid #2a2f3a; border-radius: 0.75rem; background: #12151c; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; color: #7dd3fc; }
  h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: #7dd3fc; }
  p, li { margin: 0 0 0.75rem; color: #b8bec9; line-height: 1.5; }
  ul { padding-left: 1.25rem; }
  code { color: #7dd3fc; }
  a { color: #7dd3fc; }
  form { display: flex; gap: 0.5rem; }
  input { flex: 1; padding: 0.5rem 0.75rem; border-radius: 0.5rem; border: 1px solid #2a2f3a; background: #0b0d12; color: #e6e6e6; }
  button { padding: 0.5rem 1rem; border-radius: 0.5rem; border: none; background: #7dd3fc; color: #0b0d12; font-weight: 600; cursor: pointer; }
  .code { color: #64748b; font-size: 0.85rem; margin-top: 1rem; }
  .warn { color: #fbbf24; }
  footer { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #2a2f3a; font-size: 0.85rem; color: #64748b; }
  footer a { color: #64748b; text-decoration: underline; }
`

function footer(config) {
  const abuseContact = configuredOrPlaceholder(config.ABUSE_EMAIL, 'ABUSE_EMAIL (or OPERATOR_EMAIL)')
  return `<footer>
    <a href="/impressum">Impressum</a> &middot; <a href="/terms">Terms of Service</a><br>
    Abuse contact: ${abuseContact}
  </footer>`
}

// Apex landing page: the gateway's own domain (no tenant subdomain) has no
// tunnel to proxy to, so serve a minimal paste-a-key page instead of a dead
// 404.
function apexPage(config) {
  const safeDomain = escapeHtml(config.BASE_DOMAIN)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Janus</h1>
    <p>Paste a Holesail public key below, or visit
      <code>https://0000&lt;your-key&gt;.${safeDomain}/</code> directly.</p>
    <form id="go">
      <input id="key" type="text" placeholder="hs://0000... or bare key" autofocus>
      <button type="submit">Go</button>
    </form>
    <p class="code">Janus</p>
    ${footer(config)}
  </div>
  <script>
    document.getElementById('go').addEventListener('submit', function (e) {
      e.preventDefault()
      var raw = document.getElementById('key').value.trim()
      if (raw.toLowerCase().indexOf('hs://') === 0) raw = raw.slice(5)
      if (!raw) return
      window.location = 'https://' + raw + '.${safeDomain}/'
    })
  </script>
</body>
</html>`
}

function impressumPage(config) {
  const name = configuredOrPlaceholder(config.OPERATOR_NAME, 'OPERATOR_NAME')
  const address = configuredOrPlaceholder(config.OPERATOR_ADDRESS, 'OPERATOR_ADDRESS')
  const email = configuredOrPlaceholder(config.OPERATOR_EMAIL, 'OPERATOR_EMAIL')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Impressum / Legal Notice - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Impressum / Legal Notice</h1>
    <p><strong>Operator:</strong> ${name}</p>
    <p><strong>Address:</strong> ${address}</p>
    <p><strong>Contact:</strong> ${email}</p>
    ${footer(config)}
  </div>
</body>
</html>`
}

function termsPage(config) {
  const abuseContact = configuredOrPlaceholder(config.ABUSE_EMAIL, 'ABUSE_EMAIL (or OPERATOR_EMAIL)')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Terms of Service - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <!-- TEMPLATE, not legal advice; operator must review -->
  <div class="card">
    <h1>Terms of Service</h1>
    <p>This is a generic template and is provided as-is, without any warranty.
      It is <strong>not legal advice</strong>. The operator of this gateway
      is responsible for reviewing, completing, and adapting it to their own
      jurisdiction and circumstances before relying on it.</p>

    <h2>Prohibited use</h2>
    <p>You may not use this gateway to host, transmit, or link to:</p>
    <ul>
      <li>Content that is illegal under applicable law;</li>
      <li>Child sexual abuse material (CSAM) in any form;</li>
      <li>Non-consensual intimate content, or content that facilitates the
        creation or distribution of such content;</li>
      <li>Phishing pages, malware, or other content intended to
        compromise, deceive, or defraud visitors.</li>
    </ul>

    <h2>Enforcement</h2>
    <p>The operator cooperates with legitimate legal requests from
      appropriate authorities and reserves the right to terminate any
      session, tunnel, or key, at any time and without prior notice, for
      violations of these terms or on receipt of a valid abuse report.</p>

    <h2>Abuse reports</h2>
    <p>Report abuse to: ${abuseContact}</p>

    ${footer(config)}
  </div>
</body>
</html>`
}

function rateLimitPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>429 Too Many Requests - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Too Many Requests</h1>
    <p>You have exceeded the request rate limit for this gateway. Please
      wait a moment and try again.</p>
    <p class="code">Janus &middot; HTTP 429</p>
  </div>
</body>
</html>`
}

module.exports = { escapeHtml, apexPage, impressumPage, termsPage, rateLimitPage }
