#!/usr/bin/env node
// Syntax-checks every application module (replaces a hand-maintained file list).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const root = new URL("../src/", import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name)); else if (/\.m?js$/.test(e.name)) files.push(join(dir, e.name));
  }
})(root);
for (const f of files) execFileSync(process.execPath, ["--check", f], { stdio: "inherit" });
console.log(`Syntax OK: ${files.length} modules.`);
