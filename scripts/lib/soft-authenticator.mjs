// Software WebAuthn authenticator for tests and headless live smoke checks.
// Produces real "none"-attestation registrations and ES256 assertions
// (CBOR/COSE, P-256, authenticator data with UP+UV flags and a signature
// counter), so the server's verification runs unmodified. Test use only.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();

/** Minimal CBOR encoder (unsigned/negative ints, byte/text strings, arrays, maps). */
export function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (v && typeof v === "object") return cbor(new Map(Object.entries(v)));
  throw new TypeError("unsupported CBOR value");
}

export class SoftAuthenticator {
  constructor({ origin, rpID }) {
    this.origin = origin; this.rpID = rpID; this.credentials = new Map();
  }
  #authData(flags, counter, attested = null) {
    const parts = [sha256(this.rpID), Buffer.from([flags]), Buffer.alloc(4)];
    parts[2].writeUInt32BE(counter);
    if (attested) {
      const len = Buffer.alloc(2); len.writeUInt16BE(attested.id.length);
      const jwk = attested.publicKey.export({ format: "jwk" });
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
      parts.push(Buffer.alloc(16), len, attested.id, cose);
    }
    return Buffer.concat(parts);
  }
  /** navigator.credentials.create() equivalent; returns the JSON the browser script posts. */
  create(options, { origin = this.origin } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const id = randomBytes(16);
    const cred = { id, privateKey, publicKey, counter: 0, userHandle: options.user.id };
    this.credentials.set(b64u(id), cred);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", this.#authData(0x45, 0, cred)]]));
    return { id: b64u(id), rawId: b64u(id), type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ["internal"] } };
  }
  /** navigator.credentials.get() equivalent for a discoverable credential. */
  get(options, { credentialId = [...this.credentials.keys()][0], origin = this.origin, counterDelta = 1, flags = 0x05 } = {}) {
    const cred = this.credentials.get(credentialId);
    cred.counter += counterDelta;
    const authenticatorData = this.#authData(flags, cred.counter);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), cred.privateKey);
    return { id: credentialId, rawId: credentialId, type: "public-key", clientExtensionResults: {}, authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), userHandle: cred.userHandle } };
  }
}
