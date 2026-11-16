import pg from "pg";
import { readFileSync } from "node:fs";

/**
 * Postgres access for the portal-local demo backend. Neon requires TLS; the
 * connection string's sslmode is honored. All durable state lives here
 * (including uploaded file bytes), so nothing depends on the instance disk.
 */
export function createPool(connectionString, { max = 5 } = {}) {
  if (typeof connectionString !== "string" || !/^postgres(?:ql)?:\/\//.test(connectionString))
    throw new Error("DATABASE_URL must be a postgres:// connection string");
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000,
    statement_timeout: 20_000 });
  pool.on("error", () => { /* idle client errors are retried by the pool; never crash the process */ });
  return pool;
}

export async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

const IMMUTABLE_TABLES = ["submissions", "documents", "manifests", "receipts", "ledger_entries", "agency_inbox_receipts"];

export const MIGRATIONS = [
  {
    id: "0001_demo_filing_core",
    sql: `
CREATE TABLE agencies (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{2,64}$'),
  name text NOT NULL,
  description text NOT NULL,
  filing_types text[] NOT NULL,
  fictional boolean NOT NULL DEFAULT true CHECK (fictional),
  routing_sla_hours integer NOT NULL CHECK (routing_sla_hours > 0)
);
CREATE TABLE ledger_entries (
  seq bigint PRIMARY KEY CHECK (seq >= 1),
  recorded_at timestamptz NOT NULL,
  event_type text NOT NULL,
  subject text NOT NULL,
  payload jsonb NOT NULL,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text NOT NULL UNIQUE CHECK (entry_hash ~ '^[0-9a-f]{64}$')
);
CREATE TABLE ledger_head (
  id integer PRIMARY KEY CHECK (id = 1),
  seq bigint NOT NULL,
  entry_hash text NOT NULL,
  recorded_at timestamptz NOT NULL
);
INSERT INTO ledger_head VALUES (1, 0, repeat('0', 64), '1970-01-01T00:00:00Z');
CREATE TABLE submissions (
  id uuid PRIMARY KEY,
  tracking_number text NOT NULL UNIQUE,
  access_salt text NOT NULL,
  access_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('original', 'amendment')),
  parent_id uuid REFERENCES submissions(id),
  agency_id text NOT NULL REFERENCES agencies(id),
  filing_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  claimant_name text NOT NULL,
  claimant_contact text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_sha256 text NOT NULL,
  received_at timestamptz NOT NULL,
  CHECK ((kind = 'original') = (parent_id IS NULL))
);
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id),
  ordinal integer NOT NULL,
  filename text NOT NULL,
  media_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea NOT NULL,
  UNIQUE (submission_id, ordinal)
);
CREATE TABLE manifests (
  submission_id uuid PRIMARY KEY REFERENCES submissions(id),
  manifest jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
CREATE TABLE receipts (
  receipt_id text PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id),
  document jsonb NOT NULL,
  ledger_seq bigint NOT NULL REFERENCES ledger_entries(seq)
);
CREATE TABLE status_events (
  id bigserial PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submissions(id),
  status text NOT NULL,
  note text NOT NULL DEFAULT '',
  actor text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ledger_seq bigint REFERENCES ledger_entries(seq)
);
CREATE INDEX status_events_submission ON status_events (submission_id, id);
CREATE TABLE routing_outbox (
  id bigserial PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id),
  agency_id text NOT NULL REFERENCES agencies(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until timestamptz,
  last_error text,
  delivered_at timestamptz,
  due_by timestamptz NOT NULL
);
CREATE INDEX routing_outbox_due ON routing_outbox (state, next_attempt_at);
CREATE TABLE agency_inbox_receipts (
  id bigserial PRIMARY KEY,
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id),
  agency_id text NOT NULL REFERENCES agencies(id),
  delivered_at timestamptz NOT NULL,
  acknowledgement text NOT NULL,
  ledger_seq bigint NOT NULL REFERENCES ledger_entries(seq)
);
CREATE TABLE rate_events (
  bucket text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX rate_events_bucket ON rate_events (bucket, at);
CREATE FUNCTION ufr_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = '42501';
END $$;
${IMMUTABLE_TABLES.map((t) => `CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t}
  FOR EACH ROW EXECUTE FUNCTION ufr_forbid_mutation();
CREATE TRIGGER ${t}_no_truncate BEFORE TRUNCATE ON ${t}
  FOR EACH STATEMENT EXECUTE FUNCTION ufr_forbid_mutation();`).join("\n")}
`,
  },
];

const MIGRATION_LOCK = 724_001_004;

/** Applies pending migrations under an advisory lock (safe with concurrent instances). */
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = new Set((await client.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
    const ran = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
        ran.push(migration.id);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** Seeds the clearly fictional demonstration agency directory (idempotent upsert). */
export async function seedAgencies(pool, path = new URL("../../config/demo-agencies.json", import.meta.url)) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (doc.schema !== "ufr-demo-agencies-v1" || doc.fictional !== true || !Array.isArray(doc.agencies))
    throw new Error("Invalid demo agency directory");
  for (const a of doc.agencies) {
    await pool.query(`INSERT INTO agencies (id, name, description, filing_types, fictional, routing_sla_hours)
      VALUES ($1, $2, $3, $4, true, $5)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
        filing_types = EXCLUDED.filing_types, routing_sla_hours = EXCLUDED.routing_sla_hours`,
    [a.id, a.name, a.description, a.filingTypes, a.routingSlaHours]);
  }
  return doc.agencies.length;
}
