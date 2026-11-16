import { canonicalJson, sha256Hex } from "./canonical.mjs";

export const GENESIS_HASH = "0".repeat(64);
export const MAX_CLOCK_SKEW_MS = 5000;

export class TrustedTimeError extends Error {}

/**
 * Authoritative time (UFR-007, portal-local): the database's
 * clock_timestamp() is the time of record, cross-checked against the
 * application clock and required to be monotonic with the ledger head.
 * If the sources disagree, the filing fails closed instead of fabricating a
 * timestamp. This is a demo time source, not a qualified timestamp service.
 */
export async function trustedNow(client, head, appNow = Date.now()) {
  const { rows } = await client.query("SELECT clock_timestamp() AS now");
  const dbNow = rows[0].now.getTime();
  if (Math.abs(dbNow - appNow) > MAX_CLOCK_SKEW_MS) throw new TrustedTimeError("clock_skew");
  if (head && dbNow < new Date(head.recorded_at).getTime()) throw new TrustedTimeError("clock_rollback");
  return new Date(dbNow);
}

export function entryHash({ seq, recordedAt, eventType, subject, payload, prevHash }) {
  return sha256Hex(Buffer.from(canonicalJson({ seq, recordedAt, eventType, subject, payload, prevHash }), "utf8"));
}

/**
 * Appends one hash-chained entry inside the caller's transaction. The head
 * row is locked FOR UPDATE, so concurrent appends serialize and the chain
 * cannot fork. Tables are append-only by trigger.
 */
export async function appendLedger(client, { eventType, subject, payload, appNow }) {
  const head = (await client.query("SELECT seq, entry_hash, recorded_at FROM ledger_head WHERE id = 1 FOR UPDATE")).rows[0];
  const at = await trustedNow(client, head, appNow);
  const seq = Number(head.seq) + 1;
  const recordedAt = at.toISOString();
  const prevHash = head.entry_hash;
  const hash = entryHash({ seq, recordedAt, eventType, subject, payload, prevHash });
  await client.query(`INSERT INTO ledger_entries (seq, recorded_at, event_type, subject, payload, prev_hash, entry_hash)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [seq, recordedAt, eventType, subject, payload, prevHash, hash]);
  await client.query("UPDATE ledger_head SET seq = $1, entry_hash = $2, recorded_at = $3 WHERE id = 1", [seq, hash, recordedAt]);
  return { seq, recordedAt, entryHash: hash, prevHash };
}

/** Recomputes the whole chain (bounded) and reports the first inconsistency. */
export async function verifyLedger(pool, { limit = 100_000 } = {}) {
  const { rows } = await pool.query(`SELECT seq, recorded_at, event_type, subject, payload, prev_hash, entry_hash
    FROM ledger_entries ORDER BY seq LIMIT $1`, [limit]);
  let prev = GENESIS_HASH;
  for (const [index, row] of rows.entries()) {
    const seq = Number(row.seq);
    if (seq !== index + 1) return { valid: false, checked: index, failure: { seq, reason: "sequence_gap" } };
    if (row.prev_hash !== prev) return { valid: false, checked: index, failure: { seq, reason: "prev_hash_mismatch" } };
    const expected = entryHash({ seq, recordedAt: row.recorded_at.toISOString(), eventType: row.event_type,
      subject: row.subject, payload: row.payload, prevHash: row.prev_hash });
    if (expected !== row.entry_hash) return { valid: false, checked: index, failure: { seq, reason: "entry_hash_mismatch" } };
    prev = row.entry_hash;
  }
  const head = (await pool.query("SELECT seq, entry_hash FROM ledger_head WHERE id = 1")).rows[0];
  if (rows.length < limit && (Number(head.seq) !== rows.length || head.entry_hash !== prev))
    return { valid: false, checked: rows.length, failure: { seq: Number(head.seq), reason: "head_mismatch" } };
  return { valid: true, checked: rows.length, headHash: prev };
}
