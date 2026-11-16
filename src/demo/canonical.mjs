import { createHash } from "node:crypto";

/**
 * Deterministic JSON encoding used for manifests, receipts and ledger
 * entries: object keys sorted by UTF-16 code unit, no whitespace, only
 * JSON-safe values. Anything ambiguous (undefined, functions, non-finite
 * numbers, non-plain objects) throws instead of being silently dropped.
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Non-finite number in canonical JSON");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        throw new TypeError("Non-plain object in canonical JSON");
      return "{" + Object.keys(value).sort().map((key) => {
        if (value[key] === undefined) throw new TypeError(`Undefined value for ${key}`);
        return JSON.stringify(key) + ":" + canonicalJson(value[key]);
      }).join(",") + "}";
    default:
      throw new TypeError(`Unsupported ${typeof value} in canonical JSON`);
  }
}

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
export const canonicalDigest = (value) => sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
