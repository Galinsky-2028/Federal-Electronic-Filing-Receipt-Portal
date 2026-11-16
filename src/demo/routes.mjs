import Busboy from "busboy";
import { randomBytes } from "node:crypto";
import { clientAddress, PARTICIPANT_COOKIE, sameOrigin, STAFF_COOKIE } from "./auth.mjs";
import { IntakeError, LIMITS, STAFF_STATUSES } from "./backend.mjs";
import { sha256Hex } from "./canonical.mjs";
import { verifyLedger } from "./ledger.mjs";
import { demoStylesheet, filedPage, staffLedgerPage, trackLoginPage, unavailablePage, verifyPage } from "./views.mjs";
import {
  caseView2, classifiedRefusedPage, delegationCreatedPage, draftSavedPage, filePage2, msg, resumePage, revealResultPage,
  staffLoginPage2, staffMfaPage, staffNotificationsPage, staffQueuePage2, staffRecordsPage, staffRevealsPage,
  staffSubmissionPage2, staffUsersPage,
} from "./views2.mjs";
import { agencyScopes, hasRole } from "../platform/services.mjs";
import { otpauthUri } from "../platform/safety.mjs";

export const DEMO_CSP = "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const MAX_FORM_BYTES = 64 * 1024;
const MAX_MULTIPART_BYTES = LIMITS.totalBytes + 512 * 1024;
const newKey = () => randomBytes(18).toString("base64url");
const UUID = "[0-9a-f-]{36}";

const PUBLIC_EXACT = ["/file", "/file/resume", "/file/guide", "/track", "/track/case", "/track/amend", "/track/logout", "/track/corrections",
  "/track/delegations", "/verify", "/api/verify", "/api/receipts/keys", "/api/demo/agencies", "/assets/demo.v1.css"];
const DEMO_PATTERNS = [
  /^\/track\/receipts\/RCPT-DEMO-[0-9A-Z]{20}\.(json|txt)$/, new RegExp(`^/track/(corrections/${UUID}\\.json|delegations/${UUID}/revoke)$`),
  /^\/file\/guide\/[a-z-]{2,40}$/, /^\/staff(\/.*)?$/,
];
const extraMatchers = [];
/** Lets feature modules (workflows, oversight, operations) claim extra paths. */
export function registerDemoPaths(...matchers) { extraMatchers.push(...matchers); }
export function isDemoPath(path) {
  return PUBLIC_EXACT.includes(path) || DEMO_PATTERNS.some((re) => re.test(path)) || extraMatchers.some((m) => m(path));
}

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

export function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) { req.resume(); return reject(new HttpError(413, "payload_too_large")); }
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > max) { req.destroy(); reject(new HttpError(413, "payload_too_large")); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "unsupported_media_type");
  const params = new URLSearchParams((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
  const out = {};
  for (const [k, v] of params) { if (k === "roles" && k in out) out[k] += "," + v; else if (!(k in out)) out[k] = v; }
  return out;
}

export function readMultipart(req) {
  return new Promise((resolve, reject) => {
    if (!/^multipart\/form-data\b/i.test(req.headers["content-type"] ?? "")) return reject(new HttpError(415, "unsupported_media_type"));
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_MULTIPART_BYTES) { req.resume(); return reject(new IntakeError("file_too_large", 413)); }
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fields: 40, fieldSize: 25_000, files: LIMITS.files + 1,
        fileSize: LIMITS.fileBytes + 1, parts: 50, headerPairs: 50 } });
    } catch { return reject(new HttpError(400, "invalid_request")); }
    const fields = {}; const files = []; let failure = null; let total = 0;
    bb.on("field", (name, value, info) => { if (info.valueTruncated) failure ??= new IntakeError("invalid_body"); if (!(name in fields)) fields[name] = value; });
    bb.on("file", (name, stream, info) => {
      const chunks = []; let size = 0;
      stream.on("data", (c) => { size += c.length; total += c.length; if (total > MAX_MULTIPART_BYTES) failure ??= new IntakeError("file_too_large", 413); else chunks.push(c); });
      stream.on("limit", () => { failure ??= new IntakeError("file_too_large", 413); });
      stream.on("close", () => {
        if (name !== "files" || (size === 0 && !info.filename)) return;
        files.push({ filename: info.filename || "attachment", mediaType: String(info.mimeType).toLowerCase(), content: Buffer.concat(chunks) });
      });
    });
    bb.on("filesLimit", () => { failure ??= new IntakeError("too_many_files"); });
    bb.on("partsLimit", () => { failure ??= new HttpError(400, "invalid_request"); });
    bb.on("error", () => reject(new HttpError(400, "invalid_request")));
    bb.on("close", () => failure ? reject(failure) : resolve({ fields, files }));
    req.pipe(bb);
  });
}

const attested = (f) => f.attest_demo === "yes" && f.attest_synthetic === "yes" && f.attest_unclassified === "yes";
export function receiptText(doc) {
  const r = doc.receipt;
  return ["DEMONSTRATION RECEIPT - NOT A GOVERNMENT RECEIPT", r.notice, "",
    `Receipt ID:        ${r.receiptId}`, `Tracking number:   ${r.trackingNumber}`, `Kind:              ${r.kind}${r.amends ? ` (supplements ${r.amends})` : ""}`,
    `Received:          ${r.receivedAt} (database time of record)`, `Fictional agency:  ${r.agency.name}`, `Filing type:       ${r.filingType}`,
    `Manifest SHA-256:  ${r.manifest.sha256} (${r.manifest.partCount} parts, ${r.manifest.totalBytes} bytes)`,
    `Ledger entry:      #${r.ledger.seq} ${r.ledger.entryHash}`, `Signing key:       ${r.issuer.keyId} (Ed25519)`, `Signature:         ${doc.signature.value}`,
    "", "Verify the JSON copy at /verify. Verification proves only these cryptographic facts.", ""].join("\n");
}

/**
 * Builds the demo request handler. Response objects follow the portal
 * server contract ({status, contentType, rawBody|body, headers}).
 * `extensions` are feature handlers tried first; each returns a response or null.
 */
export function createDemoHandler({ backend, auth, platform = null, publicOrigin = null, trustProxy = false, logger = () => {},
  extensions = [], structuredForms = null }) {
  const html = (status, rawBody, headers = {}) => ({ status, contentType: "text/html; charset=utf-8", rawBody, headers });
  const redirect = (location, headers = {}) => ({ status: 303, rawBody: "", contentType: "text/plain; charset=utf-8", headers: { location, ...headers } });
  const json = (status, body) => ({ status, body });

  async function limit(req, scope, max, windowSeconds) {
    const ok = await backend.allow(`${scope}:${clientAddress(req, trustProxy)}`, max, windowSeconds) &&
      await backend.allow(`${scope}:global`, max * 20, windowSeconds);
    if (!ok) throw new IntakeError("rate_limited", 429);
  }
  async function participantSession(cookies) {
    const s = auth.participant(cookies);
    if (!s) return null;
    const [rootId, scope = "owner", delegationId = ""] = s.subject.split("|");
    if (delegationId && !(await platform.delegationActive(delegationId))) return null;
    return { rootId, scope, delegationId: delegationId || null, csrf: s.csrf };
  }
  async function staffSession(cookies) {
    const s = auth.staff(cookies);
    if (!s) return null;
    const user = await platform.getStaff(s.subject);
    return user ? { user, csrf: s.csrf } : null;
  }
  const structuredHtml = (values) => structuredForms?.render(values?.filingType, values) ?? "";
  const filingInput = (f, files, extra = {}) => ({ agencyId: f.agencyId, filingType: f.filingType, title: f.title ?? "", body: f.body ?? "",
    claimantName: f.claimantName ?? "", claimantContact: f.claimantContact ?? "", idempotencyKey: f.idempotencyKey, documents: files,
    emergency: f.emergency === "yes", structured: structuredForms ? structuredForms.parse(f.filingType, f) : {}, ...extra });

  async function handle(req, path, method) {
    if (path === "/assets/demo.v1.css" && (method === "GET" || method === "HEAD"))
      return { status: 200, contentType: "text/css; charset=utf-8", rawBody: demoStylesheet, headOnly: method === "HEAD" };
    if (!backend) {
      if (path.startsWith("/api/")) return json(503, { schemaVersion: 1, status: "demo_unconfigured", filingsAccepted: false });
      return html(503, unavailablePage(path));
    }
    const isGet = method === "GET" || method === "HEAD";
    const isPost = method === "POST";
    const tokenApi = path.startsWith("/api/uploads"); // bearer-token JSON API: no ambient credentials, so no CSRF exposure
    if (!isGet && !isPost && !(tokenApi && method === "PUT")) return { status: 405, body: { error: "method_not_allowed" }, allow: "GET, HEAD, POST" };
    if (isPost && !tokenApi && !sameOrigin(req, publicOrigin)) return json(403, { error: "cross_origin_request_rejected" });
    const cookies = auth.parseCookies(req.headers.cookie);
    const ctx = { req, path, method, isGet, isPost, cookies, html, json, redirect, readForm, readMultipart, limit,
      participant: () => participantSession(cookies), staff: () => staffSession(cookies), backend, platform, auth, logger };
    for (const ext of extensions) {
      const r = await ext(ctx);
      if (r) return r;
    }

    // ---------------------------------------------------------------- public JSON APIs
    if (path === "/api/receipts/keys") return isGet ? json(200, { schema: "ufr-demo-receipt-keys-v1", demo: true,
      notice: "Keys of a development prototype. Not a government key.", keys: backend.publicKeys() }) : json(405, { error: "method_not_allowed" });
    if (path === "/api/demo/agencies") return json(200, { schema: "ufr-demo-agencies-v1", fictional: true, agencies: await backend.listAgencies() });
    if (path === "/api/verify") {
      if (!isPost) return { status: 405, body: { error: "method_not_allowed" }, allow: "POST" };
      await limit(req, "verify", 60, 60);
      let doc;
      try { doc = JSON.parse((await readBody(req, 32 * 1024)).toString("utf8")); } catch (e) { if (e instanceof HttpError) throw e; return json(400, { valid: false, reason: "malformed_document" }); }
      return json(200, await backend.verifyReceipt(doc));
    }

    // ---------------------------------------------------------------- filing, drafts
    if (path === "/file") {
      const agencies = await backend.listAgencies();
      if (isGet) return html(200, filePage2({ agencies, idempotencyKey: newKey(), structuredHtml: structuredHtml({}) }));
      let parsed;
      try {
        await limit(req, "file", 10, 600);
        parsed = await readMultipart(req);
        if (parsed.fields.action === "draft") {
          const draftCode = await platform.saveDraft({ ...parsed.fields, structured: structuredForms?.parse(parsed.fields.filingType, parsed.fields, { lenient: true }) ?? {} });
          return html(201, draftSavedPage(draftCode));
        }
        if (!attested(parsed.fields)) throw new IntakeError("attestations_required");
        const draft = parsed.fields.draftCode ? await platform.loadDraft(parsed.fields.draftCode) : null;
        const staged = await platform.uploads?.resolve(parsed.fields.uploadTokens) ?? [];
        const result = await backend.fileSubmission(filingInput(parsed.fields, [...parsed.files, ...staged], { draftCodeHash: draft?.codeHash }));
        await platform.uploads?.consume(staged.map((d) => d.uploadId));
        logger("filing.received", { receiptId: result.receipt.receipt.receiptId, replayed: result.replayed });
        return html(result.replayed ? 200 : 201, filedPage({ result }));
      } catch (error) {
        if (!(error instanceof IntakeError)) throw error;
        if (error.code === "classified_marking") { logger("intake.classified_marking_refused", {}); return html(422, classifiedRefusedPage()); }
        return html(error.status ?? 400, filePage2({ agencies, idempotencyKey: error.code === "idempotency_conflict" ? newKey() : (parsed?.fields.idempotencyKey ?? newKey()),
          error: error.code, values: parsed?.fields, structuredHtml: structuredHtml(parsed?.fields) }));
      }
    }
    if (path === "/file/resume") {
      if (isGet) return html(200, resumePage());
      await limit(req, "draft", 20, 600);
      const form = await readForm(req);
      const draft = await platform.loadDraft(form.draftCode);
      if (!draft) return html(404, resumePage("draft_not_found"));
      const values = { ...draft.fields, draftCode: form.draftCode, emergency: draft.fields.emergency, ...(draft.fields.structured ?? {}) };
      return html(200, filePage2({ agencies: await backend.listAgencies(), idempotencyKey: newKey(), values, structuredHtml: structuredHtml(values) }));
    }

    // ---------------------------------------------------------------- participant tracking
    if (path === "/track") {
      if (isGet) return (await participantSession(cookies)) ? redirect("/track/case") : html(200, trackLoginPage());
      try { await limit(req, "track", 20, 600); } catch { return html(429, trackLoginPage({ error: "rate_limited" })); }
      const form = await readForm(req);
      const session = await backend.openParticipantSession(form.trackingNumber, form.accessCode);
      if (!session) return html(401, trackLoginPage({ error: "no_match" }));
      return redirect("/track/case", { "set-cookie": auth.issueParticipant(`${session.rootId}|${session.scope}|${session.delegationId ?? ""}`).header });
    }
    if (path.startsWith("/track/")) {
      const session = await participantSession(cookies);
      if (path === "/track/logout") {
        const form = await readForm(req);
        if (!auth.csrfValid(session ? { csrf: session.csrf } : null, form.csrf)) return json(403, { error: "csrf_rejected" });
        return redirect("/track", { "set-cookie": auth.clear(PARTICIPANT_COOKIE) });
      }
      if (!session) return redirect("/track", { "set-cookie": auth.clear(PARTICIPANT_COOKIE) });
      const view = await backend.participantView(session.rootId);
      if (!view) return redirect("/track", { "set-cookie": auth.clear(PARTICIPANT_COOKIE) });
      const agencies = await backend.listAgencies();
      const render = async (status, extra = {}) => html(status, caseView2({ view, agencies, session, csrf: session.csrf, idempotencyKey: newKey(),
        delegations: session.scope === "owner" ? await platform.listDelegations(session.rootId) : [],
        corrections: await platform.listCorrections(session.rootId), extraHtml: ctx.caseExtraHtml ? await ctx.caseExtraHtml(session, view) : "", ...extra }));
      let m;
      if ((m = /^\/track\/receipts\/(RCPT-DEMO-[0-9A-Z]{20})\.(json|txt)$/.exec(path))) {
        const filing = view.filings.find((f) => f.receipt.receipt.receiptId === m[1]);
        if (!filing) return json(404, { error: "not_found" });
        return m[2] === "json"
          ? { status: 200, contentType: "application/json; charset=utf-8", rawBody: JSON.stringify(filing.receipt, null, 2), headers: { "content-disposition": `attachment; filename="${m[1]}.json"` } }
          : { status: 200, contentType: "text/plain; charset=utf-8", rawBody: receiptText(filing.receipt), headers: { "content-disposition": `inline; filename="${m[1]}.txt"` } };
      }
      if ((m = new RegExp(`^/track/corrections/(${UUID})\\.json$`).exec(path))) {
        const c = (await platform.listCorrections(session.rootId)).find((x) => x.id === m[1] && x.correction_document);
        return c ? { status: 200, contentType: "application/json; charset=utf-8", rawBody: JSON.stringify(c.correction_document, null, 2) } : json(404, { error: "not_found" });
      }
      if (path === "/track/case") return render(200);
      const isAmend = path === "/track/amend";
      let fields;
      try {
        if (isAmend) {
          await limit(req, "amend", 10, 600);
          const parsed = await readMultipart(req);
          fields = parsed.fields;
          if (!auth.csrfValid(session, fields.csrf)) return json(403, { error: "csrf_rejected" });
          if (session.scope === "view") throw new IntakeError("forbidden", 403);
          if (!attested(fields)) throw new IntakeError("attestations_required");
          const staged = await platform.uploads?.resolve(fields.uploadTokens) ?? [];
          const result = await backend.fileSubmission(filingInput(fields, [...parsed.files, ...staged]), { parentRootId: session.rootId });
          await platform.uploads?.consume(staged.map((d) => d.uploadId));
          logger("filing.amendment", { receiptId: result.receipt.receipt.receiptId });
          return redirect("/track/case");
        }
        fields = await readForm(req);
        if (!auth.csrfValid(session, fields.csrf)) return json(403, { error: "csrf_rejected" });
        if (path === "/track/corrections") {
          await platform.fileCorrection(session, fields.kind, fields.statement);
          return redirect("/track/case");
        }
        if (path === "/track/delegations") {
          const delegateCode = await platform.createDelegation(session, fields.label, fields.scope);
          return html(201, delegationCreatedPage(delegateCode, view.filings[0].trackingNumber));
        }
        if ((m = new RegExp(`^/track/delegations/(${UUID})/revoke$`).exec(path))) {
          await platform.revokeDelegation(session, m[1]);
          return redirect("/track/case");
        }
        if (ctx.participantPost) { const r = await ctx.participantPost(session, fields); if (r) return r; }
        return json(404, { error: "not_found" });
      } catch (error) {
        if (!(error instanceof IntakeError)) throw error;
        if (error.code === "classified_marking") return html(422, classifiedRefusedPage());
        return render(error.status ?? 400, { error: error.code, values: isAmend ? fields : undefined });
      }
    }

    // ---------------------------------------------------------------- public verifier
    if (path === "/verify") {
      if (isGet) return html(200, verifyPage());
      await limit(req, "verify", 60, 60);
      const form = await readForm(req);
      const input = String(form.receipt ?? "").slice(0, 20_000);
      let doc;
      try { doc = JSON.parse(input); } catch { return html(400, verifyPage({ result: { valid: false, reason: "malformed_document" }, input })); }
      return html(200, verifyPage({ result: await backend.verifyReceipt(doc), input }));
    }

    // ---------------------------------------------------------------- staff console
    if (path.startsWith("/staff")) return staffRoutes(ctx);
    return json(404, { error: "not_found" });
  }

  async function staffRoutes(ctx) {
    const { req, path, isGet, cookies } = ctx;
    const configured = (await platform.staffCount()) > 0;
    if (path === "/staff/login") {
      if (isGet) return (await staffSession(cookies)) ? redirect("/staff") : html(200, staffLoginPage2({ configured }));
      try { await limit(req, "staff-login", 30, 900); } catch { return html(429, staffLoginPage2({ configured, error: "rate_limited" })); }
      const form = await readForm(req);
      const out = await platform.login(form.username, form.password, form.totp);
      if (out.error) { logger("staff.login_failed", { reason: out.error }); return html(401, staffLoginPage2({ configured, error: out.error })); }
      logger("staff.login", { user: out.user.id });
      return redirect("/staff", { "set-cookie": auth.issueStaff(out.user.id).header });
    }
    const session = await staffSession(cookies);
    if (!session) return isGet && path === "/staff" ? html(200, staffLoginPage2({ configured })) : redirect("/staff/login");
    const { user, csrf } = session;
    let form = {};
    if (!isGet) {
      form = await readForm(req);
      if (!auth.csrfValid(session, form.csrf)) return json(403, { error: "csrf_rejected" });
    }
    const denied = () => html(403, staffQueuePage2({ rows: [], csrf, user }).replace("<h1>Filing queue</h1>", `<h1>Not permitted</h1><p>${msg("forbidden")}</p>`));
    try {
      if (ctx.staffExtension) { const r = await ctx.staffExtension({ ...ctx, user, csrf, form, denied }); if (r) return r; }
      if (path === "/staff/logout") return redirect("/staff/login", { "set-cookie": auth.clear(STAFF_COOKIE) });
      if (path === "/staff") {
        const scopes = hasRole(user, "intake", "privacy_officer", "oversight", "records_officer") ? null : agencyScopes(user);
        return html(200, staffQueuePage2({ rows: scopes && !scopes.length ? [] : await backend.listSubmissions({ agencyIds: scopes }), csrf, user }));
      }
      if (path === "/staff/ledger") {
        if (!hasRole(user, "oversight")) return denied();
        return html(200, staffLedgerPage({ result: await verifyLedger(backend.pool) }));
      }
      if (path === "/staff/notifications") {
        const audiences = ["role:intake", ...user.roles.map((r) => r.startsWith("agency:") ? r : `role:${r}`)];
        return html(200, staffNotificationsPage({ user, list: await platform.notificationsFor(user.roles.includes("admin") ? [...audiences, ...(await backend.listAgencies()).map((a) => `agency:${a.id}`)] : audiences) }));
      }
      if (path === "/staff/mfa") {
        const u = await platform.getStaff(user.id);
        return html(200, staffMfaPage({ user, csrf, enabled: u.mfa_enabled, secret: u.mfa_enabled ? null : u.totp_secret, uri: u.totp_secret ? otpauthUri(u.totp_secret, user.username) : "" }));
      }
      if (path === "/staff/mfa/begin") { await platform.beginMfa(user); return redirect("/staff/mfa"); }
      if (path === "/staff/mfa/confirm") { await platform.confirmMfa(user, form.code); return redirect("/staff/mfa"); }
      if (path === "/staff/reveals") {
        if (!hasRole(user, "intake", "privacy_officer")) return denied();
        const pending = await platform.pendingReveals();
        const mine = (await backend.pool.query(`SELECT r.id, s.tracking_number FROM reveal_requests r JOIN submissions s ON s.id = r.submission_id
          WHERE r.requested_by = $1 AND r.approved_at IS NOT NULL AND r.consumed_at IS NULL AND r.expires_at > clock_timestamp()`, [user.id])).rows;
        return html(200, staffRevealsPage({ user, csrf, pending, mine }));
      }
      let m;
      if ((m = new RegExp(`^/staff/reveals/(${UUID})/(approve|view)$`).exec(path))) {
        if (m[2] === "approve") { await platform.approveReveal(user, m[1]); return redirect("/staff/reveals"); }
        return html(200, revealResultPage({ user, identity: await platform.consumeReveal(user, m[1]) }));
      }
      if (path === "/staff/admin/users") {
        if (!hasRole(user, "admin")) return denied();
        if (!isGet) await platform.createStaff(user, { username: form.username, password: form.password, roles: String(form.roles ?? "").split(",").map((x) => x.trim()) });
        return isGet ? html(200, staffUsersPage({ user, csrf, users: await platform.listStaff() })) : redirect("/staff/admin/users");
      }
      if ((m = new RegExp(`^/staff/admin/users/(${UUID})/(disable|enable)$`).exec(path))) {
        await platform.setStaffDisabled(user, m[1], m[2] === "disable");
        return redirect("/staff/admin/users");
      }
      if (path === "/staff/records" || path === "/staff/records/dispose") {
        if (!hasRole(user, "records_officer")) return denied();
        const result = path.endsWith("/dispose") ? await platform.disposeEligible({ actor: user.id }) : undefined;
        return html(200, staffRecordsPage({ user, csrf, result, schedule: platform.retention }));
      }
      if ((m = new RegExp(`^/staff/corrections/(${UUID})$`).exec(path))) {
        const sid = (await backend.pool.query("SELECT submission_id FROM corrections WHERE id = $1", [m[1]])).rows[0]?.submission_id;
        if (!sid || !(await platform.canSeeSubmission(user, sid))) return denied();
        await platform.decideCorrection(user, m[1], form.decision, form.note);
        return redirect(`/staff/submissions/${sid}`);
      }
      if ((m = new RegExp(`^/staff/documents/(${UUID})$`).exec(path))) {
        const sid = (await backend.pool.query("SELECT submission_id FROM documents WHERE id = $1", [m[1]])).rows[0]?.submission_id;
        if (!sid || !(await platform.canSeeSubmission(user, sid))) return denied();
        const doc = await backend.document(m[1]);
        if (!doc) return json(404, { error: "not_found" });
        if (doc.quarantined) return json(423, { error: "quarantined", verdict: doc.verdict });
        if (doc.disposed) return json(410, { error: "disposed" });
        logger("staff.document_viewed", { actor: user.id });
        return { status: 200, contentType: doc.media_type, rawBody: doc.content, headers: {
          "content-disposition": `attachment; filename="${doc.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"` } };
      }
      if ((m = new RegExp(`^/staff/submissions/(${UUID})(?:/(status|reveal|hold|hold/release))?$`).exec(path))) {
        if (!(await platform.canSeeSubmission(user, m[1]))) return denied();
        if (m[2] === "status") { await backend.recordStatus(m[1], form.status, form.note, `staff:${user.username}`); return redirect(`/staff/submissions/${m[1]}`); }
        if (m[2] === "reveal") { await platform.requestReveal(user, m[1], form.reason); return redirect("/staff/reveals"); }
        if (m[2] === "hold") { await platform.placeHold(user, m[1], form.reason); return redirect(`/staff/submissions/${m[1]}`); }
        if (m[2] === "hold/release") { await platform.releaseHold(user, m[1]); return redirect(`/staff/submissions/${m[1]}`); }
        const s = await backend.staffSubmission(m[1]);
        if (!s) return json(404, { error: "not_found" });
        return html(200, staffSubmissionPage2({ s, csrf, user, statuses: ctx.staffStatuses?.(s) ?? STAFF_STATUSES,
          corrections: await platform.listCorrections(m[1]), records: await platform.recordsStatus(m[1]),
          canReveal: hasRole(user, "intake", "privacy_officer"), canDecide: hasRole(user, "intake"), canHold: hasRole(user, "records_officer"),
          extraHtml: ctx.staffSubmissionExtra ? await ctx.staffSubmissionExtra({ s, user, csrf }) : "" }));
      }
      return json(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof IntakeError) {
        if (error.status === 403) return denied();
        return json(error.status ?? 400, { error: error.code, message: msg(error.code) });
      }
      throw error;
    }
  }

  const storageDown = (e) => ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "57P01", "57P03", "53300"].includes(e?.code) ||
    /timeout exceeded when trying to connect|Connection terminated/i.test(String(e?.message ?? ""));
  return async function demoHandler(req, path, method) {
    try { return await handle(req, path, method); }
    catch (error) {
      if (error instanceof HttpError || error instanceof IntakeError) return { status: error.status ?? 400, body: { error: error.code } };
      if (storageDown(error)) {
        // UFR-057 degraded mode: fail closed and say so plainly. Nothing was saved and no filing date is preserved.
        logger("demo.storage_unavailable", { code: error?.code });
        return path.startsWith("/api/") ? { status: 503, body: { error: "storage_unavailable", filingsAccepted: false }, headers: { "retry-after": "60" } }
          : { status: 503, contentType: "text/html; charset=utf-8", headers: { "retry-after": "60" }, rawBody: unavailablePage(path)
            .replace("Demo filing is not configured", "Temporarily unavailable")
            .replace(/<section class="empty-state" role="status">[\s\S]*?<\/section>/, '<section class="error-summary" role="alert"><p>The demonstration storage service is unreachable. Nothing you submitted was saved and no filing date was preserved. Try again in a few minutes.</p></section>') };
      }
      logger("demo.error", { name: error?.name, code: error?.code, message: String(error?.message ?? "").slice(0, 200) });
      return { status: 500, body: { error: "internal_error" } };
    }
  };
}

export { sha256Hex };
