# Portal-local demonstration system: evidence

Base: `bbecf3d918ca849d812e63adea465c9ac703660a` (main after UFR-004). Owner directive (relayed 2026-11-16): implement the remaining portal features locally rather than waiting on Secure Intake; keep it demo-only.

## Verification

`npm run check` with Postgres 16 (`TEST_DATABASE_URL`, `REQUIRE_DB_TESTS=1`; CI runs a Postgres service so the database suites cannot be skipped): 48 tests. New suites:

- `tests/demo-backend.test.mjs` (8): atomic filing with signed, ledger-anchored receipt; concurrent idempotent replay and 409 conflict; append-only triggers (UPDATE/DELETE/TRUNCATE); detection of forged fields, an unknown key, a wrong ledger pointer, and a privileged chain edit; participant access and amendments; routing delivery, retry, dead-letter and escalation without receipt change; validation before writes; ledgered staff status; idempotent migrations; rate limits.
- `tests/demo-http.test.mjs` (3): browser flow (file → receipt → replay → track → download → amend with and without CSRF → API/HTML verify → forged agency → staff login/queue/detail/status/CSRF/download/ledger); cross-origin and Origin-less posts, missing attestations, executable and disguised uploads, 5 MB limit, wrong media type, 405, no partial writes; readiness; runtime refuses partial configuration; unconfigured deployments serve a truthful 503 page.

Existing shell, registry, policy, engine-contract and threat-model suites still pass unchanged, except that the shell shows a demonstration notice and links only when demo filing is configured.

## Limits

Portable tests do not establish government authorization, legal sufficiency, production availability, hardware key protection or independent review. AI-assisted review only.
