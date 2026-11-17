import { readFileSync } from "node:fs";
import { escapeHtml as h } from "../public-shell.mjs";
import { IntakeError } from "../demo/backend.mjs";
import { registerDemoPaths, readBody, readForm } from "../demo/routes.mjs";
import { layout } from "../demo/views.mjs";
import { statusText } from "../demo/views2.mjs";
import { ACCOUNT_COOKIE } from "../demo/auth.mjs";

const UUID = "[0-9a-f-]{36}";
const clientScript = readFileSync(new URL("./account-client.js", import.meta.url), "utf8");
export const ACCOUNT_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
registerDemoPaths((p) => p === "/account" || p === "/assets/account.v1.js" || /^\/account\/[A-Za-z0-9/_-]{2,1500}$/.test(p));

const csrfField = (t) => `<input type="hidden" name="csrf" value="${h(t)}">`;
const when = (d) => (d ? new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z") : "");
const ERR = { passkey_verification_failed: "The passkey could not be verified. Try again.", challenge_expired: "That request expired. Try again.",
  link_failed: "Those details did not match a filing you own. Use the tracking number and the original access code (not a representative code).",
  recovery_failed: "That recovery code is not valid or was already used.", last_passkey: "You cannot remove your only passkey. Add another one first.",
  passkey_already_registered: "That passkey is already registered.", too_many_passkeys: "This account already has the maximum number of passkeys.",
  rate_limited: "Too many requests. Wait a few minutes and try again.", invalid_contact: "Enter an email address or phone number." };
const err = (c) => (c ? `<div class="error-summary" role="alert"><h2>There is a problem</h2><p>${h(ERR[c] ?? "The request could not be completed.")}</p></div>` : "");
const page = (body, title = "Your account") => layout({ title, path: "/account", body }).replace("</body>", '<script src="/assets/account.v1.js" defer></script></body>');

function signInPage(error) {
  return page(`<p class="eyebrow">Optional account</p><h1>Sign in with a passkey</h1>` + err(error) +
    `<p class="lead">An account is optional. It keeps your demonstration filings in one list. It uses a <strong>passkey</strong> (your device's screen lock or a security key). There is no password, and no email or phone number is required.</p>` +
    `<p id="passkey-status" role="status" class="small"></p>` +
    `<div class="actions"><button class="button" type="button" data-passkey="login">Sign in with a passkey</button></div>` +
    `<h2>Create an account</h2><form class="demo-form" data-passkey-form="register"><label for="label">Account nickname (synthetic, optional)</label><input id="label" name="label" maxlength="60" autocomplete="off"><button class="button secondary" type="submit">Create account with a passkey</button></form>` +
    `<section id="recovery-codes" hidden><h2>Save your recovery codes now</h2><p>Each code works once if you lose your passkey. They are shown only once and stored only as hashes.</p><ol id="recovery-code-list" class="codes"></ol><p><a class="button" href="/account">I saved my codes. Continue to my account</a></p></section>` +
    `<h2>Lost your passkey?</h2><form class="demo-form" method="post" action="/account/recover"><label for="code">Recovery code</label><input id="code" name="code" autocomplete="off" maxlength="40" required><button class="button secondary" type="submit">Sign in with a recovery code</button></form>` +
    `<details><summary>Recovery by email or text message</summary><p>This demonstration has no email or SMS provider. Requests are recorded but nothing is sent. Use a recovery code.</p><form class="demo-form" method="post" action="/account/recovery/contact"><label for="channel">Channel</label><select id="channel" name="channel"><option value="email">Email</option><option value="sms">Text message</option></select><label for="contact">Email or phone (synthetic)</label><input id="contact" name="contact" maxlength="200" autocomplete="off" required><button class="button secondary" type="submit">Request recovery message</button></form></details>` +
    `<noscript><p class="error-summary">Passkeys need JavaScript. You can still track filings with a tracking number and access code, and sign in with a recovery code.</p></noscript>`);
}

function dashboard({ s, csrf, filings, passkeys, sessions, remaining, error }) {
  return page(`<p class="eyebrow">Your account (demonstration)</p><h1>Your filings</h1>` + err(error) +
    `<form method="post" action="/account/logout" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Sign out</button></form>` +
    (remaining <= 3 ? `<div class="error-summary" role="status"><p>Only ${remaining} recovery codes left. Generate new ones below.</p></div>` : "") +
    (filings.length ? `<div class="table-wrap"><table><caption>Linked filings</caption><thead><tr><th scope="col">Tracking</th><th scope="col">Subject</th><th scope="col">Fictional agency</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>${filings.map((f) =>
      `<tr><td><code>${h(f.tracking_number)}</code></td><td>${h(f.title)}${f.unread ? ` <strong class="badge">${f.unread} new</strong>` : ""}</td><td>${h(f.agency_name)}</td><td>${h(statusText(f.status))}</td><td><form method="post" action="/account/filings/${h(f.root_id)}/open" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Open</button></form> · <form method="post" action="/account/filings/${h(f.root_id)}/unlink" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Unlink</button></form></td></tr>`).join("")}</tbody></table></div>`
      : "<p>No filings linked yet.</p>") +
    `<h2>Link a filing</h2><form class="demo-form" method="post" action="/account/link">${csrfField(csrf)}<label for="trackingNumber">Tracking number</label><input id="trackingNumber" name="trackingNumber" required autocomplete="off" maxlength="19"><label for="accessCode">Access code</label><input id="accessCode" name="accessCode" type="password" required autocomplete="off" maxlength="40"><button class="button" type="submit">Link filing</button></form>` +
    `<h2>Passkeys</h2><ul>${passkeys.map((p) => `<li>${h(p.label)} · added ${h(when(p.created_at))}${p.last_used_at ? ` · last used ${h(when(p.last_used_at))}` : ""}${passkeys.length > 1 ? ` <form method="post" action="/account/passkeys/${h(p.id)}/remove" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Remove</button></form>` : ""}</li>`).join("")}</ul>` +
    `<p id="passkey-status" role="status" class="small"></p><button class="button secondary" type="button" data-passkey="add" data-csrf="${h(csrf)}">Add another passkey</button>` +
    `<h2>Recovery codes</h2><p>${remaining} unused recovery codes.</p><form method="post" action="/account/recovery-codes">${csrfField(csrf)}<button class="button secondary" type="submit">Generate new recovery codes (old codes stop working)</button></form>` +
    `<h2>Signed-in sessions</h2><ul>${sessions.map((x) => `<li>${h(x.method.replace(/_/g, " "))} · since ${h(when(x.created_at))}${x.id === s.id ? " · <strong>this session</strong>" : ` <form method="post" action="/account/sessions/${h(x.id)}/revoke" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Sign out this session</button></form>`}</li>`).join("")}</ul>` +
    `<form method="post" action="/account/sessions/revoke-all">${csrfField(csrf)}<button class="button secondary" type="submit">Sign out everywhere</button></form>`);
}

function codesPage(codes) {
  return page(`<p class="eyebrow">Recovery codes</p><h1>Save your new recovery codes</h1><section class="once" role="status"><p>Each code works once. They are shown only now and stored only as hashes. Your previous codes no longer work.</p><ol class="codes">${codes.map((c) => `<li><code class="big">${h(c)}</code></li>`).join("")}</ol></section><p><a href="/account">Back to my account →</a></p>`, "Recovery codes");
}

export function createAccountExtension({ accounts, env }) {
  return async function accountExtension(ctx) {
    const { req, path, isGet, isPost, html, json, redirect, auth, limit } = ctx;
    if (path === "/assets/account.v1.js") return isGet ? { status: 200, contentType: "text/javascript; charset=utf-8", rawBody: clientScript } : json(405, { error: "method_not_allowed" });
    if (path !== "/account" && !path.startsWith("/account/")) return null;
    const origin = env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
    const rpID = new URL(origin).hostname;
    const hint = String(req.headers["user-agent"] ?? "").slice(0, 80);
    const withCsp = (r) => ({ ...r, headers: { ...(r.headers ?? {}), "content-security-policy": ACCOUNT_CSP } });
    const setSession = (sessionId) => auth.issueAccount(sessionId).header;
    const readJson = async () => {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new IntakeError("unsupported_media_type", 415);
      try { return JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")); } catch { throw new IntakeError("invalid_request", 400); }
    };
    const cookie = auth.account(ctx.cookies);
    const s = cookie ? await accounts.session(cookie.subject) : null;
    const csrf = cookie?.csrf;
    const render = async (status, error) => withCsp(s
      ? html(status, dashboard({ s, csrf, error, filings: await accounts.listFilings(s.accountId), passkeys: await accounts.listPasskeys(s.accountId),
        sessions: await accounts.listSessions(s.accountId), remaining: await accounts.remainingRecoveryCodes(s.accountId) }))
      : html(status, signInPage(error)));
    try {
      if (path === "/account") return isGet ? render(200) : json(405, { error: "method_not_allowed" });
      if (!isPost) return json(405, { error: "method_not_allowed" });
      // -------------------------------------------- unauthenticated ceremonies (JSON) and recovery
      if (path === "/account/register/options") { await limit(req, "acct-register", 10, 600); const b = await readJson(); return json(200, await accounts.registrationOptions({ rpID, label: b.label })); }
      if (path === "/account/register/verify") {
        const b = await readJson();
        const out = await accounts.completeRegistration({ challengeId: b.challengeId, response: b.response, rpID, origin, clientHint: hint });
        return { status: 201, body: { recoveryCodes: out.recoveryCodes, redirect: "/account" }, headers: { "set-cookie": setSession(out.sessionId) } };
      }
      if (path === "/account/login/options") { await limit(req, "acct-login", 30, 600); await readJson(); return json(200, await accounts.authenticationOptions({ rpID })); }
      if (path === "/account/login/verify") {
        const b = await readJson();
        const out = await accounts.completeAuthentication({ challengeId: b.challengeId, response: b.response, rpID, origin, clientHint: hint });
        return { status: 200, body: { redirect: "/account" }, headers: { "set-cookie": setSession(out.sessionId) } };
      }
      if (path === "/account/recover") {
        try { await limit(req, "acct-recover", 10, 900); } catch { return withCsp(html(429, signInPage("rate_limited"))); }
        const out = await accounts.recover((await readForm(req)).code, hint);
        if (!out) return withCsp(html(401, signInPage("recovery_failed")));
        return redirect("/account", { "set-cookie": setSession(out.sessionId) });
      }
      if (path === "/account/recovery/contact") {
        await limit(req, "acct-contact", 5, 900);
        const f = await readForm(req);
        await accounts.requestContactRecovery(f.channel, f.contact);
        return withCsp(html(202, page(`<p class="eyebrow">Recovery</p><h1>No message was sent</h1><section class="error-summary" role="status"><p>This demonstration has no email or SMS provider configured. Your request was recorded, but nothing was sent. Use one of your recovery codes instead.</p></section><p><a href="/account">Back →</a></p>`, "Recovery")));
      }
      // -------------------------------------------- authenticated actions (session + CSRF)
      if (!s) return path.endsWith("/verify") || path.endsWith("/options") ? json(401, { error: "signed_out" }) : redirect("/account", { "set-cookie": auth.clear(ACCOUNT_COOKIE) });
      if (path === "/account/passkeys/options" || path === "/account/passkeys/verify") {
        if (!auth.csrfValid(cookie, req.headers["x-csrf-token"])) return json(403, { error: "csrf_rejected" });
        const b = await readJson();
        if (path.endsWith("/options")) return json(200, await accounts.addPasskeyOptions(s.accountId, { rpID }));
        await accounts.completeAddPasskey(s.accountId, { challengeId: b.challengeId, response: b.response, rpID, origin });
        return json(201, { redirect: "/account" });
      }
      const form = await readForm(req);
      if (!auth.csrfValid(cookie, form.csrf)) return json(403, { error: "csrf_rejected" });
      let m;
      if (path === "/account/logout") { await accounts.revokeSession(s.accountId, s.id); return redirect("/account", { "set-cookie": auth.clear(ACCOUNT_COOKIE) }); }
      if (path === "/account/sessions/revoke-all") { await accounts.revokeAllSessions(s.accountId); return redirect("/account", { "set-cookie": auth.clear(ACCOUNT_COOKIE) }); }
      if ((m = new RegExp(`^/account/sessions/(${UUID})/revoke$`).exec(path))) { await accounts.revokeSession(s.accountId, m[1]); return redirect("/account"); }
      if (path === "/account/recovery-codes") return withCsp(html(201, codesPage(await accounts.regenerateRecoveryCodes(s.accountId))));
      if ((m = /^\/account\/passkeys\/([A-Za-z0-9_-]{16,1366})\/remove$/.exec(path))) { await accounts.removePasskey(s.accountId, m[1]); return redirect("/account"); }
      if (path === "/account/link") {
        try { await limit(req, "acct-link", 20, 600); await accounts.linkFiling(s.accountId, form.trackingNumber, form.accessCode); }
        catch (e) { if (e instanceof IntakeError) return render(e.status === 429 ? 429 : 400, e.code); throw e; }
        return redirect("/account");
      }
      if ((m = new RegExp(`^/account/filings/(${UUID})/(open|unlink)$`).exec(path))) {
        if (!(await accounts.ownsFiling(s.accountId, m[1]))) return render(404, "link_failed");
        if (m[2] === "unlink") { await accounts.unlinkFiling(s.accountId, m[1]); return redirect("/account"); }
        return redirect("/track/case", { "set-cookie": auth.issueParticipant(`${m[1]}|owner|`).header });
      }
      return json(404, { error: "not_found" });
    } catch (e) {
      if (e instanceof IntakeError) {
        if (path.endsWith("/verify") || path.endsWith("/options")) return json(e.status ?? 400, { error: e.code, message: ERR[e.code] ?? "The request could not be completed." });
        return render(e.status ?? 400, e.code);
      }
      throw e;
    }
  };
}
