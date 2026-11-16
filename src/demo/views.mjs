import { escapeHtml as h } from "../public-shell.mjs";
import { RECEIPT_NOTICE } from "./receipt.mjs";

export const DEMO_BANNER = "Not an official U.S. Government filing service. Demonstration only: use synthetic data. " +
  "Receipts from this site are not government receipts and preserve no legal deadline.";

export const demoNavigation = Object.freeze([
  ["/", "Overview"], ["/file", "File (demo)"], ["/track", "Track"], ["/verify", "Verify a receipt"],
  ["/agencies", "Agency directory"], ["/help", "Help & safety"],
]);

export function layout({ title, path, body, staff = false }) {
  const nav = staff
    ? [["/staff", "Staff queue"], ["/staff/ledger", "Ledger check"], ["/", "Public site"]]
    : demoNavigation;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow"><title>${h(title)} | Federal Filing Prototype (demo)</title>` +
    `<link rel="stylesheet" href="/assets/public-shell.v1.css"><link rel="stylesheet" href="/assets/demo.v1.css"></head><body>` +
    `<a class="skip-link" href="#main">Skip to main content</a>` +
    `<aside class="notice demo-notice" aria-label="Demonstration notice"><strong>Development prototype · demonstration only</strong><span>${h(DEMO_BANNER)}</span></aside>` +
    `<header class="site-header"><div class="brand"><a href="/" aria-label="Federal Filing Prototype home"><span class="brand-mark" aria-hidden="true">F/</span><span>Federal Filing<br><small>${staff ? "Demo staff console" : "Demonstration prototype"}</small></span></a></div>` +
    `<nav aria-label="Main navigation">${nav.map(([p, l]) => `<a href="${p}"${p === path ? ' aria-current="page"' : ""}>${h(l)}</a>`).join("")}</nav></header>` +
    `<main id="main" tabindex="-1" class="demo-main">${body}</main>` +
    `<footer><div><strong>Federal Filing Prototype</strong><p>Demonstration only. Fictional agencies, synthetic data, no filing authority, no government receipt.</p></div>` +
    `<nav aria-label="Footer navigation"><a href="/privacy">Privacy</a><a href="/help">Help &amp; safety</a><a href="/about">Project boundaries</a></nav></footer></body></html>`;
}

const errorText = {
  invalid_agency: "Choose one of the fictional demonstration agencies.",
  invalid_filing_type: "That filing type is not accepted by the selected fictional agency.",
  invalid_title: "Enter a subject of up to 200 characters.", invalid_body: "Enter the filing text (up to 20,000 characters).",
  invalid_name: "Enter a synthetic name (up to 120 characters).", invalid_contact: "Contact details are too long.",
  invalid_filename: "An attachment name is invalid.", unsupported_file_type: "Attachments must be PDF, plain text, PNG or JPEG.",
  file_too_large: "Attachments are limited to 5 MB each and 10 MB in total.", too_many_files: "Attach at most three files.",
  file_content_mismatch: "An attachment's content does not match its file type.",
  invalid_idempotency_key: "The form expired. Reload the page and try again.",
  idempotency_conflict: "This form was already submitted with different content. Reload the page to start a new filing.",
  attestations_required: "Confirm all three statements before submitting.",
  rate_limited: "Too many requests. Wait a few minutes and try again.",
  amendment_agency_mismatch: "Supplementary filings go to the same agency as the original.",
  invalid_request: "The request could not be read. Reload the page and try again.",
};
export const errorMessage = (code) => errorText[code] ?? "The request could not be completed.";

export function unavailablePage(path) {
  return layout({ title: "Demo unavailable", path, body: `<p class="eyebrow">Demonstration filing</p><h1>Demo filing is not configured</h1>` +
    `<section class="empty-state" role="status"><p>This deployment has no demonstration storage or signing key configured, so no demo filings, tracking or receipt verification are available. Nothing is accepted.</p><a href="/help">Read help and safety guidance →</a></section>` });
}

const attestations = `<fieldset><legend>Before you submit (required)</legend>` +
  `<label class="check"><input type="checkbox" name="attest_demo" value="yes" required> I understand this is a demonstration that files nothing with any government institution.</label>` +
  `<label class="check"><input type="checkbox" name="attest_synthetic" value="yes" required> I am entering only synthetic, made-up information. No real personal data.</label>` +
  `<label class="check"><input type="checkbox" name="attest_unclassified" value="yes" required> This contains no classified or sensitive government information.</label></fieldset>`;

function filingFields({ agencies, idempotencyKey, values = {}, lockedAgency = null }) {
  const types = [...new Set(agencies.flatMap((a) => a.filingTypes))];
  const agencyField = lockedAgency
    ? `<input type="hidden" name="agencyId" value="${h(lockedAgency.id)}"><p><strong>Agency:</strong> ${h(lockedAgency.name)}</p>`
    : `<label for="agencyId">Fictional recipient agency</label><select id="agencyId" name="agencyId" required>${agencies.map((a) =>
      `<option value="${h(a.id)}"${values.agencyId === a.id ? " selected" : ""}>${h(a.name)}: ${h(a.filingTypes.join(", "))}</option>`).join("")}</select>`;
  return `<input type="hidden" name="idempotencyKey" value="${h(idempotencyKey)}">${agencyField}` +
    `<label for="filingType">Filing type</label><select id="filingType" name="filingType" required>${types.map((t) =>
      `<option value="${h(t)}"${values.filingType === t ? " selected" : ""}>${h(t)}</option>`).join("")}</select>` +
    `<label for="title">Subject</label><input id="title" name="title" maxlength="200" required value="${h(values.title ?? "")}">` +
    `<label for="body">Filing text</label><textarea id="body" name="body" rows="10" maxlength="20000" required>${h(values.body ?? "")}</textarea>` +
    `<label for="claimantName">Your name (synthetic)</label><input id="claimantName" name="claimantName" maxlength="120" required autocomplete="off" value="${h(values.claimantName ?? "")}">` +
    `<label for="claimantContact">Contact (optional, synthetic)</label><input id="claimantContact" name="claimantContact" maxlength="200" autocomplete="off" value="${h(values.claimantContact ?? "")}">` +
    `<label for="files">Attachments (optional: up to 3 PDF, text, PNG or JPEG files; 5 MB each)</label><input id="files" name="files" type="file" multiple accept=".pdf,.txt,.png,.jpg,.jpeg,application/pdf,text/plain,image/png,image/jpeg">` +
    attestations;
}

export function filePage({ agencies, idempotencyKey, error, values }) {
  return layout({ title: "File (demo)", path: "/file", body: `<p class="eyebrow">Demonstration filing</p><h1>Submit a demonstration filing</h1>` +
    `<p class="lead">Practice the filing journey with fictional agencies. You will receive a signed demonstration receipt, a tracking number and a one-time access code.</p>` +
    (error ? `<div class="error-summary" role="alert"><h2>There is a problem</h2><p>${h(errorMessage(error))}</p></div>` : "") +
    `<form class="demo-form" method="post" action="/file" enctype="multipart/form-data">${filingFields({ agencies, idempotencyKey, values })}` +
    `<button class="button" type="submit">Submit demonstration filing</button></form>` });
}

export function receiptPanel(doc) {
  const r = doc.receipt;
  return `<section class="receipt" aria-label="Demonstration receipt"><p class="receipt-stamp">DEMONSTRATION RECEIPT · NOT A GOVERNMENT RECEIPT</p>` +
    `<dl><dt>Receipt ID</dt><dd><code>${h(r.receiptId)}</code></dd><dt>Tracking number</dt><dd><code>${h(r.trackingNumber)}</code></dd>` +
    `<dt>Kind</dt><dd>${h(r.kind)}${r.amends ? ` (supplements <code>${h(r.amends)}</code>)` : ""}</dd>` +
    `<dt>Received (database time of record)</dt><dd><time datetime="${h(r.receivedAt)}">${h(r.receivedAt)}</time></dd>` +
    `<dt>Fictional recipient</dt><dd>${h(r.agency.name)}</dd><dt>Filing type</dt><dd>${h(r.filingType)}</dd>` +
    `<dt>Content manifest SHA-256</dt><dd><code class="hash">${h(r.manifest.sha256)}</code> (${r.manifest.partCount} part(s), ${r.manifest.totalBytes} bytes)</dd>` +
    `<dt>Ledger entry</dt><dd>#${r.ledger.seq} · <code class="hash">${h(r.ledger.entryHash)}</code></dd>` +
    `<dt>Signing key</dt><dd><code>${h(r.issuer.keyId)}</code> (Ed25519)</dd></dl>` +
    `<p class="small">${h(RECEIPT_NOTICE)}</p>` +
    `<details><summary>Signed receipt JSON (paste into the verifier)</summary><pre class="receipt-json">${h(JSON.stringify(doc, null, 2))}</pre></details></section>`;
}

export function filedPage({ result }) {
  const code = result.accessCode;
  return layout({ title: "Demonstration receipt", path: "/file", body: `<p class="eyebrow">Demonstration filing received</p>` +
    `<h1>${result.replayed ? "This filing was already received" : "Your demonstration filing was received"}</h1>` +
    (code ? `<section class="once" role="status"><h2>Save these now</h2><p>Tracking number: <code class="big">${h(result.trackingNumber)}</code></p>` +
      `<p>Access code: <code class="big">${h(code.match(/.{1,4}/g).join("-"))}</code></p>` +
      `<p class="small">The access code is shown only once and is stored only as a salted hash. You need both to check status or add a supplement. A tracking number alone grants no access.</p></section>`
      : `<p>This repeat submission returned the original receipt. Use the access code shown when you first submitted.</p>`) +
    receiptPanel(result.receipt) + `<p><a href="/track">Check status →</a> · <a href="/verify">Verify a receipt →</a></p>` });
}

export function trackLoginPage({ error } = {}) {
  return layout({ title: "Track a filing", path: "/track", body: `<p class="eyebrow">Status tracking</p><h1>Track a demonstration filing</h1>` +
    `<p class="lead">Enter the tracking number and the access code you saved when you submitted.</p>` +
    (error ? `<div class="error-summary" role="alert"><p>${h(error === "rate_limited" ? errorMessage(error) : "Those details did not match a filing. Check both values and try again.")}</p></div>` : "") +
    `<form class="demo-form" method="post" action="/track"><label for="trackingNumber">Tracking number</label><input id="trackingNumber" name="trackingNumber" required autocomplete="off" placeholder="DEMO-XXXX-XXXX-XXXX" maxlength="19">` +
    `<label for="accessCode">Access code</label><input id="accessCode" name="accessCode" type="password" required autocomplete="off" maxlength="40">` +
    `<button class="button" type="submit">View status</button></form>` });
}

const statusLabel = { received: "Received (demo receipt issued)", routed: "Delivered to fictional agency inbox",
  routing_escalated: "Routing escalated to staff", under_review: "Under review", information_requested: "Information requested",
  referred: "Referred", closed: "Closed" };

export function caseView({ view, agencies, csrf, idempotencyKey, error, values }) {
  const root = view.filings[0];
  const agency = agencies.find((a) => a.name === root.agencyName);
  return layout({ title: "Filing status", path: "/track", body: `<p class="eyebrow">Status tracking</p><h1>${h(root.title)}</h1>` +
    `<form method="post" action="/track/logout" class="inline-form"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="text-button" type="submit">Sign out</button></form>` +
    `<h2>Current status</h2><p class="status-pill">${h(statusLabel[root.status] ?? root.status)}</p>` +
    `<h2>History</h2><ol class="timeline">${view.history.map((e) => `<li><time datetime="${h(e.at)}">${h(e.at)}</time> · ${h(statusLabel[e.status] ?? e.status)}${e.note ? `: ${h(e.note)}` : ""}</li>`).join("")}</ol>` +
    `<h2>Receipts</h2>${view.filings.map((f) => receiptPanel(f.receipt) +
      `<p class="small"><a href="/track/receipts/${h(f.receipt.receipt.receiptId)}.json">Download signed receipt JSON</a>${f.acknowledgement ? ` · Fictional agency acknowledgement <code>${h(f.acknowledgement)}</code>` : ""}</p>`).join("")}` +
    `<h2>Add a supplementary filing</h2><p>Supplements receive their own receipt and never change the original.</p>` +
    (error ? `<div class="error-summary" role="alert"><p>${h(errorMessage(error))}</p></div>` : "") +
    (agency ? `<form class="demo-form" method="post" action="/track/amend" enctype="multipart/form-data"><input type="hidden" name="csrf" value="${h(csrf)}">` +
      `${filingFields({ agencies: [agency], idempotencyKey, values: values ?? { filingType: root.filingType }, lockedAgency: agency })}<button class="button" type="submit">Submit supplement</button></form>` : "") });
}

export function verifyPage({ result, input } = {}) {
  const outcome = !result ? "" : result.valid
    ? `<section class="verify-ok" role="status"><h2>Valid demonstration receipt</h2><p>This prototype's key <code>${h(result.keyId)}</code> signed these exact fields, and ledger entry #${result.ledgerSeq} matches. Received <time datetime="${h(result.receivedAt)}">${h(result.receivedAt)}</time>; manifest <code class="hash">${h(result.manifestSha256)}</code>.</p><p class="small">This proves only these cryptographic facts. It does not show legal sufficiency or receipt by any government institution.</p></section>`
    : `<section class="error-summary" role="alert"><h2>Not verified</h2><p>${h({ malformed_document: "The text is not a signed receipt document.", malformed_receipt: "The receipt fields are malformed or altered.", malformed_signature: "The signature block is malformed.", unknown_key: "The receipt was not signed by a key this prototype publishes.", bad_signature: "The signature does not match the receipt fields. The receipt was altered or forged.", not_in_ledger: "No matching ledger entry exists.", ledger_mismatch: "The receipt does not match its ledger entry." }[result.reason] ?? "The receipt could not be verified.")}</p></section>`;
  return layout({ title: "Verify a receipt", path: "/verify", body: `<p class="eyebrow">Independent verification</p><h1>Verify a demonstration receipt</h1>` +
    `<p class="lead">Paste a signed receipt JSON document. Verification checks the Ed25519 signature against the <a href="/api/receipts/keys">published keys</a> and the hash-chained ledger. It reveals no filing content.</p>` +
    outcome + `<form class="demo-form" method="post" action="/verify"><label for="receipt">Signed receipt JSON</label><textarea id="receipt" name="receipt" rows="12" required maxlength="20000">${h(input ?? "")}</textarea>` +
    `<button class="button" type="submit">Verify</button></form>` });
}

export function staffLoginPage({ error, configured }) {
  return layout({ title: "Staff sign-in", path: "/staff", staff: true, body: `<p class="eyebrow">Demo staff console</p><h1>Staff sign-in</h1>` +
    (!configured ? `<section class="empty-state" role="status"><p>Staff access is not configured on this deployment.</p></section>` :
      (error ? `<div class="error-summary" role="alert"><p>${h(error === "rate_limited" ? errorMessage(error) : "Sign-in failed.")}</p></div>` : "") +
      `<form class="demo-form" method="post" action="/staff/login"><label for="username">Username</label><input id="username" name="username" required autocomplete="username">` +
      `<label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"><button class="button" type="submit">Sign in</button></form>`) });
}

export function staffQueuePage({ rows, csrf }) {
  return layout({ title: "Staff queue", path: "/staff", staff: true, body: `<p class="eyebrow">Demo staff console</p><h1>Filing queue</h1>` +
    `<form method="post" action="/staff/logout" class="inline-form"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="text-button" type="submit">Sign out</button></form>` +
    `<div class="table-wrap"><table><caption>Most recent demonstration filings (synthetic data)</caption><thead><tr><th scope="col">Received</th><th scope="col">Tracking</th><th scope="col">Kind</th><th scope="col">Subject</th><th scope="col">Fictional agency</th><th scope="col">Routing</th><th scope="col">Status</th></tr></thead><tbody>` +
    (rows.length ? rows.map((r) => `<tr><td><time datetime="${h(r.receivedAt)}">${h(r.receivedAt.slice(0, 16).replace("T", " "))}</time></td><td><a href="/staff/submissions/${h(r.id)}"><code>${h(r.trackingNumber)}</code></a></td><td>${h(r.kind)}</td><td>${h(r.title)}</td><td>${h(r.agencyName)}</td><td>${h(r.routing ?? "")}</td><td>${h(r.status ?? "")}</td></tr>`).join("")
      : `<tr><td colspan="7">No filings yet.</td></tr>`) + `</tbody></table></div>` });
}

export function staffSubmissionPage({ s, csrf, statuses }) {
  return layout({ title: "Filing detail", path: "/staff", staff: true, body: `<p class="eyebrow">Demo staff console · ${h(s.kind)}</p><h1>${h(s.title)}</h1>` +
    `<dl class="facts"><dt>Tracking</dt><dd><code>${h(s.tracking_number)}</code></dd><dt>Fictional agency</dt><dd>${h(s.agency_name)}</dd><dt>Filing type</dt><dd>${h(s.filing_type)}</dd>` +
    `<dt>Received</dt><dd>${h(s.received_at.toISOString())}</dd><dt>Claimant (synthetic)</dt><dd>${h(s.claimant_name)}${s.claimant_contact ? ` · ${h(s.claimant_contact)}` : ""}</dd>` +
    `<dt>Routing</dt><dd>${h(s.routing_state ?? "")}${s.acknowledgement ? ` · ack <code>${h(s.acknowledgement)}</code>` : ""}${s.last_error ? ` · last error: ${h(s.last_error)}` : ""} · due by ${h(s.due_by?.toISOString() ?? "")}</dd>` +
    `<dt>Manifest SHA-256</dt><dd><code class="hash">${h(s.manifest_sha256)}</code></dd></dl>` +
    `<h2>Original text (immutable)</h2><pre class="filing-text">${h(s.body)}</pre>` +
    `<h2>Attachments</h2>${s.documents.length ? `<ul>${s.documents.map((d) => `<li><a href="/staff/documents/${h(d.id)}">${h(d.filename)}</a> · ${h(d.media_type)} · ${d.size_bytes} bytes · <code class="hash">${h(d.sha256)}</code></li>`).join("")}</ul>` : "<p>None.</p>"}` +
    `<h2>Review history</h2><ol class="timeline">${s.history.map((e) => `<li>${h(e.at.toISOString())} · ${h(e.status)} · ${h(e.actor)}${e.note ? `: ${h(e.note)}` : ""}${e.ledger_seq ? ` · ledger #${h(e.ledger_seq)}` : ""}</li>`).join("")}</ol>` +
    `<h2>Record review status</h2><p class="small">Status changes are ledgered. They never alter the original filing or its receipt.</p>` +
    `<form class="demo-form" method="post" action="/staff/submissions/${h(s.id)}/status"><input type="hidden" name="csrf" value="${h(csrf)}">` +
    `<label for="status">Status</label><select id="status" name="status">${statuses.map((x) => `<option value="${h(x)}">${h(x)}</option>`).join("")}</select>` +
    `<label for="note">Note (synthetic)</label><textarea id="note" name="note" rows="3" maxlength="1000"></textarea><button class="button" type="submit">Record status</button></form>` +
    receiptPanel(s.document) });
}

export function staffLedgerPage({ result }) {
  return layout({ title: "Ledger check", path: "/staff/ledger", staff: true, body: `<p class="eyebrow">Demo staff console</p><h1>Ledger integrity</h1>` +
    (result.valid ? `<section class="verify-ok" role="status"><p>Hash chain valid across ${result.checked} entries. Head <code class="hash">${h(result.headHash)}</code>.</p></section>`
      : `<section class="error-summary" role="alert"><p>Hash chain INVALID at entry #${h(result.failure.seq)}: ${h(result.failure.reason)} (after ${result.checked} valid entries).</p></section>`) });
}

export const demoStylesheet = `.demo-notice{background:#5c1d00;color:#fff}.demo-notice strong{color:#fff}.demo-main{max-width:60rem;margin:0 auto;padding:2rem 1rem}` +
  `.demo-form{display:grid;gap:.5rem;max-width:42rem;margin:1.5rem 0}.demo-form label{font-weight:600;margin-top:.5rem}` +
  `.demo-form input:not([type=checkbox]),.demo-form select,.demo-form textarea{font:inherit;padding:.6rem;border:2px solid #444;border-radius:4px;width:100%;box-sizing:border-box}` +
  `.demo-form input:focus,.demo-form select:focus,.demo-form textarea:focus,.button:focus{outline:3px solid #ffbf47;outline-offset:2px}` +
  `fieldset{border:2px solid #444;border-radius:4px;padding:1rem;margin-top:1rem}.check{display:flex;gap:.6rem;align-items:flex-start;font-weight:400!important}` +
  `.error-summary{border:4px solid #b10e1e;padding:1rem;margin:1rem 0}.verify-ok,.once{border:4px solid #00703c;padding:1rem;margin:1rem 0}` +
  `.receipt{border:2px dashed #5c1d00;padding:1rem;margin:1rem 0;background:#fffaf5}.receipt-stamp{font-weight:700;color:#5c1d00;letter-spacing:.05em}` +
  `.receipt dl,.facts{display:grid;grid-template-columns:minmax(10rem,auto) 1fr;gap:.3rem 1rem}.receipt dt,.facts dt{font-weight:600}` +
  `.hash{word-break:break-all;font-size:.85em}.big{font-size:1.4em;letter-spacing:.05em}pre{white-space:pre-wrap;word-break:break-word;background:#f3f2f1;padding:1rem;max-height:30rem;overflow:auto}` +
  `.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #b1b4b6;padding:.5rem;text-align:left;vertical-align:top}` +
  `.status-pill{display:inline-block;padding:.3rem .8rem;border:2px solid #1d70b8;font-weight:700}.timeline li{margin:.3rem 0}` +
  `.inline-form{display:inline}.text-button{background:none;border:0;color:#1d70b8;text-decoration:underline;font:inherit;cursor:pointer;padding:0}` +
  `@media (prefers-color-scheme:dark){.receipt{background:transparent}pre{background:#222}}`;
