#!/usr/bin/env node
// Independent checkpoint witness (UFR-049). Run by any third party:
//   node scripts/witness-checkpoints.mjs https://portal.example [state-file]
// Verifies every published checkpoint signature against the published key,
// and that no previously witnessed checkpoint changed (split view or history
// rewrite) and the head never moved backwards. Stores what it has seen in the
// state file. A real deployment would also gossip state between independent witnesses.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { verifySignature } from "../src/demo/signing.mjs";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
const stateFile = process.argv[3] ?? "witness-state.json";
if (!/^https?:\/\/[^/]+$/.test(base)) { console.error("usage: witness-checkpoints.mjs <origin> [state-file]"); process.exit(2); }
const doc = await (await fetch(base + "/api/ledger/checkpoints", { signal: AbortSignal.timeout(90_000) })).json();
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { seen: {}, maxSeq: 0, keys: {} };
const problems = [];
for (const { checkpoint, signature } of doc.checkpoints) {
  const key = doc.keys.find((k) => k.kid === signature.keyId);
  if (!key || !verifySignature(key, checkpoint, signature.value)) problems.push(`bad signature at ${checkpoint.seq}`);
  if (state.keys[signature.keyId] && state.keys[signature.keyId] !== key?.x) problems.push(`key ${signature.keyId} changed`);
  if (key) state.keys[signature.keyId] = key.x;
  const prior = state.seen[checkpoint.seq];
  if (prior && prior !== checkpoint.headHash) problems.push(`checkpoint ${checkpoint.seq} changed: ${prior} -> ${checkpoint.headHash}`);
  state.seen[checkpoint.seq] = checkpoint.headHash;
}
const newest = Math.max(0, ...doc.checkpoints.map((c) => c.checkpoint.seq));
if (newest < state.maxSeq) problems.push(`head moved backwards: ${state.maxSeq} -> ${newest}`);
state.maxSeq = Math.max(state.maxSeq, newest);
writeFileSync(stateFile, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ base, checkpoints: doc.checkpoints.length, newestSeq: newest, problems }));
if (problems.length) process.exit(1);
