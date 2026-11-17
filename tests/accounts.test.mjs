import test from "node:test";
import assert from "node:assert/strict";
import { dbTestOptions } from "./helpers/db.mjs";
import { buildApp, cookieOf, field, fileAndLogin, FORM, form, get, post } from "./helpers/app.mjs";
import { SoftAuthenticator } from "../scripts/lib/soft-authenticator.mjs";

const opts = dbTestOptions();
const JSONT = "application/json";

async function setup(t) {
  const app = await buildApp(t);
  const rpID = new URL(app.base).hostname;
  const authn = new SoftAuthenticator({ origin: app.base, rpID });
  const api = async (path, body, { cookie, csrf, origin = app.base } = {}) => {
    const res = await post(app.base, path, JSON.stringify(body), { type: JSONT, cookie, origin, headers: csrf ? { "x-csrf-token": csrf } : {} });
    return { res, data: await res.json().catch(() => ({})), cookie: cookieOf(res) };
  };
  async function register(label = "Synthetic account") {
    const o = await api("/account/register/options", { label });
    const r = await api("/account/register/verify", { challengeId: o.data.challengeId, response: authn.create(o.data.options) });
    return { ...r, options: o.data.options };
  }
  async function login(getOpts = {}) {
    const o = await api("/account/login/options", {});
    return api("/account/login/verify", { challengeId: o.data.challengeId, response: authn.get(o.data.options, getOpts) });
  }
  return { ...app, authn, api, register, login, rpID };
}

test("passkey sign-up and sign-in, recovery codes shown once, account-scoped filing list", opts, async (t) => {
  const { base, pool, register, login, authn, api } = await setup(t);
  const reg = await register();
  assert.equal(reg.res.status, 201);
  assert.equal(reg.data.recoveryCodes.length, 10);
  assert.ok(reg.data.recoveryCodes.every((c) => /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/.test(c)));
  assert.match(reg.res.headers.get("set-cookie"), /^ufr_account=.*HttpOnly; SameSite=Strict/);
  const stored = (await pool.query("SELECT code_hash FROM recovery_codes")).rows.map((r) => r.code_hash).join();
  assert.ok(reg.data.recoveryCodes.every((c) => !stored.includes(c.replace(/-/g, ""))), "codes stored only as hashes");
  const dash = await get(base, "/account", reg.cookie);
  assert.match(dash.headers.get("content-security-policy"), /script-src 'self'; connect-src 'self'/);
  let html = await dash.text();
  assert.match(html, /No filings linked yet/);
  assert.match(html, /<script src="\/assets\/account.v1.js" defer><\/script>/);
  assert.match((await get(base, "/assets/account.v1.js")).headers.get("content-type"), /^text\/javascript/);
  // Link an existing filing (owner code), list it, open it without re-entering codes.
  const f = await fileAndLogin(base, { title: "Linked synthetic filing" });
  const csrf = field(html, "csrf");
  assert.equal((await post(base, "/account/link", form({ csrf, trackingNumber: f.tracking, accessCode: "WRONGWRONGWRONGWRONGWRON" }), { cookie: reg.cookie, type: FORM })).status, 400);
  assert.equal((await post(base, "/account/link", form({ csrf, trackingNumber: f.tracking, accessCode: f.access }), { cookie: reg.cookie, type: FORM })).status, 303);
  html = await (await get(base, "/account", reg.cookie)).text();
  assert.match(html, /Linked synthetic filing/);
  const rootId = html.match(/\/account\/filings\/([0-9a-f-]{36})\/open/)[1];
  const open = await post(base, `/account/filings/${rootId}/open`, form({ csrf }), { cookie: reg.cookie, type: FORM });
  assert.equal(open.status, 303);
  assert.match(await (await get(base, "/track/case", cookieOf(open))).text(), /Linked synthetic filing/);
  // A representative code cannot claim a filing.
  const caseHtml = await (await get(base, "/track/case", f.cookie)).text();
  const d = await post(base, "/track/delegations", form({ csrf: field(caseHtml, "csrf"), label: "rep", scope: "view_supplement" }), { cookie: f.cookie, type: FORM });
  const repCode = (await d.text()).match(/Representative code: <code class="big">([0-9A-Z-]+)<\/code>/)[1];
  const other = await register("Second synthetic account");
  const ocsrf = field(await (await get(base, "/account", other.cookie)).text(), "csrf");
  assert.equal((await post(base, "/account/link", form({ csrf: ocsrf, trackingNumber: f.tracking, accessCode: repCode }), { cookie: other.cookie, type: FORM })).status, 400);
  // Another account cannot open a filing it has not linked.
  assert.equal((await post(base, `/account/filings/${rootId}/open`, form({ csrf: ocsrf }), { cookie: other.cookie, type: FORM })).status, 404);
  // Passkey sign-in on the first account's credential.
  authn.credentials.delete([...authn.credentials.keys()][1]);
  const li = await login();
  assert.equal(li.res.status, 200);
  assert.match(await (await get(base, "/account", li.cookie)).text(), /Linked synthetic filing/);
  assert.ok(api);
});

test("passkey negative paths: replay, wrong origin, missing user verification, cloned counter, unknown key, CSRF", opts, async (t) => {
  const { base, register, api, authn } = await setup(t);
  await register();
  // Challenge replay: a valid assertion cannot be used twice.
  const o = await api("/account/login/options", {});
  const assertion = authn.get(o.data.options);
  assert.equal((await api("/account/login/verify", { challengeId: o.data.challengeId, response: assertion })).res.status, 200);
  assert.equal((await api("/account/login/verify", { challengeId: o.data.challengeId, response: assertion })).res.status, 400);
  const tryLogin = async (getOpts) => { const x = await api("/account/login/options", {}); return (await api("/account/login/verify", { challengeId: x.data.challengeId, response: authn.get(x.data.options, getOpts) })).res.status; };
  assert.equal(await tryLogin({ origin: "https://evil.example" }), 401, "phishing origin");
  assert.equal(await tryLogin({ flags: 0x01 }), 401, "user verification required");
  [...authn.credentials.values()][0].counter = 0; // a clone replaying an old counter state
  assert.equal(await tryLogin({ counterDelta: 0 }), 401, "signature counter must increase (cloned authenticator)");
  const unknown = await api("/account/login/options", {});
  const forged = authn.get(unknown.data.options); forged.id = forged.rawId = "AAAAAAAAAAAAAAAAAAAAAA";
  assert.equal((await api("/account/login/verify", { challengeId: unknown.data.challengeId, response: forged })).res.status, 401);
  assert.equal((await api("/account/login/verify", { challengeId: "00000000-0000-0000-0000-000000000000", response: forged })).res.status, 400);
  // Registration with a tampered origin fails and creates nothing.
  const ro = await api("/account/register/options", {});
  assert.equal((await api("/account/register/verify", { challengeId: ro.data.challengeId, response: authn.create(ro.data.options, { origin: "https://evil.example" }) })).res.status, 400);
  // Cross-origin and non-JSON requests are refused.
  assert.equal((await api("/account/register/options", {}, { origin: "https://evil.example" })).res.status, 403);
  assert.equal((await post(base, "/account/login/options", "x=1", { type: FORM })).status, 415);
  // Adding a passkey requires the session CSRF header.
  const li = await api("/account/login/options", {});
  const session = await api("/account/login/verify", { challengeId: li.data.challengeId, response: authn.get(li.data.options) });
  assert.equal((await api("/account/passkeys/options", {}, { cookie: session.cookie })).res.status, 403);
  assert.equal((await api("/account/passkeys/options", {}, { cookie: "ufr_account=forged.value" })).res.status, 401);
});

test("recovery codes are one-time; regeneration revokes old codes; sessions are revocable; passkeys managed; contact recovery sends nothing", opts, async (t) => {
  const { base, pool, register, api, authn } = await setup(t);
  const reg = await register();
  const [c1, c2] = reg.data.recoveryCodes;
  const rec = await post(base, "/account/recover", form({ code: c1.toLowerCase().replace(/-/g, " ") }), { type: FORM });
  assert.equal(rec.status, 303);
  const recCookie = cookieOf(rec);
  assert.match(await (await get(base, "/account", recCookie)).text(), /9 unused recovery codes/);
  assert.equal((await post(base, "/account/recover", form({ code: c1 }), { type: FORM })).status, 401, "one-time");
  assert.equal((await post(base, "/account/recover", form({ code: "AAAAA-BBBBB-CCCCC-DDDDD" }), { type: FORM })).status, 401);
  // Sessions: the recovery session revokes the registration session; revoked cookies stop working.
  let html = await (await get(base, "/account", recCookie)).text();
  const csrf = field(html, "csrf");
  const other = html.match(/\/account\/sessions\/([0-9a-f-]{36})\/revoke/)[1];
  assert.equal((await post(base, `/account/sessions/${other}/revoke`, form({ csrf }), { cookie: recCookie, type: FORM })).status, 303);
  assert.match(await (await get(base, "/account", reg.cookie)).text(), /Sign in with a passkey/);
  // Regenerate: old unused codes stop working, new ones are shown once.
  const regen = await post(base, "/account/recovery-codes", form({ csrf }), { cookie: recCookie, type: FORM });
  const newCodes = [...(await regen.text()).matchAll(/<code class="big">([0-9A-Z-]+)<\/code>/g)].map((m) => m[1]);
  assert.equal(newCodes.length, 10);
  assert.equal((await post(base, "/account/recover", form({ code: c2 }), { type: FORM })).status, 401);
  // Passkeys: add a second (with CSRF header), remove one, cannot remove the last.
  const ao = await api("/account/passkeys/options", {}, { cookie: recCookie, csrf });
  assert.equal(ao.data.options.excludeCredentials.length, 1);
  assert.equal((await api("/account/passkeys/verify", { challengeId: ao.data.challengeId, response: authn.create(ao.data.options) }, { cookie: recCookie, csrf })).res.status, 201);
  const ids = (await pool.query("SELECT id FROM passkeys WHERE removed_at IS NULL ORDER BY created_at")).rows.map((r) => r.id);
  assert.equal(ids.length, 2);
  assert.equal((await post(base, `/account/passkeys/${ids[0]}/remove`, form({ csrf }), { cookie: recCookie, type: FORM })).status, 303);
  assert.equal((await post(base, `/account/passkeys/${ids[1]}/remove`, form({ csrf }), { cookie: recCookie, type: FORM })).status, 409);
  // Sign out everywhere ends the current session too.
  assert.equal((await post(base, "/account/sessions/revoke-all", form({ csrf }), { cookie: recCookie, type: FORM })).status, 303);
  assert.match(await (await get(base, "/account", recCookie)).text(), /Sign in with a passkey/);
  // Contact recovery seam: recorded as undeliverable, contact never stored in plaintext.
  const cr = await post(base, "/account/recovery/contact", form({ channel: "email", contact: "someone@example.test" }), { type: FORM });
  assert.equal(cr.status, 202);
  assert.match(await cr.text(), /nothing was sent/);
  const row = (await pool.query("SELECT channel, state, contact_sha256 FROM account_recovery_requests")).rows[0];
  assert.equal(row.state, "undeliverable");
  assert.doesNotMatch(JSON.stringify(row), /someone@example/);
  const events = (await pool.query("SELECT event_type FROM ledger_entries WHERE event_type LIKE 'account.%'")).rows.map((r) => r.event_type);
  for (const e of ["account.created", "account.recovered", "account.session_revoked", "account.recovery_codes_regenerated", "account.passkey_added", "account.passkey_removed"])
    assert.ok(events.includes(e), e);
});

test("account pages are available in Spanish", opts, async (t) => {
  const { base, register } = await setup(t);
  const signedOut = await (await fetch(base + "/account", { headers: { cookie: "ufr_lang=es" } })).text();
  assert.match(signedOut, /Iniciar sesión con una llave de acceso/);
  assert.match(signedOut, /Crear una cuenta/);
  const reg = await register();
  const dash = await (await fetch(base + "/account", { headers: { cookie: `${reg.cookie}; ufr_lang=es` } })).text();
  assert.match(dash, /Sus presentaciones/);
  assert.match(dash, /Vincular una presentación/);
  assert.doesNotMatch(dash, />Link a filing<|>Passkeys<|>Recovery codes</);
});
