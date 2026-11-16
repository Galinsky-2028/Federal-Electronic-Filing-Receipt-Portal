import { escapeHtml as h } from "../public-shell.mjs";
import { errorMessage, layout, receiptPanel } from "./views.mjs";

const extraErrors = {
  classified_marking: "Classification markings were detected, so nothing was saved. Do not send classified information here.",
  invalid_statement: "Enter a statement of up to 4,000 characters.", invalid_label: "Enter a label of up to 80 characters.",
  invalid_scope: "Choose an access level.", invalid_kind: "Choose a request type.", forbidden: "You do not have permission to do that.",
  draft_not_found: "No unexpired draft matches that code.", invalid_mfa_code: "That code did not match. Check your authenticator's clock.",
  weak_password: "Passwords must be at least 16 varied characters.", invalid_username: "Usernames are 3 to 40 lowercase letters, digits, dot, dash or underscore.",
  invalid_roles: "Choose at least one valid role.", username_taken: "That username is taken.", dual_control_required: "A different privacy officer must approve.",
  reveal_unavailable: "This reveal is not approved, has expired, or was already used.", invalid_reason: "Enter a reason of up to 500 characters.",
  identity_disposed: "The identity was disposed under the retention schedule.",
};
export const msg = (c) => extraErrors[c] ??
  (/^(missing|invalid)_[A-Za-z]+$/.test(c) && !errorMessage(c).startsWith("The request")
    ? errorMessage(c)
    : /^missing_([A-Za-z]+)$/.test(c) ? `Complete the required field "${c.slice(8).replace(/([A-Z])/g, " $1").toLowerCase()}".`
    : /^invalid_([A-Za-z]+)$/.test(c) ? `Check the field "${c.slice(8).replace(/([A-Z])/g, " $1").toLowerCase()}".` : errorMessage(c));
const err = (c) => (c ? `<div class="error-summary" role="alert"><h2>There is a problem</h2><p>${h(msg(c))}</p></div>` : "");
const csrfField = (t) => `<input type="hidden" name="csrf" value="${h(t)}">`;
const when = (d) => (d ? new Date(d).toISOString().replace(".000Z", "Z") : "");

const attestations = `<fieldset><legend>Before you submit (required)</legend>` +
  `<label class="check"><input type="checkbox" name="attest_demo" value="yes" required> I understand this is a demonstration that files nothing with any government institution.</label>` +
  `<label class="check"><input type="checkbox" name="attest_synthetic" value="yes" required> I am entering only synthetic, made-up information. No real personal data.</label>` +
  `<label class="check"><input type="checkbox" name="attest_unclassified" value="yes" required> This contains no classified or sensitive government information.</label></fieldset>`;

export function filingFields({ agencies, idempotencyKey, values = {}, lockedAgency = null, structuredHtml = "" }) {
  const types = [...new Set(agencies.flatMap((a) => a.filingTypes))];
  const agencyField = lockedAgency
    ? `<input type="hidden" name="agencyId" value="${h(lockedAgency.id)}"><p><strong>Agency:</strong> ${h(lockedAgency.name)}</p>`
    : `<label for="agencyId">Fictional recipient agency</label><select id="agencyId" name="agencyId" required>${agencies.map((a) =>
      `<option value="${h(a.id)}"${values.agencyId === a.id ? " selected" : ""}>${h(a.name)}: ${h(a.filingTypes.join(", "))}</option>`).join("")}</select>`;
  return `<input type="hidden" name="idempotencyKey" value="${h(idempotencyKey)}">${values.draftCode ? `<input type="hidden" name="draftCode" value="${h(values.draftCode)}">` : ""}${agencyField}` +
    `<label for="filingType">Filing type</label><select id="filingType" name="filingType" required>${types.map((t) =>
      `<option value="${h(t)}"${values.filingType === t ? " selected" : ""}>${h(t)}</option>`).join("")}</select>` +
    `<label for="title">Subject</label><input id="title" name="title" maxlength="200" required value="${h(values.title ?? "")}">` +
    `<label for="body">Filing text</label><textarea id="body" name="body" rows="10" maxlength="20000" required>${h(values.body ?? "")}</textarea>` +
    structuredHtml +
    `<label for="claimantName">Your name (synthetic; stored encrypted)</label><input id="claimantName" name="claimantName" maxlength="120" required autocomplete="off" value="${h(values.claimantName ?? "")}">` +
    `<label for="claimantContact">Contact (optional, synthetic; stored encrypted)</label><input id="claimantContact" name="claimantContact" maxlength="200" autocomplete="off" value="${h(values.claimantContact ?? "")}">` +
    `<label for="files">Attachments (optional: up to 3 PDF, text, PNG or JPEG files; 5 MB each). Files are scanned; anything unsafe is quarantined.</label><input id="files" name="files" type="file" multiple accept=".pdf,.txt,.png,.jpg,.jpeg,application/pdf,text/plain,image/png,image/jpeg">` +
    `<fieldset><legend>Urgency</legend><label class="check"><input type="checkbox" name="emergency" value="yes"${values.emergency === "yes" || values.emergency === true ? " checked" : ""}> This matter involves an imminent risk to health, safety, shelter or liberty (prioritized routing, 4-hour target).</label></fieldset>` +
    attestations;
}

export function filePage2({ agencies, idempotencyKey, error, values, structuredHtml }) {
  return layout({ title: "File (demo)", path: "/file", body: `<p class="eyebrow">Demonstration filing</p><h1>Submit a demonstration filing</h1>` +
    `<p class="lead">Practice the filing journey with fictional agencies. You will receive a signed demonstration receipt, a tracking number and a one-time access code. <a href="/file/guide">Not sure what to file? Use the guide.</a> <a href="/file/resume">Resume a saved draft.</a></p>` +
    err(error) + `<form class="demo-form" method="post" action="/file" enctype="multipart/form-data">${filingFields({ agencies, idempotencyKey, values, structuredHtml })}` +
    `<div class="actions"><button class="button" type="submit" name="action" value="file">Submit demonstration filing</button> <button class="button secondary" type="submit" name="action" value="draft" formnovalidate>Save draft (text only)</button></div></form>` });
}

export function draftSavedPage(draftCode) {
  return layout({ title: "Draft saved", path: "/file", body: `<p class="eyebrow">Draft saved</p><h1>Your draft is saved for 7 days</h1>` +
    `<section class="once" role="status"><p>Draft code: <code class="big">${h(draftCode.match(/.{1,4}/g).join("-"))}</code></p><p class="small">Shown once. Attachments and confirmations are not saved; add them when you resume. Nothing has been filed.</p></section><p><a href="/file/resume">Resume a draft →</a></p>` });
}

export function resumePage(error) {
  return layout({ title: "Resume a draft", path: "/file", body: `<p class="eyebrow">Drafts</p><h1>Resume a saved draft</h1>` + err(error) +
    `<form class="demo-form" method="post" action="/file/resume"><label for="draftCode">Draft code</label><input id="draftCode" name="draftCode" required autocomplete="off" maxlength="40"><button class="button" type="submit">Resume</button></form>` });
}

export function classifiedRefusedPage() {
  return layout({ title: "Submission stopped", path: "/file", body: `<p class="eyebrow">Submission stopped</p><h1>Classification markings detected</h1>` +
    `<section class="error-summary" role="alert"><p>Your submission appears to contain U.S. classification markings. It was <strong>not saved</strong>; only a content-free audit event was recorded.</p>` +
    `<p>Classified information must never be sent through an unclassified website. Contact your security officer or the responsible institution for an authorized classified channel.</p></section><p><a href="/help">Read help and safety guidance →</a></p>` });
}

const statusLabel = { received: "Received (demo receipt issued)", routed: "Delivered to fictional agency inbox", routing_escalated: "Routing escalated to staff",
  under_review: "Under review", information_requested: "Information requested", referred: "Referred", closed: "Closed", withdrawn: "Withdrawn",
  withdrawal_requested: "Withdrawal requested", correction_requested: "Receipt correction requested", complaint_filed: "Complaint filed" };
export const statusText = (s) => statusLabel[s] ?? String(s ?? "").replace(/_/g, " ");

export function caseView2({ view, agencies, session, csrf, idempotencyKey, error, values, delegations = [], corrections = [], notices = "", extraHtml = "" }) {
  const root = view.filings[0];
  const agency = agencies.find((a) => a.name === root.agencyName);
  const canAct = session.scope !== "view";
  const owner = session.scope === "owner";
  return layout({ title: "Filing status", path: "/track", body: `<p class="eyebrow">Status tracking${owner ? "" : " · representative access (" + h(session.scope) + ")"}</p><h1>${h(root.title)}</h1>` +
    `<form method="post" action="/track/logout" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Sign out</button></form>` +
    err(error) + `<h2>Current status</h2><p class="status-pill">${h(statusText(view.history.at(-1)?.status ?? root.status))}</p>` + extraHtml + notices +
    `<h2>History</h2><ol class="timeline">${view.history.map((e) => `<li><time datetime="${h(e.at)}">${h(e.at)}</time> · ${h(statusText(e.status))}${e.note ? `: ${h(e.note)}` : ""}</li>`).join("")}</ol>` +
    `<h2>Receipts</h2>${view.filings.map((f) => receiptPanel(f.receipt) +
      `<p class="small"><a href="/track/receipts/${h(f.receipt.receipt.receiptId)}.json">Download signed receipt (JSON)</a> · <a href="/track/receipts/${h(f.receipt.receipt.receiptId)}.txt">Plain-text copy</a>${f.acknowledgement ? ` · Fictional agency acknowledgement <code>${h(f.acknowledgement)}</code>` : ""}</p>`).join("")}` +
    `<h2>Corrections, complaints and withdrawal</h2>${corrections.length ? `<ul>${corrections.map((c) => `<li>${h(c.kind.replace(/_/g, " "))} · filed ${h(when(c.filed_at))} · ${c.decision ? h(c.decision) + (c.decision_note ? `: ${h(c.decision_note)}` : "") : "pending"}${c.correction_document ? ` · <a href="/track/corrections/${h(c.id)}.json">signed correction notice</a>` : ""}</li>`).join("")}</ul>` : "<p>None filed.</p>"}` +
    (canAct ? `<form class="demo-form" method="post" action="/track/corrections">${csrfField(csrf)}<label for="kind">Request type</label><select id="kind" name="kind"><option value="receipt_correction">Receipt correction</option><option value="processing_complaint">Complaint about processing</option><option value="withdrawal">Withdraw this filing</option></select><label for="statement">Statement</label><textarea id="statement" name="statement" rows="4" maxlength="4000" required></textarea><button class="button" type="submit">Submit request</button></form>` : "") +
    (owner ? `<h2>Representative access</h2><p>Let a representative view (or also supplement) this filing with their own code. You can revoke it at any time.</p>${delegations.length ? `<ul>${delegations.map((d) => `<li>${h(d.label)} · ${h(d.scope)} · ${d.revoked_at ? "revoked" : `<form method="post" action="/track/delegations/${h(d.id)}/revoke" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Revoke</button></form>`}</li>`).join("")}</ul>` : ""}` +
      `<form class="demo-form" method="post" action="/track/delegations">${csrfField(csrf)}<label for="label">Representative label (synthetic)</label><input id="label" name="label" maxlength="80" required><label for="scope">Access</label><select id="scope" name="scope"><option value="view">View status and receipts</option><option value="view_supplement">View and submit supplements</option></select><button class="button" type="submit">Create representative code</button></form>` : "") +
    (canAct && agency ? `<h2>Add a supplementary filing</h2><p>Supplements receive their own receipt and never change the original.</p>` +
      `<form class="demo-form" method="post" action="/track/amend" enctype="multipart/form-data">${csrfField(csrf)}${filingFields({ agencies: [agency], idempotencyKey, values: values ?? { filingType: root.filingType }, lockedAgency: agency })}<button class="button" type="submit">Submit supplement</button></form>` : "") });
}

export function delegationCreatedPage(delegateCode, tracking) {
  return layout({ title: "Representative code", path: "/track", body: `<p class="eyebrow">Representative access</p><h1>Share this code with your representative</h1>` +
    `<section class="once" role="status"><p>Tracking number: <code class="big">${h(tracking)}</code></p><p>Representative code: <code class="big">${h(delegateCode.match(/.{1,4}/g).join("-"))}</code></p><p class="small">Shown once. Stored only as a salted hash. Revoke it from the status page at any time.</p></section><p><a href="/track/case">Back to status →</a></p>` });
}

// ------------------------------------------------------------ staff
export function staffLayout({ title, user, body, path = "/staff" }) {
  return layout({ title, path, staff: true, staffUser: user, body });
}
export function staffLoginPage2({ error, configured }) {
  return layout({ title: "Staff sign-in", path: "/staff", staff: true, body: `<p class="eyebrow">Demo staff console</p><h1>Staff sign-in</h1>` +
    (!configured ? `<section class="empty-state" role="status"><p>Staff access is not configured on this deployment.</p></section>` :
      (error ? `<div class="error-summary" role="alert"><p>${h(error === "rate_limited" ? msg(error) : error === "mfa_required" ? "Enter your 6-digit authenticator code." : error === "locked" ? "Too many failed attempts. Try again in 15 minutes." : "Sign-in failed.")}</p></div>` : "") +
      `<form class="demo-form" method="post" action="/staff/login"><label for="username">Username</label><input id="username" name="username" required autocomplete="username">` +
      `<label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password">` +
      `<label for="totp">Authenticator code (if MFA is enabled)</label><input id="totp" name="totp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"><button class="button" type="submit">Sign in</button></form>`) });
}

export function staffQueuePage2({ rows, csrf, user }) {
  return staffLayout({ title: "Staff queue", user, body: `<p class="eyebrow">Demo staff console · ${h(user.username)} · ${h(user.roles.join(", "))}</p><h1>Filing queue</h1>` +
    `<form method="post" action="/staff/logout" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Sign out</button></form>` +
    `<div class="table-wrap"><table><caption>Demonstration filings (synthetic data). Emergency matters first.</caption><thead><tr><th scope="col">Received</th><th scope="col">Tracking</th><th scope="col">Kind</th><th scope="col">Subject</th><th scope="col">Fictional agency</th><th scope="col">Routing</th><th scope="col">Status</th></tr></thead><tbody>` +
    (rows.length ? rows.map((r) => `<tr${r.emergency ? ' class="emergency"' : ""}><td><time datetime="${h(r.receivedAt)}">${h(r.receivedAt.slice(0, 16).replace("T", " "))}</time></td><td><a href="/staff/submissions/${h(r.id)}"><code>${h(r.trackingNumber)}</code></a>${r.emergency ? ' <strong class="badge">EMERGENCY</strong>' : ""}</td><td>${h(r.kind)}</td><td>${h(r.title)}</td><td>${h(r.agencyName)}</td><td>${h(r.routing ?? "")}</td><td>${h(statusText(r.status))}</td></tr>`).join("")
      : `<tr><td colspan="7">No filings yet.</td></tr>`) + `</tbody></table></div>` });
}

export function staffSubmissionPage2({ s, csrf, statuses, user, corrections, records, canReveal, canDecide, canHold, extraHtml = "" }) {
  return staffLayout({ title: "Filing detail", user, body: `<p class="eyebrow">Demo staff console · ${h(s.kind)}${s.emergency ? " · EMERGENCY" : ""}</p><h1>${h(s.title)}</h1>` +
    `<dl class="facts"><dt>Tracking</dt><dd><code>${h(s.tracking_number)}</code></dd><dt>Fictional agency</dt><dd>${h(s.agency_name)}</dd><dt>Filing type</dt><dd>${h(s.filing_type)}</dd>` +
    `<dt>Received</dt><dd>${h(when(s.received_at))}</dd><dt>Claimant</dt><dd>${s.identity_protected ? "Protected compartment (encrypted). Reveal requires a second privacy officer's approval." : `${h(s.claimant_name)}${s.claimant_contact ? ` · ${h(s.claimant_contact)}` : ""}`}</dd>` +
    `<dt>Routing</dt><dd>${h(s.routing_state ?? "")}${s.acknowledgement ? ` · ack <code>${h(s.acknowledgement)}</code>` : ""}${s.last_error ? ` · last error: ${h(s.last_error)}` : ""} · due by ${h(when(s.due_by))}</dd>` +
    `<dt>Manifest SHA-256</dt><dd><code class="hash">${h(s.manifest_sha256)}</code></dd>` +
    `<dt>Records</dt><dd>${records.disposition ? `Disposed ${h(when(records.disposition.disposed_at))} (${h(records.disposition.rule)})` : records.hold && !records.hold.released_at ? `On legal hold since ${h(when(records.hold.placed_at))}` : "Active"}</dd></dl>` +
    extraHtml +
    (canReveal && s.identity_protected ? `<form class="demo-form" method="post" action="/staff/submissions/${h(s.id)}/reveal">${csrfField(csrf)}<label for="reason">Reason for identity reveal (ledgered)</label><input id="reason" name="reason" maxlength="500" required><button class="button secondary" type="submit">Request identity reveal</button></form>` : "") +
    `<h2>Original text (immutable)</h2><pre class="filing-text">${h(s.body)}</pre>` +
    (s.structured && Object.keys(s.structured).length ? `<h2>Structured fields</h2><dl class="facts">${Object.entries(s.structured).map(([k, v]) => `<dt>${h(k)}</dt><dd>${h(typeof v === "string" ? v : JSON.stringify(v))}</dd>`).join("")}</dl>` : "") +
    `<h2>Attachments</h2>${s.documents.length ? `<ul>${s.documents.map((d) => `<li>${d.verdict === "clean" ? `<a href="/staff/documents/${h(d.id)}">${h(d.filename)}</a>` : `${h(d.filename)} <strong class="badge">QUARANTINED: ${h(d.verdict ?? "unscanned")}</strong> ${h(d.scan_detail ?? "")}`} · ${h(d.media_type)} · ${d.size_bytes} bytes · ${h(d.encryption)} · <code class="hash">${h(d.sha256)}</code></li>`).join("")}</ul>` : "<p>None.</p>"}` +
    `<h2>Corrections and complaints</h2>${corrections.length ? `<ul>${corrections.map((c) => `<li><strong>${h(c.kind.replace(/_/g, " "))}</strong> (${h(c.filed_by)}, ${h(when(c.filed_at))}): ${h(c.statement)} · ${c.decision ? `${h(c.decision)} by ${h(c.decided_by_name)}` : canDecide ? `<form method="post" action="/staff/corrections/${h(c.id)}" class="inline-form">${csrfField(csrf)}<label for="note-${h(c.id)}">Note</label> <input id="note-${h(c.id)}" name="note" maxlength="2000"> <button class="text-button" name="decision" value="accepted">Accept</button> <button class="text-button" name="decision" value="denied">Deny</button></form>` : "pending"}</li>`).join("")}</ul>` : "<p>None.</p>"}` +
    `<h2>Review history</h2><ol class="timeline">${s.history.map((e) => `<li>${h(when(e.at))} · ${h(statusText(e.status))} · ${h(e.actor)}${e.note ? `: ${h(e.note)}` : ""}${e.ledger_seq ? ` · ledger #${h(e.ledger_seq)}` : ""}</li>`).join("")}</ol>` +
    `<h2>Record review status</h2><form class="demo-form" method="post" action="/staff/submissions/${h(s.id)}/status">${csrfField(csrf)}` +
    `<label for="status">Status</label><select id="status" name="status">${statuses.map((x) => `<option value="${h(x)}">${h(statusText(x))}</option>`).join("")}</select>` +
    `<label for="note">Note (synthetic)</label><textarea id="note" name="note" rows="3" maxlength="1000"></textarea><button class="button" type="submit">Record status</button></form>` +
    (canHold ? `<h2>Records management</h2>${records.hold && !records.hold.released_at ? `<form method="post" action="/staff/submissions/${h(s.id)}/hold/release">${csrfField(csrf)}<button class="button secondary" type="submit">Release legal hold</button></form>` : `<form class="demo-form" method="post" action="/staff/submissions/${h(s.id)}/hold">${csrfField(csrf)}<label for="hold-reason">Legal hold reason</label><input id="hold-reason" name="reason" maxlength="500" required><button class="button secondary" type="submit">Place legal hold</button></form>`}` : "") +
    receiptPanel(s.document) });
}

export function staffRevealsPage({ user, csrf, pending, mine }) {
  return staffLayout({ title: "Identity reveals", user, path: "/staff/reveals", body: `<p class="eyebrow">Dual control</p><h1>Identity reveal requests</h1>` +
    `<h2>Awaiting approval</h2>${pending.length ? `<ul>${pending.map((r) => `<li><code>${h(r.tracking_number)}</code> · requested by ${h(r.requested_by)} · ${h(r.reason)}${r.requester_id !== user.id && user.roles.includes("privacy_officer") ? ` <form method="post" action="/staff/reveals/${h(r.id)}/approve" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">Approve</button></form>` : ""}</li>`).join("")}</ul>` : "<p>None.</p>"}` +
    `<h2>My approved reveals (one-time, 15 minutes)</h2>${mine.length ? `<ul>${mine.map((r) => `<li><code>${h(r.tracking_number)}</code> <form method="post" action="/staff/reveals/${h(r.id)}/view" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">View identity once</button></form></li>`).join("")}</ul>` : "<p>None.</p>"}` });
}

export function revealResultPage({ user, identity }) {
  return staffLayout({ title: "Identity", user, path: "/staff/reveals", body: `<p class="eyebrow">Ledgered one-time reveal</p><h1>Protected identity (synthetic)</h1>` +
    `<dl class="facts"><dt>Name</dt><dd>${h(identity.claimantName)}</dd><dt>Contact</dt><dd>${h(identity.claimantContact || "(none)")}</dd></dl><p class="small">This view was recorded in the ledger and cannot be repeated.</p>` });
}

export function staffUsersPage({ user, csrf, users, error }) {
  return staffLayout({ title: "Staff accounts", user, path: "/staff/admin/users", body: `<p class="eyebrow">Administration</p><h1>Staff accounts</h1>` + err(error) +
    `<div class="table-wrap"><table><thead><tr><th scope="col">User</th><th scope="col">Roles</th><th scope="col">MFA</th><th scope="col">State</th></tr></thead><tbody>${users.map((u) => `<tr><td>${h(u.username)}</td><td>${h(u.roles.join(", "))}</td><td>${u.mfa_enabled ? "on" : "off"}</td><td>${u.disabled ? "disabled" : "active"}${u.id !== user.id ? ` <form method="post" action="/staff/admin/users/${h(u.id)}/${u.disabled ? "enable" : "disable"}" class="inline-form">${csrfField(csrf)}<button class="text-button" type="submit">${u.disabled ? "Enable" : "Disable"}</button></form>` : ""}</td></tr>`).join("")}</tbody></table></div>` +
    `<h2>Create account</h2><form class="demo-form" method="post" action="/staff/admin/users">${csrfField(csrf)}<label for="new-username">Username</label><input id="new-username" name="username" required maxlength="40" autocomplete="off">` +
    `<label for="new-password">Initial password (16+ characters)</label><input id="new-password" name="password" type="password" required minlength="16" autocomplete="new-password">` +
    `<label for="roles">Roles (comma-separated: admin, intake, privacy_officer, oversight, records_officer, agency:&lt;agency-id&gt;)</label><input id="roles" name="roles" required maxlength="300"><button class="button" type="submit">Create</button></form>` });
}

export function staffMfaPage({ user, csrf, secret, uri, enabled, error }) {
  return staffLayout({ title: "Two-factor authentication", user, path: "/staff/mfa", body: `<p class="eyebrow">Account security</p><h1>Authenticator (TOTP) sign-in</h1>` + err(error) +
    (enabled ? `<p class="verify-ok">Two-factor authentication is on.</p>` : secret
      ? `<p>Add this secret to an authenticator app, then enter the current 6-digit code.</p><p>Secret: <code class="big">${h(secret.match(/.{1,4}/g).join(" "))}</code></p><p class="small">Setup URI: <code class="hash">${h(uri)}</code></p><form class="demo-form" method="post" action="/staff/mfa/confirm">${csrfField(csrf)}<label for="code">Code</label><input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code"><button class="button" type="submit">Turn on</button></form>`
      : `<form method="post" action="/staff/mfa/begin">${csrfField(csrf)}<button class="button" type="submit">Set up authenticator</button></form>`) });
}

export function staffRecordsPage({ user, csrf, result, schedule }) {
  return staffLayout({ title: "Records", user, path: "/staff/records", body: `<p class="eyebrow">Records management</p><h1>Retention and disposition</h1>` +
    `<p class="small">${h(schedule.notice)}</p><div class="table-wrap"><table><thead><tr><th scope="col">Filing type</th><th scope="col">Retention (days)</th></tr></thead><tbody>${Object.entries(schedule.schedules).map(([k, v]) => `<tr><td>${h(k)}</td><td>${v}</td></tr>`).join("")}</tbody></table></div>` +
    (result !== undefined ? `<p class="verify-ok" role="status">Disposition run complete: ${result} filing(s) crypto-shredded.</p>` : "") +
    `<form method="post" action="/staff/records/dispose">${csrfField(csrf)}<button class="button secondary" type="submit">Run disposition now</button></form><p class="small">Disposition destroys the data keys for identity, filing text and attachments of expired filings not on legal hold. Receipts, manifests (hashes only), subject lines and the ledger remain, so receipts stay verifiable.</p>` });
}

export function staffNotificationsPage({ user, list }) {
  return staffLayout({ title: "Notifications", user, path: "/staff/notifications", body: `<p class="eyebrow">Provider-free notifications</p><h1>Notifications</h1>` +
    (list.length ? `<ul>${list.map((n) => `<li>${h(when(n.created_at))} · ${h(n.template)} · ${h(n.audience)}${n.payload?.submissionId ? ` · <a href="/staff/submissions/${h(n.payload.submissionId)}">open</a>` : ""}</li>`).join("")}</ul>` : "<p>None.</p>") });
}
