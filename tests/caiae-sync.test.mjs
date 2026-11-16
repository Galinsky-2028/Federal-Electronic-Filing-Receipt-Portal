import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dbTestOptions } from "./helpers/db.mjs";
import { buildApp, fileAndLogin } from "./helpers/app.mjs";
import { caiaeConfig } from "../src/platform/caiae-sync.mjs";

const opts = dbTestOptions();
const ORG = "2c21c4b1-175f-418b-ae54-d4939742062b";
const TOKEN = "caiau_0123456789_" + "s".repeat(43);

/** Minimal fake of the CAIAE resource/evidence API with fault injection. */
async function fakeCaiae(t) {
  const state = { resources: [], evidence: [], mode: "ok", calls: 0 };
  const server = createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    state.calls++;
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
    if (state.mode === "down") return send(503, { error: "sleeping" });
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === `/v1/organizations/${ORG}/resources`) return send(200, state.resources);
    if (req.method === "POST" && url.pathname === "/v1/resources") { const r = { id: randomUUID(), ...JSON.parse(body) }; state.resources.push(r); return send(201, r); }
    const m = /^\/v1\/organizations\/[^/]+\/resources\/([^/]+)\/evidence$/.exec(url.pathname);
    if (req.method === "GET" && m) return send(200, state.evidence.filter((e) => e.resourceId === m[1]));
    if (req.method === "POST" && url.pathname === "/v1/evidence") {
      const e = { id: randomUUID(), ...JSON.parse(body) }; state.evidence.push(e);
      if (state.mode === "lose-response") { state.mode = "ok"; req.socket.destroy(); return; } // stored, but the client never hears back
      return send(201, e);
    }
    send(404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

test("configuration is all-or-nothing and validated", () => {
  assert.equal(caiaeConfig({}), null);
  assert.throws(() => caiaeConfig({ CAIAE_API_BASE_URL: "https://x.example" }), /requires/);
  assert.throws(() => caiaeConfig({ CAIAE_API_BASE_URL: "http://caiae.example", CAIAE_ORGANIZATION_ID: ORG, CAIAE_OPERATOR_TOKEN: TOKEN }), /https/);
  assert.throws(() => caiaeConfig({ CAIAE_API_BASE_URL: "https://x.example", CAIAE_ORGANIZATION_ID: ORG, CAIAE_OPERATOR_TOKEN: "bad" }), /format/);
  assert.equal(caiaeConfig({ CAIAE_API_BASE_URL: "https://x.example/", CAIAE_ORGANIZATION_ID: ORG, CAIAE_OPERATOR_TOKEN: TOKEN }).baseUrl, "https://x.example");
});

test("ledger events reach CAIAE exactly once, in order, content-free, across lost responses and outages", opts, async (t) => {
  const caiae = await fakeCaiae(t);
  const { base, pool, runtime } = await buildApp(t, { CAIAE_API_BASE_URL: caiae.url, CAIAE_ORGANIZATION_ID: ORG, CAIAE_OPERATOR_TOKEN: TOKEN });
  const sync = runtime.features.caiaeSync;
  assert.ok(sync);
  await fileAndLogin(base, { title: "Synthetic CAIAE test" });
  const head = () => pool.query("SELECT seq FROM ledger_head").then((r) => Number(r.rows[0].seq));
  assert.equal(await sync.run(), await head());
  assert.equal(caiae.state.resources.length, 1);
  assert.match(caiae.state.resources[0].name, /fictional/);
  const seqs = caiae.state.evidence.map((e) => e.attributes.ledgerSeq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  const filed = caiae.state.evidence.find((e) => e.attributes.eventType === "filing.received");
  assert.equal(filed.attributes.payload.trackingNumber, undefined, "tracking numbers are not forwarded");
  assert.doesNotMatch(JSON.stringify(caiae.state.evidence), /Synthetic CAIAE test|Pat Example|Synthetic claim text/);
  const entry = (await pool.query("SELECT entry_hash FROM ledger_entries WHERE seq = $1", [filed.attributes.ledgerSeq])).rows[0].entry_hash;
  assert.equal(filed.checksum, entry);
  // Lost response: CAIAE stored the record but the portal did not hear back; reconciliation prevents a duplicate.
  await fileAndLogin(base, { title: "Second synthetic" });
  caiae.state.mode = "lose-response";
  await sync.run();
  assert.ok((await sync.status()).lastError);
  await pool.query("UPDATE caiae_sync SET next_attempt_at = NULL");
  await sync.run();
  assert.equal((await sync.status()).lag, 0);
  const all = caiae.state.evidence.map((e) => e.attributes.ledgerSeq);
  assert.equal(new Set(all).size, all.length, "no duplicate evidence");
  assert.equal(all.length, await head());
  // Outage: retries back off without losing or duplicating anything.
  await fileAndLogin(base, { title: "Third synthetic" });
  caiae.state.mode = "down";
  assert.equal(await sync.run(), 0);
  const st = (await pool.query("SELECT attempts, next_attempt_at FROM caiae_sync")).rows[0];
  assert.equal(st.attempts, 1);
  assert.ok(st.next_attempt_at > new Date());
  const callsBefore = caiae.state.calls;
  assert.equal(await sync.run(), 0, "respects backoff");
  assert.equal(caiae.state.calls, callsBefore);
  caiae.state.mode = "ok";
  await pool.query("UPDATE caiae_sync SET next_attempt_at = NULL");
  await sync.run();
  assert.equal((await sync.status()).lag, 0);
  assert.equal(caiae.state.evidence.length, await head());
  assert.equal(caiae.state.resources.length, 1, "resource reused");
});
