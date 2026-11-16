import Busboy from "busboy";
import { randomBytes } from "node:crypto";
import { clientAddress, PARTICIPANT_COOKIE, sameOrigin, STAFF_COOKIE } from "./auth.mjs";
import { IntakeError, LIMITS, STAFF_STATUSES } from "./backend.mjs";
import { verifyLedger } from "./ledger.mjs";
import {
  caseView, demoStylesheet, filedPage, filePage, staffLedgerPage, staffLoginPage, staffQueuePage,
  staffSubmissionPage, trackLoginPage, unavailablePage, verifyPage,
} from "./views.mjs";

export const DEMO_CSP = "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const MAX_FORM_BYTES = 64 * 1024;
const MAX_MULTIPART_BYTES = LIMITS.totalBytes + 512 * 1024;
const newKey = () => randomBytes(18).toString("base64url");

export const DEMO_GET_PATHS = new Set(["/file", "/track", "/track/case", "/verify", "/staff", "/staff/login", "/staff/ledger",
  "/api/receipts/keys", "/api/demo/agencies", "/assets/demo.v1.css"]);
const DEMO_POST_PATHS = new Set(["/file", "/track", "/track/amend", "/track/logout", "/verify", "/api/verify",
  "/staff/login", "/staff/logout"]);

export function isDemoPath(path) {
  return DEMO_GET_PATHS.has(path) || DEMO_POST_PATHS.has(path) || /^\/track\/receipts\/RCPT-DEMO-[0-9A-Z]{20}\.json$/.test(path) ||
    /^\/staff\/(?:submissions\/[0-9a-f-]{36}(?:\/status)?|documents\/[0-9a-f-]{36})$/.test(path);
}

class HttpError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) { req.resume(); return reject(new HttpError(413, "payload_too_large")); }
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > max) { req.destroy(); reject(new HttpError(413, "payload_too_large")); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "unsupported_media_type");
  const params = new URLSearchParams((await readBody(req, MAX_FORM_BYTES)).toString("utf8"));
  const out = {};
  for (const [k, v] of params) if (!(k in out)) out[k] = v;
  return out;
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    if (!/^multipart\/form-data\b/i.test(req.headers["content-type"] ?? "")) return reject(new HttpError(415, "unsupported_media_type"));
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_MULTIPART_BYTES) { req.resume(); return reject(new IntakeError("file_too_large", 413)); }
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fields: 20, fieldSize: 25_000, files: LIMITS.files + 1,
        fileSize: LIMITS.fileBytes + 1, parts: 30, headerPairs: 50 } });
    } catch { return reject(new HttpError(400, "invalid_request")); }
    const fields = {}; const files = []; let failure = null; let total = 0;
    bb.on("field", (name, value, info) => { if (info.valueTruncated) failure ??= new IntakeError("invalid_body"); if (!(name in fields)) fields[name] = value; });
    bb.on("file", (name, stream, info) => {
      const chunks = []; let size = 0;
      stream.on("data", (c) => { size += c.length; total += c.length; if (total > MAX_MULTIPART_BYTES) failure ??= new IntakeError("file_too_large", 413); else chunks.push(c); });
      stream.on("limit", () => { failure ??= new IntakeError("file_too_large", 413); });
      stream.on("close", () => {
        if (name !== "files" || (size === 0 && !info.filename)) return; // empty file input
        files.push({ filename: info.filename || "attachment", mediaType: String(info.mimeType).toLowerCase(), content: Buffer.concat(chunks) });
      });
    });
    bb.on("filesLimit", () => { failure ??= new IntakeError("too_many_files"); });
    bb.on("partsLimit", () => { failure ??= new HttpError(400, "invalid_request"); });
    bb.on("error", () => reject(new HttpError(400, "invalid_request")));
    bb.on("close", () => failure ? reject(failure) : resolve({ fields, files }));
    req.on("data", () => { if (total > MAX_MULTIPART_BYTES * 2) req.destroy(); });
    req.pipe(bb);
  });
}

const attested = (f) => f.attest_demo === "yes" && f.attest_synthetic === "yes" && f.attest_unclassified === "yes";
const filingInput = (f, files) => ({ agencyId: f.agencyId, filingType: f.filingType, title: f.title ?? "", body: f.body ?? "",
  claimantName: f.claimantName ?? "", claimantContact: f.claimantContact ?? "", idempotencyKey: f.idempotencyKey, documents: files });

/**
 * Builds the demo request handler. Returns null for paths it does not own.
 * Response objects follow the portal server contract
 * ({status, contentType, rawBody|body, headers}).
 */
export function createDemoHandler({ backend, auth, publicOrigin = null, trustProxy = false, logger = () => {} }) {
  const html = (status, rawBody, headers = {}) => ({ status, contentType: "text/html; charset=utf-8", rawBody, headers });
  const redirect = (location, headers = {}) => ({ status: 303, rawBody: "", contentType: "text/plain; charset=utf-8", headers: { location, ...headers } });
  const json = (status, body) => ({ status, body });

  async function limit(req, scope, max, windowSeconds) {
    const ok = await backend.allow(`${scope}:${clientAddress(req, trustProxy)}`, max, windowSeconds) &&
      await backend.allow(`${scope}:global`, max * 20, windowSeconds);
    if (!ok) throw new IntakeError("rate_limited", 429);
  }

  async function handle(req, path, method) {
    if (path === "/assets/demo.v1.css" && (method === "GET" || method === "HEAD"))
      return { status: 200, contentType: "text/css; charset=utf-8", rawBody: demoStylesheet, headOnly: method === "HEAD" };
    if (!backend) {
      if (path.startsWith("/api/")) return json(503, { schemaVersion: 1, status: "demo_unconfigured", filingsAccepted: false });
      return method === "GET" || method === "HEAD" ? html(503, unavailablePage(path)) : html(503, unavailablePage(path));
    }
    const isGet = method === "GET" || method === "HEAD";
    const isPost = method === "POST";
    const allowedGet = DEMO_GET_PATHS.has(path) || path.startsWith("/track/receipts/") || /^\/staff\/(submissions|documents)\/[0-9a-f-]{36}$/.test(path);
    const allowedPost = DEMO_POST_PATHS.has(path) || /^\/staff\/submissions\/[0-9a-f-]{36}\/status$/.test(path);
    if (!(isGet && allowedGet) && !(isPost && allowedPost))
      return { status: 405, body: { error: "method_not_allowed" }, allow: allowedPost ? "POST" : "GET, HEAD" };
    if (isPost && !sameOrigin(req, publicOrigin)) return json(403, { error: "cross_origin_request_rejected" });
    const cookies = auth.parseCookies(req.headers.cookie);

    // Public JSON APIs
    if (path === "/api/receipts/keys") return json(200, { schema: "ufr-demo-receipt-keys-v1", demo: true,
      notice: "Keys of a development prototype. Not a government key.", keys: backend.publicKeys() });
    if (path === "/api/demo/agencies") return json(200, { schema: "ufr-demo-agencies-v1", fictional: true, agencies: await backend.listAgencies() });
    if (path === "/api/verify") {
      await limit(req, "verify", 60, 60);
      let doc;
      try { doc = JSON.parse((await readBody(req, 32 * 1024)).toString("utf8")); } catch (e) { if (e instanceof HttpError) throw e; return json(400, { valid: false, reason: "malformed_document" }); }
      return json(200, await backend.verifyReceipt(doc));
    }

    // Filing
    if (path === "/file") {
      const agencies = await backend.listAgencies();
      if (isGet) return html(200, filePage({ agencies, idempotencyKey: newKey() }));
      let parsed;
      try {
        await limit(req, "file", 10, 600);
        parsed = await readMultipart(req);
        if (!attested(parsed.fields)) throw new IntakeError("attestations_required");
        const result = await backend.fileSubmission(filingInput(parsed.fields, parsed.files));
        logger("filing.received", { receiptId: result.receipt.receipt.receiptId, replayed: result.replayed });
        return html(result.replayed ? 200 : 201, filedPage({ result }));
      } catch (error) {
        if (!(error instanceof IntakeError)) throw error;
        return html(error.status ?? 400, filePage({ agencies, idempotencyKey: error.code === "idempotency_conflict" ? newKey() : (parsed?.fields.idempotencyKey ?? newKey()),
          error: error.code, values: parsed?.fields }));
      }
    }

    // Participant tracking
    if (path === "/track") {
      if (isGet) return auth.participant(cookies) ? redirect("/track/case") : html(200, trackLoginPage());
      try { await limit(req, "track", 20, 600); } catch { return html(429, trackLoginPage({ error: "rate_limited" })); }
      const form = await readForm(req);
      const rootId = await backend.openParticipant(form.trackingNumber, form.accessCode);
      if (!rootId) return html(401, trackLoginPage({ error: "no_match" }));
      return redirect("/track/case", { "set-cookie": auth.issueParticipant(rootId).header });
    }
    const participant = auth.participant(cookies);
    if (path === "/track/logout") {
      const form = await readForm(req);
      if (!auth.csrfValid(participant, form.csrf)) return json(403, { error: "csrf_rejected" });
      return redirect("/track", { "set-cookie": auth.clear(PARTICIPANT_COOKIE) });
    }
    if (path === "/track/case" || path === "/track/amend" || path.startsWith("/track/receipts/")) {
      if (!participant) return redirect("/track");
      const view = await backend.participantView(participant.subject);
      if (!view) return redirect("/track", { "set-cookie": auth.clear(PARTICIPANT_COOKIE) });
      const agencies = await backend.listAgencies();
      if (path.startsWith("/track/receipts/")) {
        const id = path.slice("/track/receipts/".length, -".json".length);
        const filing = view.filings.find((f) => f.receipt.receipt.receiptId === id);
        if (!filing) return json(404, { error: "not_found" });
        return { status: 200, contentType: "application/json; charset=utf-8", rawBody: JSON.stringify(filing.receipt, null, 2),
          headers: { "content-disposition": `attachment; filename="${id}.json"` } };
      }
      if (path === "/track/case") return html(200, caseView({ view, agencies, csrf: participant.csrf, idempotencyKey: newKey() }));
      let parsed;
      try {
        await limit(req, "amend", 10, 600);
        parsed = await readMultipart(req);
        if (!auth.csrfValid(participant, parsed.fields.csrf)) return json(403, { error: "csrf_rejected" });
        if (!attested(parsed.fields)) throw new IntakeError("attestations_required");
        const result = await backend.fileSubmission(filingInput(parsed.fields, parsed.files), { parentRootId: participant.subject });
        logger("filing.amendment", { receiptId: result.receipt.receipt.receiptId });
        return redirect("/track/case");
      } catch (error) {
        if (!(error instanceof IntakeError)) throw error;
        return html(error.status ?? 400, caseView({ view, agencies, csrf: participant.csrf, idempotencyKey: newKey(), error: error.code, values: parsed?.fields }));
      }
    }

    // Public verifier
    if (path === "/verify") {
      if (isGet) return html(200, verifyPage());
      await limit(req, "verify", 60, 60);
      const form = await readForm(req);
      const input = String(form.receipt ?? "").slice(0, 20_000);
      let doc;
      try { doc = JSON.parse(input); } catch { return html(400, verifyPage({ result: { valid: false, reason: "malformed_document" }, input })); }
      return html(200, verifyPage({ result: await backend.verifyReceipt(doc), input }));
    }

    // Staff console
    const staff = auth.staff(cookies);
    if (path === "/staff/login") {
      if (isGet) return staff ? redirect("/staff") : html(200, staffLoginPage({ configured: auth.staffConfigured }));
      try { await limit(req, "staff-login", 10, 900); } catch { return html(429, staffLoginPage({ configured: auth.staffConfigured, error: "rate_limited" })); }
      const form = await readForm(req);
      if (!auth.checkStaffPassword(form.username, form.password)) {
        logger("staff.login_failed", {});
        return html(401, staffLoginPage({ configured: auth.staffConfigured, error: "failed" }));
      }
      logger("staff.login", {});
      return redirect("/staff", { "set-cookie": auth.issueStaff(form.username.trim()).header });
    }
    if (!staff) return isGet && path === "/staff" ? html(200, staffLoginPage({ configured: auth.staffConfigured })) : redirect("/staff/login");
    if (path === "/staff/logout") {
      const form = await readForm(req);
      if (!auth.csrfValid(staff, form.csrf)) return json(403, { error: "csrf_rejected" });
      return redirect("/staff/login", { "set-cookie": auth.clear(STAFF_COOKIE) });
    }
    if (path === "/staff") return html(200, staffQueuePage({ rows: await backend.listSubmissions(), csrf: staff.csrf }));
    if (path === "/staff/ledger") return html(200, staffLedgerPage({ result: await verifyLedger(backend.pool) }));
    let m;
    if ((m = /^\/staff\/documents\/([0-9a-f-]{36})$/.exec(path))) {
      const doc = await backend.document(m[1]);
      if (!doc) return json(404, { error: "not_found" });
      logger("staff.document_viewed", { actor: staff.subject });
      return { status: 200, contentType: doc.media_type, rawBody: doc.content, headers: {
        "content-disposition": `attachment; filename="${doc.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"` } };
    }
    if ((m = /^\/staff\/submissions\/([0-9a-f-]{36})(\/status)?$/.exec(path))) {
      if (m[2]) {
        const form = await readForm(req);
        if (!auth.csrfValid(staff, form.csrf)) return json(403, { error: "csrf_rejected" });
        try { await backend.recordStatus(m[1], form.status, form.note, `staff:${staff.subject}`); }
        catch (error) { if (error instanceof IntakeError) return json(error.status ?? 400, { error: error.code }); throw error; }
        return redirect(`/staff/submissions/${m[1]}`);
      }
      const s = await backend.staffSubmission(m[1]);
      if (!s) return json(404, { error: "not_found" });
      return html(200, staffSubmissionPage({ s, csrf: staff.csrf, statuses: STAFF_STATUSES }));
    }
    return json(404, { error: "not_found" });
  }

  return async function demoHandler(req, path, method) {
    try { return await handle(req, path, method); }
    catch (error) {
      if (error instanceof HttpError || error instanceof IntakeError) return { status: error.status ?? 400, body: { error: error.code } };
      logger("demo.error", { name: error?.name, code: error?.code });
      return { status: 500, body: { error: "internal_error" } };
    }
  };
}
