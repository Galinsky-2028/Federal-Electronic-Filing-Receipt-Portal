# Operations runbook (demonstration)

## Configuration (Render env only)
Required together: `DATABASE_URL` (Neon, `sslmode=verify-full`), `RECEIPT_SIGNING_KEY` (base64 PKCS#8 Ed25519), `SESSION_SECRET`, `DATA_ENCRYPTION_KEY` (64 hex). Optional: `STAFF_USERNAME` and `STAFF_PASSWORD` (bootstrap admin, created once), `PUBLIC_ORIGIN`, `TRUST_PROXY=true`, `METRICS_TOKEN`, `EVENTS_FEED_TOKEN`. Losing `DATA_ENCRYPTION_KEY` makes protected identities, filing text and attachments unreadable. Losing `RECEIPT_SIGNING_KEY` means old receipts still verify only if the public key is retained.

## Health and observability
- `/api/health`: liveness.
- `/api/ready`: database readiness (503 `demo_storage_unavailable` on outage; pages fail closed with no data saved).
- `/api/metrics`: Prometheus text, `Authorization: Bearer $METRICS_TOKEN`.
- Logs: structured JSON events, with no filing content, identities or secrets.
- `/staff/oversight`: ledger validity, the newest signed checkpoint and SLA state.

## Backup and restore
1. `DATABASE_URL=... scripts/backup.sh backups/` writes a pg_dump archive plus a manifest (SHA-256, ledger head).
2. Restore into an empty database: `pg_restore --no-owner --dbname "$RESTORE_URL" backups/portal-*.dump`.
3. Run `RESTORE_URL=... PUBLIC_KEY_JWK="$(curl -s $ORIGIN/api/receipts/keys | jq -c '.keys[0]')" node scripts/restore-verify.mjs`. It verifies the whole hash chain and every signed checkpoint.
4. Compare the restored head with the latest public checkpoint (`/api/ledger/checkpoints/latest`). A restored head older than a published checkpoint means data loss, which must be recorded, not hidden.

Crypto-shred caveat: backups made before a disposition still contain wrapped data keys. Disposition is final only after those backups expire.

## Independent witnessing
Third parties run `node scripts/witness-checkpoints.mjs <origin> state.json` on a schedule. Any changed checkpoint, key or backwards head fails the run.

## Load and release checks
- `PORTAL_BASE_URL=http://127.0.0.1:3000 TRUST_PROXY=true CONCURRENCY=8 FILINGS=60 node scripts/load-generator.mjs` (local or staging only).
- `npm run release:check`: lockfile integrity, SBOM, secret scan.
- `PORTAL_BASE_URL=https://... node scripts/live-smoke.mjs` (also runs in CI after merges).

## Incidents
- Ledger invalid: stop writes (scale to 0), preserve the database, compare against published checkpoints and backups, record the incident.
- Key compromise: rotate `RECEIPT_SIGNING_KEY`, publish the old key's retirement, and keep the old public key for verifying past receipts. Multi-key verification is a follow-up.
