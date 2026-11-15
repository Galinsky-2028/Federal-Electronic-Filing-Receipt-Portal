import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import {
  EngineContractError, engineReadinessReason, parseEngineError, parseEngineLiveness,
  parseEngineReadiness, validateEngineLock, verifyEngineWebhook,
} from "../src/engine/contract.mjs";
import { parseEngineBaseUrl, probeEngine } from "../src/engine/client.mjs";

const rawLock = JSON.parse(readFileSync(new URL("../config/engine.lock.json", import.meta.url), "utf8"));
const lock = validateEngineLock(rawLock);
const clone = () => structuredClone(rawLock);
const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof EngineContractError && e.code === code);
const live = (extra = {}) => JSON.stringify({ status: "ok", service: "secure-intake-case-workflow-engine",
  version: "1.0.0-rc.9", check: "liveness", ...extra });
const ready = (status, database, extra = {}) => JSON.stringify({ status, service: "secure-intake-case-workflow-engine",
  version: "1.0.0-rc.9", check: "readiness", checks: { database }, ...extra });

test("committed lock pins rc.9 by tag and commit and is never production eligible", () => {
  assert.equal(lock.version, "1.0.0-rc.9");
  assert.equal(lock.tag, "v1.0.0-rc.9");
  assert.equal(lock.sourceCommit, "2fb452f23e5e5464db03a3ec95d36c4bc2db4fa4");
  assert.equal(lock.prerelease, true);
  assert.equal(lock.productionEligible, false);
  assert.ok(Object.isFrozen(lock));
});

test("lock drift, unknown fields and false production eligibility fail closed", () => {
  const cases = [
    [(l) => { l.extra = true; }, "LOCK_SHAPE"],
    [(l) => { l.contract = "ufr-engine-contract-v2"; }, "LOCK_VERSION"],
    [(l) => { l.engine.branch = "main"; }, "LOCK_ENGINE_SHAPE"],
    [(l) => { l.engine.service = "other-engine"; }, "LOCK_SERVICE"],
    [(l) => { l.engine.version = "latest"; }, "LOCK_ENGINE_VERSION"],
    [(l) => { l.engine.tag = "v1.0.0"; }, "LOCK_TAG"],
    [(l) => { l.engine.sourceCommit = "main"; }, "LOCK_COMMIT"],
    [(l) => { l.engine.sourceCommit = "2FB452F23E5E5464DB03A3EC95D36C4BC2DB4FA4"; }, "LOCK_COMMIT"],
    [(l) => { l.engine.manifestSchemaVersion = 2; }, "LOCK_MANIFEST_SCHEMA"],
    [(l) => { l.engine.image = "ghcr.io/x/engine:latest"; }, "LOCK_IMAGE"],
    [(l) => { l.engine.imageDigest = "sha256:short"; }, "LOCK_IMAGE_DIGEST"],
    [(l) => { l.production.requires = []; }, "LOCK_PRODUCTION_REQUIREMENTS"],
    [(l) => { l.production.eligible = true; }, "LOCK_PRODUCTION_ELIGIBILITY"],
    [(l) => { l.production.eligible = "yes"; }, "LOCK_PRODUCTION_ELIGIBILITY"],
    [(l) => { l.engine.imageDigest = "sha256:" + "a".repeat(64); l.production.eligible = true; }, "LOCK_PRODUCTION_ELIGIBILITY"],
  ];
  for (const [mutate, code] of cases) {
    const l = clone(); mutate(l);
    rejects(() => validateEngineLock(l), code);
  }
  // A stable, digest-pinned engine may be marked eligible; this is the only path.
  const stable = clone();
  Object.assign(stable.engine, { version: "1.0.0", tag: "v1.0.0",
    image: "ghcr.io/x/secure-intake-case-workflow-engine:1.0.0", imageDigest: "sha256:" + "b".repeat(64) });
  stable.production.eligible = true;
  assert.equal(validateEngineLock(stable).productionEligible, true);
});

test("liveness is accepted only for the pinned service and version", () => {
  assert.deepEqual({ ...parseEngineLiveness(200, live(), lock) }, { alive: true, version: "1.0.0-rc.9" });
  rejects(() => parseEngineLiveness(500, live(), lock), "LIVENESS_STATUS");
  rejects(() => parseEngineLiveness(200, live({ service: "imposter" }), lock), "ENGINE_SERVICE_MISMATCH");
  rejects(() => parseEngineLiveness(200, live({ version: "1.0.0-rc.10" }), lock), "ENGINE_VERSION_MISMATCH");
  rejects(() => parseEngineLiveness(200, live({ filingsAccepted: true }), lock), "LIVENESS_SHAPE");
  rejects(() => parseEngineLiveness(200, live({ check: "readiness" }), lock), "LIVENESS_SHAPE");
  rejects(() => parseEngineLiveness(200, "not json", lock), "RESPONSE_JSON");
  rejects(() => parseEngineLiveness(200, "[]", lock), "RESPONSE_SHAPE");
  rejects(() => parseEngineLiveness(200, " ".repeat(17000) + live(), lock), "RESPONSE_SIZE");
  rejects(() => parseEngineLiveness(200, '{"__proto__":{"x":1},"status":"ok"}', lock), "LIVENESS_SHAPE");
});

test("readiness status, body and coarse database state must agree", () => {
  assert.equal(parseEngineReadiness(200, ready("ready", "ok"), lock).ready, true);
  for (const db of ["unconfigured", "unavailable"])
    assert.deepEqual({ ...parseEngineReadiness(503, ready("not_ready", db), lock) },
      { ready: false, database: db, version: "1.0.0-rc.9" });
  rejects(() => parseEngineReadiness(200, ready("not_ready", "ok"), lock), "READINESS_INCONSISTENT");
  rejects(() => parseEngineReadiness(503, ready("ready", "ok"), lock), "READINESS_INCONSISTENT");
  rejects(() => parseEngineReadiness(503, ready("not_ready", "ok"), lock), "READINESS_INCONSISTENT");
  rejects(() => parseEngineReadiness(200, ready("ready", "unavailable"), lock), "READINESS_INCONSISTENT");
  rejects(() => parseEngineReadiness(503, ready("not_ready", "postgres://user:pw@db"), lock), "READINESS_SHAPE");
  rejects(() => parseEngineReadiness(502, ready("not_ready", "unavailable"), lock), "READINESS_STATUS");
  rejects(() => parseEngineReadiness(200, ready("ready", "ok", { version: "0.9.0" }), lock), "ENGINE_VERSION_MISMATCH");
});

test("engine error envelopes are bounded and expose only code and correlation", () => {
  assert.deepEqual({ ...parseEngineError('{"error":{"code":"permission_denied","message":"No.","correlationId":"req_1"}}') },
    { code: "permission_denied", correlationId: "req_1" });
  for (const bad of [
    '{"error":{"code":"Permission Denied","message":"x"}}',
    '{"error":{"code":"x","message":"x","stack":"at db"}}',
    '{"error":{"code":"x"}}',
    '{"error":"x"}',
    JSON.stringify({ error: { code: "x", message: "m".repeat(1001) } }),
    JSON.stringify({ error: { code: "x", message: "m", correlationId: "bad id with spaces" } }),
  ]) rejects(() => parseEngineError(bad), "ERROR_ENVELOPE");
});

test("portal readiness never reports ready for filings under this contract", () => {
  assert.equal(engineReadinessReason(lock, null), "upstream_unconfigured");
  assert.equal(engineReadinessReason(lock, { state: "unavailable" }), "upstream_unavailable");
  assert.equal(engineReadinessReason(lock, { state: "not_ready" }), "upstream_unavailable");
  assert.equal(engineReadinessReason(lock, { state: "contract_mismatch" }), "upstream_contract_mismatch");
  assert.equal(engineReadinessReason(lock, { state: "ready" }), "upstream_prerelease");
  assert.equal(engineReadinessReason({ prerelease: false, productionEligible: true }, { state: "ready" }),
    "portal_intake_unimplemented");
});

const secret = "0123456789abcdef0123456789abcdef";
const payload = { id: "dlv_1", type: "case.created", occurredAt: "2026-11-15T12:00:00.000Z",
  organizationId: "org_1", resource: { type: "case", id: "case_1", parentType: null, parentId: null },
  correlationId: null, source: "api", previousState: null, newState: { status: "open" }, metadata: {} };
function delivery({ body = JSON.stringify(payload), ts = "1763208000", key = secret, headers = {} } = {}) {
  const sig = createHmac("sha256", key).update(`${ts}.`).update(body).digest("hex");
  return { secret, rawBody: body, nowSeconds: 1763208010, headers: {
    "x-sicwe-delivery": "dlv_1", "x-sicwe-event": "case.created",
    "x-sicwe-timestamp": ts, "x-sicwe-signature": `sha256=${sig}`, ...headers } };
}

test("signed engine webhooks verify against the exact raw body", () => {
  const ok = verifyEngineWebhook(delivery());
  assert.equal(ok.deliveryId, "dlv_1");
  assert.equal(ok.event, "case.created");
  const h = delivery(); h.headers = new Headers(h.headers);
  assert.equal(verifyEngineWebhook(h).deliveryId, "dlv_1");
});

test("tampered, stale, replay-shaped and malformed webhooks fail closed", () => {
  const tampered = delivery(); tampered.rawBody = tampered.rawBody.replace("open", "closed");
  rejects(() => verifyEngineWebhook(tampered), "WEBHOOK_SIGNATURE");
  rejects(() => verifyEngineWebhook(delivery({ key: "f".repeat(32) })), "WEBHOOK_SIGNATURE");
  rejects(() => verifyEngineWebhook({ ...delivery(), nowSeconds: 1763208000 + 301 }), "WEBHOOK_TIMESTAMP_TOLERANCE");
  rejects(() => verifyEngineWebhook({ ...delivery(), nowSeconds: 1763208000 - 301 }), "WEBHOOK_TIMESTAMP_TOLERANCE");
  rejects(() => verifyEngineWebhook(delivery({ ts: "01763208000" })), "WEBHOOK_TIMESTAMP");
  const upper = delivery(); upper.headers["x-sicwe-signature"] = upper.headers["x-sicwe-signature"].toUpperCase();
  rejects(() => verifyEngineWebhook(upper), "WEBHOOK_SIGNATURE_FORMAT");
  const missing = delivery(); delete missing.headers["x-sicwe-delivery"];
  rejects(() => verifyEngineWebhook(missing), "WEBHOOK_HEADERS");
  rejects(() => verifyEngineWebhook(delivery({ headers: { "x-sicwe-event": "case.closed" } })), "WEBHOOK_PAYLOAD");
  rejects(() => verifyEngineWebhook(delivery({ headers: { "x-sicwe-delivery": "dlv_2" } })), "WEBHOOK_PAYLOAD");
  rejects(() => verifyEngineWebhook(delivery({ headers: { "x-sicwe-event": "CASE" } })), "WEBHOOK_HEADERS");
  rejects(() => verifyEngineWebhook({ ...delivery(), secret: "short" }), "WEBHOOK_SECRET");
  rejects(() => verifyEngineWebhook(delivery({ body: "x".repeat(256 * 1024 + 1) })), "WEBHOOK_BODY_SIZE");
  rejects(() => verifyEngineWebhook(delivery({ body: JSON.stringify({ ...payload, extra: 1 }) })), "WEBHOOK_PAYLOAD");
  rejects(() => verifyEngineWebhook(delivery({ body: "{not json" })), "WEBHOOK_BODY_JSON");
  const invalidUtf8 = Buffer.from([0x7b, 0xff, 0x7d]);
  const sig = createHmac("sha256", secret).update("1763208000.").update(invalidUtf8).digest("hex");
  rejects(() => verifyEngineWebhook({ secret, rawBody: invalidUtf8, nowSeconds: 1763208000, headers: {
    "x-sicwe-delivery": "dlv_1", "x-sicwe-event": "case.created", "x-sicwe-timestamp": "1763208000",
    "x-sicwe-signature": `sha256=${sig}` } }), "WEBHOOK_BODY_ENCODING");
  rejects(() => verifyEngineWebhook({ ...delivery(), toleranceSeconds: 86400 }), "WEBHOOK_CLOCK");
});

test("engine base URLs require HTTPS (loopback excepted) and carry no secrets", () => {
  assert.equal(parseEngineBaseUrl("https://intake.example.test/"), "https://intake.example.test");
  assert.equal(parseEngineBaseUrl("http://127.0.0.1:4000"), "http://127.0.0.1:4000");
  for (const bad of ["http://intake.example.test", "https://user:pw@intake.example.test",
    "https://intake.example.test/api", "https://intake.example.test/?token=x", "https://intake.example.test/#x",
    "ftp://intake.example.test", "", "not a url", "http://localhost.evil.test"])
    rejects(() => parseEngineBaseUrl(bad), "BASE_URL");
});

async function withEngine(handler, fn) {
  const seen = [];
  const server = createServer((req, res) => { seen.push(req); handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, seen); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
const json = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "content-type": type }); res.end(body);
};

test("probe reports ready and not_ready from a contract-valid engine without sending credentials", async () => {
  await withEngine((req, res) => req.url === "/api/health" ? json(res, 200, live()) : json(res, 200, ready("ready", "ok")),
    async (base, seen) => {
      assert.deepEqual({ ...await probeEngine({ baseUrl: base, lock }) }, { state: "ready", database: "ok" });
      assert.deepEqual(seen.map((r) => r.url), ["/api/health", "/api/ready"]);
      assert.ok(seen.every((r) => r.method === "GET" && !r.headers.authorization && !r.headers.cookie));
    });
  await withEngine((req, res) => req.url === "/api/health" ? json(res, 200, live()) : json(res, 503, ready("not_ready", "unavailable")),
    async (base) => assert.equal((await probeEngine({ baseUrl: base, lock })).state, "not_ready"));
});

test("probe fails closed on drift, oversize, wrong type, redirect, timeout and refusal", async () => {
  const mismatch = async (handler, code) => withEngine(handler, async (base) =>
    assert.deepEqual({ ...await probeEngine({ baseUrl: base, lock }) }, { state: "contract_mismatch", code }));
  await mismatch((req, res) => json(res, 200, live({ version: "1.0.0" })), "ENGINE_VERSION_MISMATCH");
  await mismatch((req, res) => json(res, 200, live() + " ".repeat(20000)), "RESPONSE_SIZE");
  await mismatch((req, res) => { res.writeHead(200, { "content-type": "application/json" });
    res.write(" ".repeat(10000)); res.end(" ".repeat(10000) + live()); }, "RESPONSE_SIZE");
  await mismatch((req, res) => json(res, 200, live(), "text/html"), "RESPONSE_CONTENT_TYPE");
  await withEngine((req, res) => { res.writeHead(302, { location: "https://elsewhere.example.test/" }); res.end(); },
    async (base) => assert.equal((await probeEngine({ baseUrl: base, lock })).state, "unavailable"));
  await withEngine(() => {}, async (base) => {
    const started = Date.now();
    assert.equal((await probeEngine({ baseUrl: base, lock, timeoutMs: 200 })).state, "unavailable");
    assert.ok(Date.now() - started < 5000);
  });
  const closed = await withEngine(() => {}, async (base) => base);
  assert.deepEqual({ ...await probeEngine({ baseUrl: closed, lock }) }, { state: "unavailable" });
  await assert.rejects(probeEngine({ baseUrl: "http://intake.example.test", lock }), EngineContractError);
});
