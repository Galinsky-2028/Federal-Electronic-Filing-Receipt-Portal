import test from "node:test";
import assert from "node:assert/strict";
import { dbTestOptions } from "./helpers/db.mjs";
import { buildApp, field, fileAndLogin, filingForm, get, post, staffLogin } from "./helpers/app.mjs";

const opts = dbTestOptions();

/** Lightweight automated accessibility checks (UFR-029); not a substitute for manual assistive-technology testing. */
function a11y(html, path) {
  assert.match(html, /<html lang="en">/, path);
  assert.equal((html.match(/<h1[ >]/g) ?? []).length, 1, `${path}: exactly one h1`);
  assert.match(html, /href="#main">Skip to main content/, path);
  assert.doesNotMatch(html, /<script\b|\son[a-z]+=|style="/i, `${path}: no scripts or inline styles`);
  for (const [, id] of html.matchAll(/<(?:input|select|textarea)\b(?![^>]*type="(?:hidden|submit)")[^>]*\bid="([^"]+)"/g))
    assert.match(html, new RegExp(`<label for="${id}"`), `${path}: #${id} has a label`);
  for (const tag of html.matchAll(/<(?:input|select|textarea)\b(?![^>]*type="hidden")[^>]*>/g))
    assert.match(tag[0], /\bid="|type="(?:submit|checkbox)"/, `${path}: form control has an id`);
  assert.ok(Buffer.byteLength(html) < 60_000, `${path}: page under 60 KB for low bandwidth`);
}

test("public pages pass automated accessibility and low-bandwidth checks", opts, async (t) => {
  const { base } = await buildApp(t);
  const f = await fileAndLogin(base);
  for (const path of ["/", "/file", "/file/guide", "/file/guide/tort-claim-notice", "/file/resume", "/track", "/verify", "/transparency", "/help/assistance"]) {
    const res = await get(base, path);
    assert.equal(res.status, 200, path);
    a11y(await res.text(), path);
  }
  const es = await (await get(base, "/es")).text();
  assert.match(es, /<div lang="es">/);
  assert.match(es, /No es un servicio oficial del Gobierno de los Estados Unidos/);
  a11y(await (await get(base, "/track/case", f.cookie)).text(), "/track/case");
  const s = await staffLogin(base);
  for (const path of ["/staff", "/staff/oversight", "/staff/records", "/staff/reveals", "/staff/mfa", "/staff/admin/users", "/staff/notifications"])
    a11y(await (await get(base, path, s.cookie)).text(), path);
  const receiptId = (await (await get(base, "/track/case", f.cookie)).text()).match(/(RCPT-DEMO-[0-9A-Z]{20})/)[1];
  const txt = await get(base, `/track/receipts/${receiptId}.txt`, f.cookie);
  assert.match(txt.headers.get("content-type"), /^text\/plain/);
  assert.match(await txt.text(), /DEMONSTRATION RECEIPT - NOT A GOVERNMENT RECEIPT/);
});

test("guided forms enforce type-specific fields; generic form stays lenient", opts, async (t) => {
  const { base, pool } = await buildApp(t);
  const page = await (await get(base, "/file/guide/tort-claim-notice")).text();
  assert.match(page, /Sum certain claimed/);
  const key = field(page, "idempotencyKey");
  const base0 = { agencyId: "demo-tort-claims-desk", filingType: "tort-claim-notice", guided: "yes" };
  let res = await post(base, "/file", filingForm(key, { ...base0, incidentDate: "2026-10-01", incidentLocation: "Synthetic St", injuryType: "property" }));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /sum certain/);
  res = await post(base, "/file", filingForm(key, { ...base0, incidentDate: "2026-10-01", incidentLocation: "Synthetic St", injuryType: "property", sumCertain: "-5" }));
  assert.equal(res.status, 400);
  res = await post(base, "/file", filingForm(key, { ...base0, incidentDate: "2026-10-01", incidentLocation: "Synthetic St", injuryType: "property", sumCertain: "1250.00" }));
  assert.equal(res.status, 201);
  const s = await staffLogin(base);
  const id = (await pool.query("SELECT id FROM submissions LIMIT 1")).rows[0].id;
  assert.match(await (await get(base, `/staff/submissions/${id}`, s.cookie)).text(), /sumCertain<\/dt><dd>1250\.00/);
  const generic = await post(base, "/file", filingForm(field(await (await fetch(base + "/file")).text(), "idempotencyKey"), { agencyId: "demo-tort-claims-desk", filingType: "tort-claim-notice" }));
  assert.equal(generic.status, 201);
});

test("resumable uploads: chunked with offsets, token-bound, attachable once", opts, async (t) => {
  const { base, pool } = await buildApp(t);
  const content = Buffer.from("%PDF-1.4 " + "x".repeat(3000));
  const create = await post(base, "/api/uploads", JSON.stringify({ filename: "big.pdf", mediaType: "application/pdf", size: content.length }), { type: "application/json", origin: null });
  assert.equal(create.status, 201);
  const { uploadId, uploadToken } = await create.json();
  const put = (start, end, token = uploadToken) => fetch(`${base}/api/uploads/${uploadId}`, { method: "PUT", body: content.subarray(start, end + 1),
    headers: { "x-upload-token": token, "content-range": `bytes ${start}-${end}/${content.length}` } });
  assert.equal((await put(0, 999, "wrong-token")).status, 404);
  assert.equal((await put(0, 999)).status, 200);
  assert.equal((await put(2000, 2999)).status, 409, "offset gap refused");
  const st = await (await fetch(`${base}/api/uploads/${uploadId}`, { headers: { "x-upload-token": uploadToken } })).json();
  assert.deepEqual(st, { received: 1000, total: content.length, completed: false });
  assert.equal((await put(1000, content.length - 1)).status, 200);
  const key = field(await (await fetch(base + "/file")).text(), "idempotencyKey");
  const res = await post(base, "/file", filingForm(key, { uploadTokens: `${uploadId}:${uploadToken}` }));
  assert.equal(res.status, 201);
  const doc = (await pool.query("SELECT size_bytes, sha256 FROM documents")).rows[0];
  assert.equal(doc.size_bytes, content.length);
  const again = await post(base, "/file", filingForm(field(await (await fetch(base + "/file")).text(), "idempotencyKey"), { uploadTokens: `${uploadId}:${uploadToken}` }));
  assert.equal(again.status, 409, "an upload attaches to one filing only");
});

test("transparency suppresses small counts; metrics and event feed require their tokens; checkpoints are public", opts, async (t) => {
  const { base } = await buildApp(t, { METRICS_TOKEN: "m".repeat(40), EVENTS_FEED_TOKEN: "e".repeat(40) });
  await fileAndLogin(base);
  const tr = await (await get(base, "/transparency")).text();
  assert.match(tr, /fewer than 5/);
  assert.match(tr, /synthetic demonstration data/);
  assert.equal((await get(base, "/api/metrics")).status, 401);
  const metrics = await fetch(`${base}/api/metrics`, { headers: { authorization: "Bearer " + "m".repeat(40) } });
  assert.match(await metrics.text(), /ufr_submissions\{kind="original"\} 1/);
  assert.equal((await fetch(`${base}/api/events/after/0`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  const feed = await (await fetch(`${base}/api/events/after/0`, { headers: { authorization: "Bearer " + "e".repeat(40) } })).json();
  assert.deepEqual(feed.events.map((e) => e.eventType), ["staff.bootstrapped", "filing.received"]);
  assert.doesNotMatch(JSON.stringify(feed), /Pat Example|Synthetic claim text/, "feed is content-free");
  const cps = await (await get(base, "/api/ledger/checkpoints")).json();
  assert.equal(cps.schema, "ufr-demo-ledger-checkpoints-v1");
});
