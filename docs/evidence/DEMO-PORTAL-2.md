# Portal-local platform round 2: evidence

Base: `4552882` (main after #12). Owner directive (2026-11-16): implement every remaining unit buildable in software, portal-locally, demo-only.

## Verification
- `npm run check` with Postgres 16 (CI enforces DB suites): 63 tests. New suites:
  - `platform.test.mjs`: TOTP RFC 6238 vectors and replay, scanner, markings; encryption at rest; quarantine; emergency priority; classified refusal; accounts, roles, agency scope, dual-control reveal, MFA, lockout; drafts, delegation, signed corrections, withdrawal, legal hold, crypto-shred disposition with receipts still verifiable.
  - `workflows.test.mjs`: deadline engine (holidays, observance, DST, tolling); records workflow with tolling and appeal window; read receipts; defect cure and relation back, including the late case; tort deemed denial; routing-SLA escalation; signed checkpoints.
  - `features-http.test.mjs`: accessibility and low-bandwidth checks on public and staff pages; guided-form validation; resumable uploads; transparency suppression; metrics and feed token checks.
  - `adversarial.test.mjs`: IDOR, forged cookies, CSRF, injection, enumeration uniformity; insider SQL tampering blocked or detected; role boundaries; disabled accounts; database-level dual control.
  - `degraded.test.mjs`: fail-closed storage outage.
- `npm run release:check`: no problems; SBOM generated.
- Local load test, 8 concurrent clients and 60 filings: 0 errors; filing p50 41 ms, p95 92 ms; verify p95 21 ms.
- Backup, restore and verify: 71 ledger entries, chain valid, checkpoint matched; 60 submissions and 60 receipts restored.
- Live smoke (18 checks) passes locally; it reruns against Render after deploy.

## Limits
Synthetic data and fictional agencies only. Demonstration deadline rules and retention schedule. Heuristic scanning, not antivirus. No independent witness, penetration test, manual accessibility audit or E2EESA certification yet. AI-assisted review only.
