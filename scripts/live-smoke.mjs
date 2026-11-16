#!/usr/bin/env node
// End-to-end smoke of a deployed DEMO portal using one synthetic filing:
// health, readiness, demo banner, file -> signed receipt -> public verify,
// tamper rejection, tracking login, published keys. Usage:
//   PORTAL_BASE_URL=https://... node scripts/live-smoke.mjs
const base = (process.env.PORTAL_BASE_URL ?? process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https:\/\/[a-z0-9.-]+$/.test(base) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) { console.error("PORTAL_BASE_URL must be an https origin"); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(JSON.stringify({ name, ok, detail })); if (!ok) throw new Error(name); };
async function wake() {
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(90_000) }); if (r.ok) return r; } catch {}
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error("portal did not wake");
}
try {
  const health = await (await wake()).json();
  check("health_prototype_only", health.authority === "prototype-only" && health.filingsAccepted === false);
  const ready = await fetch(base + "/api/ready");
  const readyBody = await ready.json();
  check("ready_demo_backend", ready.status === 200 && readyBody.backend === "portal-local-demo" && readyBody.filingsAccepted === false);
  const home = await (await fetch(base + "/")).text();
  check("home_not_government_banner", /Not an official U\.S\. Government filing service/.test(home) && /demonstration only/i.test(home));
  const page = await fetch(base + "/file");
  const html = await page.text();
  const key = html.match(/name="idempotencyKey" value="([^"]+)"/)?.[1];
  check("file_form", page.status === 200 && Boolean(key) && /\(fictional\)/.test(html));
  const fd = new FormData();
  for (const [k, v] of Object.entries({ idempotencyKey: key, agencyId: "demo-records-access-unit", filingType: "records-request",
    title: "Automated smoke test (synthetic)", body: "Synthetic smoke-test filing. No real data.", claimantName: "Smoke Test Bot",
    claimantContact: "", attest_demo: "yes", attest_synthetic: "yes", attest_unclassified: "yes" })) fd.append(k, v);
  fd.append("files", new Blob(["synthetic smoke attachment\n"], { type: "text/plain" }), "smoke.txt");
  const filed = await fetch(base + "/file", { method: "POST", body: fd, headers: { origin: base } });
  const receiptHtml = await filed.text();
  check("filing_receipt_issued", filed.status === 201 && /NOT A GOVERNMENT RECEIPT/.test(receiptHtml), String(filed.status));
  const json = receiptHtml.match(/<pre class="receipt-json">([\s\S]*?)<\/pre>/)?.[1]
    ?.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const doc = JSON.parse(json);
  check("receipt_demo_notice", doc.receipt.demo === true && /Not issued by or on behalf of the United States Government/.test(doc.receipt.notice));
  const verify = async (d) => (await fetch(base + "/api/verify", { method: "POST", body: JSON.stringify(d),
    headers: { origin: base, "content-type": "application/json" } })).json();
  const v = await verify(doc);
  check("receipt_verifies", v.valid === true && v.receiptId === doc.receipt.receiptId);
  const forged = structuredClone(doc); forged.receipt.receivedAt = "2000-01-01T00:00:00.000Z";
  check("forgery_rejected", (await verify(forged)).valid === false);
  const tracking = receiptHtml.match(/Tracking number: <code class="big">(DEMO-[0-9A-Z-]+)<\/code>/)?.[1];
  const access = receiptHtml.match(/Access code: <code class="big">([0-9A-Z-]+)<\/code>/)?.[1];
  const login = await fetch(base + "/track", { method: "POST", redirect: "manual", body: new URLSearchParams({ trackingNumber: tracking, accessCode: access }),
    headers: { origin: base, "content-type": "application/x-www-form-urlencoded" } });
  check("tracking_login", login.status === 303 && /ufr_participant=.*HttpOnly.*Secure/i.test(login.headers.get("set-cookie") ?? ""));
  const keys = await (await fetch(base + "/api/receipts/keys")).json();
  check("published_key_matches", keys.keys.some((k) => k.kid === doc.signature.keyId && k.d === undefined));
  const cross = await fetch(base + "/api/verify", { method: "POST", body: "{}", headers: { origin: "https://evil.example", "content-type": "application/json" } });
  check("cross_origin_rejected", cross.status === 403);
  console.log(JSON.stringify({ base, passing: results.length, status: "passed" }));
} catch (error) {
  console.error(JSON.stringify({ base, passing: results.filter((r) => r.ok).length, status: "failed", error: String(error?.message ?? error) }));
  process.exit(1);
}
