import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------- TOTP (UFR-024 MFA)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret() {
  return Array.from(randomBytes(20), (b) => B32[b & 31]).join("");
}
function b32decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error("bad_base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}
/** RFC 6238 (SHA-1, 30 s, 6 digits), +/-1 step; returns the matched step so callers can refuse replay. */
export function verifyTotp(secret, code, nowMs = Date.now(), lastStep = -1) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) return null;
  const now = Math.floor(nowMs / 30_000);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code.trim()))) return step;
  }
  return null;
}
export const otpauthUri = (secret, account) =>
  `otpauth://totp/${encodeURIComponent("FedFilingDemo:" + account)}?secret=${secret}&issuer=FedFilingDemo&algorithm=SHA1&digits=6&period=30`;

// ---------------------------------------------------------------- passwords
export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$16384$${salt.toString("base64")}$${scryptSync(password, salt, 32, { N: 16384 }).toString("base64")}`;
}
export function verifyPassword(stored, password) {
  const [alg, n, salt, hash] = String(stored ?? "").split("$");
  if (alg !== "scrypt" || typeof password !== "string") {
    scryptSync("x", "dummy-salt-dummy", 32, { N: 16384 }); // equalize timing for unknown users
    return false;
  }
  const actual = scryptSync(password, Buffer.from(salt, "base64"), 32, { N: Number(n) });
  return timingSafeEqual(actual, Buffer.from(hash, "base64"));
}
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 16) return "Passwords must be at least 16 characters.";
  if (password.length > 200) return "Password too long.";
  if (new Set(password).size < 6) return "Password is too repetitive.";
  return null;
}

// ---------------------------------------------------------------- malware heuristics (UFR-027)
/**
 * Built-in heuristic scanner. Not an antivirus engine: it catches the EICAR
 * test file, active PDF content (JavaScript, launch actions, embedded files)
 * and image polyglots (data appended after the image end marker). Anything
 * not "clean" stays quarantined. An external scanner can be added behind
 * the same verdict interface.
 */
export function scanDocument(mediaType, content) {
  const latin = content.toString("latin1");
  if (latin.includes("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"))
    return { verdict: "infected", detail: "EICAR test signature" };
  if (mediaType === "application/pdf") {
    const hits = ["/JavaScript", "/JS", "/Launch", "/EmbeddedFile", "/RichMedia", "/XFA"].filter((t) => latin.includes(t));
    if (hits.length) return { verdict: "suspicious", detail: "active PDF content: " + hits.join(", ") };
  }
  if (mediaType === "image/png") {
    const end = content.indexOf(Buffer.from("IEND"));
    if (end < 0) return { verdict: "suspicious", detail: "PNG without IEND" };
    if (content.length - (end + 8) > 64) return { verdict: "suspicious", detail: "data appended after PNG end" };
  }
  if (mediaType === "image/jpeg") {
    const end = content.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (end < 0 || content.length - (end + 2) > 64) return { verdict: "suspicious", detail: "data appended after JPEG end" };
  }
  if (/<script\b|<\?php|#!\/bin\/(ba)?sh/i.test(latin) && mediaType !== "text/plain")
    return { verdict: "suspicious", detail: "embedded script markers" };
  return { verdict: "clean", detail: "heuristic scan passed" };
}

// ---------------------------------------------------------------- classified markings (UFR-047)
const MARKING_RULES = [
  ["banner-ts", /\bTOP\s+SECRET\s*\/\//i], ["banner-s", /(^|[^A-Z])SECRET\s*\/\/\s*[A-Z]/],
  ["banner-c", /\bCONFIDENTIAL\s*\/\/\s*[A-Z]/], ["portion", /\((TS|S|C)\s*\/\/\s*[A-Z]{2,}/],
  ["dissem", /\/\/\s*(NOFORN|ORCON|NOCONTRACT|PROPIN|REL\s+TO\s+[A-Z]|FVEY|IMCON)\b/],
  ["sci", /\b(TS|TOP\s+SECRET)\s*\/\/\s*SCI\b/i], ["cab", /\bCLASSIFIED\s+BY\s*:/i],
  ["declass", /\bDECLASSIFY\s+ON\s*:/i],
];
/**
 * Detects U.S. classification markings in text or document bytes. A hit
 * stops collection: nothing is stored except a content-free audit event
 * naming the rule. It cannot detect unmarked classified content; the
 * attestation and guidance remain the primary control.
 */
export function detectClassifiedMarking(...inputs) {
  for (const input of inputs) {
    const text = Buffer.isBuffer(input) ? input.toString("latin1") : String(input ?? "");
    for (const [rule, re] of MARKING_RULES) if (re.test(text)) return rule;
  }
  return null;
}
