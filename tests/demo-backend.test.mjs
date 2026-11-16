import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dbTestOptions, freshPool } from "./helpers/db.mjs";
import { LocalIntakeBackend, IntakeError } from "../src/demo/backend.mjs";
import { generateSigningKeyEncoded, loadSigningKey } from "../src/demo/signing.mjs";
import { verifyReceiptDocument } from "../src/demo/receipt.mjs";
import { verifyLedger } from "../src/demo/ledger.mjs";
import { migrate } from "../src/demo/db.mjs";

const opts = dbTestOptions();
const key = () => "k" + randomBytes(12).toString("hex");
const filing = (over = {}) => ({ agencyId: "demo-records-access-unit", filingType: "records-request",
  title: "Synthetic records request", body: "Please provide synthetic records for testing.",
  claimantName: "Test Person", claimantContact: "", idempotencyKey: key(), documents: [], ...over });
const pdf = Buffer.from("%PDF-1.4\n% synthetic test document\n");

async function setup(t) {
  const pool = await freshPool(t);
  const signer = loadSigningKey(generateSigningKeyEncoded());
  return { pool, backend: new LocalIntakeBackend({ pool, signer }) };
}

test("filing issues a signed, ledger-anchored demo receipt atomically", opts, async (t) => {
  const { pool, backend } = await setup(t);
  const out = await backend.fileSubmission(filing({ documents: [{ filename: "a.pdf", mediaType: "application/pdf", content: pdf }] }));
  assert.match(out.trackingNumber, /^DEMO-/);
  assert.match(out.accessCode, /^[0-9A-Z]{24}$/);
  assert.equal(out.receipt.receipt.demo, true);
  assert.match(out.receipt.receipt.notice, /Not issued by or on behalf of the United States Government/);
  assert.equal(out.receipt.receipt.manifest.partCount, 2);
  assert.deepEqual(verifyReceiptDocument(out.receipt, backend.publicKeys()), { valid: true });
  const v = await backend.verifyReceipt(out.receipt);
  assert.equal(v.valid, true);
  assert.equal((await verifyLedger(pool)).valid, true);
  for (const table of ["submissions", "documents", "manifests", "receipts", "routing_outbox", "status_events"])
    assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count), 1, table);
});

test("idempotent retries return the same receipt; conflicting reuse is rejected", opts, async (t) => {
  const { pool, backend } = await setup(t);
  const input = filing();
  const [a, b] = await Promise.all([backend.fileSubmission(input), backend.fileSubmission(input)]);
  assert.equal(a.receipt.receipt.receiptId, b.receipt.receipt.receiptId);
  assert.equal([a, b].filter((x) => x.replayed).length, 1);
  assert.equal([a, b].find((x) => x.replayed).accessCode, null);
  await assert.rejects(backend.fileSubmission({ ...input, body: "different" }), (e) => e.code === "idempotency_conflict");
  assert.equal(Number((await pool.query("SELECT count(*) FROM submissions")).rows[0].count), 1);
});

test("originals, receipts and ledger entries are append-only in the database", opts, async (t) => {
  const { pool, backend } = await setup(t);
  await backend.fileSubmission(filing({ documents: [{ filename: "a.pdf", mediaType: "application/pdf", content: pdf }] }));
  for (const sql of ["UPDATE submissions SET title = 'x'", "DELETE FROM receipts", "UPDATE ledger_entries SET subject = 'x'",
    "DELETE FROM documents", "UPDATE manifests SET sha256 = repeat('0',64)", "TRUNCATE ledger_entries CASCADE"])
    await assert.rejects(pool.query(sql), /append-only/, sql);
});

test("tampering is detected by signature, ledger cross-check and chain verification", opts, async (t) => {
  const { pool, backend } = await setup(t);
  const out = await backend.fileSubmission(filing());
  const forged = structuredClone(out.receipt); forged.receipt.receivedAt = "2020-01-01T00:00:00.000Z";
  assert.equal((await backend.verifyReceipt(forged)).reason, "bad_signature");
  const otherKey = new LocalIntakeBackend({ pool, signer: loadSigningKey(generateSigningKeyEncoded()) });
  assert.equal((await otherKey.verifyReceipt(out.receipt)).reason, "unknown_key");
  // A forged receipt signed with the real key but pointing at a different ledger entry.
  await backend.fileSubmission(filing());
  const second = await backend.fileSubmission(filing());
  const resigned = structuredClone(second.receipt.receipt); resigned.ledger.seq = 1;
  const doc = { receipt: resigned, signature: { alg: "EdDSA", keyId: backend.signer.keyId, value: backend.signer.sign(resigned) } };
  assert.equal((await backend.verifyReceipt(doc)).reason, "not_in_ledger");
  // Break the chain with privileged access (disabling triggers) and confirm detection.
  await pool.query("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only");
  await pool.query("UPDATE ledger_entries SET subject = 'tampered' WHERE seq = 2");
  assert.deepEqual((await verifyLedger(pool)).failure, { seq: 2, reason: "entry_hash_mismatch" });
});

test("participant access needs tracking number and access code; amendments never alter originals", opts, async (t) => {
  const { pool, backend } = await setup(t);
  const out = await backend.fileSubmission(filing());
  assert.equal(await backend.openParticipant(out.trackingNumber, "WRONGWRONGWRONGWRONGWRON"), null);
  assert.equal(await backend.openParticipant("DEMO-0000-0000-0000", out.accessCode), null);
  assert.equal(await backend.openParticipant(out.trackingNumber, ""), null);
  const root = await backend.openParticipant(out.trackingNumber.toLowerCase(), out.accessCode.toLowerCase());
  assert.equal(root, out.submissionId);
  const amend = await backend.fileSubmission(filing({ title: "Supplement", body: "Additional synthetic detail." }), { parentRootId: root });
  assert.equal(amend.receipt.receipt.kind, "amendment");
  assert.equal(amend.receipt.receipt.amends, out.receipt.receipt.receiptId);
  assert.equal(amend.accessCode, null);
  assert.equal(await backend.openParticipant(amend.trackingNumber, out.accessCode), root);
  await assert.rejects(backend.fileSubmission(filing({ agencyId: "demo-tort-claims-desk", filingType: "general-correspondence" }),
    { parentRootId: root }), (e) => e.code === "amendment_agency_mismatch");
  const view = await backend.participantView(root);
  assert.equal(view.filings.length, 2);
  assert.equal((await pool.query("SELECT title FROM submissions WHERE id = $1", [root])).rows[0].title, "Synthetic records request");
});

test("routing delivers to the fictional inbox, retries failures and dead-letters without touching the receipt", opts, async (t) => {
  const { pool, backend } = await setup(t);
  const ok = await backend.fileSubmission(filing());
  assert.equal(await backend.deliverDueRoutings(), 1);
  const view = await backend.participantView(ok.submissionId);
  assert.equal(view.filings[0].routing, "delivered");
  assert.match(view.filings[0].acknowledgement, /^DEMO-ACK-/);
  assert.equal(view.filings[0].status, "routed");
  const fail = await backend.fileSubmission(filing());
  backend.maxRoutingAttempts = 2;
  const boom = async () => { throw new Error("synthetic outage"); };
  assert.equal(await backend.deliverDueRoutings({ deliver: boom }), 0);
  await pool.query("UPDATE routing_outbox SET next_attempt_at = clock_timestamp() WHERE submission_id = $1", [fail.submissionId]);
  await backend.deliverDueRoutings({ deliver: boom });
  const row = (await pool.query("SELECT state, attempts FROM routing_outbox WHERE submission_id = $1", [fail.submissionId])).rows[0];
  assert.deepEqual(row, { state: "dead", attempts: 2 });
  assert.equal((await backend.verifyReceipt(fail.receipt)).valid, true);
  assert.equal((await backend.participantView(fail.submissionId)).filings[0].status, "routing_escalated");
  assert.equal((await verifyLedger(pool)).valid, true);
});

test("validation rejects unsafe input before any write", opts, async (t) => {
  const { pool, backend } = await setup(t);
  const bad = [
    [{ agencyId: "real-agency" }, "invalid_agency"],
    [{ filingType: "tort-claim-notice" }, "invalid_filing_type"],
    [{ title: "" }, "invalid_title"],
    [{ body: "x".repeat(20_001) }, "invalid_body"],
    [{ title: "bad\u0000" }, "invalid_title"],
    [{ idempotencyKey: "short" }, "invalid_idempotency_key"],
    [{ documents: [{ filename: "x.pdf", mediaType: "application/pdf", content: Buffer.from("MZ not a pdf") }] }, "file_content_mismatch"],
    [{ documents: [{ filename: "x.exe", mediaType: "application/x-msdownload", content: Buffer.from("MZ") }] }, "unsupported_file_type"],
    [{ documents: Array(4).fill({ filename: "a.pdf", mediaType: "application/pdf", content: pdf }) }, "too_many_files"],
  ];
  for (const [over, code] of bad)
    await assert.rejects(backend.fileSubmission(filing(over)), (e) => e instanceof IntakeError && e.code === code, code);
  assert.equal(Number((await pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count), 0);
});

test("staff status changes are ledgered and migrations are idempotent", opts, async (t) => {
  const { pool, backend } = await setup(t);
  const out = await backend.fileSubmission(filing());
  await backend.recordStatus(out.submissionId, "under_review", "Synthetic review note", "staff:demo");
  await assert.rejects(backend.recordStatus(out.submissionId, "deleted", "", "staff:demo"), (e) => e.code === "invalid_status");
  const s = await backend.staffSubmission(out.submissionId);
  assert.equal(s.history.at(-1).status, "under_review");
  assert.deepEqual(await migrate(pool), []);
  assert.equal((await verifyLedger(pool)).checked, 2);
  assert.equal(await backend.allow("t", 2, 60), true);
  assert.equal(await backend.allow("t", 2, 60), true);
  assert.equal(await backend.allow("t", 2, 60), false);
});
