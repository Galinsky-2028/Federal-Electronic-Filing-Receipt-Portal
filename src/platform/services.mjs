import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { accessHash, code, IntakeError } from "../demo/backend.mjs";
import { sha256Hex } from "../demo/canonical.mjs";
import { withTransaction } from "../demo/db.mjs";
import { appendLedger } from "../demo/ledger.mjs";
import { open as openSealed } from "./crypto.mjs";
import { hashPassword, newTotpSecret, passwordProblem, verifyPassword, verifyTotp } from "./safety.mjs";

export const ROLES = Object.freeze(["admin", "intake", "privacy_officer", "oversight", "records_officer"]);
const ROLE_RE = /^(admin|intake|privacy_officer|oversight|records_officer|agency:[a-z0-9-]{2,64})$/;
export const hasRole = (user, ...roles) => Boolean(user) && (user.roles.includes("admin") || roles.some((r) => user.roles.includes(r)));
export const agencyScopes = (user) => user.roles.filter((r) => r.startsWith("agency:")).map((r) => r.slice(7));
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REVEAL_TTL_MINUTES = 15;
const DRAFT_DAYS = 7;
const text = (v, max, field, allowEmpty = false) => {
  const s = typeof v === "string" ? v.normalize("NFC").trim() : "";
  if ((!allowEmpty && !s) || s.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) throw new IntakeError(`invalid_${field}`);
  return s;
};

/**
 * Portal-local platform services layered on the demo intake backend.
 * Everything consequential is ledgered. Staff actions are attributed to
 * individual accounts (UFR-024), never to a shared credential.
 */
export class PlatformServices {
  constructor({ backend, keys, retentionPath = new URL("../../config/retention-schedule.json", import.meta.url) }) {
    this.backend = backend; this.pool = backend.pool; this.keys = keys;
    this.retention = JSON.parse(readFileSync(retentionPath, "utf8"));
  }
  ledger(client, eventType, subject, payload) {
    return appendLedger(client, { eventType, subject, payload, appNow: this.backend.appNow() });
  }

  // ------------------------------------------------------------ staff accounts and MFA (UFR-024)
  async bootstrapAdmin(username, password) {
    if (!username || !password) return false;
    if (passwordProblem(password)) throw new Error("STAFF_PASSWORD must be at least 16 varied characters");
    const exists = (await this.pool.query("SELECT 1 FROM staff_users WHERE username = $1", [username])).rowCount;
    if (exists) return false;
    await withTransaction(this.pool, async (c) => {
      const id = randomUUID();
      await c.query("INSERT INTO staff_users (id, username, password_hash, roles) VALUES ($1,$2,$3,$4)",
        [id, username, hashPassword(password), ["admin"]]);
      await this.ledger(c, "staff.bootstrapped", id, { username, roles: ["admin"] });
    });
    return true;
  }
  async staffCount() { return Number((await this.pool.query("SELECT count(*) FROM staff_users WHERE NOT disabled")).rows[0].count); }
  async getStaff(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
    const u = (await this.pool.query("SELECT id, username, roles, mfa_enabled, disabled, totp_secret FROM staff_users WHERE id = $1", [id])).rows[0];
    return u && !u.disabled ? u : null;
  }
  async listStaff() {
    return (await this.pool.query("SELECT id, username, roles, mfa_enabled, disabled, locked_until FROM staff_users ORDER BY username")).rows;
  }
  /** Returns { user } or { error: "invalid" | "locked" | "mfa_required" }. Failures are non-distinguishing to callers. */
  async login(usernameInput, password, totpCode) {
    const username = String(usernameInput ?? "").trim().toLowerCase();
    return withTransaction(this.pool, async (c) => {
      const u = (await c.query("SELECT * FROM staff_users WHERE username = $1 FOR UPDATE", [username])).rows[0];
      const passwordOk = verifyPassword(u?.password_hash, password);
      if (!u || u.disabled) return { error: "invalid" };
      if (u.locked_until && u.locked_until > new Date()) return { error: "locked" };
      let step = null;
      if (passwordOk && u.mfa_enabled) {
        step = verifyTotp(u.totp_secret, totpCode ?? "", this.backend.appNow(), Number(u.totp_last_step));
        if (step === null && !totpCode) return { error: "mfa_required" };
      }
      if (!passwordOk || (u.mfa_enabled && step === null)) {
        const failed = u.failed_logins + 1;
        await c.query(`UPDATE staff_users SET failed_logins = $2,
          locked_until = CASE WHEN $2 >= ${MAX_FAILED} THEN clock_timestamp() + interval '${LOCK_MINUTES} minutes' ELSE locked_until END WHERE id = $1`, [u.id, failed]);
        if (failed === MAX_FAILED) await this.ledger(c, "staff.locked_out", u.id, { failedLogins: failed });
        return { error: "invalid" };
      }
      await c.query("UPDATE staff_users SET failed_logins = 0, locked_until = NULL, totp_last_step = GREATEST(totp_last_step, $2) WHERE id = $1",
        [u.id, step ?? -1]);
      return { user: { id: u.id, username: u.username, roles: u.roles } };
    });
  }
  async createStaff(actor, { username, password, roles }) {
    if (!hasRole(actor, "admin")) throw new IntakeError("forbidden", 403);
    const name = String(username ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(name)) throw new IntakeError("invalid_username");
    const problem = passwordProblem(password);
    if (problem) throw new IntakeError("weak_password");
    const list = [...new Set((Array.isArray(roles) ? roles : [roles]).filter(Boolean))];
    if (!list.length || !list.every((r) => ROLE_RE.test(r))) throw new IntakeError("invalid_roles");
    return withTransaction(this.pool, async (c) => {
      const id = randomUUID();
      try { await c.query("INSERT INTO staff_users (id, username, password_hash, roles) VALUES ($1,$2,$3,$4)", [id, name, hashPassword(password), list]); }
      catch (e) { if (e.code === "23505") throw new IntakeError("username_taken", 409); throw e; }
      await this.ledger(c, "staff.user_created", id, { username: name, roles: list, actor: actor.id });
      return id;
    });
  }
  async setStaffDisabled(actor, id, disabled) {
    if (!hasRole(actor, "admin") || actor.id === id) throw new IntakeError("forbidden", 403);
    return withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE staff_users SET disabled = $2 WHERE id = $1", [id, disabled]);
      if (!r.rowCount) throw new IntakeError("not_found", 404);
      await this.ledger(c, disabled ? "staff.user_disabled" : "staff.user_enabled", id, { actor: actor.id });
    });
  }
  async beginMfa(user) {
    const secret = newTotpSecret();
    await this.pool.query("UPDATE staff_users SET totp_secret = $2 WHERE id = $1 AND NOT mfa_enabled", [user.id, secret]);
    return secret;
  }
  async confirmMfa(user, codeInput) {
    return withTransaction(this.pool, async (c) => {
      const u = (await c.query("SELECT totp_secret, mfa_enabled FROM staff_users WHERE id = $1 FOR UPDATE", [user.id])).rows[0];
      if (!u?.totp_secret || u.mfa_enabled) throw new IntakeError("mfa_not_pending");
      const step = verifyTotp(u.totp_secret, codeInput, this.backend.appNow());
      if (step === null) throw new IntakeError("invalid_mfa_code");
      await c.query("UPDATE staff_users SET mfa_enabled = true, totp_last_step = $2 WHERE id = $1", [user.id, step]);
      await this.ledger(c, "staff.mfa_enabled", user.id, {});
    });
  }

  /** Agency-scoped staff may only see their agency's filings. */
  async canSeeSubmission(user, submissionId) {
    if (hasRole(user, "intake", "privacy_officer", "oversight", "records_officer")) return true;
    const scopes = agencyScopes(user);
    if (!scopes.length) return false;
    return (await this.pool.query("SELECT 1 FROM submissions WHERE id = $1 AND agency_id = ANY($2)", [submissionId, scopes])).rowCount === 1;
  }

  // ------------------------------------------------------------ protected identity, dual control (UFR-023)
  async requestReveal(user, submissionId, reasonInput) {
    if (!hasRole(user, "intake", "privacy_officer")) throw new IntakeError("forbidden", 403);
    const reason = text(reasonInput, 500, "reason");
    return withTransaction(this.pool, async (c) => {
      const s = (await c.query("SELECT identity_protected FROM submissions WHERE id = $1", [submissionId])).rows[0];
      if (!s?.identity_protected) throw new IntakeError("not_found", 404);
      const id = randomUUID();
      await c.query("INSERT INTO reveal_requests (id, submission_id, requested_by, reason) VALUES ($1,$2,$3,$4)", [id, submissionId, user.id, reason]);
      await this.ledger(c, "identity.reveal_requested", submissionId, { requestId: id, requestedBy: user.id, reasonSha256: sha256Hex(reason) });
      return id;
    });
  }
  async pendingReveals() {
    return (await this.pool.query(`SELECT r.id, r.submission_id, r.reason, r.requested_at, u.username AS requested_by, r.requested_by AS requester_id,
        s.tracking_number FROM reveal_requests r JOIN staff_users u ON u.id = r.requested_by JOIN submissions s ON s.id = r.submission_id
      WHERE r.approved_at IS NULL ORDER BY r.requested_at`)).rows;
  }
  async approveReveal(user, requestId) {
    if (!user.roles.includes("privacy_officer")) throw new IntakeError("forbidden", 403); // admin alone cannot approve
    return withTransaction(this.pool, async (c) => {
      const r = (await c.query("SELECT * FROM reveal_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
      if (!r || r.approved_at) throw new IntakeError("not_found", 404);
      if (r.requested_by === user.id) throw new IntakeError("dual_control_required", 403);
      await c.query(`UPDATE reveal_requests SET approved_by = $2, approved_at = clock_timestamp(),
        expires_at = clock_timestamp() + interval '${REVEAL_TTL_MINUTES} minutes' WHERE id = $1`, [requestId, user.id]);
      await this.ledger(c, "identity.reveal_approved", r.submission_id, { requestId, approvedBy: user.id });
    });
  }
  /** One-time, requester-only, time-limited reveal of the sealed identity. */
  async consumeReveal(user, requestId) {
    return withTransaction(this.pool, async (c) => {
      const r = (await c.query("SELECT * FROM reveal_requests WHERE id = $1 FOR UPDATE", [requestId])).rows[0];
      if (!r || r.requested_by !== user.id || !r.approved_at || r.consumed_at || r.expires_at < new Date())
        throw new IntakeError("reveal_unavailable", 403);
      const v = (await c.query("SELECT key_id, sealed FROM identity_vault WHERE submission_id = $1", [r.submission_id])).rows[0];
      let identity;
      try { identity = JSON.parse(openSealed(await this.keys.get(c, v.key_id), v.sealed, `identity:${r.submission_id}`).toString("utf8")); }
      catch (e) { if (e?.code === "data_key_destroyed") throw new IntakeError("identity_disposed", 410); throw e; }
      await c.query("UPDATE reveal_requests SET consumed_at = clock_timestamp() WHERE id = $1", [requestId]);
      await this.ledger(c, "identity.revealed", r.submission_id, { requestId, viewer: user.id });
      return { submissionId: r.submission_id, ...identity };
    });
  }

  // ------------------------------------------------------------ drafts (UFR-019)
  async saveDraft(fields) {
    const allowed = ["agencyId", "filingType", "title", "body", "claimantName", "claimantContact", "emergency", "structured"];
    const payload = Object.fromEntries(allowed.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]]));
    if (JSON.stringify(payload).length > 40_000) throw new IntakeError("invalid_body");
    const draftCode = code(24);
    await this.pool.query("DELETE FROM drafts WHERE expires_at < clock_timestamp()");
    await this.pool.query(`INSERT INTO drafts (code_hash, payload, expires_at) VALUES ($1, $2, clock_timestamp() + interval '${DRAFT_DAYS} days')`,
      [sha256Hex("draft:" + draftCode), payload]);
    return draftCode;
  }
  async loadDraft(codeInput) {
    const c = String(codeInput ?? "").toUpperCase().replace(/[\s-]/g, "");
    if (!/^[0-9A-Z]{24}$/.test(c)) return null;
    const row = (await this.pool.query("SELECT payload FROM drafts WHERE code_hash = $1 AND expires_at > clock_timestamp()",
      [sha256Hex("draft:" + c)])).rows[0];
    return row ? { fields: row.payload, codeHash: sha256Hex("draft:" + c) } : null;
  }

  // ------------------------------------------------------------ delegation (participant representatives)
  async createDelegation(session, labelInput, scope) {
    if (session.scope !== "owner") throw new IntakeError("forbidden", 403);
    if (!["view", "view_supplement"].includes(scope)) throw new IntakeError("invalid_scope");
    const label = text(labelInput, 80, "label");
    const delegateCode = code(24); const salt = randomBytes(16).toString("hex");
    await withTransaction(this.pool, async (c) => {
      const id = randomUUID();
      await c.query("INSERT INTO delegations (id, root_id, label, scope, code_salt, code_hash) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, session.rootId, label, scope, salt, accessHash(salt, delegateCode)]);
      await this.ledger(c, "participant.delegation_granted", session.rootId, { delegationId: id, scope });
    });
    return delegateCode;
  }
  async listDelegations(rootId) {
    return (await this.pool.query("SELECT id, label, scope, created_at, revoked_at FROM delegations WHERE root_id = $1 ORDER BY created_at", [rootId])).rows;
  }
  async revokeDelegation(session, id) {
    if (session.scope !== "owner") throw new IntakeError("forbidden", 403);
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE delegations SET revoked_at = clock_timestamp() WHERE id = $1 AND root_id = $2 AND revoked_at IS NULL", [id, session.rootId]);
      if (!r.rowCount) throw new IntakeError("not_found", 404);
      await this.ledger(c, "participant.delegation_revoked", session.rootId, { delegationId: id });
    });
  }
  async delegationActive(id) {
    return (await this.pool.query("SELECT 1 FROM delegations WHERE id = $1 AND revoked_at IS NULL", [id])).rowCount === 1;
  }

  // ------------------------------------------------------------ corrections, complaints, withdrawal (UFR-052)
  async fileCorrection(session, kind, statementInput) {
    if (session.scope === "view") throw new IntakeError("forbidden", 403);
    if (!["receipt_correction", "processing_complaint", "withdrawal"].includes(kind)) throw new IntakeError("invalid_kind");
    const statement = text(statementInput, 4000, "statement");
    return withTransaction(this.pool, async (c) => {
      const id = randomUUID();
      const entry = await this.ledger(c, "correction.filed", session.rootId, { correctionId: id, kind, statementSha256: sha256Hex(statement),
        filedBy: session.scope });
      await c.query(`INSERT INTO corrections (id, submission_id, kind, statement, filed_by, ledger_seq) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, session.rootId, kind, statement, session.scope === "owner" ? "claimant" : "representative", entry.seq]);
      await c.query(`INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq) VALUES ($1,$2,$3,'claimant',$4,$5)`,
        [session.rootId, kind === "withdrawal" ? "withdrawal_requested" : kind === "receipt_correction" ? "correction_requested" : "complaint_filed",
          "Filed by the participant; the original record is unchanged.", entry.recordedAt, entry.seq]);
      await c.query("INSERT INTO notification_outbox (channel, audience, template, payload) VALUES ('staff-queue', 'role:intake', $1, $2)",
        [`correction.${kind}`, { submissionId: session.rootId, correctionId: id }]);
      return id;
    });
  }
  async listCorrections(submissionId) {
    return (await this.pool.query(`SELECT c.*, u.username AS decided_by_name FROM corrections c LEFT JOIN staff_users u ON u.id = c.decided_by
      WHERE c.submission_id = $1 ORDER BY c.filed_at`, [submissionId])).rows;
  }
  /**
   * Staff decision. An accepted receipt correction yields a separately
   * signed correction notice that references, and never replaces, the
   * original receipt. An accepted withdrawal sets status "withdrawn"; the
   * filing and its receipt remain preserved.
   */
  async decideCorrection(user, correctionId, decision, noteInput) {
    if (!hasRole(user, "intake")) throw new IntakeError("forbidden", 403);
    if (!["accepted", "denied"].includes(decision)) throw new IntakeError("invalid_decision");
    const note = text(noteInput ?? "", 2000, "note", true);
    return withTransaction(this.pool, async (c) => {
      const k = (await c.query(`SELECT c.*, r.document AS receipt FROM corrections c JOIN receipts r ON r.submission_id = c.submission_id
        WHERE c.id = $1 FOR UPDATE OF c`, [correctionId])).rows[0];
      if (!k || k.decision) throw new IntakeError("not_found", 404);
      const entry = await this.ledger(c, "correction.decided", k.submission_id, { correctionId, decision, decidedBy: user.id, noteSha256: sha256Hex(note) });
      let doc = null;
      if (decision === "accepted" && k.kind === "receipt_correction") {
        const body = { schema: "ufr-demo-receipt-correction-v1", demo: true,
          notice: "DEMONSTRATION correction notice. It supplements and never replaces the original demonstration receipt. Not a government document.",
          correctionId, correctsReceiptId: k.receipt.receipt.receiptId, statementSha256: sha256Hex(k.statement),
          decidedAt: entry.recordedAt, ledger: { seq: entry.seq, entryHash: entry.entryHash } };
        doc = { correction: body, signature: { alg: "EdDSA", keyId: this.backend.signer.keyId, value: this.backend.signer.sign(body) } };
      }
      await c.query(`UPDATE corrections SET decision = $2, decision_note = $3, decided_by = $4, decided_at = $5, correction_document = $6 WHERE id = $1`,
        [correctionId, decision, note, user.id, entry.recordedAt, doc]);
      const status = decision === "accepted" && k.kind === "withdrawal" ? "withdrawn" : `${k.kind}_${decision}`;
      await c.query(`INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq) VALUES ($1,$2,$3,$4,$5,$6)`,
        [k.submission_id, status, note, `staff:${user.username}`, entry.recordedAt, entry.seq]);
      await c.query("INSERT INTO notification_outbox (channel, audience, template, payload) VALUES ('claimant-portal', $1, 'correction.decided', $2)",
        [`root:${k.submission_id}`, { correctionId, decision }]);
      return doc;
    });
  }

  // ------------------------------------------------------------ records retention, legal hold, disposition (UFR-053)
  async placeHold(user, submissionId, reasonInput) {
    if (!hasRole(user, "records_officer")) throw new IntakeError("forbidden", 403);
    const reason = text(reasonInput, 500, "reason");
    await withTransaction(this.pool, async (c) => {
      await c.query(`INSERT INTO legal_holds (submission_id, reason, placed_by) VALUES ($1,$2,$3)
        ON CONFLICT (submission_id) DO UPDATE SET reason = EXCLUDED.reason, placed_by = EXCLUDED.placed_by, placed_at = clock_timestamp(), released_at = NULL`,
      [submissionId, reason, user.id]);
      await this.ledger(c, "records.hold_placed", submissionId, { by: user.id, reasonSha256: sha256Hex(reason) });
    });
  }
  async releaseHold(user, submissionId) {
    if (!hasRole(user, "records_officer")) throw new IntakeError("forbidden", 403);
    await withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE legal_holds SET released_at = clock_timestamp() WHERE submission_id = $1 AND released_at IS NULL", [submissionId]);
      if (!r.rowCount) throw new IntakeError("not_found", 404);
      await this.ledger(c, "records.hold_released", submissionId, { by: user.id });
    });
  }
  retentionDays(filingType) { return this.retention.schedules[filingType] ?? this.retention.defaultDays; }
  /**
   * Crypto-shreds identity, content and document keys of filings past their
   * (demonstration) retention period that are not on legal hold. Receipts,
   * manifests (hashes only), subject lines and ledger entries are retained,
   * so receipts remain verifiable after disposition.
   */
  async disposeEligible({ asOf = new Date(this.backend.appNow()), actor = "records-job" } = {}) {
    const candidates = (await this.pool.query(`SELECT s.id, s.filing_type, s.received_at FROM submissions s
      WHERE s.identity_protected AND NOT EXISTS (SELECT 1 FROM dispositions d WHERE d.submission_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL AND (h.submission_id = s.id OR h.submission_id = s.parent_id))`)).rows;
    let disposed = 0;
    for (const s of candidates) {
      const days = this.retentionDays(s.filing_type);
      if (s.received_at.getTime() + days * 86_400_000 > asOf.getTime()) continue;
      await withTransaction(this.pool, async (c) => {
        const keys = (await c.query("SELECT id FROM data_keys WHERE subject = $1 AND destroyed_at IS NULL FOR UPDATE", [s.id])).rows;
        for (const k of keys) await this.keys.destroy(c, k.id, `retention:${s.filing_type}:${days}d`);
        const entry = await this.ledger(c, "records.disposed", s.id, { rule: `${s.filing_type}:${days}d`, keysDestroyed: keys.length, actor });
        await c.query("INSERT INTO dispositions (submission_id, disposed_at, rule, ledger_seq) VALUES ($1,$2,$3,$4)", [s.id, entry.recordedAt, `${s.filing_type}:${days}d`, entry.seq]);
      });
      disposed++;
    }
    return disposed;
  }
  async recordsStatus(submissionId) {
    const hold = (await this.pool.query("SELECT reason, placed_at, released_at FROM legal_holds WHERE submission_id = $1", [submissionId])).rows[0] ?? null;
    const disposition = (await this.pool.query("SELECT disposed_at, rule FROM dispositions WHERE submission_id = $1", [submissionId])).rows[0] ?? null;
    return { hold, disposition };
  }

  // ------------------------------------------------------------ provider-free notifications
  async deliverNotifications(log = () => {}) {
    const rows = (await this.pool.query(`UPDATE notification_outbox SET state = 'delivered', delivered_at = clock_timestamp(), attempts = attempts + 1
      WHERE id IN (SELECT id FROM notification_outbox WHERE state = 'pending' ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED)
      RETURNING channel, template`)).rows;
    for (const r of rows) if (r.channel === "email-simulated") log("notification.email_simulated", { template: r.template });
    return rows.length;
  }
  async notificationsFor(audiences) {
    return (await this.pool.query(`SELECT id, channel, audience, template, payload, created_at FROM notification_outbox
      WHERE audience = ANY($1) AND state = 'delivered' ORDER BY id DESC LIMIT 50`, [audiences])).rows;
  }
}
