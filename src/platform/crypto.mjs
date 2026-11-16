import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

/**
 * Envelope encryption (UFR-023 identity compartments, UFR-026 documents,
 * UFR-053 disposition). A key-encryption key (KEK) from DATA_ENCRYPTION_KEY
 * (64 hex chars, Render env only) wraps a random 256-bit data key per record.
 * Data keys live in the mutable data_keys table; destroying one
 * ("crypto-shredding") makes the append-only ciphertext permanently
 * unreadable without mutating immutable rows. Backups taken before
 * destruction still hold the wrapped key; see docs/OPERATIONS.md.
 */
export class KeyDestroyedError extends Error { constructor() { super("data_key_destroyed"); this.code = "data_key_destroyed"; } }

export function loadKek(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex.trim())) throw new Error("DATA_ENCRYPTION_KEY must be 64 hex characters");
  return Buffer.from(hex.trim(), "hex");
}

export function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
}

export function open(key, blob, aad) {
  if (!Buffer.isBuffer(blob) || blob.length < 29 || blob[0] !== 1) throw new Error("sealed_format");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
}

export class DataKeys {
  constructor(kek) { this.kek = kek; }
  async create(client, purpose, subject) {
    const id = randomUUID();
    const dek = randomBytes(32);
    await client.query("INSERT INTO data_keys (id, purpose, subject, wrapped) VALUES ($1,$2,$3,$4)",
      [id, purpose, subject, seal(this.kek, dek, `dek:${id}:${purpose}`)]);
    return { id, dek };
  }
  async get(db, id) {
    const row = (await db.query("SELECT purpose, wrapped, destroyed_at FROM data_keys WHERE id = $1", [id])).rows[0];
    if (!row || row.destroyed_at) throw new KeyDestroyedError();
    return open(this.kek, row.wrapped, `dek:${id}:${row.purpose}`);
  }
  async destroy(client, id, reason) {
    const r = await client.query(`UPDATE data_keys SET wrapped = '\\x'::bytea, destroyed_at = clock_timestamp(), destroyed_reason = $2
      WHERE id = $1 AND destroyed_at IS NULL`, [id, reason]);
    return r.rowCount === 1;
  }
}
