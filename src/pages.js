'use strict'

const { INSTRUMENT_SERIF_WOFF2, GEIST_MONO_WOFF2 } = require('./fonts')

// Phase 1: directoryPage renders the tenant URL from the stored (bare,
// normalized, no-prefix) key -- same "0000<key>.BASE_DOMAIN" composition
// documented throughout this file (see apexPage/guidePage) -- so it needs
// to validate the stored value looks like a real key before using it.
const { parseKey } = require('./key')

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

// The two self-hosted fonts, as data URIs. ~33KB of base64 -- by far the
// bulk of any page that includes them, so which pages DO include them is a
// bandwidth decision, not just a styling one. See LEAN_STYLE below.
const FONT_FACES = `
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
`

// Everything except the @font-face blocks. The --font-display/--font-mono
// custom properties below already declare full fallback stacks ('Instrument
// Serif', ui-serif, Georgia, serif), so a page that ships BASE_STYLE without
// FONT_FACES degrades to the platform serif/mono automatically -- no separate
// stylesheet and no layout change beyond the typeface itself.
const BASE_STYLE = `
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
  /* S7 "fuller fix": destructive-action styling for the dashboard's Delete
     button -- reuses the existing --warn token (already used for the
     "blocked" status badge) rather than introducing a new color, so it
     stays visually consistent with the rest of the theme in both
     light/dark modes. */
  button.danger { background: var(--warn); }
  pre { font-family: var(--font-mono); background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; padding: 0.75rem 1rem; overflow-x: auto; color: var(--text); }
  .code { color: var(--muted); font-size: 0.85rem; margin-top: 1rem; font-variant-numeric: tabular-nums; }
  .warn { color: var(--warn); }
  .tagline { font-family: var(--font-mono); color: var(--muted); font-size: 0.85rem; letter-spacing: 0.02em; margin-top: -0.5rem; margin-bottom: 2rem; }
  footer { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--rule); font-size: 0.8rem; color: var(--muted); font-family: var(--font-mono); }
  footer a { color: var(--muted); text-decoration: underline; text-underline-offset: 0.2em; }
`

// Full style, fonts included -- for pages a real visitor deliberately
// navigates to and looks at for more than a second.
const STYLE = FONT_FACES + BASE_STYLE

// Fonts omitted. Used by every page an ANONYMOUS, UNAUTHENTICATED caller can
// force us to emit in bulk: errorPage (400/404/502/503), offlinePage, and
// rateLimitPage.
//
// This is a bandwidth control, not a styling preference. Every page here
// embeds ~33KB of base64 font, and a 116-byte request to any nonexistent
// subdomain used to return 37,280 bytes -- a 321x egress amplifier reachable
// with no key, no auth, and no valid subdomain. Caddy's gzip does not help:
// the CALLER chooses the encoding, and `Accept-Encoding: identity` gets the
// full uncompressed body. Dropping FONT_FACES takes these responses to
// roughly 4KB.
//
// Do NOT "restore consistency" by putting STYLE back on these three pages.
// The typeface fallback is deliberate; see BASE_STYLE above.
const LEAN_STYLE = BASE_STYLE

// The 429 page is the one response with NO upper bound on how many times a
// single IP can elicit it: every request past RATE_MAX_REQUESTS gets one, at
// whatever rate the client can dial. Every other page is capped at
// RATE_MAX_REQUESTS per window per IP. So this page alone gets a bespoke
// minimal style rather than LEAN_STYLE -- it must stay cheaper than the cost
// of asking for it, or rate limiting increases egress instead of shedding it.
const MINIMAL_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; line-height: 1.6;
    background: light-dark(#f6f1e7, #14120f); color: light-dark(#191612, #efe9dd);
    margin: 0; padding: 3rem 1.5rem; }
  .card { max-width: 40rem; margin: 0 auto; }
  h1 { font-family: ui-serif, Georgia, serif; font-weight: 400; font-size: 2rem; margin: 0 0 1rem; }
  p { color: light-dark(#6c6558, #8b8375); margin: 0 0 0.75rem; }
`

function footer(config) {
  const abuseContact = configuredOrPlaceholder(config.ABUSE_EMAIL, 'ABUSE_EMAIL (or OPERATOR_EMAIL)')
  // Absolute-path links, so they still resolve to the apex from a tenant
  // subdomain's error page -- which is exactly where a visitor staring at a
  // 400 needs the guide most.
  const apex = `https://${escapeHtml(config.BASE_DOMAIN)}`
  return `<footer>
    <a href="${apex}/guide">Guide</a> &middot;
    <a href="/impressum">Impressum</a> &middot; <a href="/terms">Terms of Service</a><br>
    Abuse contact: ${abuseContact}
  </footer>`
}

// Apex landing page: the gateway's own domain (no tenant subdomain) has no
// tunnel to proxy to, so serve a minimal paste-a-key page instead of a dead
// 404.
function apexPage(config) {
  const safeDomain = escapeHtml(config.BASE_DOMAIN)
  // Phase 1: only advertise /directory when the operator has opted the
  // gateway into it -- DIRECTORY_ENABLED is false by default, same
  // rationale as every other opt-in surface in this file.
  const directoryLink = config.DIRECTORY_ENABLED
    ? `<p>Browse the <a href="/directory">project directory</a> &mdash; projects
      whose owners opted in to being listed.</p>`
    : ''
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
    <p>Don't have a key? <a href="/guide">Publish a local app in three
      commands</a> &mdash; or hand <a href="/llms.txt">/llms.txt</a> to an AI
      assistant and let it walk you through it.</p>
    <p>This gateway terminates TLS, so the operator can technically observe
      traffic in transit &mdash; don't route anything through it you
      wouldn't hand to a hosting provider. Details on the <a href="/guide">guide</a>.</p>
    ${directoryLink}
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

// The apex page hands out a key box but never says where a key comes from.
// This is that missing half: how to put a locally-running app behind the
// gateway. Two representations of the same content -- guidePage() for
// humans, llmsTxt() for an AI assistant the visitor is pasting into.
//
// The `--public` flag is the single most important detail on this page.
// `holesail --live <port>` WITHOUT it emits an `s000` secure-mode key,
// which key.js:assertPublic deliberately rejects with a 400. Anyone
// following the bare command lands on an error page with no clue why.
function guidePage(config) {
  const safeDomain = escapeHtml(config.BASE_DOMAIN)
  // Phase 1: only document the directory when the operator has opted the
  // gateway into it -- same gate as apexPage's directoryLink, so the guide
  // never describes a page that 404s.
  const recheckMinutes = Math.max(1, Math.round(config.DIRECTORY_RECHECK_MS / 60000))
  const directorySection = config.DIRECTORY_ENABLED
    ? `
    <h2>Get listed in the directory</h2>
    <p>The <a href="/directory">project directory</a> is opt-in. Nothing
      about your project is listed unless <em>your own backend</em> &mdash;
      the thing behind your tunnel, not this gateway &mdash; serves a
      manifest file:</p>
    <p><code>GET /.well-known/janus-index.json</code></p>
    <pre>{
  "list": true,
  "title": "My project",
  "description": "One line about what it is.",
  "tags": ["demo", "self-hosted"]
}</pre>
    <p>There is no submission form and no account. The gateway fetches that
      URL from your backend itself; serving it back with <code>list: true</code>
      is the entire consent signal.</p>
    <ul>
      <li><code>list</code> must be the literal boolean <code>true</code>.
        Missing, <code>false</code>, the string <code>"true"</code>, and
        <code>1</code> all mean <strong>not listed</strong>.</li>
      <li><code>title</code> is required, 1&ndash;80 characters.</li>
      <li><code>description</code> is optional, up to 200 characters.</li>
      <li><code>tags</code> is optional, up to 8 entries, each up to 24
        characters, lowercase letters/digits/hyphens only &mdash;
        duplicates are dropped and casing is normalized.</li>
      <li>The response must be <code>200</code> with a
        <code>content-type</code> that contains <code>application/json</code>.
        A static file server that serves <code>.json</code> as
        <code>text/plain</code> will silently fail to list &mdash; that's a
        MIME type problem, not a manifest problem, and nothing will tell you
        it happened.</li>
      <li>The manifest is only fetched when someone visits your site through
        this gateway. A project with zero visitors will not appear in the
        directory, even with a correct manifest, until it gets its first
        one.</li>
    </ul>
    <p><strong>Listing publishes your raw key, in the open, permanently.</strong>
      The directory links straight to <code>https://0000&lt;your-key&gt;.${safeDomain}/</code>
      &mdash; the same key that is the bearer credential for your backend.
      There is no separate, revocable directory token. Once listed, assume
      search crawlers and web archives capture it; the only real revocation
      is rotating the key (start a new tunnel, which mints a new one), which
      also changes the URL everyone who found you through the directory was
      using.</p>
    <p>Password-protected keys cannot be listed at all &mdash; adding a
      password de-lists the entry as soon as it's next checked. Edits
      (a new manifest, a changed field, or removing it) take up to about
      ${recheckMinutes} minute${recheckMinutes === 1 ? '' : 's'} to show up,
      since the gateway caches the last check per key rather than fetching
      on every visit &mdash; an edit that looks like it "didn't work" has
      usually just not been rechecked yet.</p>
    <p>To de-list, delete the manifest file or set <code>list: false</code>.
      If your backend simply goes offline without either, the entry stays
      listed with a last-seen time instead of disappearing &mdash;
      liveness is only updated by an actual visit succeeding or failing,
      not by polling.</p>
`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Guide - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Publish a local app</h1>
    <p class="tagline">from localhost to https, in three commands</p>

    <p>Janus turns a <a href="https://holesail.io">Holesail</a> public key into
      a public HTTPS site. Your app keeps running on your own machine; nothing
      is uploaded, and visitors install nothing.</p>

    <h2>1. Run your app</h2>
    <p>Start it however you normally would and note the port. Binding to
      <code>127.0.0.1</code> is fine &mdash; you do <em>not</em> need to expose
      it on <code>0.0.0.0</code>.</p>

    <h2>2. Publish the port</h2>
    <p><code>npx holesail --live 3000 --public</code></p>
    <p><strong>The <code>--public</code> flag is required.</strong> Without it
      Holesail prints an <code>s000</code> private key, which is the
      <em>serve</em> credential &mdash; it lets the holder impersonate your
      backend. This gateway refuses those on purpose, so a key without
      <code>--public</code> gets you a <code>400</code> and nothing else.</p>

    <h2>3. Open the link</h2>
    <p>Holesail prints <code>hs://0000&hellip;</code>. Everything after
      <code>hs://</code> is your subdomain:</p>
    <p><code>https://0000&lt;your-key&gt;.${safeDomain}/</code></p>

    <h2>The key is the password</h2>
    <p>There is no other access control. Anyone holding that URL reaches your
      app exactly as you left it &mdash; and a local dev server usually has no
      login at all, so &ldquo;anyone&rdquo; means full access to whatever it
      can read, write, or spend.</p>
    <ul>
      <li>The key travels in the TLS SNI field, which is <strong>not</strong>
        encrypted, and lands in browser history, bookmarks and
        <code>Referer</code> headers sent to third-party sites.</li>
      <li>Treat the URL as a bearer token. Don't post it anywhere public.</li>
      <li>Stopping the local process revokes it. The key changes on the next
        start unless you pass a fixed seed.</li>
    </ul>

    <h2>Trust model</h2>
    <p>This gateway terminates your visitors' TLS connection and re-serves
      the request over a separate, HyperDHT-encrypted tunnel to your
      backend. That means the operator running this gateway can technically
      observe traffic in transit &mdash; the same trust boundary as any
      hosting provider or reverse proxy you don't run yourself. Don't route
      anything through it you wouldn't hand to one.</p>
    <ul>
      <li>The gateway never logs or stores your raw key &mdash; only a
        SHA-256 hash of it (<code>keyHash</code>), used solely to identify a
        tunnel in logs and the admin dashboard.</li>
      <li>It does not log request bodies or headers.</li>
      <li>Your raw key is persisted to disk only if you (or the operator)
        explicitly set up an alias or a password for it via the admin
        dashboard &mdash; a plain <code>hs://0000&hellip;</code> link is
        never stored anywhere.</li>
      <li>The tunnel between the gateway and your backend is encrypted by
        HyperDHT; it's the leg between the gateway and your visitor's
        browser (i.e. the TLS termination above) that is the trust
        boundary.</li>
    </ul>

    <h2>When something breaks</h2>
    <ul>
      <li><code>400</code> &mdash; the key is malformed, or it's an
        <code>s000</code> secure key. Re-run step 2 with <code>--public</code>.</li>
      <li><code>502</code> &mdash; the gateway found your key on the DHT but
        your app didn't answer. Check the local process is still up and that
        you published the right port.</li>
      <li><code>503</code> &mdash; the gateway is at tunnel capacity, or it has
        recently failed to reach this backend and is backing off. Retry.</li>
      <li><code>429</code> &mdash; you're being rate limited. Slow down.</li>
      <li><strong>Nothing happens at all</strong> &mdash; holepunching needs
        outbound UDP. Symmetric NAT and CGNAT (common on mobile carriers, some
        ISPs, and locked-down office networks) can block it. This is a network
        condition, not a fault in your app; try another connection.</li>
    </ul>

    <h2>Framework notes</h2>
    <ul>
      <li>Requests arrive with <code>Host: 0000&lt;key&gt;.${safeDomain}</code>.
        Dev servers that allowlist hostnames will reject that until you add it
        &mdash; <code>server.allowedHosts</code> in Vite,
        <code>allowedHosts</code> in webpack-dev-server,
        <code>ALLOWED_HOSTS</code> in Django.</li>
      <li><code>X-Forwarded-Proto</code> arrives as <code>https,http</code>,
        because two proxies each append a value. Read the <em>leftmost</em>
        entry; an exact comparison against <code>"https"</code> will fail and
        can send a framework into a redirect loop.</li>
      <li>WebSockets work. Connect to <code>wss://</code> on the same
        hostname.</li>
    </ul>

    ${directorySection}
    <p>Machine-readable version for an AI assistant:
      <a href="/llms.txt">/llms.txt</a></p>

    ${footer(config)}
  </div>
</body>
</html>`
}

// Same content as guidePage(), as plain text, for pasting into an AI
// assistant. Served as text/plain, so no escaping applies -- BASE_DOMAIN is
// operator config rather than request-derived, and nothing else here is
// dynamic.
function llmsTxt(config) {
  const recheckMinutes = Math.max(1, Math.round(config.DIRECTORY_RECHECK_MS / 60000))
  const directorySection = config.DIRECTORY_ENABLED
    ? `
## Directory (opt-in)

There is a project directory at https://${config.BASE_DOMAIN}/directory. It
is opt-in and there is no submission form or account. A project is listed
only if ITS OWN backend (the thing behind the tunnel, not the gateway)
serves a manifest at:

    GET /.well-known/janus-index.json

Example manifest body:

    {
      "list": true,
      "title": "My project",
      "description": "One line about what it is.",
      "tags": ["demo", "self-hosted"]
    }

Rules:
- "list" must be the literal JSON boolean true. Missing, false, the string
  "true", and 1 all mean NOT listed. This is strict on purpose.
- "title" is required, 1-80 characters.
- "description" is optional, up to 200 characters.
- "tags" is optional, up to 8 entries, each up to 24 characters, lowercase
  letters/digits/hyphens only; duplicates are dropped and casing is
  normalized.
- The HTTP response must be 200 with a content-type that CONTAINS
  "application/json". A static file server that serves .json as text/plain
  will silently fail to list -- check the response header, not just the
  file contents.
- The manifest is only fetched when someone visits the site through the
  gateway. A project with zero visitors will not appear in the directory,
  even with a correct manifest, until it gets its first one.

Consequence, stated plainly: listing publishes the raw key. The directory
links straight to the tenant URL, which contains the same key that is the
bearer credential for that backend -- there is no separate, revocable
directory token. Once listed, assume it is permanently public and that
crawlers and web archives capture it. The only real revocation is rotating
the key (starting a new tunnel mints a new one), which also changes the URL.

Password-protected keys cannot be listed; adding a password de-lists the
entry as soon as it is next checked. Edits (new manifest, changed field, or
removal) take up to about ${recheckMinutes} minute${recheckMinutes === 1 ? '' : 's'} to show up -- the gateway
caches the last check per key rather than fetching on every visit. To
de-list, delete the manifest file or set "list": false. If the backend goes
offline without either, the entry stays listed with a last-seen time instead
of disappearing.
`
    : ''
  return `# Janus

Janus publishes an app running on your own machine as a public HTTPS site.
It does this by encoding a Holesail P2P public key into a subdomain, so
routing needs no database and no account. The app is never uploaded; the
gateway holds a peer-to-peer tunnel to your machine for as long as your
process is running.

Base domain: ${config.BASE_DOMAIN}
URL shape:   https://0000<52-char-key>.${config.BASE_DOMAIN}/

## Quickstart

1. Start the app locally and note its port. Binding to 127.0.0.1 is fine;
   binding to 0.0.0.0 is NOT required.
2. Publish that port:
       npx holesail --live <port> --public
3. Copy the printed key. It looks like: hs://0000<52 chars>
4. Open https://0000<52 chars>.${config.BASE_DOMAIN}/ -- everything after
   "hs://" is the subdomain, the "0000" prefix included.

## The --public flag is mandatory

"holesail --live <port>" without --public prints an s000-prefixed key. That
is the SECURE-mode key: it is the serve credential and lets whoever holds it
impersonate the backend. This gateway rejects s000 keys by design and answers
400. If you got a 400, this is almost certainly why.

## Security model

The key is the only credential. Anyone with the URL reaches the app with
whatever privileges it already grants, and a local development server
typically has no authentication at all.

- The key is visible in the TLS SNI field, which is sent unencrypted.
- It is retained in browser history and sent in Referer headers to
  third-party origins the page links to or loads from.
- Treat the URL as a bearer token; do not publish it.
- Killing the local process revokes access. Restarting mints a new key
  unless a fixed seed is supplied.

## Trust model

The gateway terminates the visitor's TLS connection and re-serves the
request over a separate HyperDHT-encrypted tunnel to the backend, so the
operator running the gateway can technically observe traffic in transit --
treat it like any hosting provider or reverse proxy you don't run yourself.
The gateway does not log raw keys (only a SHA-256 keyHash), request bodies,
or headers; a raw key is persisted only if you set up an alias or password
for it.

## Status codes

400  Key malformed, or an s000 secure key. Re-run with --public.
502  Key resolved on the DHT, but the backend did not answer. The local
     process is probably stopped, or a different port was published.
503  Gateway at tunnel capacity, or backing off after repeated failures to
     reach this backend. Retry.
429  Rate limited.
404  Unknown host -- the subdomain is not a well-formed key for this domain.

If nothing resolves at all, holepunching is failing. It needs outbound UDP,
and symmetric NAT or CGNAT (mobile carriers, some ISPs, restrictive office
networks) can prevent it. That is a network condition, not an application
bug. Retry from a different network.

${directorySection}
## Notes for frameworks

- The Host header is 0000<key>.${config.BASE_DOMAIN}. Dev servers that
  allowlist hostnames must be told about it: server.allowedHosts (Vite),
  allowedHosts (webpack-dev-server), ALLOWED_HOSTS (Django).
- X-Forwarded-Proto arrives as "https,http" because two proxies each append
  a value. Parse the leftmost entry. An exact match against "https" fails
  and can cause an HTTPS-redirect loop.
- X-Forwarded-For is a list; the client is the leftmost entry.
- WebSockets are proxied. Use wss:// on the same hostname.
`
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

// Phase 1: relative "last seen" string for a directory entry's timestamp.
// Deliberately coarse (minutes/hours/days) -- an exact timestamp is not
// useful to a browsing visitor and would just be more precision than the
// underlying liveness signal (a periodic manifest recheck) actually has.
function relativeTime(ms) {
  if (!Number.isFinite(ms)) return 'unknown'
  const deltaMs = Date.now() - ms
  if (deltaMs < 0) return 'just now'
  const mins = Math.floor(deltaMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Phase 1: opt-in project directory. `entries` is the already-sanitized,
// sorted, eligibility-filtered output of src/directory.js's Directory#list()
// -- this function does not re-filter, but it DOES escape every field, since
// title/description/tags all originate from an arbitrary tenant backend's
// manifest, not from the operator.
function directoryPage({ entries, q, config }) {
  const safeQ = escapeHtml(q || '')
  const safeDomain = escapeHtml(config.BASE_DOMAIN)

  const rows = (entries || []).map((entry) => {
    // Defense in depth: directory.js only ever stores an already-normalized
    // key (record.client.seed, see its doc comment), but re-validate here
    // before building an href out of it -- an href is exactly the kind of
    // sink where a malformed value could do the most damage, and this is
    // the one page rendering entirely attacker-supplied backend data.
    let href = null
    try {
      const parsed = parseKey(entry.rawKey)
      href = `https://0000${parsed.key}.${config.BASE_DOMAIN}/`
    } catch {
      return '' // unrenderable entry -- skip it rather than emit a broken link
    }
    const safeHref = escapeHtml(href)
    const safeTitle = escapeHtml(entry.title)
    const descHtml = entry.description
      ? `<p>${escapeHtml(entry.description)}</p>`
      : ''
    const tagsHtml = (entry.tags && entry.tags.length)
      ? `<p class="code">${entry.tags.map((t) => `#${escapeHtml(t)}`).join(' ')}</p>`
      : ''
    const offlineBadge = entry.online ? '' : ' <span class="warn">(offline)</span>'
    const lastSeen = `<p class="code">Last seen: ${escapeHtml(relativeTime(entry.lastSeenAt))}</p>`

    return `<li style="margin-bottom: 1.5rem; list-style: none;">
      <h2 style="margin-bottom: 0.25rem;"><a href="${safeHref}">${safeTitle}</a>${offlineBadge}</h2>
      ${descHtml}
      ${tagsHtml}
      ${lastSeen}
    </li>`
  }).join('\n')

  const emptyState = q
    ? `<p>No listed projects match &ldquo;${escapeHtml(q)}&rdquo;.</p>`
    : `<p>No projects are listed yet. Projects opt in by serving a manifest
      from their own backend &mdash; see <a href="/guide">the guide</a>.</p>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Directory - Janus</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Directory</h1>
    <p class="tagline">projects on ${safeDomain} whose owners opted in to being listed</p>
    <p class="code">Want your project listed? See <a href="/guide">the guide</a>.</p>
    <form method="GET" action="/directory">
      <input type="text" name="q" placeholder="Search title, description, tags" value="${safeQ}">
      <button type="submit">Search</button>
    </form>
    <ul style="padding-left: 0; margin-top: 1.5rem;">
      ${rows || ''}
    </ul>
    ${rows ? '' : emptyState}
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
<style>${LEAN_STYLE}</style>
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

// Milestone 2d (revised): served in place of the generic errorPage(502, ...)
// whenever the proxy errors out against a KNOWN tenant tunnel (i.e.
// `req._janusTunnel` is present) -- see server.js's proxy.on('error', ...)
// handler. The earlier `healthy === false` gate was deliberately removed: a
// health-probe failure streak now destroys the tunnel outright
// (tunnel-manager.js's _probeOne/destroyTunnel), so `healthy` would almost
// never still be observed false by the time a real request reaches this
// handler -- gating on it would have made this page effectively dead code.
// A proxy error against a known tunnel IS the backend being unreachable,
// which is exactly what this page exists to say. Friendly and honest: the
// backend is offline/unreachable, this is not the visitor's fault, and
// there is nothing for them to log into or retry differently.
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
<style>${LEAN_STYLE}</style>
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
<style>${MINIMAL_STYLE}</style>
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

    // S7 "fuller fix": only offer Delete where there's actually stored data
    // to delete (alias, password, or a block) -- a purely-live row with no
    // stored metadata has nothing for store.deleteKey to remove, and the
    // existing Kill control already covers that case. The confirm() guard
    // matches the destructive nature of the action (drops rawKey/alias/
    // password; a blocked key stays blocked -- see store.js#deleteKey);
    // these pages emit no Content-Security-Policy, so the inline onsubmit
    // handler is safe to use.
    const deleteForm = (row.alias || row.hasPassword || row.blocked)
      ? `<form method="POST" action="/_admin/delete" style="display:inline-flex" onsubmit="return confirm('Delete this key\\'s stored data (alias, password, raw key)? A blocked key stays blocked.')">
      <input type="hidden" name="csrf" value="${safeCsrf}">
      <input type="hidden" name="keyHash" value="${safeKeyHash}">
      <button type="submit" class="danger">Delete</button>
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
      <td style="display:flex; gap:0.5rem; flex-wrap:wrap">${blockForm}${clearAliasForm}${clearPasswordForm}${deleteForm}</td>
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
  guidePage,
  llmsTxt,
  impressumPage,
  termsPage,
  errorPage,
  offlinePage,
  rateLimitPage,
  loginPage,
  adminLoginPage,
  adminDashboardPage,
  directoryPage,
}
