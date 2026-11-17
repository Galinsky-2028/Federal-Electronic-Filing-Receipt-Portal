import test from "node:test";
import assert from "node:assert/strict";
import { dbTestOptions } from "./helpers/db.mjs";
import { buildApp, cookieOf, field, filingForm, FORM, form, post, staffCsrf, staffLogin } from "./helpers/app.mjs";
import { GUIDE } from "../src/platform/guided.mjs";
import { translateHtml } from "../src/platform/i18n.mjs";
import { SoftAuthenticator } from "../scripts/lib/soft-authenticator.mjs";

const opts = dbTestOptions();
const USER_TEXT = ["Synthetic claim &lt;script&gt;", "Synthetic claim text.", "Pat Example", "pat@example.test", "x", "t", "b", "n"];
const DATA = /^(DEMO-[0-9A-Z-]+|RCPT-DEMO-[0-9A-Z]+|[0-9A-Z]{4}(-[0-9A-Z]{4}){5}|[0-9a-f]{64}|demo-ed25519-[0-9a-f]+|\d{4}-\d{2}-\d{2}T[\d:.]+Z|[·#\d\s().,:;-]+|\(Ed25519\)|SHA-256|JSON|Español|English|Información en español|no|general|original|Ed25519|DEMO-XXXX-XXXX-XXXX)$/;

/** Visits every claimant page and state, optionally in Spanish, returning the HTML of each. */
async function crawl(app, lang) {
  const { base, pool } = app;
  const lc = lang === "es" ? "ufr_lang=es" : "";
  const withLang = (cookie) => [cookie, lc].filter(Boolean).join("; ");
  const get = (p, cookie) => fetch(base + p, { redirect: "manual", headers: { cookie: withLang(cookie) } });
  const postL = (p, body, o = {}) => post(base, p, body, { ...o, cookie: withLang(o.cookie) });
  const pages = {};
  for (const p of ["/file", "/file/guide", "/file/resume", "/track", "/verify", "/help/assistance", ...GUIDE.map((g) => "/file/guide/" + g.type)])
    pages[p] = await (await get(p)).text();
  const key = field(pages["/file"], "idempotencyKey");
  const fd = filingForm(key); fd.append("files", new Blob(["%PDF-1.4 x"], { type: "application/pdf" }), "a.pdf");
  pages.filed = await (await postL("/file", fd)).text();
  const tracking = pages.filed.match(/<code class="big">(DEMO-[0-9A-Z-]+)<\/code>/)[1];
  const access = [...pages.filed.matchAll(/<code class="big">([0-9A-Z-]+)<\/code>/g)][1][1];
  const owner = cookieOf(await post(base, "/track", form({ trackingNumber: tracking, accessCode: access }), { type: FORM }));
  const s = await staffLogin(base);
  const id = (await pool.query("SELECT id FROM submissions ORDER BY received_at DESC LIMIT 1")).rows[0].id;
  const csrf = await staffCsrf(base, s.cookie, `/staff/submissions/${id}`);
  await post(base, `/staff/submissions/${id}/transition`, form({ csrf, to: "acknowledged", note: "x" }), { cookie: s.cookie, type: FORM });
  await post(base, `/staff/submissions/${id}/notice`, form({ csrf, kind: "defect", body: "x" }), { cookie: s.cookie, type: FORM });
  let caseHtml = await (await get("/track/case", owner)).text();
  const ccsrf = field(caseHtml, "csrf");
  await post(base, "/track/corrections", form({ csrf: ccsrf, kind: "receipt_correction", statement: "x" }), { cookie: owner, type: FORM });
  pages.delegation = await (await postL("/track/delegations", form({ csrf: ccsrf, label: "x", scope: "view" }), { cookie: owner, type: FORM })).text();
  pages.case = await (await get("/track/case", owner)).text();
  const receipt = pages.case.match(/<pre class="receipt-json">([\s\S]*?)<\/pre>/)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  pages.verifyOk = await (await postL("/verify", form({ receipt }), { type: FORM })).text();
  pages.verifyBad = await (await postL("/verify", form({ receipt: "{}" }), { type: FORM })).text();
  const draft = new FormData(); for (const [k, v] of Object.entries({ action: "draft", idempotencyKey: "k".repeat(20), agencyId: "demo-benefits-claims-office", filingType: "complaint", title: "t", body: "b", claimantName: "n" })) draft.append(k, v);
  pages.draft = await (await postL("/file", draft)).text();
  pages.classified = await (await postL("/file", filingForm("k".repeat(20), { body: "TOP SECRET//NOFORN" }))).text();
  pages.missingAttest = await (await postL("/file", filingForm("k".repeat(21), { attest_demo: undefined }))).text();
  pages.guidedMissing = await (await postL("/file", filingForm("k".repeat(22), { agencyId: "demo-tort-claims-desk", filingType: "tort-claim-notice", guided: "yes" }))).text();
  pages.trackBad = await (await postL("/track", form({ trackingNumber: "x", accessCode: "y" }), { type: FORM })).text();
  pages.resumeBad = await (await postL("/file/resume", form({ draftCode: "x" }), { type: FORM })).text();
  // Accounts: signed out, registration, dashboard with a linked filing, codes, contact recovery, errors.
  pages.accountSignedOut = await (await get("/account")).text();
  const authn = new SoftAuthenticator({ origin: base, rpID: new URL(base).hostname });
  const j = async (p, body) => (await post(base, p, JSON.stringify(body), { type: "application/json" })).json();
  const ro = await j("/account/register/options", { label: "x" });
  const acct = cookieOf(await post(base, "/account/register/verify", JSON.stringify({ challengeId: ro.challengeId, response: authn.create(ro.options) }), { type: "application/json" }));
  const acsrf = field(await (await get("/account", acct)).text(), "csrf");
  pages.accountLinkBad = await (await postL("/account/link", form({ csrf: acsrf, trackingNumber: tracking, accessCode: "x" }), { cookie: acct, type: FORM })).text();
  await post(base, "/account/link", form({ csrf: acsrf, trackingNumber: tracking, accessCode: access }), { cookie: acct, type: FORM });
  pages.accountDashboard = await (await get("/account", acct)).text();
  pages.accountCodes = await (await postL("/account/recovery-codes", form({ csrf: acsrf }), { cookie: acct, type: FORM })).text();
  pages.accountContact = await (await postL("/account/recovery/contact", form({ channel: "sms", contact: "555" }), { type: FORM })).text();
  pages.accountRecoverBad = await (await postL("/account/recover", form({ code: "x" }), { type: FORM })).text();
  return pages;
}
function segments(html) {
  const out = new Set();
  const body = html.replace(/<pre[\s>][\s\S]*?<\/pre>/g, "");
  for (const m of body.matchAll(/>([^<>]+)</g)) { const t = m[1].trim(); if (t && /[A-Za-z]{2}/.test(t)) out.add(t); }
  for (const m of body.matchAll(/(?:aria-label|placeholder)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

test("every claimant page and state is fully translated into Spanish without altering data", opts, async (t) => {
  const en = await crawl(await buildApp(t), "en");
  const es = await crawl(await buildApp(t), "es");
  const english = new Set(Object.values(en).flatMap((h) => [...segments(h)]));
  const leftovers = new Map();
  for (const [page, html] of Object.entries(es)) {
    assert.match(html, /<html lang="es">/, page);
    for (const seg of segments(html)) if (english.has(seg) && !DATA.test(seg) && !USER_TEXT.includes(seg)) leftovers.set(seg, page);
  }
  assert.deepEqual([...leftovers.entries()], [], "untranslated English UI text on Spanish pages");
  // Data is untouched: form field names/values, the signed receipt JSON and user text remain identical.
  const names = (h) => [...h.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(names(es["/file"]), names(en["/file"]));
  assert.match(es.case, /&quot;notice&quot;: &quot;DEMONSTRATION RECEIPT issued by a development prototype/, "signed JSON untouched");
  assert.match(es.case, /aviso de deficiencia emitido: Subsanar antes del \d{4}-\d{2}-\d{2} \(hora del Este\)\./);
  assert.doesNotMatch(es.case, /Cure by/);
  assert.match(es.case, /Synthetic claim &lt;script&gt;/);
  assert.match(es.filed, /No es un servicio oficial de presentación del Gobierno de los Estados Unidos/);
  assert.match(es.verifyOk, /Acuse de demostración válido/);
  assert.match(es.guidedMissing, /Complete el campo obligatorio «fecha del incidente»/);
  assert.match(es.classified, /No se guardó/);
});

test("language selection: cookie switch, Accept-Language, staff pages stay English", opts, async (t) => {
  const { base } = await buildApp(t);
  const sw = await fetch(base + "/idioma/es", { redirect: "manual" });
  assert.equal(sw.status, 303);
  assert.match(sw.headers.get("set-cookie"), /^ufr_lang=es; Path=\/; SameSite=Lax/);
  const res = await fetch(base + "/file", { headers: { cookie: "ufr_lang=es" } });
  assert.equal(res.headers.get("content-language"), "es");
  const html = await res.text();
  assert.match(html, /Enviar una presentación de demostración/);
  assert.match(html, /href="\/language\/en" lang="en">English</);
  assert.match(await (await fetch(base + "/track", { headers: { "accept-language": "es-US,es;q=0.9,en;q=0.5" } })).text(), /Seguimiento de una presentación de demostración/);
  assert.match(await (await fetch(base + "/track", { headers: { "accept-language": "es", cookie: "ufr_lang=en" } })).text(), /Track a demonstration filing/);
  assert.match(await (await fetch(base + "/staff", { headers: { cookie: "ufr_lang=es" } })).text(), /Staff sign-in/);
  assert.equal(translateHtml("<html lang=\"en\"><p>Track</p></html>", "en"), "<html lang=\"en\"><p>Track</p></html>");
});
