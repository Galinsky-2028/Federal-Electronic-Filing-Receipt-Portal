import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalDigest, sha256Hex } from "./canonical.mjs";
import { withTransaction } from "./db.mjs";
import { appendLedger } from "./ledger.mjs";
import { buildReceipt, signReceipt, verifyReceiptDocument } from "./receipt.mjs";
import { open as openSealed, seal } from "../platform/crypto.mjs";
import { detectClassifiedMarking, scanDocument } from "../platform/safety.mjs";

/**
 * IntakeBackend seam. The portal's routes call only these methods, so a
 * Secure Intake adapter (src/engine/) can replace this portal-local demo
 * implementation without changing presentation code:
 *   listAgencies(), fileSubmission(input), openParticipant(tracking, code),
 *   participantView(rootId), listSubmissions(), staffSubmission(id),
 *   document(id), recordStatus(id, status, note, actor), lookupReceiptFacts(doc),
 *   deliverDueRoutings(), verifyLedger()
 * Everything here is synthetic demonstration behavior. Nothing is filed with
 * or delivered to any real government institution.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function code(length) {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
}
export const newTrackingNumber = () => { const c = code(12); return `DEMO-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`; };
const newReceiptId = () => "RCPT-DEMO-" + code(20);
const newAccessCode = () => code(24);
export const accessHash = (salt, accessCode) => sha256Hex(`${salt}:${accessCode}`);

export const STAFF_STATUSES = Object.freeze(["under_review", "information_requested", "referred", "closed"]);
export const LIMITS = Object.freeze({ title: 200, body: 20_000, name: 120, contact: 200, files: 3,
  fileBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, filename: 120, note: 1000 });
export const ALLOWED_MEDIA_TYPES = Object.freeze(["application/pdf", "text/plain", "image/png", "image/jpeg"]);

export class IntakeError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function str(value, max, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw new IntakeError(`invalid_${field}`);
  const v = value.normalize("NFC").replace(/\r\n/g, "\n").trim();
  if ((!allowEmpty && v.length === 0) || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))
    throw new IntakeError(`invalid_${field}`);
  return v;
}

/** Magic-number check so the declared media type cannot disguise content. */
export function sniffMatches(mediaType, content) {
  const head = content.subarray(0, 8);
  if (mediaType === "application/pdf") return head.subarray(0, 5).toString("latin1") === "%PDF-";
  if (mediaType === "image/png") return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === "image/jpeg") return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (mediaType === "text/plain") {
    try { new TextDecoder("utf-8", { fatal: true }).decode(content); return !content.includes(0); } catch { return false; }
  }
  return false;
}

export function validateFiling(input, agencies) {
  const agency = agencies.find((a) => a.id === input.agencyId);
  if (!agency) throw new IntakeError("invalid_agency");
  if (!agency.filingTypes.includes(input.filingType)) throw new IntakeError("invalid_filing_type");
  const documents = input.documents ?? [];
  if (!Array.isArray(documents) || documents.length > LIMITS.files) throw new IntakeError("too_many_files");
  let total = 0;
  const docs = documents.map((d, i) => {
    const filename = str(d.filename, LIMITS.filename, "filename").replace(/[\\/]/g, "_");
    if (!ALLOWED_MEDIA_TYPES.includes(d.mediaType)) throw new IntakeError("unsupported_file_type");
    if (!Buffer.isBuffer(d.content) || d.content.length === 0 || d.content.length > LIMITS.fileBytes)
      throw new IntakeError("file_too_large");
    if (!sniffMatches(d.mediaType, d.content)) throw new IntakeError("file_content_mismatch");
    total += d.content.length;
    return { ordinal: i + 1, filename, mediaType: d.mediaType, content: d.content,
      sizeBytes: d.content.length, sha256: sha256Hex(d.content) };
  });
  if (total > LIMITS.totalBytes) throw new IntakeError("file_too_large");
  if (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.idempotencyKey))
    throw new IntakeError("invalid_idempotency_key");
  return {
    agency, filingType: input.filingType, docs, idempotencyKey: input.idempotencyKey,
    title: str(input.title, LIMITS.title, "title"),
    body: str(input.body, LIMITS.body, "body"),
    claimantName: str(input.claimantName, LIMITS.name, "name"),
    claimantContact: str(input.claimantContact ?? "", LIMITS.contact, "contact", { allowEmpty: true }),
  };
}

/** UFR-008 immutable original-submission manifest (content commitments, no time). */
export function buildManifest({ submissionId, kind, parentReceiptId, agencyId, filingType, text, docs }) {
  const textBytes = Buffer.from(JSON.stringify(text), "utf8");
  const parts = [{ ordinal: 0, role: "filing-text", mediaType: "application/json", sizeBytes: textBytes.length,
    sha256: canonicalDigest(text) }, ...docs.map((d) => ({ ordinal: d.ordinal, role: "attachment",
    filename: d.filename, mediaType: d.mediaType, sizeBytes: d.sizeBytes, sha256: d.sha256 }))];
  const manifest = { schema: "ufr-demo-manifest-v1", submissionId, kind, parentReceiptId: parentReceiptId ?? null,
    agencyId, filingType, parts };
  return { manifest, sha256: canonicalDigest(manifest), partCount: parts.length,
    totalBytes: parts.reduce((n, p) => n + p.sizeBytes, 0) };
}

export class LocalIntakeBackend {
  constructor({ pool, signer, keys = null, appNow = () => Date.now(), maxRoutingAttempts = 8 }) {
    this.pool = pool; this.signer = signer; this.keys = keys; this.appNow = appNow; this.maxRoutingAttempts = maxRoutingAttempts;
    this.onFiled = []; // post-commit hooks for new (non-replayed) filings
  }

  publicKeys() { return [this.signer.publicJwk]; }

  async listAgencies() {
    const { rows } = await this.pool.query(
      "SELECT id, name, description, filing_types, routing_sla_hours FROM agencies ORDER BY name");
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, filingTypes: r.filing_types,
      routingSlaHours: r.routing_sla_hours, fictional: true }));
  }

  /**
   * UFR-009/012: one atomic transaction creates the ledger entry, original
   * record, file bytes, manifest, signed receipt, routing outbox entry and
   * initial status. A repeated idempotency key with the same request returns
   * the original receipt; with a different request it is rejected.
   */
  async fileSubmission(input, { parentRootId = null } = {}) {
    const agencies = await this.listAgencies();
    const v = validateFiling(input, agencies);
    const marking = detectClassifiedMarking(v.title, v.body, ...v.docs.map((d) => d.content));
    if (marking) {
      // UFR-047: stop collection. Record only a content-free event naming the rule.
      await withTransaction(this.pool, (client) => appendLedger(client, { eventType: "intake.classified_marking_refused",
        subject: "intake", appNow: this.appNow(), payload: { rule: marking } }));
      throw new IntakeError("classified_marking", 422);
    }
    const emergency = input.emergency === true;
    const structured = input.structured && typeof input.structured === "object" ? input.structured : {};
    const requestSha256 = canonicalDigest({ agencyId: v.agency.id, filingType: v.filingType, title: v.title, body: v.body,
      claimantName: v.claimantName, claimantContact: v.claimantContact, parentRootId,
      docs: v.docs.map((d) => [d.filename, d.mediaType, d.sha256]), emergency, structured });
    const existing = await this.#replay(v.idempotencyKey, requestSha256);
    if (existing) return existing;
    let created;
    try {
      created = await withTransaction(this.pool, async (client) => {
        let parent = null;
        if (parentRootId) {
          parent = (await client.query(`SELECT s.id, s.access_salt, s.access_hash, s.agency_id, r.receipt_id
            FROM submissions s JOIN receipts r ON r.submission_id = s.id WHERE s.id = $1 AND s.kind = 'original'`,
          [parentRootId])).rows[0];
          if (!parent) throw new IntakeError("not_found", 404);
          if (parent.agency_id !== v.agency.id) throw new IntakeError("amendment_agency_mismatch");
        }
        const submissionId = randomUUID();
        const receiptId = newReceiptId();
        const trackingNumber = newTrackingNumber();
        const kind = parent ? "amendment" : "original";
        const accessCode = parent ? null : newAccessCode();
        const salt = parent ? parent.access_salt : randomBytes(16).toString("hex");
        const hash = parent ? parent.access_hash : accessHash(salt, accessCode);
        const m = buildManifest({ submissionId, kind, parentReceiptId: parent?.receipt_id, agencyId: v.agency.id,
          filingType: v.filingType, docs: v.docs,
          text: { title: v.title, body: v.body, claimantName: v.claimantName, claimantContact: v.claimantContact, structured } });
        const scans = v.docs.map((d) => ({ ordinal: d.ordinal, ...scanDocument(d.mediaType, d.content) }));
        const entry = await appendLedger(client, { eventType: "filing.received", subject: receiptId, appNow: this.appNow(),
          payload: { receiptId, submissionId, trackingNumber, kind, amends: parent?.receipt_id ?? null,
            agencyId: v.agency.id, manifestSha256: m.sha256, emergency, scans: scans.map((x) => x.verdict),
            identityProtected: Boolean(this.keys) } });
        const protect = Boolean(this.keys);
        await client.query(`INSERT INTO submissions (id, tracking_number, access_salt, access_hash, kind, parent_id,
          agency_id, filing_type, title, body, claimant_name, claimant_contact, idempotency_key, request_sha256, received_at,
          structured, emergency, identity_protected)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [submissionId, trackingNumber, salt, hash, kind, parent?.id ?? null, v.agency.id, v.filingType, v.title, protect ? "[encrypted]" : v.body,
          protect ? "[protected]" : v.claimantName, protect ? "" : v.claimantContact, v.idempotencyKey, requestSha256,
          entry.recordedAt, structured, emergency, protect]);
        if (protect) {
          const key = await this.keys.create(client, "identity", submissionId);
          await client.query("INSERT INTO identity_vault (submission_id, key_id, sealed) VALUES ($1,$2,$3)", [submissionId, key.id,
            seal(key.dek, Buffer.from(JSON.stringify({ claimantName: v.claimantName, claimantContact: v.claimantContact })), `identity:${submissionId}`)]);
          const ck = await this.keys.create(client, "content", submissionId);
          await client.query("INSERT INTO content_vault (submission_id, key_id, sealed) VALUES ($1,$2,$3)", [submissionId, ck.id,
            seal(ck.dek, Buffer.from(JSON.stringify({ body: v.body, structured })), `content:${submissionId}`)]);
        }
        for (const d of v.docs) {
          const docId = randomUUID();
          let content = d.content; let keyId = null;
          if (protect) {
            const key = await this.keys.create(client, "document", submissionId);
            content = seal(key.dek, d.content, `doc:${docId}`); keyId = key.id;
          }
          await client.query(`INSERT INTO documents (id, submission_id, ordinal, filename, media_type, size_bytes, sha256, content, encryption, key_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [docId, submissionId, d.ordinal, d.filename, d.mediaType,
            d.sizeBytes, d.sha256, content, protect ? "aes-256-gcm-envelope" : "none", keyId]);
          const scan = scans.find((x) => x.ordinal === d.ordinal);
          await client.query("INSERT INTO scan_results (document_id, verdict, engine, detail, ledger_seq) VALUES ($1,$2,'portal-heuristic-v1',$3,$4)",
            [docId, scan.verdict, scan.detail, entry.seq]);
        }
        await client.query("INSERT INTO manifests (submission_id, manifest, sha256) VALUES ($1,$2,$3)",
          [submissionId, m.manifest, m.sha256]);
        const receipt = buildReceipt({ receiptId, trackingNumber, kind, amends: parent?.receipt_id,
          receivedAt: entry.recordedAt, agency: v.agency, filingType: v.filingType, manifest: m,
          ledger: { seq: entry.seq, entryHash: entry.entryHash }, keyId: this.signer.keyId });
        const document = signReceipt(receipt, this.signer);
        await client.query("INSERT INTO receipts (receipt_id, submission_id, document, ledger_seq) VALUES ($1,$2,$3,$4)",
          [receiptId, submissionId, document, entry.seq]);
        await client.query(`INSERT INTO routing_outbox (submission_id, agency_id, due_by)
          VALUES ($1, $2, $3::timestamptz + make_interval(hours => $4))`,
        [submissionId, v.agency.id, entry.recordedAt, emergency ? 4 : v.agency.routingSlaHours]);
        await client.query(`INSERT INTO notification_outbox (channel, audience, template, payload) VALUES
          ('staff-queue', $1, $2, $3), ('claimant-portal', $4, 'receipt.issued', $5)`,
        [emergency ? "role:intake" : `agency:${v.agency.id}`, emergency ? "filing.emergency" : "filing.received",
          { submissionId, receiptId, emergency }, `root:${parent?.id ?? submissionId}`, { receiptId, trackingNumber }]);
        if (input.draftCodeHash) await client.query("DELETE FROM drafts WHERE code_hash = $1", [input.draftCodeHash]);
        await client.query(`INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq)
          VALUES ($1, 'received', 'Demonstration receipt issued.', 'system', $2, $3)`,
        [submissionId, entry.recordedAt, entry.seq]);
        return { receipt: document, trackingNumber, accessCode, submissionId, rootId: parent?.id ?? submissionId,
          replayed: false };
      });
    } catch (error) {
      if (error?.code === "23505") { // concurrent duplicate idempotency key
        const replay = await this.#replay(v.idempotencyKey, requestSha256);
        if (replay) return replay;
      }
      throw error;
    }
    for (const hook of this.onFiled) await hook(created);
    return created;
  }

  async #replay(idempotencyKey, requestSha256) {
    const row = (await this.pool.query(`SELECT s.id, s.parent_id, s.tracking_number, s.request_sha256, r.document
      FROM submissions s JOIN receipts r ON r.submission_id = s.id WHERE s.idempotency_key = $1`, [idempotencyKey])).rows[0];
    if (!row) return null;
    if (row.request_sha256 !== requestSha256) throw new IntakeError("idempotency_conflict", 409);
    return { receipt: row.document, trackingNumber: row.tracking_number, accessCode: null, submissionId: row.id,
      rootId: row.parent_id ?? row.id, replayed: true };
  }

  /** Participant authentication: tracking number AND access code; non-distinguishing failure. */
  async openParticipant(trackingNumber, accessCodeInput) {
    const tracking = typeof trackingNumber === "string" ? trackingNumber.trim().toUpperCase() : "";
    const supplied = typeof accessCodeInput === "string" ? accessCodeInput.trim().toUpperCase().replace(/[\s-]/g, "") : "";
    const row = /^DEMO-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(tracking)
      ? (await this.pool.query("SELECT id, parent_id, access_salt, access_hash FROM submissions WHERE tracking_number = $1",
        [tracking])).rows[0] : undefined;
    const salt = row?.access_salt ?? "0".repeat(32);
    const expected = Buffer.from(row?.access_hash ?? "f".repeat(64), "hex");
    const actual = Buffer.from(accessHash(salt, supplied), "hex");
    const ok = timingSafeEqual(expected, actual) && Boolean(row) && /^[0-9A-Z]{24}$/.test(supplied);
    return ok ? (row.parent_id ?? row.id) : null;
  }

  /**
   * Participant session: the owner's access code or a delegate code
   * (UFR delegation). Returns { rootId, scope, delegationId } or null.
   */
  async openParticipantSession(trackingNumber, accessCodeInput) {
    const owner = await this.openParticipant(trackingNumber, accessCodeInput);
    if (owner) return { rootId: owner, scope: "owner", delegationId: null };
    const tracking = typeof trackingNumber === "string" ? trackingNumber.trim().toUpperCase() : "";
    const supplied = typeof accessCodeInput === "string" ? accessCodeInput.trim().toUpperCase().replace(/[\s-]/g, "") : "";
    if (!/^[0-9A-Z]{24}$/.test(supplied)) return null;
    const rows = (await this.pool.query(`SELECT d.id, d.root_id, d.scope, d.code_salt, d.code_hash FROM delegations d
      JOIN submissions s ON (s.id = d.root_id OR s.parent_id = d.root_id) WHERE s.tracking_number = $1 AND d.revoked_at IS NULL`,
    [tracking])).rows;
    for (const r of rows) {
      if (timingSafeEqual(Buffer.from(accessHash(r.code_salt, supplied), "hex"), Buffer.from(r.code_hash, "hex")))
        return { rootId: r.root_id, scope: r.scope, delegationId: r.id };
    }
    return null;
  }

  async participantView(rootId) {
    const { rows } = await this.pool.query(`SELECT s.id, s.tracking_number, s.kind, s.title, s.filing_type,
        s.received_at, a.name AS agency_name, r.document,
        (SELECT status FROM status_events e WHERE e.submission_id = s.id ORDER BY e.id DESC LIMIT 1) AS status,
        o.state AS routing_state, i.acknowledgement
      FROM submissions s JOIN agencies a ON a.id = s.agency_id JOIN receipts r ON r.submission_id = s.id
      LEFT JOIN routing_outbox o ON o.submission_id = s.id LEFT JOIN agency_inbox_receipts i ON i.submission_id = s.id
      WHERE s.id = $1 OR s.parent_id = $1 ORDER BY s.received_at, s.id`, [rootId]);
    if (rows.length === 0) return null;
    const history = (await this.pool.query(`SELECT e.status, e.note, e.at FROM status_events e
      JOIN submissions s ON s.id = e.submission_id WHERE s.id = $1 OR s.parent_id = $1 ORDER BY e.id`, [rootId])).rows;
    return { filings: rows.map((r) => ({ id: r.id, trackingNumber: r.tracking_number, kind: r.kind, title: r.title,
      filingType: r.filing_type, receivedAt: r.received_at.toISOString(), agencyName: r.agency_name, receipt: r.document,
      status: r.status, routing: r.routing_state, acknowledgement: r.acknowledgement })),
    history: history.map((h) => ({ status: h.status, note: h.note, at: h.at.toISOString() })) };
  }

  async listSubmissions({ limit = 100, agencyIds = null } = {}) {
    const { rows } = await this.pool.query(`SELECT s.id, s.tracking_number, s.kind, s.title, s.filing_type, s.received_at,
        s.emergency, s.agency_id, a.name AS agency_name, o.state AS routing_state, o.due_by,
        (SELECT status FROM status_events e WHERE e.submission_id = s.id ORDER BY e.id DESC LIMIT 1) AS status
      FROM submissions s JOIN agencies a ON a.id = s.agency_id LEFT JOIN routing_outbox o ON o.submission_id = s.id
      WHERE ($2::text[] IS NULL OR s.agency_id = ANY($2))
      ORDER BY s.emergency DESC, s.received_at DESC LIMIT $1`, [limit, agencyIds]);
    return rows.map((r) => ({ id: r.id, emergency: r.emergency, agencyId: r.agency_id, trackingNumber: r.tracking_number, kind: r.kind, title: r.title,
      filingType: r.filing_type, receivedAt: r.received_at.toISOString(), agencyName: r.agency_name,
      routing: r.routing_state, routingDueBy: r.due_by?.toISOString() ?? null, status: r.status }));
  }

  async staffSubmission(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const s = (await this.pool.query(`SELECT s.*, a.name AS agency_name, m.manifest, m.sha256 AS manifest_sha256,
        r.document, o.state AS routing_state, o.attempts, o.last_error, o.due_by, i.acknowledgement, i.delivered_at
      FROM submissions s JOIN agencies a ON a.id = s.agency_id JOIN manifests m ON m.submission_id = s.id
      JOIN receipts r ON r.submission_id = s.id LEFT JOIN routing_outbox o ON o.submission_id = s.id
      LEFT JOIN agency_inbox_receipts i ON i.submission_id = s.id WHERE s.id = $1`, [id])).rows[0];
    if (!s) return null;
    const docs = (await this.pool.query(`SELECT d.id, d.ordinal, d.filename, d.media_type, d.size_bytes, d.sha256, d.encryption,
        (SELECT verdict FROM scan_results r WHERE r.document_id = d.id ORDER BY r.id DESC LIMIT 1) AS verdict,
        (SELECT detail FROM scan_results r WHERE r.document_id = d.id ORDER BY r.id DESC LIMIT 1) AS scan_detail
      FROM documents d WHERE d.submission_id = $1 ORDER BY d.ordinal`, [id])).rows;
    const history = (await this.pool.query(`SELECT status, note, actor, at, ledger_seq FROM status_events
      WHERE submission_id = $1 ORDER BY id`, [id])).rows;
    let content = { body: s.body, structured: s.structured };
    if (s.body === "[encrypted]") {
      const v = (await this.pool.query("SELECT key_id, sealed FROM content_vault WHERE submission_id = $1", [id])).rows[0];
      try { content = JSON.parse(openSealed(await this.keys.get(this.pool, v.key_id), v.sealed, `content:${id}`).toString("utf8")); }
      catch (error) { if (error?.code !== "data_key_destroyed") throw error; content = { body: "[disposed under the retention schedule]", structured: {} }; }
    }
    return { ...s, body: content.body, structured: content.structured, documents: docs, history };
  }

  /** Decrypts, integrity-checks and enforces quarantine: only a "clean" latest scan may be released. */
  async document(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const row = (await this.pool.query(`SELECT d.id, d.filename, d.media_type, d.content, d.sha256, d.encryption, d.key_id,
        (SELECT verdict FROM scan_results r WHERE r.document_id = d.id ORDER BY r.id DESC LIMIT 1) AS verdict
      FROM documents d WHERE d.id = $1`, [id])).rows[0];
    if (!row) return null;
    if (row.verdict && row.verdict !== "clean") return { quarantined: true, verdict: row.verdict, filename: row.filename };
    let content = row.content;
    if (row.encryption !== "none") {
      try { content = openSealed(await this.keys.get(this.pool, row.key_id), row.content, `doc:${row.id}`); }
      catch (error) { if (error?.code === "data_key_destroyed") return { disposed: true, filename: row.filename }; throw error; }
    }
    if (sha256Hex(content) !== row.sha256) return null; // integrity re-check on every read
    return { filename: row.filename, media_type: row.media_type, content, sha256: row.sha256 };
  }

  /** Staff review state is separate from the immutable original and receipt. */
  async recordStatus(submissionId, status, noteInput, actor) {
    if (!STAFF_STATUSES.includes(status)) throw new IntakeError("invalid_status");
    const note = str(noteInput ?? "", LIMITS.note, "note", { allowEmpty: true });
    return withTransaction(this.pool, async (client) => {
      const exists = (await client.query("SELECT 1 FROM submissions WHERE id = $1", [submissionId])).rowCount;
      if (!exists) throw new IntakeError("not_found", 404);
      const entry = await appendLedger(client, { eventType: "status.changed", subject: submissionId, appNow: this.appNow(),
        payload: { submissionId, status, noteSha256: sha256Hex(note), actor } });
      await client.query(`INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq)
        VALUES ($1,$2,$3,$4,$5,$6)`, [submissionId, status, note, actor, entry.recordedAt, entry.seq]);
      return entry;
    });
  }

  /**
   * UFR-011 public verifier: signature check plus ledger cross-check.
   * Returns only cryptographic facts; never filing content or identity.
   */
  async verifyReceipt(doc) {
    const offline = verifyReceiptDocument(doc, this.publicKeys());
    if (!offline.valid) return { valid: false, reason: offline.reason };
    const r = doc.receipt;
    const row = (await this.pool.query(`SELECT l.entry_hash, l.payload, l.recorded_at FROM receipts rc
      JOIN ledger_entries l ON l.seq = rc.ledger_seq WHERE rc.receipt_id = $1 AND l.seq = $2`,
    [r.receiptId, r.ledger.seq])).rows[0];
    if (!row) return { valid: false, reason: "not_in_ledger" };
    if (row.entry_hash !== r.ledger.entryHash || row.payload.receiptId !== r.receiptId ||
        row.payload.manifestSha256 !== r.manifest.sha256 || row.recorded_at.toISOString() !== r.receivedAt)
      return { valid: false, reason: "ledger_mismatch" };
    return { valid: true, receiptId: r.receiptId, receivedAt: r.receivedAt, manifestSha256: r.manifest.sha256,
      ledgerSeq: r.ledger.seq, keyId: r.issuer.keyId };
  }

  /**
   * UFR-032/033: in-process delivery worker. Routing to the fictional
   * agency inbox never alters or vetoes the receipt; failures retry with
   * capped backoff and end in a dead-letter state visible to staff.
   */
  async deliverDueRoutings({ limit = 10, deliver = async () => undefined } = {}) {
    let delivered = 0;
    for (let i = 0; i < limit; i++) {
      const done = await withTransaction(this.pool, async (client) => {
        const job = (await client.query(`SELECT id, submission_id, agency_id, attempts FROM routing_outbox
          WHERE state = 'pending' AND next_attempt_at <= clock_timestamp() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
        if (!job) return null;
        try {
          await deliver(job);
          const ack = "DEMO-ACK-" + code(12);
          const entry = await appendLedger(client, { eventType: "routing.delivered", subject: job.submission_id,
            appNow: this.appNow(), payload: { submissionId: job.submission_id, agencyId: job.agency_id, acknowledgement: ack } });
          await client.query(`INSERT INTO agency_inbox_receipts (submission_id, agency_id, delivered_at, acknowledgement, ledger_seq)
            VALUES ($1,$2,$3,$4,$5)`, [job.submission_id, job.agency_id, entry.recordedAt, ack, entry.seq]);
          await client.query("UPDATE routing_outbox SET state = 'delivered', delivered_at = $2, attempts = attempts + 1 WHERE id = $1",
            [job.id, entry.recordedAt]);
          await client.query(`INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq)
            VALUES ($1, 'routed', 'Delivered to the fictional demonstration agency inbox.', 'routing-worker', $2, $3)`,
          [job.submission_id, entry.recordedAt, entry.seq]);
          return "delivered";
        } catch (error) {
          const attempts = job.attempts + 1;
          const dead = attempts >= this.maxRoutingAttempts;
          await client.query(`UPDATE routing_outbox SET attempts = $2, last_error = $3, state = $4,
            next_attempt_at = clock_timestamp() + make_interval(secs => $5) WHERE id = $1`,
          [job.id, attempts, String(error?.message ?? "delivery_failed").slice(0, 200), dead ? "dead" : "pending",
            Math.min(3600, 5 * 2 ** attempts)]);
          if (dead) {
            const entry = await appendLedger(client, { eventType: "routing.dead_letter", subject: job.submission_id,
              appNow: this.appNow(), payload: { submissionId: job.submission_id, agencyId: job.agency_id, attempts } });
            await client.query(`INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq)
              VALUES ($1, 'routing_escalated', 'Routing failed repeatedly; escalated to staff. The receipt is unaffected.',
              'routing-worker', $2, $3)`, [job.submission_id, entry.recordedAt, entry.seq]);
          }
          return "failed";
        }
      });
      if (!done) break;
      if (done === "delivered") delivered++;
    }
    return delivered;
  }

  /** Simple durable per-bucket rate limit (works across restarts of the single free instance). */
  async allow(bucket, max, windowSeconds) {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [bucket]);
      await client.query("DELETE FROM rate_events WHERE at < clock_timestamp() - make_interval(secs => $1)", [windowSeconds * 4]);
      const n = Number((await client.query(`SELECT count(*) FROM rate_events WHERE bucket = $1
        AND at > clock_timestamp() - make_interval(secs => $2)`, [bucket, windowSeconds])).rows[0].count);
      if (n >= max) return false;
      await client.query("INSERT INTO rate_events (bucket) VALUES ($1)", [bucket]);
      return true;
    });
  }
}
