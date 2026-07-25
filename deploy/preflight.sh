#!/usr/bin/env bash
#
# Janus deploy preflight -- READ-ONLY environment checks for the target VPS.
# Mutates nothing: no packages installed, no DNS records created, no files
# written. Safe to re-run at any point.
#
# WHY: the two ways this deploy fails are environmental, not code, and both
# are miserable to diagnose late:
#   1. The provider filters outbound UDP, so HyperDHT holepunching never
#      works -- while the apex page looks perfectly healthy. You would spend
#      the afternoon debugging the gateway instead of the network.
#   2. Porkbun gates API access PER DOMAIN and ships it OFF by default, so
#      every DNS-01 challenge fails with an error that looks nothing like a
#      permissions problem. You would spend it debugging Caddy.
# Both are checked here, before anything is installed.
#
# Usage (on the VPS):
#   deploy/preflight.sh
#   BASE_DOMAIN=janus.ssani.dev deploy/preflight.sh
#
# To include the Porkbun checks, export credentials first -- with a LEADING
# SPACE so they stay out of shell history:
#    export PB_KEY='pk1_...'
#    export PB_SECRET='sk1_...'
#
# Exit code is 0 if nothing FAILED (warnings and skips are tolerated), 1
# otherwise. Never prints the credentials it is given.

# Deliberately NOT `set -e`: every check must run so you get the full picture
# in one pass, rather than fixing them one restart at a time.
set -uo pipefail

BASE_DOMAIN="${BASE_DOMAIN:-janus.ssani.dev}"
PB_KEY="${PB_KEY:-}"
PB_SECRET="${PB_SECRET:-}"

pass=0; warn=0; fail=0; skip=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$*"; pass=$((pass+1)); }
no()   { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; fail=$((fail+1)); }
wa()   { printf '  \033[33mWARN\033[0m  %s\n' "$*"; warn=$((warn+1)); }
sk()   { printf '  \033[90mSKIP\033[0m  %s\n' "$*"; skip=$((skip+1)); }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

hdr "Host"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  printf '  %s (%s)\n' "${PRETTY_NAME:-unknown}" "$(uname -m)"
else
  wa "no /etc/os-release -- cannot identify distro"
fi
mem_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
printf '  RAM: %sMB\n' "$mem_mb"
if [ "$mem_mb" -lt 900 ] 2>/dev/null; then
  wa "under ~1GB RAM -- lower MemoryMax/MemoryHigh in deploy/janus.service to suit"
else
  ok "RAM is adequate for the shipped MemoryMax=768M"
fi
# Global-scope, which on a VPS is the public address but on a NATed box is a
# private one -- labelled honestly rather than asserted to be public.
printf '  IPv4 (global scope): %s\n' "$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2; exit}')"
printf '  IPv6 (global scope): %s\n' "$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/{print $2; exit}')"

hdr "Runtime"
if command -v node >/dev/null 2>&1; then
  nv=$(node -v)
  maj=$(printf '%s' "$nv" | sed 's/^v//; s/\..*//')
  if [ "$maj" -ge 20 ] 2>/dev/null; then
    ok "node $nv (>= 20 required)"
  else
    no "node $nv is too old -- package.json requires >= 20; see DEPLOY.md 'The gateway service'"
  fi
else
  no "node not installed -- see DEPLOY.md 'The gateway service' (Ubuntu apt node is too old; use NodeSource)"
fi
command -v caddy >/dev/null 2>&1 \
  && ok "caddy present ($(caddy version 2>/dev/null | head -1))" \
  || wa "caddy not installed yet -- and stock builds lack DNS plugins; see DEPLOY.md 'Caddy in front'"

hdr "Outbound UDP (HyperDHT holepunching)"
# A STUN binding request on an arbitrary high port. Proves arbitrary outbound
# UDP leaves the box AND that replies get back -- which is what the DHT needs.
# NOT proof that holepunching works end to end; only the two-machine field
# test settles that. But a failure here is fatal and worth knowing now.
if command -v node >/dev/null 2>&1; then
  udp_result=$(node -e '
const dgram = require("node:dgram");
const crypto = require("node:crypto");
const sock = dgram.createSocket("udp4");
const msg = Buffer.alloc(20);
msg.writeUInt16BE(0x0001, 0);                 // Binding Request
msg.writeUInt16BE(0, 2);                      // length
msg.writeUInt32BE(0x2112A442, 4);             // magic cookie
crypto.randomBytes(12).copy(msg, 8);          // transaction id
const timer = setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 6000);
sock.on("message", (m) => {
  clearTimeout(timer);
  console.log(m.length >= 20 && m.readUInt16BE(0) === 0x0101 ? "OK" : "BADRESPONSE");
  process.exit(0);
});
sock.on("error", (e) => { clearTimeout(timer); console.log("ERROR " + e.message); process.exit(1); });
sock.send(msg, 19302, "stun.l.google.com");
' 2>&1)
  case "$udp_result" in
    OK) ok "STUN binding succeeded -- arbitrary outbound UDP works" ;;
    TIMEOUT) no "STUN timed out -- outbound UDP looks FILTERED. Holepunching will not work; check with your provider before going further" ;;
    *) no "STUN check failed: $udp_result" ;;
  esac
else
  sk "needs node (or: apt install stun-client && stunclient stun.l.google.com 19302)"
fi

hdr "DNS for $BASE_DOMAIN"
# Resolved via node rather than dig: node is already a hard requirement, and
# dnsutils is NOT preinstalled on a stock Ubuntu server -- so this works on a
# fresh box with nothing added. The wildcard is probed with a name that
# provably has no record of its own, so a hit can only come from *.<domain>.
if command -v node >/dev/null 2>&1; then
  dns_out=$(BASE_DOMAIN="$BASE_DOMAIN" node -e '
const dns = require("node:dns").promises;
const base = process.env.BASE_DOMAIN;
const look = async (n) => { try { return (await dns.resolve4(n))[0] || ""; } catch { return ""; } };
(async () => {
  const [apex, wild] = await Promise.all([look(base), look("probe-preflight." + base)]);
  console.log(apex + "|" + wild);
})();
' 2>/dev/null)
  apex="${dns_out%%|*}"; wild="${dns_out##*|}"
  [ -n "$apex" ] && ok "apex A -> $apex" || no "apex A record missing -- see DEPLOY.md 'DNS (Porkbun)'"
  [ -n "$wild" ] && ok "wildcard resolves -> $wild (via *.$BASE_DOMAIN)" || no "wildcard *.$BASE_DOMAIN missing -- every tenant URL depends on it"
  if [ -n "$apex" ] && [ -n "$wild" ] && [ "$apex" != "$wild" ]; then
    wa "apex and wildcard resolve to DIFFERENT addresses -- intended?"
  fi
else
  sk "needs node (or: apt install dnsutils && dig +short A $BASE_DOMAIN)"
fi

hdr "Porkbun API"
if [ -z "$PB_KEY" ] || [ -z "$PB_SECRET" ]; then
  sk "PB_KEY / PB_SECRET not exported -- see this script's header"
elif ! command -v curl >/dev/null 2>&1; then
  sk "curl not installed"
else
  body=$(printf '{"apikey":"%s","secretapikey":"%s"}' "$PB_KEY" "$PB_SECRET")
  ping_st=$(curl -sS -m 20 -X POST https://api.porkbun.com/api/json/v3/ping \
    -H 'Content-Type: application/json' -d "$body" 2>/dev/null \
    | grep -o '"status":"[A-Z]*"' | head -1)
  case "$ping_st" in
    *SUCCESS*) ok "credentials valid" ;;
    *) no "credential check failed (${ping_st:-no response}) -- regenerate under Account -> API Access" ;;
  esac

  zone="${BASE_DOMAIN#*.}"   # janus.ssani.dev -> ssani.dev
  dom_st=$(curl -sS -m 20 -X POST "https://api.porkbun.com/api/json/v3/dns/retrieve/$zone" \
    -H 'Content-Type: application/json' -d "$body" 2>/dev/null \
    | grep -o '"status":"[A-Z]*"' | head -1)
  case "$dom_st" in
    *SUCCESS*) ok "API access is enabled for $zone" ;;
    *) no "$zone is NOT API-enabled (${dom_st:-no response}) -- Porkbun panel -> $zone -> Details -> turn ON 'API ACCESS'. THIS is the failure that later looks like a broken Caddy config" ;;
  esac
  unset body
fi

hdr "Ports"
for p in 80 443; do
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    wa "port $p already in use -- Caddy will fail to bind (another web server running?)"
  else
    ok "port $p free"
  fi
done

printf '\n\033[1mSummary:\033[0m %d passed, %d warned, %d failed, %d skipped\n' "$pass" "$warn" "$fail" "$skip"
if [ "$fail" -gt 0 ]; then
  printf 'Resolve the FAIL items before continuing -- each one blocks the deploy.\n'
  exit 1
fi
printf 'No blocking failures. Continue with DEPLOY.md.\n'
