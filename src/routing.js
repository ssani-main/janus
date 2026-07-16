'use strict'

// Pure host classification for Phase 1 host-based multi-tenant routing.
// Does NOT validate the extracted key -- that's key.js's job downstream.
// This only decides: is the request for the apex, a tenant subdomain, or an
// unrelated host we don't serve?

/**
 * @param {string | undefined} hostHeader raw `Host` request header value
 * @param {string} baseDomain the gateway's own domain (already lowercased)
 * @returns {{ apex: true } | { rawKey: string } | { invalid: true }}
 */
function hostToKey(hostHeader, baseDomain) {
  const host = String(hostHeader || '')
    .toLowerCase()
    .replace(/:\d+$/, '') // strip trailing :port

  if (host === '' || host === baseDomain || host === `www.${baseDomain}`) {
    return { apex: true }
  }

  const suffix = `.${baseDomain}`
  if (host.endsWith(suffix)) {
    const rawKey = host.split('.')[0]
    return { rawKey }
  }

  return { invalid: true }
}

module.exports = { hostToKey }
