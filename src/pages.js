'use strict'

const { INSTRUMENT_SERIF_WOFF2, GEIST_MONO_WOFF2 } = require('./fonts')

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
  @font-face {
    font-family: 'Instrument Serif';
    font-style: normal;
    font-weight: 400;
    font-display: swap;
    src: url('${INSTRUMENT_SERIF_WOFF2}') format('woff2');
  }
  @font-face {
    font-family: 'Geist Mono';
    font-style: normal;
    font-weight: 100 900;
    font-display: swap;
    src: url('${GEIST_MONO_WOFF2}') format('woff2');
  }

  :root {
    color-scheme: light dark;
    --bg: light-dark(#f6f1e7, #14120f);
    --text: light-dark(#191612, #efe9dd);
    --muted: light-dark(#6c6558, #8b8375);
    --accent: light-dark(#8a3b1e, #e0885c);
    --rule: light-dark(#e2dacb, #2b2722);
    --surface: light-dark(#f1ebdf, #1c1915);
    --warn: light-dark(#8a5a1e, #e0b070);
    --font-display: 'Instrument Serif', ui-serif, Georgia, serif;
    --font-mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  @supports not (color: light-dark(#000, #fff)) {
    :root {
      --bg: #f6f1e7;
      --text: #191612;
      --muted: #6c6558;
      --accent: #8a3b1e;
      --rule: #e2dacb;
      --surface: #f1ebdf;
      --warn: #8a5a1e;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #14120f;
        --text: #efe9dd;
        --muted: #8b8375;
        --accent: #e0885c;
        --rule: #2b2722;
        --surface: #1c1915;
        --warn: #e0b070;
      }
    }
  }

  body { font-family: var(--font-mono); font-weight: 400; line-height: 1.6; background: var(--bg); color: var(--text); display: flex; min-height: 100vh; align-items: flex-start; justify-content: center; margin: 0; padding: 2rem 1rem; box-sizing: border-box; }
  .card { max-width: min(680px, 100%); width: 100%; min-width: 0; margin: 0 auto; padding: 3rem 1.5rem; box-sizing: border-box; }
  h1 { font-family: var(--font-display); font-weight: 400; font-size: 2.5rem; letter-spacing: -0.01em; margin: 0 0 1rem; color: var(--text); }
  h2 { font-family: var(--font-display); font-weight: 400; font-size: 1.4rem; margin: 1.5rem 0 0.5rem; color: var(--text); }
  p, li { font-family: var(--font-mono); font-weight: 400; line-height: 1.6; margin: 0 0 0.75rem; color: var(--muted); overflow-wrap: anywhere; }
  ul { padding-left: 1.25rem; }
  code { color: var(--accent); font-family: var(--font-mono); overflow-wrap: anywhere; }
  a { color: var(--accent); text-decoration: underline; text-underline-offset: 0.2em; }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  form { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  input, button { font-family: var(--font-mono); }
  input { flex: 1 1 12rem; min-width: 0; padding: 0.5rem 0.75rem; border-radius: 4px; border: 1px solid var(--rule); background: var(--surface); color: var(--text); }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button { padding: 0.5rem 1rem; border-radius: 4px; border: 1px solid var(--rule); background: var(--accent); color: var(--bg); font-weight: 500; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .code { color: var(--muted); font-size: 0.85rem; margin-top: 1rem; font-variant-numeric: tabular-nums; }
  .warn { color: var(--warn); }
  .tagline { font-family: var(--font-mono); color: var(--muted); font-size: 0.85rem; letter-spacing: 0.02em; margin-top: -0.5rem; margin-bottom: 2rem; }
  footer { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: 0.8rem; color: var(--muted); font-family: var(--font-mono); }
  footer a { color: var(--muted); text-decoration: underline; text-underline-offset: 0.2em; }
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
    <p class="tagline">a p2p key, made public</p>
    <p>Paste a Holesail public key below, or visit
      <code>https://0000&lt;your-key&gt;.${safeDomain}/</code> directly.</p>
    <form id="go">
      <input id="key" type="text" placeholder="hs://0000... or bare key" autofocus>
      <button type="submit">Go</button>
    </form>
    ${footer(config)}
  </div>
  <script>
    document.getElementById('go').addEventListener('submit', function (e) {
      e.preventDefault()
      var raw = document.getElementById('key').value.trim()
      if (raw.toLowerCase().indexOf('hs://') === 0) raw = raw.slice(5)
      if (!raw) return
      window.location = location.protocol + '//' + raw + '.${safeDomain}' + (location.port ? ':' + location.port : '') + '/'
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

// Milestone 1, Feature 3: served in place of a passworded key's normal
// response until the visitor authenticates. `next` is the path to redirect
// to on success (escaped -- it's attacker-controllable via req.url).
function loginPage({ error, next, config }) {
  const safeNext = escapeHtml(next || '/')
  const errorHtml = error
    ? `<p class="warn">${escapeHtml(error)}</p>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Protected - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Protected</h1>
    <p>This site is password-protected by the operator.</p>
    ${errorHtml}
    <form method="POST" action="/__janus_login">
      <input type="password" name="password" placeholder="Password" required autofocus>
      <input type="hidden" name="next" value="${safeNext}">
      <button type="submit">Enter</button>
    </form>
    ${footer(config)}
  </div>
</body>
</html>`
}

// Generic error page (400/403/404/500/502/503, etc.), used by server.js for
// every non-proxied failure branch. Moved here from server.js (which had a
// local, hardcoded-dark-theme copy that never picked up the shared STYLE /
// light+dark themes / self-hosted fonts) so it can share STYLE + footer()
// like every other page instead of drifting from them.
function errorPage(code, title, msg, config) {
  const safeTitle = escapeHtml(title)
  const safeMsg = escapeHtml(msg)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${code} ${safeTitle} - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMsg}</p>
    <p class="code">Janus &middot; HTTP ${code}</p>
    ${footer(config)}
  </div>
</body>
</html>`
}

// Milestone 2d: served in place of the generic errorPage(502, ...) when the
// proxy errors out AND the periodic health probe has already confirmed
// (via `req._janusTunnel.healthy === false`) that this isn't just a one-off
// blip -- see server.js's proxy.on('error', ...) handler. Friendly and
// honest: the backend is offline/unreachable, this is not the visitor's
// fault, and there is nothing for them to log into or retry differently.
// Deliberately leaks NOTHING operational -- no keyHash, port, or failure
// counts -- a visitor hitting this page is not an operator and has no use
// for (and no right to) that information.
function offlinePage({ config, retryAfterSec }) {
  const hasRetry = Number.isFinite(retryAfterSec) && retryAfterSec > 0
  const safeRetry = hasRetry ? escapeHtml(String(Math.ceil(retryAfterSec))) : null
  const retryHtml = hasRetry
    ? `<p>Please try again in about ${safeRetry} second${safeRetry === '1' ? '' : 's'}.</p>`
    : `<p>Please try again shortly.</p>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Backend Unavailable - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Backend unavailable</h1>
    <p>The site behind this address is currently offline or unreachable.
      This isn't something you did &mdash; there's nothing to log into or
      configure on your end.</p>
    ${retryHtml}
    <p class="code">Janus &middot; HTTP 502</p>
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

// Milestone 1, Feature 4: admin dashboard login page. Distinct from the
// per-key loginPage above -- this authenticates the operator (the admin
// token), not a visitor. Rendered both for GET /_admin with no valid
// session/bearer, and after a failed POST /_admin/login.
function adminLoginPage({ error }) {
  const errorHtml = error
    ? `<p class="warn">${escapeHtml(error)}</p>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Admin - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Janus Admin</h1>
    ${errorHtml}
    <form method="POST" action="/_admin/login">
      <input type="password" name="token" placeholder="Admin token" required autofocus>
      <button type="submit">Log in</button>
    </form>
  </div>
</body>
</html>`
}

// Milestone 1, Feature 4: the admin dashboard itself. `rows` merges live
// tunnel state (src/tunnel-manager.js#list) with persisted metadata
// (src/store.js#listMetadata) by keyHash. `csrf` is a token bound to the
// admin session (see src/auth.js#csrfToken) embedded in every mutating
// form. All dynamic values are escaped -- keyHash/alias/etc. can originate
// from operator input or attacker-controlled keys, never trust them raw.
function adminDashboardPage({ rows, csrf, config, error }) {
  const safeCsrf = escapeHtml(csrf)
  const errorHtml = error
    ? `<p class="warn">${escapeHtml(error)}</p>`
    : ''

  const tableRows = rows.map((row) => {
    const shortHash = escapeHtml(String(row.keyHash).slice(0, 12))
    const alias = row.alias ? escapeHtml(row.alias) : '&mdash;'
    const statusBits = []
    statusBits.push(row.live ? 'live' : 'idle')
    if (row.blocked) statusBits.push('<span class="warn">blocked</span>')
    const status = statusBits.join(' &middot; ')
    const password = row.hasPassword ? '&#128274;' : '&mdash;'
    const port = row.live ? escapeHtml(String(row.port)) : '&mdash;'
    const inFlight = row.live ? escapeHtml(String(row.inFlight)) : '&mdash;'
    const lastRequestAt = row.live && row.lastRequestAt
      ? escapeHtml(new Date(row.lastRequestAt).toISOString())
      : '&mdash;'
    // Milestone 2d: health-probe status. Only meaningful for a live tunnel
    // -- an idle/never-created key has never been probed at all.
    const health = row.live
      ? (row.healthy === false ? '<span class="warn">unhealthy</span>' : 'healthy')
      : '&mdash;'
    const safeKeyHash = escapeHtml(row.keyHash)

    const blockForm = `<form method="POST" action="/_admin/block" style="display:inline-flex">
      <input type="hidden" name="csrf" value="${safeCsrf}">
      <input type="hidden" name="keyHash" value="${safeKeyHash}">
      <input type="hidden" name="action" value="${row.blocked ? 'unblock' : 'block'}">
      <button type="submit">${row.blocked ? 'Unblock' : 'Block'}</button>
    </form>`

    const clearAliasForm = row.alias
      ? `<form method="POST" action="/_admin/alias" style="display:inline-flex">
      <input type="hidden" name="csrf" value="${safeCsrf}">
      <input type="hidden" name="alias" value="${alias === '&mdash;' ? '' : escapeHtml(row.alias)}">
      <input type="hidden" name="action" value="clear">
      <button type="submit">Clear alias</button>
    </form>`
      : ''

    const clearPasswordForm = row.hasPassword
      ? `<form method="POST" action="/_admin/password" style="display:inline-flex">
      <input type="hidden" name="csrf" value="${safeCsrf}">
      <input type="hidden" name="keyHash" value="${safeKeyHash}">
      <input type="hidden" name="action" value="clear">
      <button type="submit">Clear password</button>
    </form>`
      : ''

    return `<tr>
      <td><code>${shortHash}&hellip;</code></td>
      <td>${alias}</td>
      <td>${status}</td>
      <td>${password}</td>
      <td>${port}</td>
      <td>${health}</td>
      <td>${inFlight}</td>
      <td>${lastRequestAt}</td>
      <td style="display:flex; gap:0.5rem; flex-wrap:wrap">${blockForm}${clearAliasForm}${clearPasswordForm}</td>
    </tr>`
  }).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Admin - Janus</title>
<style>${STYLE}
  .wide { max-width: 60rem; }
  table { display: block; overflow-x: auto; max-width: 100%; width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--rule); font-size: 0.9rem; color: var(--text); }
  th { color: var(--muted); font-weight: 500; background: var(--surface); }
  .toprow { display: flex; justify-content: space-between; align-items: center; }
  .forms-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.5rem; }
  .forms-grid form { flex-direction: column; align-items: stretch; }
  .forms-grid input { flex: initial; width: 100%; box-sizing: border-box; margin-bottom: 0.5rem; }
</style>
</head>
<body>
  <div class="card wide">
    <div class="toprow">
      <h1>Janus Admin</h1>
      <form method="POST" action="/_admin/logout">
        <input type="hidden" name="csrf" value="${safeCsrf}">
        <button type="submit">Log out</button>
      </form>
    </div>

    ${errorHtml}

    <h2>Add / update</h2>
    <div class="forms-grid">
      <form method="POST" action="/_admin/alias">
        <input type="hidden" name="csrf" value="${safeCsrf}">
        <input type="hidden" name="action" value="set">
        <input type="text" name="rawKey" placeholder="Raw key (hs://0000...)" required>
        <input type="text" name="alias" placeholder="Alias (e.g. my-app)" required>
        <button type="submit">Set alias</button>
      </form>
      <form method="POST" action="/_admin/password">
        <input type="hidden" name="csrf" value="${safeCsrf}">
        <input type="hidden" name="action" value="set">
        <input type="text" name="rawKey" placeholder="Raw key or leave blank if keyHash given">
        <input type="text" name="keyHash" placeholder="keyHash (optional if rawKey given)">
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Set password</button>
      </form>
    </div>

    <h2>Tunnels &amp; keys</h2>
    <table>
      <thead>
        <tr>
          <th>keyHash</th>
          <th>alias</th>
          <th>status</th>
          <th>password</th>
          <th>port</th>
          <th>health</th>
          <th>inFlight</th>
          <th>lastRequestAt</th>
          <th>actions</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows || '<tr><td colspan="9">No tunnels or stored keys yet.</td></tr>'}
      </tbody>
    </table>

    ${footer(config)}
  </div>
</body>
</html>`
}

module.exports = {
  escapeHtml,
  apexPage,
  impressumPage,
  termsPage,
  errorPage,
  offlinePage,
  rateLimitPage,
  loginPage,
  adminLoginPage,
  adminDashboardPage,
}
