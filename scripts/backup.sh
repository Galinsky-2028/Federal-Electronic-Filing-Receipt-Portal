#!/bin/sh
# Logical backup of the demo database (UFR-058). Usage: DATABASE_URL=... scripts/backup.sh [out-dir]
# Produces a pg_dump custom-format archive plus a manifest with its SHA-256 and the ledger head at backup time.
# NOTE: backups contain wrapped data keys; a disposition (crypto-shred) is only final once older backups expire.
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
out="${1:-backups}"; mkdir -p "$out"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"; file="$out/portal-$stamp.dump"
pg_dump --format=custom --no-owner --no-privileges --file="$file" "$DATABASE_URL"
head="$(psql "$DATABASE_URL" -At -c 'SELECT seq || '\'' '\'' || entry_hash FROM ledger_head WHERE id = 1')"
sha="$(sha256sum "$file" | cut -d' ' -f1)"
printf '{"file":"%s","sha256":"%s","ledgerHead":"%s","createdAt":"%s"}\n' "$(basename "$file")" "$sha" "$head" "$stamp" > "$file.manifest.json"
echo "backup written: $file (sha256 $sha, ledger head $head)"
