import test from "node:test";
import assert from "node:assert/strict";
import { dbTestOptions, freshPool } from "./helpers/db.mjs";
import { createPortalServer } from "../src/server.mjs";
import { createAuth } from "../src/demo/auth.mjs";
import { LocalIntakeBackend } from "../src/demo/backend.mjs";
import { createDemoHandler } from "../src/demo/routes.mjs";
import { generateSigningKeyEncoded, loadSigningKey } from "../src/demo/signing.mjs";
import { createDemoRuntime } from "../src/demo/runtime.mjs";

const opts = dbTestOptions();
const STAFF = { user: "demo-staff", pass: "synthetic-staff-password-123" };

async function serve(t) {
  const pool = await freshPool(t);
  const backend = new LocalIntakeBackend({ pool, signer: loadSigningKey(generateSigningKeyEncoded()) });
  const auth = createAuth({ secret: "x".repeat(40), staffUsername: STAFF.user, staffPassword: STAFF.pass, secureCookies: false });
  const handler = createDemoHandler({ backend, auth });
  const server = createPortalServer({ demo: { handler, ready: async () => true } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, backend, pool };
}
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const post = (base, path, body, { cookie, origin = base, type } = {}) => fetch(base + path, { method: "POST", redirect: "manual", body,
  headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(type ? { "content-type": type } : {}) } });
const form = (o) => new URLSearchParams(o).toString();
const FORM = "application/x-www-form-urlencoded";
const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];

function filingForm(key, extra = {}) {
  const fd = new FormData();
  const v = { idempotencyKey: key, agencyId: "demo-benefits-claims-office", filingType: "administrative-claim",
    title: "Synthetic claim <script>", body: "Synthetic claim text.", claimantName: "Pat Example", claimantContact: "pat@example.test",
    attest_demo: "yes", attest_synthetic: "yes", attest_unclassified: "yes", ...extra };
  for (const [k, val] of Object.entries(v)) if (val !== undefined) fd.append(k, val);
  return fd;
}

test("end-to-end demo: file, receipt, track, amend, verify, staff review", opts, async (t) => {
  const { base, backend } = await serve(t);
  const page = await fetch(base + "/file");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /form-action 'self'/);
  const html = await page.text();
  assert.match(html, /Not an official U\.S\. Government filing service/);
  assert.match(html, /\(fictional\)/);
  const key = field(html, "idempotencyKey");
  const fd = filingForm(key);
  fd.append("files", new Blob(["%PDF-1.4 synthetic"], { type: "application/pdf" }), "evidence.pdf");
  const filed = await post(base, "/file", fd);
  assert.equal(filed.status, 201);
  const receiptHtml = await filed.text();
  assert.doesNotMatch(receiptHtml, /<script>/);
  assert.match(receiptHtml, /NOT A GOVERNMENT RECEIPT/);
  const tracking = receiptHtml.match(/Tracking number: <code class="big">(DEMO-[0-9A-Z-]+)<\/code>/)[1];
  const access = receiptHtml.match(/Access code: <code class="big">([0-9A-Z-]+)<\/code>/)[1];

  const replay = await post(base, "/file", (() => { const f = filingForm(key); f.append("files", new Blob(["%PDF-1.4 synthetic"], { type: "application/pdf" }), "evidence.pdf"); return f; })());
  assert.equal(replay.status, 200);
  assert.match(await replay.text(), /already received/);

  assert.equal((await post(base, "/track", form({ trackingNumber: tracking, accessCode: "WRONG" }), { type: FORM })).status, 401);
  const login = await post(base, "/track", form({ trackingNumber: tracking, accessCode: access }), { type: FORM });
  assert.equal(login.status, 303);
  const pc = cookieOf(login);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const caseHtml = await (await fetch(base + "/track/case", { headers: { cookie: pc } })).text();
  assert.match(caseHtml, /Received \(demo receipt issued\)/);
  const csrf = field(caseHtml, "csrf");
  const receiptId = caseHtml.match(/(RCPT-DEMO-[0-9A-Z]{20})/)[1];
  const download = await fetch(`${base}/track/receipts/${receiptId}.json`, { headers: { cookie: pc } });
  const doc = await download.json();
  assert.equal((await fetch(`${base}/track/receipts/${receiptId}.json`, { redirect: "manual" })).status, 303, "no cookie, no receipt");

  const amendNoCsrf = filingForm(field(caseHtml, "idempotencyKey"), { agencyId: "demo-benefits-claims-office", title: "Supplement" });
  assert.equal((await post(base, "/track/amend", amendNoCsrf, { cookie: pc })).status, 403);
  const amend = filingForm(field(caseHtml, "idempotencyKey"), { csrf, title: "Supplement" });
  assert.equal((await post(base, "/track/amend", amend, { cookie: pc })).status, 303);
  assert.equal(((await (await fetch(base + "/track/case", { headers: { cookie: pc } })).text()).match(/DEMONSTRATION RECEIPT ·/g) ?? []).length, 2);

  const ok = await (await post(base, "/api/verify", JSON.stringify(doc), { type: "application/json" })).json();
  assert.equal(ok.valid, true);
  assert.equal(ok.receiptId, receiptId);
  const forged = structuredClone(doc); forged.receipt.agency.name = "U.S. Department of Justice";
  assert.equal((await (await post(base, "/api/verify", JSON.stringify(forged), { type: "application/json" })).json()).valid, false);
  const verifyHtml = await (await post(base, "/verify", form({ receipt: JSON.stringify(doc) }), { type: FORM })).text();
  assert.match(verifyHtml, /Valid demonstration receipt/);
  assert.doesNotMatch(verifyHtml, /Synthetic claim text/);
  const keys = await (await fetch(base + "/api/receipts/keys")).json();
  assert.equal(keys.keys[0].kid, doc.signature.keyId);
  assert.equal(keys.keys[0].d, undefined, "private key material never published");

  assert.equal((await fetch(base + "/staff", { redirect: "manual" })).status, 200);
  assert.equal((await post(base, "/staff/login", form({ username: STAFF.user, password: "wrong-password-xx" }), { type: FORM })).status, 401);
  const staffLogin = await post(base, "/staff/login", form({ username: STAFF.user, password: STAFF.pass }), { type: FORM });
  assert.equal(staffLogin.status, 303);
  const sc = cookieOf(staffLogin);
  assert.equal((await fetch(base + "/staff/ledger", { headers: { cookie: pc }, redirect: "manual" })).status, 303, "participant cookie is not staff");
  const queue = await (await fetch(base + "/staff", { headers: { cookie: sc } })).text();
  const id = queue.match(/\/staff\/submissions\/([0-9a-f-]{36})/)[1];
  const detail = await (await fetch(`${base}/staff/submissions/${id}`, { headers: { cookie: sc } })).text();
  const scsrf = field(detail, "csrf");
  assert.equal((await post(base, `/staff/submissions/${id}/status`, form({ status: "under_review", note: "x", csrf: "bad" }), { cookie: sc, type: FORM })).status, 403);
  assert.equal((await post(base, `/staff/submissions/${id}/status`, form({ status: "under_review", note: "Synthetic", csrf: scsrf }), { cookie: sc, type: FORM })).status, 303);
  const docId = detail.match(/\/staff\/documents\/([0-9a-f-]{36})/)?.[1];
  if (docId) {
    const file = await fetch(`${base}/staff/documents/${docId}`, { headers: { cookie: sc } });
    assert.match(file.headers.get("content-disposition"), /^attachment/);
    assert.equal(await file.text(), "%PDF-1.4 synthetic");
  }
  assert.match(await (await fetch(base + "/staff/ledger", { headers: { cookie: sc } })).text(), /Hash chain valid/);
  assert.equal(await backend.deliverDueRoutings(), 2);
});

test("cross-origin posts, missing attestations, oversize and bad types fail closed", opts, async (t) => {
  const { base, pool } = await serve(t);
  const key = field(await (await fetch(base + "/file")).text(), "idempotencyKey");
  assert.equal((await post(base, "/file", filingForm(key), { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(base, "/file", filingForm(key), { origin: null })).status, 403);
  assert.equal((await post(base, "/file", filingForm(key, { attest_synthetic: undefined }))).status, 400);
  const exe = filingForm(key); exe.append("files", new Blob(["MZ"], { type: "application/x-msdownload" }), "x.exe");
  assert.equal((await post(base, "/file", exe)).status, 400);
  const disguised = filingForm(key); disguised.append("files", new Blob(["MZ not pdf"], { type: "application/pdf" }), "x.pdf");
  assert.match(await (await post(base, "/file", disguised)).text(), /does not match its file type/);
  const big = filingForm(key); big.append("files", new Blob([Buffer.alloc(5 * 1024 * 1024 + 10, 65)], { type: "text/plain" }), "big.txt");
  assert.equal((await post(base, "/file", big)).status, 413);
  assert.equal((await post(base, "/track", "{}", { type: "application/json" })).status, 415);
  assert.equal((await fetch(base + "/file", { method: "PUT" })).status, 405);
  assert.equal(Number((await pool.query("SELECT count(*) FROM submissions")).rows[0].count), 0);
  const ready = await fetch(base + "/api/ready");
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).filingsAccepted, false);
  const home = await (await fetch(base + "/")).text();
  assert.match(home, /demonstration only/);
  assert.match(home, /href="\/file"/);
});

test("runtime refuses partial configuration and stays off when unconfigured", async () => {
  assert.equal(await createDemoRuntime({}), null);
  await assert.rejects(createDemoRuntime({ DATABASE_URL: "postgres://x@localhost/y" }), /missing RECEIPT_SIGNING_KEY, SESSION_SECRET/);
  await assert.rejects(createDemoRuntime({ DATABASE_URL: "postgres://x@localhost/y", RECEIPT_SIGNING_KEY: "bm90LWEta2V5", SESSION_SECRET: "x".repeat(40) }),
    /not a valid PKCS#8 key/);
  const server = createPortalServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(base + "/file");
    assert.equal(res.status, 503);
    assert.match(await res.text(), /Demo filing is not configured/);
    assert.equal((await fetch(base + "/api/receipts/keys")).status, 503);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
