// Passkey (WebAuthn) ceremonies for the demonstration account pages.
// Served from /assets/account.v1.js under a CSP allowing only same-origin scripts.
(() => {
  "use strict";
  const es = document.documentElement.lang === "es";
  const T = es ? {
    unsupported: "Este navegador no admite llaves de acceso. Puede seguir usando el número de seguimiento y el código de acceso, o un código de recuperación.",
    working: "Siga las indicaciones de su dispositivo…", failed: "No se pudo completar la operación con la llave de acceso.", cancelled: "Operación cancelada.",
  } : {
    unsupported: "This browser does not support passkeys. You can still use your tracking number and access code, or a recovery code.",
    working: "Follow your device's prompts…", failed: "The passkey operation could not be completed.", cancelled: "Cancelled.",
  };
  const status = (msg) => { const el = document.getElementById("passkey-status"); if (el) el.textContent = msg; };
  const toBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
  const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  async function post(url, body, csrf) {
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || T.failed);
    return data;
  }
  function serializeCreate(cred) {
    return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
      response: { clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject),
        transports: cred.response.getTransports?.() ?? [] } };
  }
  function serializeGet(cred) {
    return { id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
      response: { clientDataJSON: toB64u(cred.response.clientDataJSON), authenticatorData: toB64u(cred.response.authenticatorData),
        signature: toB64u(cred.response.signature), userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : undefined } };
  }
  function creationOptions(o) {
    return { ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ ...c, id: toBuf(c.id) })) };
  }
  async function register(label) {
    const { challengeId, options } = await post("/account/register/options", { label });
    const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
    const out = await post("/account/register/verify", { challengeId, response: serializeCreate(cred) });
    const list = document.getElementById("recovery-code-list");
    for (const code of out.recoveryCodes) { const li = document.createElement("li"); const c = document.createElement("code"); c.className = "big"; c.textContent = code; li.append(c); list.append(li); }
    document.getElementById("recovery-codes").hidden = false;
    document.getElementById("recovery-codes").scrollIntoView();
    status("");
  }
  async function login() {
    const { challengeId, options } = await post("/account/login/options", {});
    const cred = await navigator.credentials.get({ publicKey: { ...options, challenge: toBuf(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c) => ({ ...c, id: toBuf(c.id) })) } });
    location.assign((await post("/account/login/verify", { challengeId, response: serializeGet(cred) })).redirect);
  }
  async function addPasskey(csrf) {
    const { challengeId, options } = await post("/account/passkeys/options", {}, csrf);
    const cred = await navigator.credentials.create({ publicKey: creationOptions(options) });
    location.assign((await post("/account/passkeys/verify", { challengeId, response: serializeCreate(cred) }, csrf)).redirect);
  }
  const run = (fn) => async (event) => {
    event.preventDefault();
    if (!window.PublicKeyCredential) { status(T.unsupported); return; }
    status(T.working);
    try { await fn(event); } catch (e) { status(e && e.name === "NotAllowedError" ? T.cancelled : (e && e.message) || T.failed); }
  };
  if (!window.PublicKeyCredential) status(T.unsupported);
  document.querySelectorAll('[data-passkey="login"]').forEach((b) => b.addEventListener("click", run(login)));
  document.querySelectorAll('[data-passkey="add"]').forEach((b) => b.addEventListener("click", run(() => addPasskey(b.dataset.csrf))));
  document.querySelectorAll('[data-passkey-form="register"]').forEach((f) => f.addEventListener("submit", run(() => register(f.elements.label.value))));
})();
