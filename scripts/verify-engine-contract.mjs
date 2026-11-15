#!/usr/bin/env node
// UFR-004: validate the pinned Secure Intake contract lock and, optionally,
// probe a running engine: node scripts/verify-engine-contract.mjs [--base-url URL]
import { readFileSync } from "node:fs";
import { validateEngineLock, engineReadinessReason } from "../src/engine/contract.mjs";
import { probeEngine } from "../src/engine/client.mjs";

const lockPath = new URL("../config/engine.lock.json", import.meta.url);
const lock = validateEngineLock(JSON.parse(readFileSync(lockPath, "utf8")));
console.log(`Engine contract lock valid: ${lock.repository}@${lock.tag} (${lock.sourceCommit.slice(0, 12)}); ` +
  `prerelease=${lock.prerelease}; productionEligible=${lock.productionEligible}.`);

const flag = process.argv.indexOf("--base-url");
if (flag !== -1) {
  const probe = await probeEngine({ baseUrl: process.argv[flag + 1], lock });
  console.log(JSON.stringify({ probe, portalReadinessReason: engineReadinessReason(lock, probe) }));
  if (probe.state === "contract_mismatch" || probe.state === "unavailable") process.exit(1);
}
