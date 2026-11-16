import test from "node:test";
import assert from "node:assert/strict";
import { dbTestOptions } from "./helpers/db.mjs";
import { buildApp, field, fileAndLogin, filingForm, FORM, form, get, post, staffLogin } from "./helpers/app.mjs";
import { verifyLedger } from "../src/demo/ledger.mjs";

const opts = dbTestOptions();

/** UFR-054 adversarial and insider-threat tests (automated; complements, not replaces, independent testing). */
test("outsider attacks: IDOR, forged sessions, CSRF, injection, enumeration", opts, async (t) => {
  const { base, pool } = await buildApp(t);
  const a = await fileAndLogin(base, { title: "Alice synthetic" });
  const b = await fileAndLogin(base, { title: "Bob synthetic" });
  const bReceipt = (await (await get(base, "/track/case", b.cookie)).text()).match(/(RCPT-DEMO-[0-9A-Z]{20})/)[1];
  assert.equal((await get(base, `/track/receipts/${bReceipt}.json`, a.cookie)).status, 404, "no cross-claimant receipt access");
  // Forged / tampered session cookies.
  const [name, value] = a.cookie.split("=");
  const [body, sig] = value.split(".");
  const forgedBody = Buffer.from(JSON.stringify({ k: "p", s: "00000000-0000-0000-0000-000000000000|owner|", e: Date.now() + 1e6, n: "x" })).toString("base64url");
  assert.equal((await get(base, "/track/case", `${name}=${forgedBody}.${sig}`)).status, 303);
  assert.equal((await get(base, "/staff", `ufr_staff=${body}.${sig}`)).status, 200, "participant cookie body reused as staff is refused (login page)");
  assert.doesNotMatch(await (await get(base, "/staff", `ufr_staff=${body}.${sig}`)).text(), /Filing queue/);
  // CSRF: missing token, foreign origin, cookie without token.
  assert.equal((await post(base, "/track/corrections", form({ kind: "withdrawal", statement: "x" }), { cookie: a.cookie, type: FORM })).status, 403);
  assert.equal((await post(base, "/track/corrections", form({ kind: "withdrawal", statement: "x" }), { cookie: a.cookie, type: FORM, origin: "https://evil.example" })).status, 403);
  // Injection-shaped input is stored inert and rendered escaped.
  const evil = "'); DROP TABLE submissions; -- <img src=x onerror=alert(1)>";
  const c = await fileAndLogin(base, { title: evil });
  assert.ok(c.tracking);
  assert.equal(Number((await pool.query("SELECT count(*) FROM submissions")).rows[0].count), 3);
  assert.doesNotMatch(await (await get(base, "/track/case", c.cookie)).text(), /<img src=x/);
  // Tracking-number enumeration: identical, non-distinguishing failures.
  const wrong1 = await post(base, "/track", form({ trackingNumber: a.tracking, accessCode: "AAAABBBBCCCCDDDDEEEEFFFF" }), { type: FORM });
  const wrong2 = await post(base, "/track", form({ trackingNumber: "DEMO-ZZZZ-ZZZZ-ZZZZ", accessCode: "AAAABBBBCCCCDDDDEEEEFFFF" }), { type: FORM });
  assert.equal(wrong1.status, wrong2.status);
  assert.equal((await wrong1.text()).replace(/\s+/g, ""), (await wrong2.text()).replace(/\s+/g, ""));
});

test("insider attacks: privileged tampering is blocked or detected; role boundaries hold", opts, async (t) => {
  const { base, pool, backend, workflows } = await buildApp(t);
  await fileAndLogin(base, {}, [{ content: "%PDF-1.4 synthetic", type: "application/pdf", name: "a.pdf" }]);
  await workflows.checkpoint(new Date(), { force: true });
  // An insider with SQL access cannot rewrite originals, receipts, vaults or the ledger through normal statements...
  for (const sql of ["UPDATE submissions SET received_at = now() - interval '30 days'", "DELETE FROM receipts", "UPDATE identity_vault SET sealed = '\\x00'",
    "UPDATE content_vault SET sealed = '\\x00'", "DELETE FROM ledger_entries", "UPDATE scan_results SET verdict = 'clean'", "DELETE FROM ledger_checkpoints"])
    await assert.rejects(pool.query(sql), /append-only/, sql);
  // ...and a superuser who disables triggers to backdate a receipt is caught by signature and chain checks.
  const receipt = (await pool.query("SELECT document FROM receipts LIMIT 1")).rows[0].document;
  const backdated = structuredClone(receipt); backdated.receipt.receivedAt = "2020-01-01T00:00:00.000Z";
  assert.equal((await backend.verifyReceipt(backdated)).valid, false);
  await pool.query("ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_append_only");
  await pool.query("UPDATE ledger_entries SET payload = payload || '{\"agencyId\":\"other\"}' WHERE seq = 1");
  assert.equal((await verifyLedger(pool)).valid, false);
  await pool.query("ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_append_only");
  // A staff member cannot change their own roles, and a disabled account loses access immediately.
  const admin = await staffLogin(base);
  const csrf = field(await (await get(base, "/staff/admin/users", admin.cookie)).text(), "csrf");
  await post(base, "/staff/admin/users", form({ csrf, username: "insider", password: "synthetic-password-insider", roles: "intake" }), { cookie: admin.cookie, type: FORM });
  const insider = await staffLogin(base, "insider", "synthetic-password-insider");
  assert.equal((await get(base, "/staff/admin/users", insider.cookie)).status, 403);
  assert.equal((await get(base, "/staff/oversight", insider.cookie)).status, 403);
  assert.equal((await get(base, "/staff/records", insider.cookie)).status, 403);
  const id = (await pool.query("SELECT id FROM staff_users WHERE username = 'insider'")).rows[0].id;
  await post(base, `/staff/admin/users/${id}/disable`, form({ csrf }), { cookie: admin.cookie, type: FORM });
  assert.doesNotMatch(await (await get(base, "/staff", insider.cookie)).text(), /Filing queue/);
  // Staff cannot approve their own identity reveal even as admin (dual control is enforced in the database too).
  await assert.rejects(pool.query(`INSERT INTO reveal_requests (id, submission_id, requested_by, reason, approved_by)
    SELECT gen_random_uuid(), s.id, u.id, 'x', u.id FROM submissions s, staff_users u LIMIT 1`), /check/i);
  assert.ok(filingForm);
});
