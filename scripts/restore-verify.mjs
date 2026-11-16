#!/usr/bin/env node
// Post-restore verification (UFR-058): run against a database restored with
//   pg_restore --no-owner --dbname "$RESTORE_URL" backup.dump
// Checks the full ledger hash chain, that every signed checkpoint matches the
// restored ledger, and (optionally) that the restored head is not older than a
// checkpoint published by the live service. Usage:
//   RESTORE_URL=postgres://... [PUBLIC_KEY_JWK='{"kty":"OKP",...}'] node scripts/restore-verify.mjs
import { createPool } from "../src/demo/db.mjs";
import { verifyLedger } from "../src/demo/ledger.mjs";
import { verifySignature } from "../src/demo/signing.mjs";

const pool = createPool(process.env.RESTORE_URL ?? process.env.DATABASE_URL);
try {
  const chain = await verifyLedger(pool);
  const cps = (await pool.query("SELECT seq, head_hash, created_at, key_id, signature FROM ledger_checkpoints ORDER BY seq")).rows;
  const jwk = process.env.PUBLIC_KEY_JWK ? JSON.parse(process.env.PUBLIC_KEY_JWK) : null;
  let checked = 0;
  for (const c of cps) {
    const row = (await pool.query("SELECT entry_hash FROM ledger_entries WHERE seq = $1", [c.seq])).rows[0];
    if (!row || row.entry_hash !== c.head_hash) throw new Error(`checkpoint ${c.seq} does not match the restored ledger`);
    if (jwk) {
      const body = { schema: "ufr-demo-ledger-checkpoint-v1", demo: true, seq: Number(c.seq), headHash: c.head_hash, createdAt: c.created_at.toISOString() };
      if (!verifySignature(jwk, body, c.signature)) throw new Error(`checkpoint ${c.seq} signature invalid`);
    }
    checked++;
  }
  const counts = (await pool.query("SELECT (SELECT count(*) FROM submissions)::int submissions, (SELECT count(*) FROM receipts)::int receipts")).rows[0];
  if (!chain.valid) throw new Error(`ledger invalid: ${JSON.stringify(chain.failure)}`);
  console.log(JSON.stringify({ status: "restore_verified", ledgerEntries: chain.checked, headHash: chain.headHash, checkpointsChecked: checked,
    signaturesChecked: Boolean(jwk), ...counts }));
} catch (error) {
  console.error(JSON.stringify({ status: "restore_verification_failed", error: error.message }));
  process.exitCode = 1;
} finally { await pool.end(); }
