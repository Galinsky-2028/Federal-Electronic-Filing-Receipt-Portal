# UFR-004 Secure Intake engine integration contract

Contract id: `ufr-engine-contract-v1`. Code: `src/engine/contract.mjs`, `src/engine/client.mjs`. Lock: `config/engine.lock.json`. Verify with `npm run validate:engine` (add `-- --base-url https://...` to probe a running engine).

This unit defines how the portal will consume the Secure Intake & Case Workflow Engine. It does not implement intake, cases, receipts, routing, deadlines or correspondence, and it copies no upstream logic. It grants no filing authority; the portal's `GET /api/ready` keeps returning 503 `upstream_unconfigured`.

## Pinned release

| Field | Value |
| --- | --- |
| Source | `Justice-For-All-Movement/Secure-Intake-Case-Workflow-Engine` (public; verified read-only) |
| Version / tag | `1.0.0-rc.9` / `v1.0.0-rc.9` (annotated tag, release bot) |
| Source commit | `2fb452f23e5e5464db03a3ec95d36c4bc2db4fa4` (tag target) |
| Manifest schema | `1` |
| Image | `ghcr.io/neophilism/secure-intake-case-workflow-engine:1.0.0-rc.9` as documented upstream; digest **not verified** (`imageDigest: null`) |
| Production eligible | **false**: prerelease and no digest. The validator rejects `eligible: true` unless the version is stable and an immutable digest is pinned. |

The upstream SI-42 "Stable generic 1.0 release" unit has no merged PR at the time of pinning, so the portal remains under the upstream-first rule: development may target rc.9, production may not.

## Executable contract

- **Lock**: exact fields only; semantic version; `tag === "v" + version`; 40-hex commit; manifest schema 1; image tag equals version; optional `sha256:` digest; non-empty production requirements; prerelease/digest-less pins can never be production eligible.
- **Liveness** (`GET /api/health`, engine ADR 0031): HTTP 200, exactly `{status:"ok", service, version, check:"liveness"}`. Service must be `secure-intake-case-workflow-engine` and version must equal the lock. Version drift is a contract mismatch, not "close enough".
- **Readiness** (`GET /api/ready`, ADR 0031): 200 `ready` with database `ok`, or 503 `not_ready` with database `unconfigured`/`unavailable`. Status code, body status and database state must agree. Unknown states or extra fields (for example raw connection details) are rejected.
- **Errors** (ADR 0003): `{error:{code, message, correlationId?, details?}}`. Only the code and correlation id are surfaced; messages are bounded and never relayed to the public.
- **Probe client**: HTTPS required (loopback HTTP for development only); URLs with credentials, paths, queries or fragments are refused; `redirect: "error"`; per-request timeout (default 5 s, 0.1 to 30 s); `application/json` only; 16 KiB response bound enforced on the stream; no credentials or cookies are sent. Results are coarse (`ready`, `not_ready`, `unavailable`, `contract_mismatch`) and never include raw upstream errors.
- **Signed webhooks** (ADR 0019): `X-SICWE-Signature: sha256=<hex>` over `"<unix timestamp>.<raw body>"` with the subscription secret (32 to 256 characters). The verifier checks lowercase hex in constant time, a timestamp tolerance (default 300 s, max 900 s), a 256 KiB body bound, strict UTF-8 JSON, the exact upstream payload keys, and that payload `id`/`type` match the delivery/event headers. Deduplication on the delivery id needs a durable store and belongs to UFR-013. A verified webhook proves engine origin only, never receipt, transmission or acceptance.
- **Readiness reasons**: `upstream_unconfigured` → `upstream_unavailable` / `upstream_contract_mismatch` → `upstream_prerelease` → `portal_intake_unimplemented`. There is no reason code for "ready to accept filings" in this contract version.

## Capability assessment at rc.9 (candidate, verify before each unit)

Evidence: upstream architecture decision records (ADRs) and source at the pinned commit.

| Portal units | Upstream at rc.9 | Assessment |
| --- | --- | --- |
| UFR-006, 007, 010, 011, 014 receipt schema, authoritative time, signing, public verifier, receipt ledger | Intake confirmation code page; SHA-256 per document version (ADR 0011); immutable audit events (ADR 0012) without a hash chain; no signed receipt, trusted time source or public verifier | Upstream gap; shared-engine candidates. Build upstream first, release, then pin. Do not implement here. |
| UFR-012 idempotent filing | No idempotency key on `/api/v1/submissions` | Upstream gap. |
| UFR-013 outbox | Durable webhook outbox from audit events (ADR 0019) | Consumer side (verification above, durable dedup) is portal work; producer exists upstream. |
| UFR-021 claimant status | External participant portal (ADR 0025/0026) | Available upstream; consume via manifest. |
| UFR-023 protected identity | Protected compartments, dual-control reveal (ADR 0024) | Available upstream. |
| UFR-026/027 storage, malware quarantine | Object storage and automatic scanning (ADR 0027/0030) | Available upstream. |
| UFR-032, 039 routing, deadlines | Routing/assignment (ADR 0010), deadline primitives (ADR 0013) | Primitives upstream; Federal statutory rules stay here. |

## Change control

Bump the lock only to a released upstream tag whose commit is verified, rerun `npm run check`, and record the evidence. A new engine API shape requires a new contract version, not a silent parser relaxation. Re-review THREAT_MODEL.md before adding engine credentials, write calls or a webhook receiver endpoint.
