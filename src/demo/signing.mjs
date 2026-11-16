import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical.mjs";

/**
 * Ed25519 receipt signing. The private key is supplied only through the
 * RECEIPT_SIGNING_KEY environment variable (base64 PKCS#8 DER) and is never
 * written to disk, logs or responses. Without it, filing fails closed.
 */
export class SigningKeyError extends Error {}

function keyIdFor(publicKey) {
  return "demo-ed25519-" + sha256Hex(publicKey.export({ type: "spki", format: "der" })).slice(0, 16);
}

export function loadSigningKey(encoded) {
  if (typeof encoded !== "string" || encoded.trim() === "") throw new SigningKeyError("RECEIPT_SIGNING_KEY is not configured");
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(encoded.trim(), "base64"), format: "der", type: "pkcs8" });
  } catch { throw new SigningKeyError("RECEIPT_SIGNING_KEY is not a valid PKCS#8 key"); }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new SigningKeyError("RECEIPT_SIGNING_KEY must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const keyId = keyIdFor(publicKey);
  return Object.freeze({
    keyId,
    publicJwk: Object.freeze({ ...publicKey.export({ format: "jwk" }), kid: keyId, use: "sig", alg: "EdDSA" }),
    sign: (value) => sign(null, Buffer.from(canonicalJson(value), "utf8"), privateKey).toString("base64url"),
  });
}

/** Test/bootstrap helper: a fresh key encoded the way RECEIPT_SIGNING_KEY expects. */
export function generateSigningKeyEncoded() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
}

export function verifySignature(publicJwk, value, signature) {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const key = createPublicKey({ key: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x }, format: "jwk" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(canonicalJson(value), "utf8"), key, Buffer.from(signature, "base64url"));
  } catch { return false; }
}
