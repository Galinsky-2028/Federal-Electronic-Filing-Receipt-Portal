#!/usr/bin/env node
// Secure release validation (UFR-055, demonstration scope): lockfile integrity,
// CycloneDX SBOM generation, tracked-file secret scan and required security
// controls present in source. It does not replace independent review or E2EESA certification.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const problems = [];
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const components = [];
for (const [path, p] of Object.entries(lock.packages ?? {})) {
  if (!path) continue;
  if (!p.resolved?.startsWith("https://registry.npmjs.org/") || !/^sha512-/.test(p.integrity ?? "")) problems.push(`lockfile entry without registry integrity: ${path}`);
  components.push({ type: "library", name: path.replace(/^.*node_modules\//, ""), version: p.version, purl: `pkg:npm/${path.replace(/^.*node_modules\//, "")}@${p.version}`,
    hashes: p.integrity ? [{ alg: "SHA-512", content: Buffer.from(p.integrity.slice(7), "base64").toString("hex") }] : [] });
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const sbom = { bomFormat: "CycloneDX", specVersion: "1.5", version: 1, metadata: { component: { type: "application", name: pkg.name, version: pkg.version } }, components };
writeFileSync(process.env.SBOM_OUT ?? "sbom.cdx.json", JSON.stringify(sbom, null, 2));

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => f && !f.endsWith("package-lock.json"));
const SECRET_PATTERNS = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{6,}@(?!localhost|127\.0\.0\.1)/,
  /AKIA[0-9A-Z]{16}/, /\bgh[pousr]_[A-Za-z0-9]{36}\b/, /\brnd_[A-Za-z0-9]{20,}\b/, /\bnapi_[A-Za-z0-9]{20,}\b/, /MC4CAQAwBQYDK2Vw[A-Za-z0-9+/=]{20,}/];
for (const f of tracked) {
  let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const re of SECRET_PATTERNS) if (re.test(text)) problems.push(`possible secret in ${f}: ${re.source.slice(0, 30)}`);
}
const server = readFileSync("src/server.mjs", "utf8") + readFileSync("src/demo/routes.mjs", "utf8") + readFileSync("src/demo/auth.mjs", "utf8");
for (const control of ["content-security-policy", "x-content-type-options", "frame-ancestors 'none'", "HttpOnly; SameSite=Strict", "sameOrigin(", "csrfValid("])
  if (!server.includes(control)) problems.push(`missing security control: ${control}`);
console.log(JSON.stringify({ sbomComponents: components.length, trackedFilesScanned: tracked.length, problems }));
if (problems.length) process.exit(1);
