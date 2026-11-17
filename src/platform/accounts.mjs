import { randomUUID, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { code, IntakeError } from "../demo/backend.mjs";
import { sha256Hex } from "../demo/canonical.mjs";
import { withTransaction } from "../demo/db.mjs";
import { appendLedger } from "../demo/ledger.mjs";

/**
 * UFR-025 optional claimant accounts (demonstration), with no email or SMS
 * provider:
 *  - passkeys (WebAuthn) are the only sign-up/sign-in credential: no passwords;
 *  - ten one-time recovery codes are shown once and stored only as hashes;
 *  - existing filings are linked with their tracking number and owner access code;
 *  - sessions are server-side rows, so each one (or all) can be revoked;
 *  - RecoveryDelivery is the seam for adding email/SMS recovery later. The
 *    default NullRecoveryDelivery records requests as undeliverable and never
 *    claims a message was sent.
 * Accounts are optional: tracking number plus access code keeps working.
 */
export const RECOVERY_CODE_COUNT = 10;
const normCode = (c) => String(c ?? "").toUpperCase().replace(/[\s-]/g, "");
const CHALLENGE_TTL_SECONDS = 300;
const SESSION_HOURS = 12;
const MAX_PASSKEYS = 10;
// 100-bit random codes: an unsalted SHA-256 is preimage-safe and allows a direct, constant-work lookup.
const hashCode = (c) => sha256Hex(`recovery:${normCode(c)}`);
const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** Provider-free recovery seam. Implementations must never report delivery that did not happen. */
export class NullRecoveryDelivery {
  name = "none";
  async deliver() { return { delivered: false, state: "undeliverable", reason: "no_recovery_provider_configured" }; }
}

export class AccountServices {
  constructor({ backend, rpName = "Federal Filing Prototype (demo)", recoveryDelivery = new NullRecoveryDelivery(), logger = () => {} }) {
    this.backend = backend; this.pool = backend.pool; this.rpName = rpName; this.recoveryDelivery = recoveryDelivery; this.logger = logger;
  }
  ledger(c, eventType, subject, payload) { return appendLedger(c, { eventType, subject, payload, appNow: this.backend.appNow() }); }

  async #challenge(purpose, challenge, { accountId = null, userHandle = null } = {}) {
    const id = randomUUID();
    await this.pool.query("DELETE FROM webauthn_challenges WHERE expires_at < clock_timestamp()");
    await this.pool.query(`INSERT INTO webauthn_challenges (id, purpose, challenge, account_id, user_handle, expires_at)
      VALUES ($1,$2,$3,$4,$5, clock_timestamp() + make_interval(secs => ${CHALLENGE_TTL_SECONDS}))`, [id, purpose, challenge, accountId, userHandle]);
    return id;
  }
  /** Single-use: the challenge row is deleted when consumed, whatever the outcome. */
  async #consume(id, purpose) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) throw new IntakeError("challenge_expired", 400);
    const row = (await this.pool.query("DELETE FROM webauthn_challenges WHERE id = $1 AND purpose = $2 AND expires_at > clock_timestamp() RETURNING *",
      [id, purpose])).rows[0];
    if (!row) throw new IntakeError("challenge_expired", 400);
    return row;
  }

  // ------------------------------------------------------------ registration
  async registrationOptions({ rpID, label }) {
    const accountLabel = String(label ?? "").trim().slice(0, 60) || "Demo account";
    const userHandle = b64u(randomBytes(32));
    const options = await generateRegistrationOptions({ rpName: this.rpName, rpID, userName: accountLabel, userDisplayName: accountLabel,
      userID: Buffer.from(userHandle, "base64url"), attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" }, supportedAlgorithmIDs: [-7, -8, -257] });
    const challengeId = await this.#challenge("register", options.challenge, { userHandle: JSON.stringify({ userHandle, label: accountLabel }) });
    return { challengeId, options };
  }
  /** Creates the account, its first passkey, recovery codes and a session. Returns codes in plaintext once. */
  async completeRegistration({ challengeId, response, rpID, origin, clientHint = "" }) {
    const ch = await this.#consume(challengeId, "register");
    const { userHandle, label } = JSON.parse(ch.user_handle);
    let v;
    try {
      v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch { throw new IntakeError("passkey_verification_failed", 400); }
    if (!v.verified || !v.registrationInfo) throw new IntakeError("passkey_verification_failed", 400);
    const cred = v.registrationInfo.credential;
    return withTransaction(this.pool, async (c) => {
      const accountId = randomUUID();
      await c.query("INSERT INTO claimant_accounts (id, label) VALUES ($1,$2)", [accountId, label]);
      await this.#insertPasskey(c, accountId, cred, v.registrationInfo, "Passkey 1", userHandle);
      const codes = await this.#newRecoveryCodes(c, accountId, 1);
      const sessionId = await this.#newSession(c, accountId, "registration", clientHint);
      await this.ledger(c, "account.created", accountId, { passkeyIdSha256: sha256Hex(cred.id) });
      return { accountId, sessionId, recoveryCodes: codes };
    });
  }
  async #insertPasskey(c, accountId, cred, info, label) {
    const n = Number((await c.query("SELECT count(*) FROM passkeys WHERE account_id = $1 AND removed_at IS NULL", [accountId])).rows[0].count);
    if (n >= MAX_PASSKEYS) throw new IntakeError("too_many_passkeys", 409);
    try {
      await c.query(`INSERT INTO passkeys (id, account_id, public_key, counter, transports, label, backed_up) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [cred.id, accountId, Buffer.from(cred.publicKey), cred.counter ?? 0, cred.transports ?? [], label, Boolean(info.credentialBackedUp)]);
    } catch (e) { if (e.code === "23505") throw new IntakeError("passkey_already_registered", 409); throw e; }
  }
  async #newRecoveryCodes(c, accountId, generation) {
    await c.query("UPDATE recovery_codes SET used_at = COALESCE(used_at, clock_timestamp()) WHERE account_id = $1", [accountId]);
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => code(20));
    for (const rc of codes) await c.query("INSERT INTO recovery_codes (account_id, code_hash, generation) VALUES ($1,$2,$3)", [accountId, hashCode(rc), generation]);
    return codes.map((x) => x.match(/.{1,5}/g).join("-"));
  }
  async #newSession(c, accountId, method, clientHint) {
    const id = randomUUID();
    await c.query(`INSERT INTO account_sessions (id, account_id, method, expires_at, client_hint) VALUES ($1,$2,$3, clock_timestamp() + interval '${SESSION_HOURS} hours', $4)`,
      [id, accountId, method, String(clientHint).slice(0, 80)]);
    return id;
  }

  // ------------------------------------------------------------ sign-in
  async authenticationOptions({ rpID }) {
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: [] });
    return { challengeId: await this.#challenge("login", options.challenge), options };
  }
  async completeAuthentication({ challengeId, response, rpID, origin, clientHint = "" }) {
    const ch = await this.#consume(challengeId, "login");
    const id = typeof response?.id === "string" ? response.id : "";
    const pk = (await this.pool.query(`SELECT p.*, a.disabled_at FROM passkeys p JOIN claimant_accounts a ON a.id = p.account_id
      WHERE p.id = $1 AND p.removed_at IS NULL`, [id])).rows[0];
    if (!pk || pk.disabled_at) throw new IntakeError("passkey_verification_failed", 401);
    let v;
    try {
      v = await verifyAuthenticationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports } });
    } catch { throw new IntakeError("passkey_verification_failed", 401); }
    if (!v.verified) throw new IntakeError("passkey_verification_failed", 401);
    return withTransaction(this.pool, async (c) => {
      // Signature counters that fail to increase (when the authenticator uses them) indicate a cloned credential.
      const upd = await c.query(`UPDATE passkeys SET counter = $2, last_used_at = clock_timestamp() WHERE id = $1 AND (counter = 0 AND $2 = 0 OR $2 > counter)`,
        [pk.id, v.authenticationInfo.newCounter]);
      if (!upd.rowCount) throw new IntakeError("passkey_verification_failed", 401);
      const sessionId = await this.#newSession(c, pk.account_id, "passkey", clientHint);
      await this.ledger(c, "account.signed_in", pk.account_id, { method: "passkey" });
      return { accountId: pk.account_id, sessionId };
    });
  }
  /** One-time recovery code sign-in. Non-distinguishing failure. */
  async recover(codeInput, clientHint = "") {
    const c0 = normCode(codeInput);
    if (!/^[0-9A-Z]{20}$/.test(c0)) return null;
    return withTransaction(this.pool, async (c) => {
      const hit = (await c.query(`UPDATE recovery_codes r SET used_at = clock_timestamp() FROM claimant_accounts a
        WHERE r.code_hash = $1 AND r.used_at IS NULL AND a.id = r.account_id AND a.disabled_at IS NULL RETURNING r.account_id`, [hashCode(c0)])).rows[0];
      if (!hit) return null;
      const accountId = hit.account_id;
      const sessionId = await this.#newSession(c, accountId, "recovery_code", clientHint);
      const left = Number((await c.query("SELECT count(*) FROM recovery_codes WHERE account_id = $1 AND used_at IS NULL", [accountId])).rows[0].count);
      await this.ledger(c, "account.recovered", accountId, { method: "recovery_code", remainingCodes: left });
      return { accountId, sessionId, remainingCodes: left };
    });
  }

  // ------------------------------------------------------------ sessions
  async session(sessionId) {
    if (!/^[0-9a-f-]{36}$/.test(String(sessionId))) return null;
    const s = (await this.pool.query(`UPDATE account_sessions s SET last_seen_at = clock_timestamp() FROM claimant_accounts a
      WHERE s.id = $1 AND a.id = s.account_id AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND a.disabled_at IS NULL
      RETURNING s.id, s.account_id, s.method, a.label`, [sessionId])).rows[0];
    return s ? { id: s.id, accountId: s.account_id, method: s.method, label: s.label } : null;
  }
  async listSessions(accountId) {
    return (await this.pool.query(`SELECT id, method, created_at, last_seen_at, client_hint FROM account_sessions
      WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() ORDER BY created_at DESC`, [accountId])).rows;
  }
  async revokeSession(accountId, sessionId) {
    return withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE account_sessions SET revoked_at = clock_timestamp() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL", [sessionId, accountId]);
      if (!r.rowCount) throw new IntakeError("not_found", 404);
      await this.ledger(c, "account.session_revoked", accountId, { scope: "one" });
    });
  }
  async revokeAllSessions(accountId) {
    return withTransaction(this.pool, async (c) => {
      const r = await c.query("UPDATE account_sessions SET revoked_at = clock_timestamp() WHERE account_id = $1 AND revoked_at IS NULL", [accountId]);
      await this.ledger(c, "account.session_revoked", accountId, { scope: "all", count: r.rowCount });
      return r.rowCount;
    });
  }

  // ------------------------------------------------------------ passkeys and recovery codes
  async listPasskeys(accountId) {
    return (await this.pool.query("SELECT id, label, created_at, last_used_at, backed_up FROM passkeys WHERE account_id = $1 AND removed_at IS NULL ORDER BY created_at",
      [accountId])).rows;
  }
  async addPasskeyOptions(accountId, { rpID }) {
    const existing = await this.listPasskeys(accountId);
    const options = await generateRegistrationOptions({ rpName: this.rpName, rpID, userName: "Demo account", userDisplayName: "Demo account",
      userID: randomBytes(32), attestationType: "none", excludeCredentials: existing.map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" }, supportedAlgorithmIDs: [-7, -8, -257] });
    return { challengeId: await this.#challenge("add_passkey", options.challenge, { accountId }), options };
  }
  async completeAddPasskey(accountId, { challengeId, response, rpID, origin }) {
    const ch = await this.#consume(challengeId, "add_passkey");
    if (ch.account_id !== accountId) throw new IntakeError("challenge_expired", 400);
    let v;
    try { v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); }
    catch { throw new IntakeError("passkey_verification_failed", 400); }
    if (!v.verified) throw new IntakeError("passkey_verification_failed", 400);
    await withTransaction(this.pool, async (c) => {
      const n = Number((await c.query("SELECT count(*) FROM passkeys WHERE account_id = $1", [accountId])).rows[0].count);
      await this.#insertPasskey(c, accountId, v.registrationInfo.credential, v.registrationInfo, `Passkey ${n + 1}`);
      await this.ledger(c, "account.passkey_added", accountId, { passkeyIdSha256: sha256Hex(v.registrationInfo.credential.id) });
    });
  }
  async removePasskey(accountId, passkeyId) {
    return withTransaction(this.pool, async (c) => {
      const active = (await c.query("SELECT id FROM passkeys WHERE account_id = $1 AND removed_at IS NULL FOR UPDATE", [accountId])).rows;
      if (!active.some((p) => p.id === passkeyId)) throw new IntakeError("not_found", 404);
      if (active.length <= 1) throw new IntakeError("last_passkey", 409);
      await c.query("UPDATE passkeys SET removed_at = clock_timestamp() WHERE id = $1", [passkeyId]);
      await this.ledger(c, "account.passkey_removed", accountId, { passkeyIdSha256: sha256Hex(passkeyId) });
    });
  }
  async remainingRecoveryCodes(accountId) {
    return Number((await this.pool.query("SELECT count(*) FROM recovery_codes WHERE account_id = $1 AND used_at IS NULL", [accountId])).rows[0].count);
  }
  async regenerateRecoveryCodes(accountId) {
    return withTransaction(this.pool, async (c) => {
      const gen = Number((await c.query("SELECT COALESCE(max(generation), 0) g FROM recovery_codes WHERE account_id = $1", [accountId])).rows[0].g) + 1;
      const codes = await this.#newRecoveryCodes(c, accountId, gen);
      await this.ledger(c, "account.recovery_codes_regenerated", accountId, { generation: gen });
      return codes;
    });
  }

  // ------------------------------------------------------------ filings
  /** Links a filing with its tracking number and the OWNER access code (representative codes cannot claim a filing). */
  async linkFiling(accountId, trackingNumber, accessCode) {
    const session = await this.backend.openParticipantSession(trackingNumber, accessCode);
    if (!session || session.scope !== "owner") throw new IntakeError("link_failed", 400);
    return withTransaction(this.pool, async (c) => {
      const r = await c.query("INSERT INTO account_filings (account_id, root_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [accountId, session.rootId]);
      if (r.rowCount) await this.ledger(c, "account.filing_linked", accountId, { rootId: session.rootId });
      return session.rootId;
    });
  }
  async unlinkFiling(accountId, rootId) {
    return withTransaction(this.pool, async (c) => {
      const r = await c.query("DELETE FROM account_filings WHERE account_id = $1 AND root_id = $2", [accountId, rootId]);
      if (!r.rowCount) throw new IntakeError("not_found", 404);
      await this.ledger(c, "account.filing_unlinked", accountId, { rootId });
    });
  }
  async listFilings(accountId) {
    return (await this.pool.query(`SELECT f.root_id, s.tracking_number, s.title, s.filing_type, s.received_at, a.name AS agency_name,
        (SELECT status FROM status_events e JOIN submissions x ON x.id = e.submission_id WHERE x.id = s.id OR x.parent_id = s.id ORDER BY e.id DESC LIMIT 1) AS status,
        (SELECT count(*)::int FROM notices n WHERE n.submission_id = s.id AND n.read_at IS NULL AND n.kind <> 'claimant_reply') AS unread
      FROM account_filings f JOIN submissions s ON s.id = f.root_id JOIN agencies a ON a.id = s.agency_id
      WHERE f.account_id = $1 ORDER BY s.received_at DESC`, [accountId])).rows;
  }
  async ownsFiling(accountId, rootId) {
    return (await this.pool.query("SELECT 1 FROM account_filings WHERE account_id = $1 AND root_id = $2", [accountId, rootId])).rowCount === 1;
  }

  /** Email/SMS recovery seam: records the request without storing the contact; nothing is sent unless a provider is configured. */
  async requestContactRecovery(channel, contact) {
    if (!["email", "sms"].includes(channel) || typeof contact !== "string" || !contact.trim() || contact.length > 200) throw new IntakeError("invalid_contact");
    const result = await this.recoveryDelivery.deliver({ channel, contact: contact.trim() });
    await this.pool.query("INSERT INTO account_recovery_requests (id, channel, contact_sha256, state) VALUES ($1,$2,$3,$4)",
      [randomUUID(), channel, sha256Hex(contact.trim().toLowerCase()), result.state]);
    this.logger("account.contact_recovery_requested", { channel, state: result.state, provider: this.recoveryDelivery.name });
    return result;
  }
}
