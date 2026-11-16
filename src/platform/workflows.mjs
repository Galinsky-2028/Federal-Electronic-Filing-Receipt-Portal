import { randomUUID } from "node:crypto";
import { IntakeError } from "../demo/backend.mjs";
import { sha256Hex } from "../demo/canonical.mjs";
import { withTransaction } from "../demo/db.mjs";
import { appendLedger } from "../demo/ledger.mjs";
import { computeDeadline, extendForTolling, RULES } from "./deadlines.mjs";
import { hasRole } from "./services.mjs";

/**
 * UFR-040/041/042 filing-type workflows, UFR-043 defects/cure/relation back,
 * UFR-045 notices with read receipts, UFR-037 agency acknowledgement and
 * correspondence, UFR-038 routing/deadline escalation, UFR-049 ledger
 * checkpoints. Demonstration processing only: fictional agencies, no legal
 * effect. Review state never alters an original filing or its receipt.
 */
const CLOSE = ["closed"];
const REVIEW = (review, outcomes) => ({ acknowledged: [review, "information_requested"], information_requested: [review],
  [review]: ["information_requested", ...outcomes], ...Object.fromEntries(outcomes.map((o) => [o, CLOSE])) });
export const WORKFLOWS = {
  "records-request": { ...REVIEW("processing", ["determination_full_grant", "determination_partial_grant", "determination_denial", "no_records_found"]) },
  "records-appeal": { ...REVIEW("under_appeal_review", ["appeal_granted", "appeal_denied", "remanded"]) },
  "tort-claim-notice": { ...REVIEW("under_investigation", ["settlement_offered", "claim_denied"]), settlement_offered: ["settled", "claim_denied"],
    settled: CLOSE, deemed_denied: CLOSE },
  "administrative-claim": { ...REVIEW("under_review", ["claim_approved", "claim_partially_approved", "claim_denied"]) },
  "administrative-appeal": { ...REVIEW("under_appeal_review", ["decision_affirmed", "decision_reversed", "remanded"]) },
  complaint: { ...REVIEW("under_review", ["resolved", "referred", "dismissed"]) },
  petition: { ...REVIEW("under_review", ["granted", "denied", "referred"]) },
  "general-correspondence": { ...REVIEW("under_review", ["resolved", "referred"]) },
};
const ENTRY = ["received", "routed", "routing_escalated", "routing_overdue", "defect_notice_issued", "cured"];
const TERMINAL = ["closed", "withdrawn"];
const RESPONSE_RULE = { "records-request": "records.response", "records-appeal": "records.appeal_response", "tort-claim-notice": "tort.agency_decision",
  "administrative-claim": "claim.decision", "administrative-appeal": "appeal.decision" };
const CLAIMANT_RULES = new Set(["records.appeal_window", "tort.suit_window", "defect.cure"]);
const NOTICE_KINDS = ["acknowledgement", "information_request", "defect", "determination", "general"];
const CHECKPOINT_MINUTES = 10;

export class WorkflowServices {
  constructor({ backend, platform, logger = () => {} }) {
    this.backend = backend; this.platform = platform; this.pool = backend.pool; this.logger = logger;
  }
  ledger(client, eventType, subject, payload) { return appendLedger(client, { eventType, subject, payload, appNow: this.backend.appNow() }); }

  async currentState(db, submissionId) {
    const rows = (await db.query("SELECT status FROM status_events WHERE submission_id = $1 ORDER BY id DESC", [submissionId])).rows;
    const all = new Set(Object.values(WORKFLOWS).flatMap((w) => [...Object.keys(w), ...Object.values(w).flat()]));
    return rows.map((r) => r.status).find((s) => all.has(s) || ENTRY.includes(s) || TERMINAL.includes(s)) ?? "received";
  }
  nextStates(filingType, state) {
    if (TERMINAL.includes(state)) return [];
    if (ENTRY.includes(state)) return ["acknowledged"];
    return WORKFLOWS[filingType]?.[state] ?? [];
  }
  async allowedTransitions(submissionId) {
    const s = (await this.pool.query("SELECT filing_type, kind FROM submissions WHERE id = $1", [submissionId])).rows[0];
    if (!s || s.kind !== "original") return [];
    return this.nextStates(s.filing_type, await this.currentState(this.pool, submissionId));
  }

  async #openDeadline(c, submissionId, ruleId, startInstant, entrySeq) {
    const d = computeDeadline(ruleId, startInstant);
    await c.query(`INSERT INTO deadlines (submission_id, rule_id, rule_version, start_date, due_date, due_at, ledger_seq)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [submissionId, ruleId, d.ruleVersion, d.startDate, d.dueDate, d.dueAt, entrySeq]);
    return d;
  }
  async #closeDeadlines(c, submissionId, rules, state) {
    await c.query(`UPDATE deadlines SET state = $3, closed_at = clock_timestamp() WHERE submission_id = $1 AND rule_id = ANY($2) AND state IN ('open', 'tolled')`,
      [submissionId, rules, state]);
  }

  /** Staff/agency workflow transition with role, scope and state-machine checks. */
  async transition(user, submissionId, to, noteInput) {
    if (!(await this.platform.canSeeSubmission(user, submissionId)) || !(hasRole(user, "intake") || user.roles.some((r) => r.startsWith("agency:"))))
      throw new IntakeError("forbidden", 403);
    const note = String(noteInput ?? "").trim().slice(0, 1000);
    return withTransaction(this.pool, async (c) => {
      const s = (await c.query("SELECT id, filing_type, kind, received_at FROM submissions WHERE id = $1 FOR UPDATE", [submissionId])).rows[0];
      if (!s || s.kind !== "original") throw new IntakeError("not_found", 404);
      const from = await this.currentState(c, submissionId);
      if (!this.nextStates(s.filing_type, from).includes(to)) throw new IntakeError("invalid_transition", 409);
      const entry = await this.ledger(c, "workflow.transition", submissionId, { from, to, actor: user.id, noteSha256: sha256Hex(note) });
      await c.query("INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq) VALUES ($1,$2,$3,$4,$5,$6)",
        [submissionId, to, note, `staff:${user.username}`, entry.recordedAt, entry.seq]);
      const response = RESPONSE_RULE[s.filing_type];
      if (to === "acknowledged") {
        await this.#closeDeadlines(c, submissionId, ["complaint.acknowledge"], "met");
        if (response) await this.#openDeadline(c, submissionId, response, response === "tort.agency_decision" ? s.received_at : entry.recordedAt, entry.seq);
        await this.#notice(c, submissionId, "acknowledgement", `staff:${user.username}`, note || "Your demonstration filing was acknowledged by the fictional agency.", entry);
      }
      if (to === "information_requested")
        await c.query("UPDATE deadlines SET state = 'tolled', tolled_at = $2 WHERE submission_id = $1 AND state = 'open' AND rule_id = ANY($3)",
          [submissionId, entry.recordedAt, Object.values(RESPONSE_RULE)]);
      if (from === "information_requested") {
        const tolled = (await c.query("SELECT id, due_date, tolled_at FROM deadlines WHERE submission_id = $1 AND state = 'tolled'", [submissionId])).rows;
        for (const t of tolled) {
          const ext = extendForTolling(t.due_date.toISOString().slice(0, 10), t.tolled_at, entry.recordedAt);
          await c.query("UPDATE deadlines SET state = 'open', due_date = $2, due_at = $3, tolled_at = NULL WHERE id = $1", [t.id, ext.dueDate, ext.dueAt]);
        }
      }
      const outcomes = Object.entries(WORKFLOWS[s.filing_type] ?? {}).filter(([, next]) => next === CLOSE).map(([k]) => k);
      if (outcomes.includes(to) || ["settlement_offered", "claim_denied"].includes(to)) {
        if (response) await this.#closeDeadlines(c, submissionId, [response], "met");
        await this.#notice(c, submissionId, "determination", `staff:${user.username}`, note || `Determination recorded: ${to.replace(/_/g, " ")}.`, entry);
        if (s.filing_type === "records-request" && to !== "determination_full_grant") await this.#openDeadline(c, submissionId, "records.appeal_window", entry.recordedAt, entry.seq);
        if (s.filing_type === "tort-claim-notice" && to === "claim_denied") await this.#openDeadline(c, submissionId, "tort.suit_window", entry.recordedAt, entry.seq);
      }
      if (to === "closed") await c.query(`UPDATE deadlines SET state = 'cancelled', closed_at = clock_timestamp() WHERE submission_id = $1
        AND state IN ('open', 'tolled') AND NOT (rule_id = ANY($2))`, [submissionId, [...CLAIMANT_RULES]]);
      return entry;
    });
  }

  async #notice(c, submissionId, kind, author, body, entry, cureDueAt = null) {
    const id = randomUUID();
    await c.query(`INSERT INTO notices (id, submission_id, kind, author, body, sent_at, cure_due_at, ledger_seq) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, submissionId, kind, author, body, entry.recordedAt, cureDueAt, entry.seq]);
    await c.query("INSERT INTO notification_outbox (channel, audience, template, payload) VALUES ('claimant-portal', $1, $2, $3), ('email-simulated', $1, $2, $3)",
      [`root:${submissionId}`, `notice.${kind}`, { submissionId, noticeId: id }]);
    return id;
  }
  /** UFR-045: staff/agency notice; defect notices open a cure period (UFR-043). */
  async issueNotice(user, submissionId, kind, bodyInput) {
    if (!(await this.platform.canSeeSubmission(user, submissionId))) throw new IntakeError("forbidden", 403);
    if (!NOTICE_KINDS.includes(kind)) throw new IntakeError("invalid_kind");
    const body = String(bodyInput ?? "").trim();
    if (!body || body.length > 4000) throw new IntakeError("invalid_statement");
    return withTransaction(this.pool, async (c) => {
      const s = (await c.query("SELECT kind FROM submissions WHERE id = $1", [submissionId])).rows[0];
      if (!s || s.kind !== "original") throw new IntakeError("not_found", 404);
      const entry = await this.ledger(c, "notice.sent", submissionId, { kind, actor: user.id, bodySha256: sha256Hex(body) });
      let cure = null;
      if (kind === "defect") {
        cure = await this.#openDeadline(c, submissionId, "defect.cure", entry.recordedAt, entry.seq);
        await c.query("INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq) VALUES ($1,'defect_notice_issued',$2,$3,$4,$5)",
          [submissionId, `Cure by ${cure.dueDate} (Eastern).`, `staff:${user.username}`, entry.recordedAt, entry.seq]);
      }
      if (kind === "information_request") {
        await c.query("INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq) VALUES ($1,'information_requested','',$2,$3,$4)",
          [submissionId, `staff:${user.username}`, entry.recordedAt, entry.seq]);
        await c.query("UPDATE deadlines SET state = 'tolled', tolled_at = $2 WHERE submission_id = $1 AND state = 'open' AND rule_id = ANY($3)",
          [submissionId, entry.recordedAt, Object.values(RESPONSE_RULE)]);
      }
      return this.#notice(c, submissionId, kind, `staff:${user.username}`, body, entry, cure?.dueAt ?? null);
    });
  }
  async claimantReply(session, bodyInput) {
    if (session.scope === "view") throw new IntakeError("forbidden", 403);
    const body = String(bodyInput ?? "").trim();
    if (!body || body.length > 4000) throw new IntakeError("invalid_statement");
    return withTransaction(this.pool, async (c) => {
      const entry = await this.ledger(c, "notice.claimant_reply", session.rootId, { bodySha256: sha256Hex(body), by: session.scope });
      const id = randomUUID();
      await c.query(`INSERT INTO notices (id, submission_id, kind, author, body, sent_at, ledger_seq, read_at) VALUES ($1,$2,'claimant_reply',$3,$4,$5,$6,$5)`,
        [id, session.rootId, session.scope === "owner" ? "claimant" : "representative", body, entry.recordedAt, entry.seq]);
      const agency = (await c.query("SELECT agency_id FROM submissions WHERE id = $1", [session.rootId])).rows[0].agency_id;
      await c.query("INSERT INTO notification_outbox (channel, audience, template, payload) VALUES ('staff-queue', $1, 'notice.claimant_reply', $2)",
        [`agency:${agency}`, { submissionId: session.rootId, noticeId: id }]);
      return id;
    });
  }
  /** Read receipt: the first claimant view of a notice is ledgered as proof of delivery to the portal inbox. */
  async markNoticesRead(session, submissionId) {
    if (session.scope !== "owner" && session.scope !== "view_supplement" && session.scope !== "view") return 0;
    const unread = (await this.pool.query("SELECT id FROM notices WHERE submission_id = $1 AND read_at IS NULL AND kind <> 'claimant_reply'", [submissionId])).rows;
    for (const n of unread) {
      await withTransaction(this.pool, async (c) => {
        const r = (await c.query("SELECT read_at FROM notices WHERE id = $1 FOR UPDATE", [n.id])).rows[0];
        if (r.read_at) return;
        const entry = await this.ledger(c, "notice.read", submissionId, { noticeId: n.id, by: session.scope });
        await c.query("UPDATE notices SET read_at = $2, read_ledger_seq = $3 WHERE id = $1", [n.id, entry.recordedAt, entry.seq]);
      });
    }
    return unread.length;
  }
  async notices(submissionId) {
    return (await this.pool.query("SELECT * FROM notices WHERE submission_id = $1 ORDER BY sent_at, id", [submissionId])).rows;
  }
  async deadlines(submissionId) {
    return (await this.pool.query("SELECT * FROM deadlines WHERE submission_id = $1 ORDER BY due_at", [submissionId])).rows.map((d) => ({
      ...d, label: RULES[d.rule_id]?.label ?? d.rule_id, party: CLAIMANT_RULES.has(d.rule_id) ? "claimant" : "agency" }));
  }

  /** Hook after every new (non-replayed) filing: complaint/petition acknowledgement clock and cure relation back. */
  async onFiled(result) {
    const r = result.receipt.receipt;
    await withTransaction(this.pool, async (c) => {
      const s = (await c.query("SELECT filing_type, received_at FROM submissions WHERE id = $1", [result.rootId])).rows[0];
      if (r.kind === "original" && ["complaint", "petition"].includes(s.filing_type))
        await this.#openDeadline(c, result.rootId, "complaint.acknowledge", r.receivedAt, r.ledger.seq);
      if (r.kind !== "amendment") return;
      const defect = (await c.query(`SELECT id, cure_due_at FROM notices WHERE submission_id = $1 AND kind = 'defect' AND cure_outcome IS NULL
        ORDER BY sent_at DESC LIMIT 1 FOR UPDATE`, [result.rootId])).rows[0];
      if (!defect) return;
      const timely = new Date(r.receivedAt) <= defect.cure_due_at;
      const outcome = timely ? "cured_relates_back" : "cured_late";
      const entry = await this.ledger(c, timely ? "filing.cure_related_back" : "filing.cure_late", result.rootId,
        { noticeId: defect.id, curingReceiptId: r.receiptId, originalReceivedAt: s.received_at.toISOString() });
      await c.query("UPDATE notices SET cure_outcome = $2 WHERE id = $1", [defect.id, outcome]);
      await this.#closeDeadlines(c, result.rootId, ["defect.cure"], timely ? "met" : "missed");
      await c.query("INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq) VALUES ($1,'cured',$2,'system',$3,$4)",
        [result.rootId, timely ? `Cured within the cure period; treated as filed on ${s.received_at.toISOString()} (relation back, demonstration rule).`
          : "Cure received after the cure period; no relation back (demonstration rule).", entry.recordedAt, entry.seq]);
    });
  }

  /** Background jobs: deadline misses (incl. tort deemed denial), routing SLA escalation, ledger checkpoints. */
  async runJobs(now = new Date(this.backend.appNow())) {
    let changed = 0;
    const due = (await this.pool.query("SELECT id, submission_id, rule_id FROM deadlines WHERE state = 'open' AND due_at < $1 LIMIT 50", [now])).rows;
    for (const d of due) {
      await withTransaction(this.pool, async (c) => {
        const r = await c.query("UPDATE deadlines SET state = $2, closed_at = clock_timestamp() WHERE id = $1 AND state = 'open'",
          [d.id, CLAIMANT_RULES.has(d.rule_id) ? "cancelled" : "missed"]);
        if (!r.rowCount || CLAIMANT_RULES.has(d.rule_id)) return;
        const entry = await this.ledger(c, "deadline.missed", d.submission_id, { deadlineId: Number(d.id), rule: d.rule_id });
        const deemed = d.rule_id === "tort.agency_decision";
        await c.query("INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq) VALUES ($1,$2,$3,'deadline-engine',$4,$5)",
          [d.submission_id, deemed ? "deemed_denied" : "deadline_missed", deemed ? "No final disposition within the demonstration period; treated as deemed denied." : RULES[d.rule_id]?.label ?? d.rule_id,
            entry.recordedAt, entry.seq]);
        if (deemed) await this.#openDeadline(c, d.submission_id, "tort.suit_window", entry.recordedAt, entry.seq);
        await c.query("INSERT INTO notification_outbox (channel, audience, template, payload) VALUES ('staff-queue', 'role:oversight', 'deadline.missed', $1), ('staff-queue', 'role:intake', 'deadline.missed', $1)",
          [{ submissionId: d.submission_id, rule: d.rule_id }]);
        changed++;
      });
    }
    const overdue = (await this.pool.query(`SELECT o.submission_id FROM routing_outbox o WHERE o.state = 'pending' AND o.due_by < $1
      AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.submission_id = o.submission_id AND e.kind = 'routing_overdue') LIMIT 50`, [now])).rows;
    for (const o of overdue) {
      await withTransaction(this.pool, async (c) => {
        const ins = await c.query("INSERT INTO escalations (submission_id, kind, ref) VALUES ($1, 'routing_overdue', 'sla') ON CONFLICT DO NOTHING", [o.submission_id]);
        if (!ins.rowCount) return;
        const entry = await this.ledger(c, "routing.overdue", o.submission_id, {});
        await c.query("INSERT INTO status_events (submission_id, status, note, actor, at, ledger_seq) VALUES ($1,'routing_overdue','Routing SLA exceeded; escalated. The receipt is unaffected.','routing-sla',$2,$3)",
          [o.submission_id, entry.recordedAt, entry.seq]);
        await c.query("INSERT INTO notification_outbox (channel, audience, template, payload) VALUES ('staff-queue', 'role:intake', 'routing.overdue', $1), ('staff-queue', 'role:oversight', 'routing.overdue', $1)",
          [{ submissionId: o.submission_id }]);
        changed++;
      });
    }
    await this.checkpoint(now);
    return changed;
  }

  /** UFR-049: periodically sign the ledger head so third parties can detect history rewrites (split views, truncation). */
  async checkpoint(now = new Date(this.backend.appNow()), { force = false } = {}) {
    const head = (await this.pool.query("SELECT seq, entry_hash FROM ledger_head WHERE id = 1")).rows[0];
    if (Number(head.seq) === 0) return null;
    const last = (await this.pool.query("SELECT seq, created_at FROM ledger_checkpoints ORDER BY seq DESC LIMIT 1")).rows[0];
    if (last && Number(last.seq) === Number(head.seq)) return null;
    if (!force && last && now - last.created_at < CHECKPOINT_MINUTES * 60_000) return null;
    const body = { schema: "ufr-demo-ledger-checkpoint-v1", demo: true, seq: Number(head.seq), headHash: head.entry_hash, createdAt: now.toISOString() };
    await this.pool.query("INSERT INTO ledger_checkpoints (seq, head_hash, created_at, key_id, signature) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [body.seq, body.headHash, body.createdAt, this.backend.signer.keyId, this.backend.signer.sign(body)]);
    return body;
  }
  async checkpoints(limit = 50) {
    return (await this.pool.query("SELECT seq, head_hash, created_at, key_id, signature FROM ledger_checkpoints ORDER BY seq DESC LIMIT $1", [limit])).rows
      .map((r) => ({ checkpoint: { schema: "ufr-demo-ledger-checkpoint-v1", demo: true, seq: Number(r.seq), headHash: r.head_hash, createdAt: r.created_at.toISOString() },
        signature: { alg: "EdDSA", keyId: r.key_id, value: r.signature } }));
  }
}
