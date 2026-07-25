#!/usr/bin/env bash
#
# Back up Janus's persistent store (STORE_PATH, default ./janus-data.json).
#
# WHY THIS EXISTS: the store is the ONLY copy of every named alias, per-key
# password hash, blocklist entry -- and the raw Holesail keys for aliased
# entries. Routing raw-key URLs is stateless and survives anything, but lose
# this file and every alias mapping is gone with no way to reconstruct it.
#
# WHAT IT IS NOT: this is a local-disk snapshot with rotation. A backup that
# only ever lands on the same disk as the original does not survive the
# failure it exists for. Ship BACKUP_DIR offsite (restic/rclone/borg to
# object storage) on whatever schedule you can tolerate losing.
#
# Usage:
#   deploy/backup-store.sh                    # uses the defaults below
#   STORE_PATH=/opt/janus/janus-data.json \
#     BACKUP_DIR=/var/backups/janus \
#     JANUS_BACKUP_GPG_RECIPIENT=ops@example.com \
#     deploy/backup-store.sh
#
# Suggested cron (as the `holesail` user, nightly at 03:17):
#   17 3 * * * /opt/janus/deploy/backup-store.sh >> /var/log/janus-backup.log 2>&1

set -euo pipefail

STORE_PATH="${STORE_PATH:-/opt/janus/janus-data.json}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/janus}"
KEEP="${JANUS_BACKUP_KEEP:-14}"
RECIPIENT="${JANUS_BACKUP_GPG_RECIPIENT:-}"

log() { printf '%s janus-backup: %s\n' "$(date -Is)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

[ -f "$STORE_PATH" ] || die "store not found at $STORE_PATH (set STORE_PATH)"

# The store holds plaintext raw keys -- a key IS the bearer credential for its
# backend, so an unencrypted backup is a second copy of every credential in a
# place that is easy to forget about. Refuse to fail silently about it.
if [ -z "$RECIPIENT" ]; then
  log "WARNING: JANUS_BACKUP_GPG_RECIPIENT is unset -- writing a PLAINTEXT backup"
  log "WARNING: it contains raw Holesail keys; set a GPG recipient or keep BACKUP_DIR on encrypted storage"
fi

umask 0077
mkdir -p "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/janus-data-$STAMP.json"

# Copy first, verify second. The gateway writes this file via atomic rename
# (see src/store.js), so a plain cp can never observe a half-written file --
# but it CAN observe a version that is one write behind, which is fine, and a
# corrupt-on-disk file, which is not. Parse before keeping it: a backup that
# isn't valid JSON is not a backup.
cp -p "$STORE_PATH" "$DEST"
if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$DEST" 2>/dev/null; then
  rm -f "$DEST"
  die "$STORE_PATH did not parse as JSON -- refusing to keep a corrupt backup"
fi

if [ -n "$RECIPIENT" ]; then
  gpg --batch --yes --trust-model always --encrypt --recipient "$RECIPIENT" --output "$DEST.gpg" "$DEST" \
    || die "gpg encryption failed for $DEST"
  rm -f "$DEST"
  DEST="$DEST.gpg"
fi

chmod 600 "$DEST"
log "wrote $DEST ($(wc -c < "$DEST") bytes)"

# Rotate: keep the newest $KEEP, drop the rest. Uses the sortable UTC stamp in
# the filename rather than mtime, so a restored/touched file can't reorder it.
mapfile -t OLD < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'janus-data-*.json*' -printf '%f\n' \
  | sort -r | tail -n +"$((KEEP + 1))")
for f in "${OLD[@]:-}"; do
  [ -n "$f" ] || continue
  rm -f -- "$BACKUP_DIR/$f"
  log "rotated out $f"
done

log "done; $(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'janus-data-*.json*' | wc -l) backup(s) retained"
