import { withTransaction } from "../demo/db.mjs";

/**
 * UFR-048 Compliance Engine event integration (demonstration). Forwards every
 * portal ledger entry, in sequence order, to the Compliance, Authorization &
 * Immutable Audit Engine (CAIAE) as an evidence record on a single resource
 * representing this portal. Payloads are content-free (identifiers, hashes,
 * states); tracking numbers are dropped. Delivery is exactly-once in effect:
 *   - a durable cursor records the last delivered sequence;
 *   - before sending, the sequence is marked in flight (committed);
 *   - if a previous attempt's outcome is unknown, the evidence list is
 *     reconciled by ledgerSeq before anything is resent;
 *   - failures back off exponentially (capped) and are visible to staff.
 * Configured only by CAIAE_API_BASE_URL, CAIAE_ORGANIZATION_ID and
 * CAIAE_OPERATOR_TOKEN (Render env); absent configuration disables it.
 */
export const EVIDENCE_TYPE = "ufr-portal-ledger-event";
export const RESOURCE_TYPE = "federal-filing-portal";
const DROP_KEYS = new Set(["trackingNumber"]);
const MAX_BACKOFF_SECONDS = 600;

export function caiaeConfig(env) {
  const baseUrl = env.CAIAE_API_BASE_URL?.trim(); const organizationId = env.CAIAE_ORGANIZATION_ID?.trim(); const token = env.CAIAE_OPERATOR_TOKEN?.trim();
  if (!baseUrl && !organizationId && !token) return null;
  if (!baseUrl || !organizationId || !token) throw new Error("CAIAE integration requires CAIAE_API_BASE_URL, CAIAE_ORGANIZATION_ID and CAIAE_OPERATOR_TOKEN");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("CAIAE_API_BASE_URL must be https");
  if (!/^[0-9a-f-]{36}$/.test(organizationId)) throw new Error("CAIAE_ORGANIZATION_ID must be a UUID");
  if (!/^caiau_[a-f0-9]{10}_[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("CAIAE_OPERATOR_TOKEN has an unexpected format");
  return { baseUrl: url.origin, organizationId, token, externalRef: env.CAIAE_PORTAL_EXTERNAL_REF?.trim() || "ufr-portal:federal-filing-receipt-portal-prototype" };
}

export class CaiaeClient {
  constructor({ baseUrl, organizationId, token, fetchImpl = globalThis.fetch, timeoutMs = 60_000 }) {
    Object.assign(this, { baseUrl, organizationId, token, fetchImpl, timeoutMs });
  }
  async request(path, { method = "GET", body } = {}) {
    const res = await this.fetchImpl(this.baseUrl + path, { method, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
      headers: { authorization: `Bearer ${this.token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`caiae_http_${res.status}`); e.status = res.status; e.detail = text.slice(0, 200); throw e; }
    return text ? JSON.parse(text) : null;
  }
  listResources() { return this.request(`/v1/organizations/${this.organizationId}/resources?resourceType=${RESOURCE_TYPE}`); }
  createResource(body) { return this.request("/v1/resources", { method: "POST", body: { organizationId: this.organizationId, ...body } }); }
  listEvidence(resourceId) { return this.request(`/v1/organizations/${this.organizationId}/resources/${resourceId}/evidence`); }
  createEvidence(body) { return this.request("/v1/evidence", { method: "POST", body: { organizationId: this.organizationId, ...body } }); }
}

const strip = (payload) => Object.fromEntries(Object.entries(payload ?? {}).filter(([k]) => !DROP_KEYS.has(k)));
const list = (x) => (Array.isArray(x) ? x : Array.isArray(x?.data) ? x.data : Array.isArray(x?.items) ? x.items : []);

export class CaiaeEventSync {
  constructor({ pool, client, externalRef, keyId, logger = () => {}, batch = 20 }) {
    Object.assign(this, { pool, client, externalRef, keyId, logger, batch });
  }

  async state() {
    await this.pool.query("INSERT INTO caiae_sync (id) VALUES (1) ON CONFLICT DO NOTHING");
    return (await this.pool.query("SELECT * FROM caiae_sync WHERE id = 1")).rows[0];
  }

  async #ensureResource(st) {
    if (st.resource_id) return st.resource_id;
    const existing = list(await this.client.listResources()).find((r) => r.externalRef === this.externalRef);
    const resource = existing ?? await this.client.createResource({ resourceType: RESOURCE_TYPE, externalRef: this.externalRef,
      name: "Federal Filing & Receipt Portal (demonstration, fictional)",
      attributes: { demo: true, fictional: true, ledgerSchema: "ufr-ledger-v1", receiptKeyId: this.keyId },
      metadata: { source: "federal-electronic-filing-receipt-portal", notice: "Synthetic demonstration data; not a government system." } });
    await this.pool.query("UPDATE caiae_sync SET resource_id = $1 WHERE id = 1", [resource.id]);
    this.logger("caiae.resource_ready", { resourceId: resource.id, created: !existing });
    return resource.id;
  }

  /** Delivers up to `batch` pending ledger entries. Returns the count delivered. Never throws. */
  async run(now = new Date()) {
    const st = await this.state();
    if (st.next_attempt_at && st.next_attempt_at > now) return 0;
    let delivered = 0;
    try {
      const resourceId = await this.#ensureResource(st);
      let cursor = Number(st.delivered_seq);
      if (st.in_flight_seq !== null) {
        // The previous attempt's outcome is unknown: reconcile before resending anything.
        const seq = Number(st.in_flight_seq);
        const found = list(await this.client.listEvidence(resourceId)).some((e) => e.evidenceType === EVIDENCE_TYPE && Number(e.attributes?.ledgerSeq) === seq);
        if (found) { cursor = seq; this.logger("caiae.reconciled", { seq }); }
        await this.pool.query("UPDATE caiae_sync SET delivered_seq = $1, in_flight_seq = NULL WHERE id = 1", [cursor]);
      }
      const rows = (await this.pool.query(`SELECT seq, recorded_at, event_type, subject, payload, prev_hash, entry_hash FROM ledger_entries
        WHERE seq > $1 ORDER BY seq LIMIT $2`, [cursor, this.batch])).rows;
      for (const r of rows) {
        const seq = Number(r.seq);
        await this.pool.query("UPDATE caiae_sync SET in_flight_seq = $1 WHERE id = 1", [seq]);
        const evidence = await this.client.createEvidence({ resourceId, evidenceType: EVIDENCE_TYPE, title: `${r.event_type} #${seq}`,
          source: "federal-electronic-filing-receipt-portal (demo)", checksumAlgorithm: "sha256", checksum: r.entry_hash,
          capturedAt: r.recorded_at.toISOString(), correlationId: `ufr-ledger-${seq}`,
          provenance: { system: "federal-electronic-filing-receipt-portal", ledgerSeq: seq, receiptKeyId: this.keyId, demo: true },
          attributes: { ledgerSeq: seq, eventType: r.event_type, subject: r.subject, payload: strip(r.payload), prevHash: r.prev_hash, entryHash: r.entry_hash },
          metadata: { demo: true, fictional: true } });
        await withTransaction(this.pool, async (c) => {
          await c.query(`UPDATE caiae_sync SET delivered_seq = $1, in_flight_seq = NULL, attempts = 0, last_error = NULL, next_attempt_at = NULL,
            last_delivered_at = clock_timestamp(), last_evidence_id = $2 WHERE id = 1`, [seq, evidence?.id ?? null]);
        });
        delivered++;
      }
      if (delivered) this.logger("caiae.events_delivered", { count: delivered, throughSeq: Number(rows.at(-1).seq) });
      else if (Number(st.attempts) > 0) await this.pool.query("UPDATE caiae_sync SET attempts = 0, last_error = NULL, next_attempt_at = NULL WHERE id = 1");
      return delivered;
    } catch (error) {
      const attempts = Number(st.attempts) + 1;
      const backoff = Math.min(MAX_BACKOFF_SECONDS, 5 * 2 ** Math.min(attempts, 10));
      await this.pool.query(`UPDATE caiae_sync SET attempts = $1, last_error = $2, next_attempt_at = clock_timestamp() + make_interval(secs => $3) WHERE id = 1`,
        [attempts, String(error?.message ?? "error").slice(0, 120), backoff]).catch(() => undefined);
      this.logger("caiae.delivery_retry", { attempts, backoffSeconds: backoff, error: String(error?.message ?? "error").slice(0, 120), delivered });
      return delivered;
    }
  }

  async status() {
    const st = await this.state();
    const head = Number((await this.pool.query("SELECT seq FROM ledger_head WHERE id = 1")).rows[0].seq);
    return { deliveredSeq: Number(st.delivered_seq), headSeq: head, lag: head - Number(st.delivered_seq), attempts: st.attempts,
      lastError: st.last_error, lastDeliveredAt: st.last_delivered_at, resourceId: st.resource_id };
  }
}
