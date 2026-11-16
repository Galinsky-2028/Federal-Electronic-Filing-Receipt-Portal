# Portal-local demonstration filing and receipt system

**Status:** implemented portal-locally under the owner directive of 16 November 2026 ("build out the full portal now rather than waiting on Secure Intake upstream"). It is a **demonstration**: fictional agencies, synthetic data, a prototype signing key. It is not an official U.S. Government service and issues no government receipt. Secure Intake integration is still pending. Production eligibility remains blocked by `config/engine.lock.json` (rc.9 prerelease) and by legal authority (UFR-060).

## Upstream seam

All presentation code (`src/demo/routes.mjs`) calls only the `LocalIntakeBackend` interface in `src/demo/backend.mjs` (`listAgencies`, `fileSubmission`, `openParticipant`, `participantView`, `listSubmissions`, `staffSubmission`, `document`, `recordStatus`, `verifyReceipt`, `deliverDueRoutings`, `allow`). A Secure Intake adapter built on `src/engine/` (UFR-004 contract) can replace it without changing pages. Nothing was copied from Secure Intake. Every component was written independently for this repository.

## What exists

| Capability | Implementation | Units (portal-local) |
| --- | --- | --- |
| Canonical receipt schema | `ufr-demo-receipt-v1`, exact-field validation, explicit non-government notice, `demo: true` | UFR-006 |
| Authoritative time | Postgres `clock_timestamp()` as the time of record, cross-checked against the app clock (max 5 s skew) and monotonic with the ledger head. Fails closed on skew or rollback. | UFR-007 |
| Immutable manifest | `ufr-demo-manifest-v1`: SHA-256 commitments for the filing text and each attachment; canonical-JSON digest | UFR-008 |
| Atomic receipt transaction | One transaction: ledger entry, original record, file bytes, manifest, signed receipt, routing outbox, initial status | UFR-009 |
| Receipt signing | Ed25519 over canonical JSON; key only in `RECEIPT_SIGNING_KEY` (Render env); public JWK at `/api/receipts/keys` | UFR-010 |
| Public verifier | `/verify` and `POST /api/verify`: signature plus ledger cross-check; reveals no content | UFR-011 |
| Idempotency | Caller-bound key per form; same request replays the original receipt; different request gets 409; concurrency-safe | UFR-012 |
| Durable outbox and delivery worker | `routing_outbox` with leasing (`FOR UPDATE SKIP LOCKED`), capped exponential backoff, dead-letter and staff escalation; in-process worker | UFR-013, UFR-032, UFR-033 |
| Hash-chained ledger | `ledger_entries` with prev/entry SHA-256 chain, head row locked per append, staff integrity check `/staff/ledger` | UFR-014 |
| Text filing and uploads | `/file`: text plus up to 3 PDF/TXT/PNG/JPEG files (5 MB each, 10 MB total), magic-number checks; bytes stored in Postgres (no instance disk) | UFR-016 |
| Receipt presentation and export | Receipt panel plus signed JSON download | UFR-020 |
| Claimant tracking and participant access | Tracking number plus one-time 120-bit access code (salted hash only), signed HttpOnly SameSite=Strict session, non-distinguishing failures | UFR-021 |
| Amendments and supplements | New receipt referencing the original; originals never change | UFR-022 |
| Staff console | `/staff`: queue, detail, attachment download (integrity re-checked), ledgered review status, ledger check. Single shared demo credential. | partial UFR-024 |
| Directory and routing | Clearly fictional demo agencies (`config/demo-agencies.json`); routing never vetoes a receipt; SLA due dates | partial UFR-031, UFR-037, UFR-038 |
| Abuse controls | Durable per-IP and global rate limits, same-origin checks, session-bound CSRF tokens, body/part limits, CSP | partial UFR-056 |

Append-only enforcement: database triggers reject UPDATE, DELETE and TRUNCATE on submissions, documents, manifests, receipts, ledger entries and agency inbox records.

## Not implemented (honest gaps)

Protected identity compartments (identity stored as plain columns; synthetic data only), application-level encryption of files (Neon encrypts at rest), malware scanning (type sniffing only), resumable uploads, drafts, individual staff identities/MFA, statutory deadline engine and workflows (FTCA, FOIA), court gateway, Compliance Engine events, independent witnessing, oversight/public dashboards, records disposition, HA/fallback, and the real Federal agency directory (primary sources unreachable from the build environment).

## Configuration

See `render.yaml`. Required together: `DATABASE_URL`, `RECEIPT_SIGNING_KEY`, `SESSION_SECRET`; optional `STAFF_USERNAME`/`STAFF_PASSWORD` (16+ chars), `PUBLIC_ORIGIN`, `TRUST_PROXY=true` behind Render. Migrations run on startup.
