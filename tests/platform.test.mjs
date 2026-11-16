import test from "node:test";
import assert from "node:assert/strict";
import { dbTestOptions } from "./helpers/db.mjs";
import { ADMIN, buildApp, cookieOf, field, fileAndLogin, FORM, form, get, post, staffCsrf, staffLogin } from "./helpers/app.mjs";
import { totpAt, verifyTotp, scanDocument, detectClassifiedMarking, newTotpSecret } from "../src/platform/safety.mjs";
import { verifyLedger } from "../src/demo/ledger.mjs";

const opts = dbTestOptions();
const pdf = "%PDF-1.4 synthetic\n";

test("safety primitives: TOTP vectors and replay, scanner verdicts, classified markings", () => {
  // RFC 6238 SHA-1 test secret "12345678901234567890" in base32.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpAt(secret, Math.floor(59 / 30)), "287082");
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), "081804");
  const now = 1_763_300_000_000; const step = Math.floor(now / 30_000);
  assert.equal(verifyTotp(secret, totpAt(secret, step), now), step);
  assert.equal(verifyTotp(secret, totpAt(secret, step), now, step), null, "replay of the same step is refused");
  assert.equal(verifyTotp(secret, totpAt(secret, step - 3), now), null);
  assert.match(newTotpSecret(), /^[A-Z2-7]{20}$/);
  assert.equal(scanDocument("text/plain", Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")).verdict, "infected");
  assert.equal(scanDocument("application/pdf", Buffer.from("%PDF-1.4 /OpenAction << /JS (app.alert(1)) >>")).verdict, "suspicious");
  assert.equal(scanDocument("application/pdf", Buffer.from(pdf)).verdict, "clean");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IEND"), Buffer.alloc(4), Buffer.alloc(200, 65)]);
  assert.equal(scanDocument("image/png", png).verdict, "suspicious");
  for (const t of ["TOP SECRET//NOFORN", "(S//REL TO USA) para", "SECRET//ORCON", "Classified By: x", "Declassify On: 20451231", "UNCLASSIFIED//FOUO text // NOFORN"])
    assert.ok(detectClassifiedMarking(t), t);
  for (const t of ["My secret recipe", "This is confidential between us", "top secret plan for a party", "UNCLASSIFIED"])
    assert.equal(detectClassifiedMarking(t), null, t);
});

test("encryption at rest, scanning/quarantine, emergency ordering and classified refusal", opts, async (t) => {
  const { base, pool } = await buildApp(t);
  const evil = "%PDF-1.4 /OpenAction << /JS (app.alert(1)) >>";
  const a = await fileAndLogin(base, { emergency: "yes", title: "Urgent synthetic matter" }, [{ content: pdf, type: "application/pdf", name: "ok.pdf" }, { content: evil, type: "application/pdf", name: "bad.pdf" }]);
  assert.ok(a.cookie);
  const row = (await pool.query("SELECT claimant_name, claimant_contact, body, identity_protected, emergency FROM submissions LIMIT 1")).rows[0];
  assert.deepEqual(row, { claimant_name: "[protected]", claimant_contact: "", body: "[encrypted]", identity_protected: true, emergency: true });
  const docs = (await pool.query("SELECT content, encryption FROM documents ORDER BY ordinal")).rows;
  assert.ok(docs.every((d) => d.encryption === "aes-256-gcm-envelope" && !d.content.toString("latin1").includes("%PDF")));
  const vault = (await pool.query("SELECT sealed FROM identity_vault")).rows[0].sealed.toString("latin1");
  assert.doesNotMatch(vault, /Pat Example/);
  await fileAndLogin(base, { title: "Ordinary synthetic matter" });
  const s = await staffLogin(base);
  const queue = await (await get(base, "/staff", s.cookie)).text();
  assert.ok(queue.indexOf("Urgent synthetic matter") < queue.indexOf("Ordinary synthetic matter"), "emergency first");
  assert.match(queue, /EMERGENCY/);
  const id = queue.match(/\/staff\/submissions\/([0-9a-f-]{36})/)[1];
  const detail = await (await get(base, `/staff/submissions/${id}`, s.cookie)).text();
  assert.match(detail, /Synthetic claim text\./, "staff see decrypted body");
  assert.match(detail, /QUARANTINED: suspicious/);
  assert.doesNotMatch(detail, /Pat Example/, "identity hidden without dual-control reveal");
  const docIds = [...detail.matchAll(/\/staff\/documents\/([0-9a-f-]{36})/g)].map((m) => m[1]);
  assert.equal(docIds.length, 1, "only the clean document is linked");
  assert.equal(await (await get(base, `/staff/documents/${docIds[0]}`, s.cookie)).text(), pdf);
  const badId = (await pool.query("SELECT id FROM documents WHERE filename = 'bad.pdf'")).rows[0].id;
  assert.equal((await get(base, `/staff/documents/${badId}`, s.cookie)).status, 423);
  // Classified marking: refused, nothing stored, content-free ledger event.
  const before = Number((await pool.query("SELECT count(*) FROM submissions")).rows[0].count);
  const key = field(await (await fetch(base + "/file")).text(), "idempotencyKey");
  const { filingForm } = await import("./helpers/app.mjs");
  const res = await post(base, "/file", filingForm(key, { body: "Please review: SECRET//NOFORN attachment summary" }));
  assert.equal(res.status, 422);
  assert.match(await res.text(), /not saved/);
  assert.equal(Number((await pool.query("SELECT count(*) FROM submissions")).rows[0].count), before);
  const ev = (await pool.query("SELECT payload FROM ledger_entries WHERE event_type = 'intake.classified_marking_refused'")).rows[0].payload;
  assert.deepEqual(Object.keys(ev), ["rule"]);
});

test("staff accounts: roles, MFA enrollment, lockout, agency scoping and dual-control identity reveal", opts, async (t) => {
  const { base, platform, pool } = await buildApp(t);
  const filing = await fileAndLogin(base, { claimantName: "Rae Synthetic" });
  const admin = await staffLogin(base);
  let csrf = await staffCsrf(base, admin.cookie, "/staff/admin/users");
  for (const [u, roles] of [["intake1", "intake"], ["privacy1", "privacy_officer"], ["agency1", "agency:demo-records-access-unit"], ["records1", "records_officer"]])
    assert.equal((await post(base, "/staff/admin/users", form({ csrf, username: u, password: "synthetic-password-" + u, roles }), { cookie: admin.cookie, type: FORM })).status, 303);
  assert.equal((await post(base, "/staff/admin/users", form({ csrf, username: "weak", password: "short", roles: "intake" }), { cookie: admin.cookie, type: FORM })).status, 400);
  // Agency-scoped user cannot see another agency's filing.
  const ag = await staffLogin(base, "agency1", "synthetic-password-agency1");
  assert.doesNotMatch(await (await get(base, "/staff", ag.cookie)).text(), /submissions\//);
  const id = (await pool.query("SELECT id FROM submissions LIMIT 1")).rows[0].id;
  assert.equal((await get(base, `/staff/submissions/${id}`, ag.cookie)).status, 403);
  // Intake requests a reveal; the same person cannot approve; privacy officer approves; requester views once.
  const intake = await staffLogin(base, "intake1", "synthetic-password-intake1");
  csrf = await staffCsrf(base, intake.cookie, `/staff/submissions/${id}`);
  assert.equal((await post(base, `/staff/submissions/${id}/reveal`, form({ csrf, reason: "Synthetic verification" }), { cookie: intake.cookie, type: FORM })).status, 303);
  const reqId = (await pool.query("SELECT id FROM reveal_requests")).rows[0].id;
  assert.equal((await post(base, `/staff/reveals/${reqId}/approve`, form({ csrf }), { cookie: intake.cookie, type: FORM })).status, 403);
  const priv = await staffLogin(base, "privacy1", "synthetic-password-privacy1");
  const pcsrf = await staffCsrf(base, priv.cookie, "/staff/reveals");
  assert.equal((await post(base, `/staff/reveals/${reqId}/approve`, form({ csrf: pcsrf }), { cookie: priv.cookie, type: FORM })).status, 303);
  assert.equal((await post(base, `/staff/reveals/${reqId}/view`, form({ csrf: pcsrf }), { cookie: priv.cookie, type: FORM })).status, 403, "only the requester");
  const view = await post(base, `/staff/reveals/${reqId}/view`, form({ csrf }), { cookie: intake.cookie, type: FORM });
  assert.match(await view.text(), /Rae Synthetic/);
  assert.equal((await post(base, `/staff/reveals/${reqId}/view`, form({ csrf }), { cookie: intake.cookie, type: FORM })).status, 403, "one-time");
  const events = (await pool.query("SELECT event_type FROM ledger_entries WHERE event_type LIKE 'identity.%' ORDER BY seq")).rows.map((r) => r.event_type);
  assert.deepEqual(events, ["identity.reveal_requested", "identity.reveal_approved", "identity.revealed"]);
  // MFA enrollment and login with TOTP; replayed code rejected.
  const icsrf = await staffCsrf(base, intake.cookie, "/staff/mfa");
  await post(base, "/staff/mfa/begin", form({ csrf: icsrf }), { cookie: intake.cookie, type: FORM });
  const secret = (await pool.query("SELECT totp_secret FROM staff_users WHERE username = 'intake1'")).rows[0].totp_secret;
  const code = totpAt(secret, Math.floor(Date.now() / 30_000));
  assert.equal((await post(base, "/staff/mfa/confirm", form({ csrf: icsrf, code }), { cookie: intake.cookie, type: FORM })).status, 303);
  assert.equal((await staffLogin(base, "intake1", "synthetic-password-intake1")).status, 401, "MFA required");
  assert.equal((await staffLogin(base, "intake1", "synthetic-password-intake1", code)).status, 401, "replayed code refused");
  // Lockout after five failures, even with the right password afterwards.
  for (let i = 0; i < 5; i++) await staffLogin(base, "records1", "wrong-password-xxxxxxx");
  assert.equal((await staffLogin(base, "records1", "synthetic-password-records1")).status, 401);
  assert.ok((await pool.query("SELECT locked_until FROM staff_users WHERE username = 'records1'")).rows[0].locked_until);
  assert.equal((await verifyLedger(pool)).valid, true);
  assert.ok(filing.tracking);
  assert.ok(platform);
});

test("drafts, delegation, corrections with signed notice, withdrawal, legal hold and crypto-shred disposition", opts, async (t) => {
  const { base, pool, platform, backend } = await buildApp(t);
  // Draft save and resume (text only).
  const fd = new FormData();
  for (const [k, v] of Object.entries({ action: "draft", idempotencyKey: "draft-key-0000000001", agencyId: "demo-tort-claims-desk", filingType: "tort-claim-notice", title: "Draft synthetic", body: "Draft body", claimantName: "D" })) fd.append(k, v);
  const saved = await post(base, "/file", fd);
  assert.equal(saved.status, 201);
  const draftCode = (await saved.text()).match(/Draft code: <code class="big">([0-9A-Z-]+)<\/code>/)[1];
  assert.equal(Number((await pool.query("SELECT count(*) FROM submissions")).rows[0].count), 0, "a draft files nothing");
  const resumed = await (await post(base, "/file/resume", form({ draftCode }), { type: FORM })).text();
  assert.match(resumed, /value="Draft synthetic"/);
  assert.equal((await post(base, "/file/resume", form({ draftCode: "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF" }), { type: FORM })).status, 404);
  // Owner creates a view-only representative code; representative cannot act; revocation ends access.
  const f = await fileAndLogin(base, { filingType: "records-request", agencyId: "demo-records-access-unit" });
  const caseHtml = await (await get(base, "/track/case", f.cookie)).text();
  const csrf = field(caseHtml, "csrf");
  const dres = await post(base, "/track/delegations", form({ csrf, label: "Synthetic attorney", scope: "view" }), { cookie: f.cookie, type: FORM });
  const delegateCode = (await dres.text()).match(/Representative code: <code class="big">([0-9A-Z-]+)<\/code>/)[1];
  const rep = cookieOf(await post(base, "/track", form({ trackingNumber: f.tracking, accessCode: delegateCode }), { type: FORM }));
  const repHtml = await (await get(base, "/track/case", rep)).text();
  assert.match(repHtml, /representative access \(view\)/);
  assert.doesNotMatch(repHtml, /action="\/track\/amend"/);
  assert.equal((await post(base, "/track/corrections", form({ csrf: field(repHtml, "csrf"), kind: "withdrawal", statement: "x" }), { cookie: rep, type: FORM })).status, 403);
  const delId = (await pool.query("SELECT id FROM delegations")).rows[0].id;
  await post(base, `/track/delegations/${delId}/revoke`, form({ csrf }), { cookie: f.cookie, type: FORM });
  assert.equal((await get(base, "/track/case", rep)).status, 303, "revoked representative is signed out");
  // Receipt correction accepted -> separately signed correction notice; withdrawal accepted -> withdrawn.
  await post(base, "/track/corrections", form({ csrf, kind: "receipt_correction", statement: "The subject line has a typo." }), { cookie: f.cookie, type: FORM });
  await post(base, "/track/corrections", form({ csrf, kind: "withdrawal", statement: "I no longer need this." }), { cookie: f.cookie, type: FORM });
  const admin = await staffLogin(base);
  const ids = (await pool.query("SELECT id, kind, submission_id FROM corrections ORDER BY filed_at")).rows;
  const scsrf = await staffCsrf(base, admin.cookie, `/staff/submissions/${ids[0].submission_id}`);
  for (const c of ids) assert.equal((await post(base, `/staff/corrections/${c.id}`, form({ csrf: scsrf, decision: "accepted", note: "Synthetic decision" }), { cookie: admin.cookie, type: FORM })).status, 303);
  const doc = (await pool.query("SELECT correction_document FROM corrections WHERE kind = 'receipt_correction'")).rows[0].correction_document;
  const { verifySignature } = await import("../src/demo/signing.mjs");
  assert.ok(verifySignature(backend.publicKeys()[0], doc.correction, doc.signature.value));
  assert.match(await (await get(base, "/track/case", f.cookie)).text(), /Withdrawn/);
  // Legal hold blocks disposition; release + expiry crypto-shreds; receipt still verifies.
  const sid = ids[0].submission_id;
  const admin2 = await platform.getStaff((await pool.query("SELECT id FROM staff_users WHERE username = $1", [ADMIN.user])).rows[0].id);
  await platform.placeHold(admin2, sid, "Synthetic litigation hold");
  const future = new Date(Date.now() + 400 * 86_400_000);
  assert.equal(await platform.disposeEligible({ asOf: future }), 0);
  await platform.releaseHold(admin2, sid);
  assert.equal(await platform.disposeEligible({ asOf: future }), 1);
  const detail = await (await get(base, `/staff/submissions/${sid}`, admin.cookie)).text();
  assert.match(detail, /disposed under the retention schedule/);
  assert.match(detail, /Disposed /);
  const receipt = (await pool.query("SELECT document FROM receipts WHERE submission_id = $1", [sid])).rows[0].document;
  assert.equal((await backend.verifyReceipt(receipt)).valid, true, "receipts survive disposition");
  assert.equal(Number((await pool.query("SELECT count(*) FROM data_keys WHERE subject = $1 AND destroyed_at IS NULL", [sid])).rows[0].count), 0);
  assert.equal((await verifyLedger(pool)).valid, true);
});
