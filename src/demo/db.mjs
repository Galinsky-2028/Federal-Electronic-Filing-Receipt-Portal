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
  {
    id: "0002_security_data_claimant",
    sql: `
ALTER TABLE submissions ADD COLUMN structured jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE submissions ADD COLUMN emergency boolean NOT NULL DEFAULT false;
ALTER TABLE submissions ADD COLUMN identity_protected boolean NOT NULL DEFAULT false;
CREATE TABLE data_keys (
  id uuid PRIMARY KEY, purpose text NOT NULL CHECK (purpose IN ('identity', 'document', 'content')), subject uuid NOT NULL,
  wrapped bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  destroyed_at timestamptz, destroyed_reason text
);
CREATE INDEX data_keys_subject ON data_keys (subject);
ALTER TABLE documents ADD COLUMN encryption text NOT NULL DEFAULT 'none' CHECK (encryption IN ('none', 'aes-256-gcm-envelope'));
ALTER TABLE documents ADD COLUMN key_id uuid REFERENCES data_keys(id);
CREATE TABLE identity_vault (
  submission_id uuid PRIMARY KEY REFERENCES submissions(id), key_id uuid NOT NULL REFERENCES data_keys(id), sealed bytea NOT NULL
);
CREATE TABLE content_vault (
  submission_id uuid PRIMARY KEY REFERENCES submissions(id), key_id uuid NOT NULL REFERENCES data_keys(id), sealed bytea NOT NULL
);
CREATE TRIGGER content_vault_append_only BEFORE UPDATE OR DELETE ON content_vault FOR EACH ROW EXECUTE FUNCTION ufr_forbid_mutation();
CREATE TABLE scan_results (
  id bigserial PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id),
  verdict text NOT NULL CHECK (verdict IN ('clean', 'suspicious', 'infected', 'error')),
  engine text NOT NULL, detail text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(), ledger_seq bigint REFERENCES ledger_entries(seq)
);
CREATE TABLE staff_users (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
  password_hash text NOT NULL, roles text[] NOT NULL, totp_secret text, mfa_enabled boolean NOT NULL DEFAULT false,
  totp_last_step bigint NOT NULL DEFAULT -1, disabled boolean NOT NULL DEFAULT false,
  failed_logins integer NOT NULL DEFAULT 0, locked_until timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE reveal_requests (
  id uuid PRIMARY KEY, submission_id uuid NOT NULL REFERENCES submissions(id), requested_by uuid NOT NULL REFERENCES staff_users(id),
  reason text NOT NULL, requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by uuid REFERENCES staff_users(id), approved_at timestamptz, consumed_at timestamptz, expires_at timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE TABLE drafts (
  code_hash text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL
);
CREATE TABLE delegations (
  id uuid PRIMARY KEY, root_id uuid NOT NULL REFERENCES submissions(id), label text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('view', 'view_supplement')), code_salt text NOT NULL, code_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz
);
CREATE TABLE corrections (
  id uuid PRIMARY KEY, submission_id uuid NOT NULL REFERENCES submissions(id),
  kind text NOT NULL CHECK (kind IN ('receipt_correction', 'processing_complaint', 'withdrawal')),
  statement text NOT NULL, filed_by text NOT NULL, filed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decision text CHECK (decision IN ('accepted', 'denied')), decision_note text, decided_by uuid REFERENCES staff_users(id),
  decided_at timestamptz, correction_document jsonb, ledger_seq bigint REFERENCES ledger_entries(seq)
);
CREATE TABLE legal_holds (
  submission_id uuid PRIMARY KEY REFERENCES submissions(id), reason text NOT NULL, placed_by uuid NOT NULL REFERENCES staff_users(id),
  placed_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz
);
CREATE TABLE dispositions (
  submission_id uuid PRIMARY KEY REFERENCES submissions(id), disposed_at timestamptz NOT NULL, rule text NOT NULL, ledger_seq bigint NOT NULL REFERENCES ledger_entries(seq)
);
CREATE TABLE notification_outbox (
  id bigserial PRIMARY KEY, channel text NOT NULL CHECK (channel IN ('staff-queue', 'claimant-portal', 'email-simulated')),
  audience text NOT NULL, template text NOT NULL, payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'dead')), attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivered_at timestamptz
);
CREATE TRIGGER identity_vault_append_only BEFORE UPDATE OR DELETE ON identity_vault FOR EACH ROW EXECUTE FUNCTION ufr_forbid_mutation();
CREATE TRIGGER scan_results_append_only BEFORE UPDATE OR DELETE ON scan_results FOR EACH ROW EXECUTE FUNCTION ufr_forbid_mutation();
CREATE TRIGGER dispositions_append_only BEFORE UPDATE OR DELETE ON dispositions FOR EACH ROW EXECUTE FUNCTION ufr_forbid_mutation();
`,
  },
  {
    id: "0003_workflows_oversight_operations",
    sql: `
CREATE TABLE deadlines (
  id bigserial PRIMARY KEY, submission_id uuid NOT NULL REFERENCES submissions(id), rule_id text NOT NULL, rule_version text NOT NULL,
  start_date date NOT NULL, due_date date NOT NULL, due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'met', 'missed', 'tolled', 'cancelled')),
  tolled_at timestamptz, closed_at timestamptz, ledger_seq bigint REFERENCES ledger_entries(seq),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX deadlines_open ON deadlines (state, due_at);
CREATE TABLE notices (
  id uuid PRIMARY KEY, submission_id uuid NOT NULL REFERENCES submissions(id),
  kind text NOT NULL CHECK (kind IN ('acknowledgement', 'information_request', 'defect', 'determination', 'general', 'claimant_reply')),
  author text NOT NULL, body text NOT NULL, sent_at timestamptz NOT NULL, cure_due_at timestamptz,
  ledger_seq bigint NOT NULL REFERENCES ledger_entries(seq), read_at timestamptz, read_ledger_seq bigint REFERENCES ledger_entries(seq),
  cure_outcome text CHECK (cure_outcome IN ('cured_relates_back', 'cured_late'))
);
CREATE INDEX notices_submission ON notices (submission_id, sent_at);
CREATE TABLE ledger_checkpoints (
  seq bigint PRIMARY KEY, head_hash text NOT NULL, created_at timestamptz NOT NULL, key_id text NOT NULL, signature text NOT NULL
);
CREATE TRIGGER ledger_checkpoints_append_only BEFORE UPDATE OR DELETE ON ledger_checkpoints FOR EACH ROW EXECUTE FUNCTION ufr_forbid_mutation();
CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY, token_hash text NOT NULL, filename text NOT NULL, media_type text NOT NULL, total_size integer NOT NULL,
  received integer NOT NULL DEFAULT 0, completed boolean NOT NULL DEFAULT false, consumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL
);
CREATE TABLE upload_chunks (
  session_id uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE, start_offset integer NOT NULL, data bytea NOT NULL,
  PRIMARY KEY (session_id, start_offset)
);
CREATE TABLE escalations (
  submission_id uuid NOT NULL REFERENCES submissions(id), kind text NOT NULL, ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (submission_id, kind, ref)
);
`,
  },
  {
    id: "0004_caiae_event_sync",
    sql: `
CREATE TABLE caiae_sync (
  id integer PRIMARY KEY CHECK (id = 1), resource_id text, delivered_seq bigint NOT NULL DEFAULT 0, in_flight_seq bigint,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz, last_error text, last_delivered_at timestamptz, last_evidence_id text
);
INSERT INTO caiae_sync (id) VALUES (1);
`,
  },
  {
    id: "0005_claimant_accounts",
    sql: `
CREATE TABLE claimant_accounts (
  id uuid PRIMARY KEY, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), disabled_at timestamptz
);
CREATE TABLE passkeys (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]+$' AND length(id) BETWEEN 16 AND 1366), account_id uuid NOT NULL REFERENCES claimant_accounts(id),
  public_key bytea NOT NULL, counter bigint NOT NULL DEFAULT 0, transports text[] NOT NULL DEFAULT '{}', label text NOT NULL,
  backed_up boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_used_at timestamptz, removed_at timestamptz
);
CREATE INDEX passkeys_account ON passkeys (account_id);
CREATE TABLE recovery_codes (
  account_id uuid NOT NULL REFERENCES claimant_accounts(id), code_hash text NOT NULL, generation integer NOT NULL,
  used_at timestamptz, PRIMARY KEY (account_id, code_hash)
);
CREATE TABLE account_sessions (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES claimant_accounts(id), method text NOT NULL CHECK (method IN ('passkey', 'recovery_code', 'registration')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, client_hint text NOT NULL DEFAULT ''
);
CREATE INDEX account_sessions_account ON account_sessions (account_id);
CREATE TABLE account_filings (
  account_id uuid NOT NULL REFERENCES claimant_accounts(id), root_id uuid NOT NULL REFERENCES submissions(id),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (account_id, root_id)
);
CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY, purpose text NOT NULL CHECK (purpose IN ('register', 'login', 'add_passkey')), challenge text NOT NULL,
  account_id uuid REFERENCES claimant_accounts(id), user_handle text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL
);
CREATE TABLE account_recovery_requests (
  id uuid PRIMARY KEY, channel text NOT NULL, contact_sha256 text NOT NULL, state text NOT NULL CHECK (state IN ('undeliverable', 'queued')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
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
