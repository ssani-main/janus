# Public Suffix List submission runbook

Submit `janus.ssani.dev` to the Public Suffix List (PSL), making each tenant subdomain (`0000<key>.janus.ssani.dev`) a separate site boundary in browsers. This is a **long lead-time task** — filing takes ~1 hour, but the change must ship in a browser release before it takes effect. Start early.

---

## Quick checklist

- [ ] **You must do: Fork and edit `publicsuffix/list` repo**
- [ ] **You must do: Add `_psl` DNS TXT record to Porkbun** (step 4 below)
- [ ] ~~Automated~~ Submit the PR (step 3) with both the domain line and a comment block (step 2)
- [ ] ~~Automated~~ Track landing on `publicsuffix.org` (step 5)
- [ ] Periodically watch browser rollout via Chrome/Firefox/Safari release notes

---

## Why this matters (concrete consequences)

Without a PSL entry, every tenant is a subdomain of one registrable domain. Browsers therefore treat them as **SAME SITE** — not the same origin, but the same registrable domain under `SameSite` cookie policy (RFC 6265 scopes SameSite to eTLD+1, not to origin).

Because Janus wildcards at `*.janus.ssani.dev`, the admin apex (`https://janus.ssani.dev`) and every tenant (`https://0000<key>.janus.ssani.dev`) are the same site. Tenants are untrusted by design (anyone can run one and share a key), so each can serve attacker-controlled HTML.

**Reachable attacks:**

1. **Cookie-bombing → cross-tenant DoS.** A tenant writes many large cookies on the parent domain:
   ```js
   document.cookie = 'x=xxx; domain=.janus.ssani.dev; path=/; max-age=999999'  // x100
   ```
   Every sibling tenant and the apex then send those cookies on every request and get rejected with HTTP 413 (request header too large). One tenant can deny service to all others.

2. **Admin cookie clobbering → operator lockout.** A tenant can overwrite `janus_admin` on the parent domain:
   ```js
   document.cookie = 'janus_admin=pwned; domain=.janus.ssani.dev; path=/_admin; SameSite=Strict'
   ```
   `parseCookies` is last-write-wins, and browsers don't guarantee host-only cookies are sent before domain cookies. The operator can be forced out of the dashboard. **Not privilege escalation** — the session HMAC still fails, and the cookie is `HttpOnly` + `SameSite=Strict` + `Path=/_admin`, so it can be neither read nor forged — but it is a lockout.

The PSL fix is exactly what its private section exists for. Once listed, browsers enforce site boundaries and refuse to set cookies on the parent domain from subdomains.

---

## Latency expectations

Filing the PR takes ~1 hour of active work. **Rollout takes weeks to months** because the change must be included in a browser release:

- Chrome/Chromium: quarterly, ~4-week lead time before public release
- Firefox: 4-week cycle, or faster ESR
- Safari: typically 2–3 month seasonal releases

The PSL itself is updated more frequently (daily-ish), but browsers ship with a cached copy and only refresh on release. That is why filing early is the entire point — you want the change in the list as soon as possible, sitting dormant until the next browser ships.

---

## Exact steps

### 1. Fork the repository

Go to `https://github.com/publicsuffix/list` and fork it to your personal GitHub account (not `ssani-main` — the fork must be under your own name, since *you* are the submitter and contact person for this domain).

```sh
git clone https://github.com/<YOUR_GITHUB_USERNAME>/list.git
cd list
git remote add upstream https://github.com/publicsuffix/list.git
git checkout -b add-janus-ssani-dev
```

### 2. Add the domain to the PRIVATE DOMAINS section

Open `public_suffix_list.dat` in your text editor. Find the **PRIVATE DOMAINS** section (search for `BEGIN PRIVATE DOMAINS`). This section starts around line 18580 (as of mid-2026) but check the file itself — it grows.

Locate the correct alphabetical position. You are adding `janus.ssani.dev` under the `.dev` entries. Look for existing entries in that region; the file is sorted alphabetically.

Add this **exact** block (note the two-slash comment line above the domain):

```
// Janus : https://janus.ssani.dev
// Submitted by <your name> <ssani.main@gmail.com>
janus.ssani.dev
```

Explanation of the format:
- `// Janus : URL` — the comment format the list requires. `Janus` is the project name; the URL is a link to the gateway landing page.
- `// Submitted by <name> <email>` — required contact info. Use your own name and the operator email. The file's maintainers will contact you if there are questions.
- `janus.ssani.dev` — the domain itself, no wildcards.

Do not include `*` or any other variation — the PSL processes the literal domain, not a pattern.

### 3. Open a pull request

Push your branch:

```sh
git add public_suffix_list.dat
git commit -m "Add janus.ssani.dev to the private domains section"
git push origin add-janus-ssani-dev
```

Then open a PR against `publicsuffix/list`'s `main` branch. **Do not open it until you have completed step 4** (the `_psl` DNS record must exist before they review).

**Suggested PR title:**
```
Add janus.ssani.dev to private domains
```

**Suggested PR body:**
```
Janus is a P2P gateway that converts a Holesail key into a public HTTPS URL. Each tenant shares a subdomain of `janus.ssani.dev` (e.g., `0000<key>.janus.ssani.dev`), so browsers must treat them as separate sites, not siblings under the same registrable domain.

Without a PSL entry, browser SameSite cookie policy treats all subdomains as the same site (eTLD+1 scope). Untrusted tenants can then:
1. Cookie-bomb the parent domain, causing cross-tenant DoS to all other tenants
2. Overwrite the admin session cookie, locking the operator out of the dashboard

The PSL entry restores site boundaries: browsers then refuse to set cookies on the parent domain from subdomains.

A `_psl` DNS TXT record confirming domain ownership is included in the PR verification.
```

**Take note of the PR number** (e.g., `12345`). You will need it in step 4.

### 4. Add the `_psl` verification DNS record at Porkbun

The PSL maintainers require a DNS TXT record to confirm you control the domain. They will not merge without it.

Go to the Porkbun DNS panel for `ssani.dev`:
- Account → Domains → `ssani.dev` → Manage DNS

Add a new TXT record:

| Name | Type | Value |
|---|---|---|
| `_psl.janus.ssani.dev` | TXT | `https://github.com/publicsuffix/list/pull/<PR-NUMBER>` |

Example (if your PR number is 12345):
```
_psl.janus.ssani.dev  TXT  "https://github.com/publicsuffix/list/pull/12345"
```

**The DNS record must exist before maintainers review the PR.** They typically check within hours of a PR opening. If your record isn't live yet, the check will fail.

DNS propagation can take a few minutes (rarely up to 15 mins in practice). The PSL's verification bot will attempt a lookup; if it fails, the PR comment will say so. Re-run the check if needed by asking in the PR comments: the bot will re-verify on request.

---

## How to verify it landed

### On the PSL itself

Once the PR merges, the change appears in the public list within hours (the list is regenerated daily):

```sh
# Check if it's live
curl -s https://publicsuffix.org/list/public_suffix_list.dat | grep janus.ssani.dev
```

Also check: `https://publicsuffix.org/list/` and search for `janus.ssani.dev`.

### In browsers

The PSL ships with each browser release. You cannot force an earlier rollout, but you can track it:

- **Chrome/Chromium:** Check `chrome://net-internals/#preload_hsts` once it's released. Look for `janus.ssani.dev` in the public suffix list (separate tab).
- **Firefox:** No built-in UI for checking the compiled PSL. The practical test below is the reliable way to verify.
- **Safari:** Shipped with OS updates; no easy way to check. Check Safari release notes once it reaches an OS version you use.

From the operator's perspective, you will know it worked when a test tenant can no longer set cookies on the parent domain. A simple test:

1. Create a test backend that serves:
   ```html
   <script>
   document.cookie = 'test=1; domain=.janus.ssani.dev; path=/; max-age=999999';
   console.log(document.cookie);  // should NOT include 'test' once PSL is live
   </script>
   ```
2. Visit it through the gateway in a new browser (fresh cookie jar).
3. Before PSL landing: you will see `test=1` in the console (cookie set).
4. After PSL landing (next browser release): cookie will be rejected (domain cookie not allowed).

---

## What to do in the meantime (weeks to months)

Until the PSL change ships in browsers, treat the apex admin dashboard as **reachable but spammable by any tenant**. The server-side `cookieDomainRewrite: ''` (see `src/server.js`) already strips `Domain=` from *backend* response headers, closing half the attack surface. It cannot touch cookies a tenant's own JavaScript sets.

**Recommended practices for operator work during the rollout window:**

- Use the **bearer-token JSON API** (`Authorization: Bearer $ADMIN_TOKEN`) for important operations — block, unblock, kill, delete. The bearer path does not depend on a cookie a tenant can clobber.
- Avoid using the cookie-authenticated dashboard for critical work when adversarial tenants are present.
- If you must use the dashboard, do so in a private/incognito window and clear all site data after, to minimize the window a clobbered cookie could exist.

The easiest path is the CLI in `bin/janus.js`. Set `ADMIN_TOKEN` and `JANUS_URL` (optional, defaults to `http://127.0.0.1:3000`), then:

```bash
# List all keys
janus ls

# Block a key (tears down its tunnel)
janus block <keyHash>

# Unblock a key
janus unblock <keyHash>

# Kill a key's tunnel (temporary, restart-recoverable; does not affect stored metadata)
janus kill <keyHash>

# Delete a key's stored record
janus rm <keyHash>
```

If using curl directly, call the JSON API with `Authorization: Bearer` headers:

```bash
# Block a key
curl -X POST https://janus.ssani.dev/_admin/api/block \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"block","keyHash":"<KEYHASH>"}'

# Unblock a key
curl -X POST https://janus.ssani.dev/_admin/api/block \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"unblock","keyHash":"<KEYHASH>"}'

# Kill a key's tunnel (query string, not JSON body)
curl -X POST "https://janus.ssani.dev/_admin/kill?keyHash=<KEYHASH>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Delete a key's record
curl -X DELETE "https://janus.ssani.dev/_admin/api/keys/<KEYHASH>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## References

- **Public Suffix List:** `https://publicsuffix.org/`
- **GitHub repository:** `https://github.com/publicsuffix/list`
- **Contributing guide:** `https://github.com/publicsuffix/list/blob/main/CONTRIBUTING.md`
- **Janus ROADMAP:** see the "Public Suffix List submission" section for technical justification
- **Janus DEPLOY.md:** see section 3 for admin dashboard security notes
