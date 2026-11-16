import { verifySignature } from "./signing.mjs";

export const RECEIPT_SCHEMA = "ufr-demo-receipt-v1";
export const RECEIPT_NOTICE =
  "DEMONSTRATION RECEIPT issued by a development prototype. Not issued by or on behalf of the United States " +
  "Government and not evidence that any government institution received a filing. Synthetic data only.";
export const ISSUER_NAME = "Federal Electronic Filing & Receipt Portal (development prototype, not a government service)";

const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECEIPT_ID = /^RCPT-DEMO-[0-9A-Z]{20}$/;
const TRACKING = /^DEMO-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

function keysExactly(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Canonical receipt body (UFR-006). Every field is required; unknown fields are invalid. */
export function buildReceipt({ receiptId, trackingNumber, kind, amends, receivedAt, agency, filingType,
  manifest, ledger, keyId }) {
  const receipt = {
    schema: RECEIPT_SCHEMA, notice: RECEIPT_NOTICE, demo: true,
    receiptId, trackingNumber, kind, amends: amends ?? null, receivedAt,
    timeSource: "database-clock-cross-checked",
    agency: { id: agency.id, name: agency.name, fictional: true },
    filingType,
    manifest: { sha256: manifest.sha256, partCount: manifest.partCount, totalBytes: manifest.totalBytes },
    ledger: { seq: ledger.seq, entryHash: ledger.entryHash },
    issuer: { name: ISSUER_NAME, keyId },
  };
  if (!isReceiptShape(receipt)) throw new TypeError("Invalid receipt fields");
  return receipt;
}

export function isReceiptShape(r) {
  return keysExactly(r, ["schema", "notice", "demo", "receiptId", "trackingNumber", "kind", "amends", "receivedAt",
    "timeSource", "agency", "filingType", "manifest", "ledger", "issuer"]) &&
    r.schema === RECEIPT_SCHEMA && r.notice === RECEIPT_NOTICE && r.demo === true &&
    RECEIPT_ID.test(r.receiptId) && TRACKING.test(r.trackingNumber) &&
    (r.kind === "original" ? r.amends === null : r.kind === "amendment" && RECEIPT_ID.test(r.amends ?? "")) &&
    ISO.test(r.receivedAt) && r.timeSource === "database-clock-cross-checked" &&
    keysExactly(r.agency, ["id", "name", "fictional"]) && r.agency.fictional === true &&
    typeof r.agency.id === "string" && typeof r.agency.name === "string" &&
    typeof r.filingType === "string" && r.filingType.length <= 64 &&
    keysExactly(r.manifest, ["sha256", "partCount", "totalBytes"]) && HEX64.test(r.manifest.sha256) &&
    Number.isSafeInteger(r.manifest.partCount) && r.manifest.partCount >= 1 &&
    Number.isSafeInteger(r.manifest.totalBytes) && r.manifest.totalBytes >= 0 &&
    keysExactly(r.ledger, ["seq", "entryHash"]) && Number.isSafeInteger(r.ledger.seq) && r.ledger.seq >= 1 &&
    HEX64.test(r.ledger.entryHash) &&
    keysExactly(r.issuer, ["name", "keyId"]) && r.issuer.name === ISSUER_NAME && typeof r.issuer.keyId === "string";
}

export function signReceipt(receipt, signer) {
  return { receipt, signature: { alg: "EdDSA", keyId: signer.keyId, value: signer.sign(receipt) } };
}

/**
 * Offline verification of a signed receipt document against published keys.
 * Proves only that this prototype's key signed these exact fields; it says
 * nothing about legal sufficiency or receipt by any government institution.
 */
export function verifyReceiptDocument(doc, publicJwks) {
  if (!keysExactly(doc, ["receipt", "signature"])) return { valid: false, reason: "malformed_document" };
  if (!isReceiptShape(doc.receipt)) return { valid: false, reason: "malformed_receipt" };
  const sig = doc.signature;
  if (!keysExactly(sig, ["alg", "keyId", "value"]) || sig.alg !== "EdDSA" || sig.keyId !== doc.receipt.issuer.keyId)
    return { valid: false, reason: "malformed_signature" };
  const key = publicJwks.find((jwk) => jwk.kid === sig.keyId);
  if (!key) return { valid: false, reason: "unknown_key" };
  if (!verifySignature(key, doc.receipt, sig.value)) return { valid: false, reason: "bad_signature" };
  return { valid: true };
}
