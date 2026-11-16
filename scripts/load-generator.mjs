#!/usr/bin/env node
// Load test (UFR-057/058 evidence): concurrent synthetic filings and receipt
// verifications. Use against local or staging instances, not production.
//   PORTAL_BASE_URL=http://127.0.0.1:3000 CONCURRENCY=10 FILINGS=50 node scripts/load-generator.mjs
const base = process.env.PORTAL_BASE_URL ?? "http://127.0.0.1:3000";
const concurrency = Number(process.env.CONCURRENCY ?? 10); const total = Number(process.env.FILINGS ?? 50);
const lat = { file: [], verify: [] }; let errors = 0; let next = 0;
async function one(i) {
  const page = await (await fetch(base + "/file")).text();
  const key = page.match(/name="idempotencyKey" value="([^"]+)"/)[1];
  const fd = new FormData();
  for (const [k, v] of Object.entries({ idempotencyKey: key, agencyId: "demo-benefits-claims-office", filingType: "general-correspondence",
    title: `Load test ${i} (synthetic)`, body: "Synthetic load-test filing.", claimantName: "Load Bot", attest_demo: "yes", attest_synthetic: "yes", attest_unclassified: "yes" })) fd.append(k, v);
  let t = performance.now();
  const res = await fetch(base + "/file", { method: "POST", body: fd, headers: { origin: base, "x-forwarded-for": `10.0.${i >> 8}.${i & 255}` } });
  const html = await res.text(); lat.file.push(performance.now() - t);
  if (res.status !== 201) { errors++; return; }
  const json = html.match(/<pre class="receipt-json">([\s\S]*?)<\/pre>/)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  t = performance.now();
  const v = await (await fetch(base + "/api/verify", { method: "POST", body: json, headers: { origin: base, "content-type": "application/json" } })).json();
  lat.verify.push(performance.now() - t);
  if (!v.valid) errors++;
}
const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => { while (next < total) { const i = next++; try { await one(i); } catch { errors++; } } }));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };
console.log(JSON.stringify({ base, concurrency, filings: total, errors, seconds: ((performance.now() - started) / 1000).toFixed(1),
  fileMs: { p50: pct(lat.file, 0.5), p95: pct(lat.file, 0.95), max: pct(lat.file, 1) }, verifyMs: { p50: pct(lat.verify, 0.5), p95: pct(lat.verify, 0.95) } }));
if (errors) process.exit(1);
