import test from "node:test";
import assert from "node:assert/strict";
import { dbTestOptions } from "./helpers/db.mjs";
import { buildApp, field, fileAndLogin, FORM, form, get, post, staffCsrf, staffLogin } from "./helpers/app.mjs";
import { addBusinessDays, computeDeadline, endOfEasternDay, extendForTolling, federalHolidays, isBusinessDay } from "../src/platform/deadlines.mjs";
import { verifySignature } from "../src/demo/signing.mjs";
import { verifyLedger } from "../src/demo/ledger.mjs";

const opts = dbTestOptions();

test("deadline engine: holidays with observance, business days, roll-forward, DST-aware end of day, tolling", () => {
  assert.ok(federalHolidays(2026).has("2026-07-03"), "July 4 2026 (Sat) observed Fri");
  assert.ok(federalHolidays(2027).has("2027-12-31"), "Jan 1 2028 (Sat) observed Dec 31 2027");
  assert.ok(federalHolidays(2026).has("2026-11-26"), "Thanksgiving");
  assert.equal(isBusinessDay("2026-11-26"), false);
  assert.equal(addBusinessDays("2026-11-25", 1), "2026-11-27");
  assert.equal(computeDeadline("records.response", "2026-11-16T15:00:00Z").dueDate, "2026-12-15");
  assert.equal(computeDeadline("tort.agency_decision", "2026-08-31T15:00:00Z").dueDate, "2027-03-01", "Feb 28 2027 is a Sunday");
  assert.equal(computeDeadline("records.response", "2026-11-17T03:30:00Z").startDate, "2026-11-16", "Eastern calendar date");
  assert.equal(endOfEasternDay("2026-07-01").toISOString(), "2026-07-02T03:59:59.999Z");
  assert.equal(endOfEasternDay("2026-12-01").toISOString(), "2026-12-02T04:59:59.999Z");
  assert.equal(extendForTolling("2026-12-15", "2026-11-20T15:00:00Z", "2026-11-30T15:00:00Z").tolledBusinessDays, 5);
  assert.throws(() => computeDeadline("unknown.rule", new Date()));
});

async function setup(t, filing) {
  const app = await buildApp(t);
  const f = await fileAndLogin(app.base, filing);
  const s = await staffLogin(app.base);
  const id = (await app.pool.query("SELECT id FROM submissions WHERE kind = 'original' LIMIT 1")).rows[0].id;
  const csrf = await staffCsrf(app.base, s.cookie, `/staff/submissions/${id}`);
  const step = (to, note = "") => post(app.base, `/staff/submissions/${id}/transition`, form({ csrf, to, note }), { cookie: s.cookie, type: FORM });
  const notice = (kind, body) => post(app.base, `/staff/submissions/${id}/notice`, form({ csrf, kind, body }), { cookie: s.cookie, type: FORM });
  return { ...app, f, s, id, step, notice };
}

test("records workflow: acknowledgement notice and clock, tolling, determination, appeal window, read receipts", opts, async (t) => {
  const { base, pool, f, id, step, notice } = await setup(t, { filingType: "records-request", agencyId: "demo-records-access-unit" });
  assert.equal((await step("determination_denial")).status, 409, "state machine enforced");
  assert.equal((await step("acknowledged", "We have your synthetic request.")).status, 303);
  let d = (await pool.query("SELECT rule_id, state, due_date FROM deadlines WHERE submission_id = $1", [id])).rows;
  assert.deepEqual(d.map((x) => [x.rule_id, x.state]), [["records.response", "open"]]);
  const due0 = d[0].due_date.toISOString().slice(0, 10);
  assert.equal((await notice("information_request", "Please clarify the synthetic date range.")).status, 303);
  assert.equal((await pool.query("SELECT state FROM deadlines WHERE submission_id = $1", [id])).rows[0].state, "tolled");
  assert.equal((await step("processing")).status, 303);
  d = (await pool.query("SELECT state, due_date FROM deadlines WHERE submission_id = $1", [id])).rows[0];
  assert.equal(d.state, "open");
  assert.ok(d.due_date.toISOString().slice(0, 10) >= due0, "tolling never shortens the clock");
  assert.equal((await step("determination_partial_grant", "Synthetic partial release.")).status, 303);
  const rules = (await pool.query("SELECT rule_id, state FROM deadlines WHERE submission_id = $1 ORDER BY id", [id])).rows.map((r) => `${r.rule_id}:${r.state}`);
  assert.deepEqual(rules, ["records.response:met", "records.appeal_window:open"]);
  // Claimant view lists notices and records read receipts in the ledger.
  const caseHtml = await (await get(base, "/track/case", f.cookie)).text();
  assert.match(caseHtml, /Please clarify the synthetic date range/);
  assert.match(caseHtml, /Deadlines \(demonstration estimates\)/);
  const unread = Number((await pool.query("SELECT count(*) FROM notices WHERE submission_id = $1 AND read_at IS NULL", [id])).rows[0].count);
  assert.equal(unread, 0);
  assert.ok(Number((await pool.query("SELECT count(*) FROM ledger_entries WHERE event_type = 'notice.read'")).rows[0].count) >= 3);
  await post(base, "/track/reply", form({ csrf: field(caseHtml, "csrf"), body: "Synthetic reply." }), { cookie: f.cookie, type: FORM });
  assert.equal((await pool.query("SELECT author FROM notices WHERE kind = 'claimant_reply'")).rows[0].author, "claimant");
});

test("defect notice and cure: a timely supplement relates back; a late one does not", opts, async (t) => {
  const { base, pool, f, id, notice } = await setup(t, { filingType: "administrative-claim" });
  assert.equal((await notice("defect", "Synthetic defect: missing signature line.")).status, 303);
  assert.equal((await pool.query("SELECT state FROM deadlines WHERE rule_id = 'defect.cure'")).rows[0].state, "open");
  const caseHtml = await (await get(base, "/track/case", f.cookie)).text();
  const { filingForm } = await import("./helpers/app.mjs");
  const fd = filingForm(field(caseHtml, "idempotencyKey"), { csrf: field(caseHtml, "csrf"), title: "Cure", body: "Signature line added." });
  assert.equal((await post(base, "/track/amend", fd, { cookie: f.cookie })).status, 303);
  const n = (await pool.query("SELECT cure_outcome FROM notices WHERE kind = 'defect'")).rows[0];
  assert.equal(n.cure_outcome, "cured_relates_back");
  const ev = (await pool.query("SELECT payload FROM ledger_entries WHERE event_type = 'filing.cure_related_back'")).rows[0].payload;
  const received = (await pool.query("SELECT received_at FROM submissions WHERE id = $1", [id])).rows[0].received_at.toISOString();
  assert.equal(ev.originalReceivedAt, received);
  assert.equal((await pool.query("SELECT state FROM deadlines WHERE rule_id = 'defect.cure'")).rows[0].state, "met");
  // Late cure: second defect notice with its cure deadline already passed.
  await notice("defect", "Second synthetic defect.");
  await pool.query("UPDATE notices SET cure_due_at = now() - interval '1 day' WHERE cure_outcome IS NULL");
  const html2 = await (await get(base, "/track/case", f.cookie)).text();
  await post(base, "/track/amend", filingForm(field(html2, "idempotencyKey"), { csrf: field(html2, "csrf"), title: "Late cure" }), { cookie: f.cookie });
  assert.equal((await pool.query("SELECT cure_outcome FROM notices WHERE kind = 'defect' ORDER BY sent_at DESC LIMIT 1")).rows[0].cure_outcome, "cured_late");
});

test("tort claim: deemed denial on a missed agency clock, routing SLA escalation, signed checkpoints", opts, async (t) => {
  const { pool, workflows, id, step, backend } = await setup(t, { filingType: "tort-claim-notice", agencyId: "demo-tort-claims-desk", title: "Synthetic fender bender" });
  await step("acknowledged");
  const future = new Date(Date.now() + 200 * 86_400_000);
  assert.ok(await workflows.runJobs(future) >= 2, "deadline missed + routing overdue");
  const statuses = (await pool.query("SELECT status FROM status_events WHERE submission_id = $1 ORDER BY id", [id])).rows.map((r) => r.status);
  assert.ok(statuses.includes("deemed_denied"));
  assert.ok(statuses.includes("routing_overdue"));
  assert.deepEqual((await pool.query("SELECT rule_id, state FROM deadlines WHERE submission_id = $1 ORDER BY id", [id])).rows.map((r) => `${r.rule_id}:${r.state}`),
    ["tort.agency_decision:missed", "tort.suit_window:open"]);
  assert.equal(await workflows.runJobs(future), 0, "escalations are idempotent");
  const cp = await workflows.checkpoint(new Date(), { force: true }) ?? (await workflows.checkpoints(1))[0].checkpoint;
  const [signed] = await workflows.checkpoints(1);
  assert.equal(signed.checkpoint.seq, cp.seq);
  assert.ok(verifySignature(backend.publicKeys()[0], signed.checkpoint, signed.signature.value));
  const head = (await pool.query("SELECT entry_hash FROM ledger_entries WHERE seq = $1", [signed.checkpoint.seq])).rows[0].entry_hash;
  assert.equal(signed.checkpoint.headHash, head);
  assert.equal((await verifyLedger(pool)).valid, true);
});
