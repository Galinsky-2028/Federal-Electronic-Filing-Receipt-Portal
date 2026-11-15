import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * UFR-004: versioned portal-side contract for consuming the Secure Intake &
 * Case Workflow Engine. This module only validates what the portal receives
 * from a pinned upstream release. It implements no intake, case, receipt,
 * routing or deadline behavior; those remain upstream (upstream-first rule).
 * Nothing here grants filing authority or makes the portal "ready".
 */
export const ENGINE_CONTRACT_VERSION = "ufr-engine-contract-v1";
export const ENGINE_SERVICE_ID = "secure-intake-case-workflow-engine";
export const SUPPORTED_MANIFEST_SCHEMA = 1;
export const MAX_ENGINE_RESPONSE_BYTES = 16 * 1024;
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export class EngineContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "EngineContractError";
    this.code = code;
  }
}

const fail = (code) => { throw new EngineContractError(code); };
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function exactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z.-]{1,64}))?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Validates config/engine.lock.json. Unknown or missing fields fail closed. */
export function validateEngineLock(lock) {
  if (!exactKeys(lock, ["schemaVersion", "contract", "engine", "production"])) fail("LOCK_SHAPE");
  if (lock.schemaVersion !== 1 || lock.contract !== ENGINE_CONTRACT_VERSION) fail("LOCK_VERSION");
  const { engine, production } = lock;
  if (!exactKeys(engine, ["repository", "service", "version", "tag", "sourceCommit",
    "manifestSchemaVersion", "image", "imageDigest"])) fail("LOCK_ENGINE_SHAPE");
  if (!REPOSITORY.test(engine.repository)) fail("LOCK_REPOSITORY");
  if (engine.service !== ENGINE_SERVICE_ID) fail("LOCK_SERVICE");
  const semver = typeof engine.version === "string" ? SEMVER.exec(engine.version) : null;
  if (!semver) fail("LOCK_ENGINE_VERSION");
  if (engine.tag !== "v" + engine.version) fail("LOCK_TAG");
  if (typeof engine.sourceCommit !== "string" || !COMMIT.test(engine.sourceCommit)) fail("LOCK_COMMIT");
  if (engine.manifestSchemaVersion !== SUPPORTED_MANIFEST_SCHEMA) fail("LOCK_MANIFEST_SCHEMA");
  if (typeof engine.image !== "string" || engine.image.length > 256 ||
      !engine.image.endsWith(":" + engine.version)) fail("LOCK_IMAGE");
  if (engine.imageDigest !== null && !(typeof engine.imageDigest === "string" &&
      IMAGE_DIGEST.test(engine.imageDigest))) fail("LOCK_IMAGE_DIGEST");
  const prerelease = semver[4] !== undefined;
  if (!exactKeys(production, ["eligible", "requires"])) fail("LOCK_PRODUCTION_SHAPE");
  if (!Array.isArray(production.requires) || production.requires.length === 0 ||
      !production.requires.every((item) => typeof item === "string" && item.length > 0 && item.length <= 200))
    fail("LOCK_PRODUCTION_REQUIREMENTS");
  // Upstream-first guard: a prerelease or digest-less pin can never be marked
  // production eligible, whatever the lock file claims.
  if (production.eligible !== false &&
      (production.eligible !== true || prerelease || engine.imageDigest === null))
    fail("LOCK_PRODUCTION_ELIGIBILITY");
  return Object.freeze({
    repository: engine.repository, version: engine.version, tag: engine.tag,
    sourceCommit: engine.sourceCommit, manifestSchemaVersion: engine.manifestSchemaVersion,
    image: engine.image, imageDigest: engine.imageDigest, prerelease,
    productionEligible: production.eligible === true,
  });
}

function parseJsonObject(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_ENGINE_RESPONSE_BYTES)
    fail("RESPONSE_SIZE");
  let value;
  try { value = JSON.parse(text); } catch { fail("RESPONSE_JSON"); }
  if (!isPlainObject(value)) fail("RESPONSE_SHAPE");
  return value;
}

function checkIdentity(body, lock) {
  if (body.service !== ENGINE_SERVICE_ID) fail("ENGINE_SERVICE_MISMATCH");
  if (body.version !== lock.version) fail("ENGINE_VERSION_MISMATCH");
}

/** Engine GET /api/health (ADR 0031): liveness only, never readiness. */
export function parseEngineLiveness(status, text, lock) {
  if (status !== 200) fail("LIVENESS_STATUS");
  const body = parseJsonObject(text);
  if (!exactKeys(body, ["status", "service", "version", "check"]) ||
      body.status !== "ok" || body.check !== "liveness") fail("LIVENESS_SHAPE");
  checkIdentity(body, lock);
  return Object.freeze({ alive: true, version: body.version });
}

const DATABASE_STATES = new Set(["ok", "unconfigured", "unavailable"]);

/** Engine GET /api/ready (ADR 0031): 200 ready or 503 not_ready, coarse database state. */
export function parseEngineReadiness(status, text, lock) {
  if (status !== 200 && status !== 503) fail("READINESS_STATUS");
  const body = parseJsonObject(text);
  if (!exactKeys(body, ["status", "service", "version", "check", "checks"]) ||
      body.check !== "readiness" || !exactKeys(body.checks, ["database"]) ||
      !DATABASE_STATES.has(body.checks.database)) fail("READINESS_SHAPE");
  checkIdentity(body, lock);
  const ready = status === 200;
  if (ready !== (body.status === "ready") || (!ready && body.status !== "not_ready") ||
      ready !== (body.checks.database === "ok")) fail("READINESS_INCONSISTENT");
  return Object.freeze({ ready, database: body.checks.database, version: body.version });
}

const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** Engine error envelope (ADR 0003). Messages are bounded and never echoed to the public. */
export function parseEngineError(text) {
  const body = parseJsonObject(text);
  if (!exactKeys(body, ["error"]) ||
      !exactKeys(body.error, ["code", "message"], ["correlationId", "details"]) ||
      typeof body.error.code !== "string" || !ERROR_CODE.test(body.error.code) ||
      typeof body.error.message !== "string" || body.error.message.length > 1000 ||
      (body.error.correlationId !== undefined &&
        !(typeof body.error.correlationId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(body.error.correlationId))))
    fail("ERROR_ENVELOPE");
  return Object.freeze({ code: body.error.code, correlationId: body.error.correlationId ?? null });
}

/**
 * Portal readiness reason derived from the lock and an optional probe result.
 * The portal is never ready for filings under this contract: even a healthy,
 * stable, digest-pinned engine leaves receipt, signing and authority units
 * outstanding, so the best reachable reason is "portal_intake_unimplemented".
 */
export function engineReadinessReason(lock, probe) {
  if (!probe) return "upstream_unconfigured";
  if (probe.state === "contract_mismatch") return "upstream_contract_mismatch";
  if (probe.state !== "ready") return "upstream_unavailable";
  if (lock.prerelease || !lock.productionEligible) return "upstream_prerelease";
  return "portal_intake_unimplemented";
}

const HEADER = {
  delivery: "x-sicwe-delivery", event: "x-sicwe-event",
  timestamp: "x-sicwe-timestamp", signature: "x-sicwe-signature",
};
const DELIVERY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,7}$/;

function header(headers, name) {
  const value = headers instanceof Headers ? headers.get(name) : headers?.[name];
  if (typeof value !== "string") fail("WEBHOOK_HEADERS");
  return value;
}

/**
 * Verifies a Secure Intake webhook delivery (ADR 0019):
 * HMAC-SHA256(secret, "<unix-timestamp>.<raw body>") in
 * X-SICWE-Signature: sha256=<hex>. Enforces a timestamp tolerance and checks
 * the signed body agrees with the delivery headers. Deduplication on the
 * returned deliveryId requires a durable store and is the caller's duty
 * (UFR-013); a verified delivery is evidence of engine origin only, never of
 * filing receipt or acceptance.
 */
export function verifyEngineWebhook({ secret, headers, rawBody, nowSeconds,
  toleranceSeconds = DEFAULT_WEBHOOK_TOLERANCE_SECONDS }) {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 256) fail("WEBHOOK_SECRET");
  if (!Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(toleranceSeconds) ||
      toleranceSeconds < 1 || toleranceSeconds > 900) fail("WEBHOOK_CLOCK");
  const body = Buffer.isBuffer(rawBody) ? rawBody : typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : null;
  if (!body || body.length === 0 || body.length > MAX_WEBHOOK_BODY_BYTES) fail("WEBHOOK_BODY_SIZE");
  const deliveryId = header(headers, HEADER.delivery);
  const event = header(headers, HEADER.event);
  const timestamp = header(headers, HEADER.timestamp);
  const signature = header(headers, HEADER.signature);
  if (!DELIVERY_ID.test(deliveryId) || !EVENT_NAME.test(event)) fail("WEBHOOK_HEADERS");
  if (!/^[1-9]\d{0,11}$/.test(timestamp)) fail("WEBHOOK_TIMESTAMP");
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) fail("WEBHOOK_TIMESTAMP_TOLERANCE");
  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) fail("WEBHOOK_SIGNATURE_FORMAT");
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(timestamp + ".", "utf8"), body])).digest();
  if (!timingSafeEqual(expected, Buffer.from(match[1], "hex"))) fail("WEBHOOK_SIGNATURE");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { fail("WEBHOOK_BODY_ENCODING"); }
  let payload;
  try { payload = JSON.parse(text); } catch { fail("WEBHOOK_BODY_JSON"); }
  if (!exactKeys(payload, ["id", "type", "occurredAt", "organizationId", "resource",
    "correlationId", "source", "previousState", "newState", "metadata"]) ||
      payload.id !== deliveryId || payload.type !== event ||
      typeof payload.occurredAt !== "string" || Number.isNaN(Date.parse(payload.occurredAt)) ||
      typeof payload.organizationId !== "string" ||
      !exactKeys(payload.resource, ["type", "id", "parentType", "parentId"]))
    fail("WEBHOOK_PAYLOAD");
  return Object.freeze({ deliveryId, event, timestamp: Number(timestamp), payload });
}
