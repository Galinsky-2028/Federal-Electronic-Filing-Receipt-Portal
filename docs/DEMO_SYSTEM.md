# Portal-local demonstration filing and receipt system

**Status:** implemented portal-locally under the owner directives of 16 November 2026. It is a **demonstration**: fictional agencies, synthetic data, a prototype signing key, and demonstration deadline rules. It is not an official U.S. Government service, issues no government receipt and computes no authoritative legal deadline (`/api/policy` keeps that disabled). Secure Intake integration is pending, and production stays blocked by `config/engine.lock.json` (rc.9 prerelease) and by legal authority (UFR-060).

## Upstream seam

Presentation (`src/demo/routes.mjs`, `views*.mjs`) calls the `LocalIntakeBackend` interface (`src/demo/backend.mjs`), `PlatformServices` (`src/platform/services.mjs`) and `WorkflowServices` (`src/platform/workflows.mjs`). A Secure Intake adapter built on the UFR-004 contract (`src/engine/`) can replace these local implementations without changing pages. Nothing was copied from Secure Intake.

## Coverage by unit

| Unit | Status | Implementation |
| --- | --- | --- |
| 006-014 | done | Receipt schema, DB-clock time of record, manifest, atomic receipt transaction, Ed25519 signing, public verifier, idempotency, routing outbox, hash-chained ledger |
| 016, 020-022 | done | Text and attachment filing; receipt JSON, plain-text and print views; tracking with one-time access code; supplements |
| 017, 018 | done | `/file/guide` purpose chooser; per-type guided forms with validated structured fields (for example the tort-claim sum certain) |
| 019 | done | Server-side text drafts with a one-time draft code, 7-day expiry |
| 025 | done | Optional claimant accounts with **passkeys (WebAuthn)**: no passwords, email or phone. Ten one-time recovery codes are shown once and stored hashed. Filings link via tracking number and the owner access code (not representative codes). Account-scoped filing list. Server-side sessions with per-session and everywhere revocation. Passkey add and remove (never the last). User verification is required, challenges are single-use, signature counters are checked, and the origin and RP ID are bound. `RecoveryDelivery` is the seam for adding email/SMS later; the default records requests as undeliverable and never claims to have sent anything. Available in Spanish. |
| 023 | done | Identity and filing text sealed in per-record envelope-encrypted vaults; dual-control (requester plus a different privacy officer), one-time, 15-minute, ledgered reveal |
| 024 | done | Individual staff accounts (scrypt), roles (`admin`, `intake`, `privacy_officer`, `oversight`, `records_officer`, `agency:<id>`), TOTP MFA with replay protection, lockout, agency scoping |
| 026 | done | AES-256-GCM envelope encryption of attachments; integrity re-check on read |
| 027 | partial | Heuristic scanner (EICAR, active PDF content, image polyglots, script markers) and quarantine (423 on download). No commercial AV engine. |
| 028 | done (API) | Token-bound resumable chunk upload API (`/api/uploads`), attachable once to a filing |
| 029 | partial | Automated checks on every page (labels, one h1, skip link, no scripts, size under 60 KB); print styles; text receipts. Manual assistive-technology audit pending. |
| 030 | done | Spanish for every form and claimant flow (filing, guided forms, drafts, receipts, tracking, delegation, corrections, notices, deadlines, verification, errors). Selected by `/idioma/es` cookie or `Accept-Language`. A coverage test fails on any untranslated English UI text. Signed receipt JSON stays canonical English; staff pages stay English. |
| 031 | partial | Clearly fictional demo directory; the real Federal directory needs primary sources unreachable here |
| 032, 033 | done | Routing without intake veto; delivery worker with backoff and dead-letter |
| 037 | done | Agency-scoped staff acknowledge, send notices and receive claimant replies |
| 038 | done | Routing-SLA and deadline-miss escalation (idempotent), staff and oversight notifications |
| 039 | done (demo rules) | Versioned deadline engine: Eastern calendar dates, computed federal holidays with observance, business days, roll-forward, DST-aware end of day, tolling |
| 040-042 | done (demo) | Workflows for tort claims (deemed denial on a missed clock), records requests and appeals, administrative claims and appeals, complaints and petitions |
| 043 | done | Defect notices with 30-day cure period; a timely cure relates back to the original receipt date (ledgered); a late cure does not |
| 044 | done | Emergency flag: 4-hour routing SLA, queue priority, staff notification |
| 045 | done | Notices delivered to the portal inbox with ledgered read receipts; email is simulated (provider-free outbox) |
| 047 | done | Classification-marking detection stops collection and stores only a content-free audit event. It cannot detect unmarked classified content. |
| 048 | done (demo tenant) | Every ledger entry is delivered in order to the deployed CAIAE engine as content-free evidence on one portal resource, through a dedicated fictional demo tenant (`federal-filing-portal-demo`). Delivery uses a durable cursor, an in-flight marker reconciled before any resend, and capped backoff. Lag and errors appear on the oversight dashboard and in metrics. The token-protected pull feed remains available. |
| 049 | partial | Signed ledger checkpoints (`/api/ledger/checkpoints`), `scripts/witness-checkpoints.mjs`, and a scheduled GitHub-hosted witness (`.github/workflows/witness.yml`) that keeps state between runs. A truly independent third-party witness operator is still needed. |
| 050, 051 | done | Oversight dashboard (ledger validity, reveals, holds, MFA gaps, refusals, quarantine, SLAs); public transparency statistics with suppression of counts from 1 to 4 |
| 052 | done | Receipt corrections (separately signed correction notice, never replacing the receipt), processing complaints, withdrawal |
| 053 | done (demo schedule) | Retention schedule, legal holds, crypto-shred disposition that keeps receipts verifiable |
| 054 | done (automated) | Outsider and insider adversarial test suite; independent penetration test deferred under owner policy |
| 055 | partial | `npm run release:check`: lockfile integrity, CycloneDX SBOM, secret scan, control presence. E2EESA certification is external. |
| 056 | partial | Durable per-IP and global rate limits, account lockout, attestations; no adaptive bot defense |
| 057 | partial | Degraded-mode fail-closed page; multi-instance-safe locking; load-generator script. Real HA needs paid multi-instance infrastructure. |
| 058 | done | Metrics (`/api/metrics`, token), structured logs, backup/restore-verify scripts, runbook (docs/OPERATIONS.md) |
| 059 | partial | Demo release-candidate evidence (docs/evidence/DEMO-PORTAL-2.md, live smoke) |
| 034-036, 046, 060 | remaining | See below |

## Remaining, and why

- **025 email/SMS recovery delivery:** accounts are done with passkeys and recovery codes. Adding email or SMS recovery only needs a provider adapter behind `RecoveryDelivery` plus provider credentials.
- **034-036 Agency system adapters, official intake addresses, correspondence connectors:** these need real agency endpoints, addresses and mail or e-filing provider accounts.
- **046 Federal court filing gateway:** needs a judiciary-authorized integration.
- **060 Government deployment and operational acceptance:** needs legal authority and a receiving institution.
- **Upstream integration:** all shared-engine-candidate units still need Secure Intake equivalents released, then an adapter swap.
