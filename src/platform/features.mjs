import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { escapeHtml as h } from "../public-shell.mjs";
import { ALLOWED_MEDIA_TYPES, IntakeError, LIMITS, sniffMatches } from "../demo/backend.mjs";
import { verifyLedger } from "../demo/ledger.mjs";
import { registerDemoPaths, readBody } from "../demo/routes.mjs";
import { layout } from "../demo/views.mjs";
import { msg, statusText } from "../demo/views2.mjs";
import { RULESET_VERSION } from "./deadlines.mjs";
import { GUIDE, structuredForms } from "./guided.mjs";
import { hasRole } from "./services.mjs";
import { WorkflowServices } from "./workflows.mjs";
import { CaiaeClient, CaiaeEventSync, caiaeConfig } from "./caiae-sync.mjs";
import { filePage2 } from "../demo/views2.mjs";

const UUID = "[0-9a-f-]{36}";
const CHUNK = 1024 * 1024;
const csrfField = (t) => `<input type="hidden" name="csrf" value="${h(t)}">`;
const when = (d) => (d ? new Date(d).toISOString().replace(".000Z", "Z") : "");
const sha = (x) => createHash("sha256").update(x).digest("hex");
const eqHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearer = (req) => (/^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? "") ?? [])[1] ?? "";
const k = (n) => (n > 0 && n < 5 ? "fewer than 5" : String(n)); // small-cell suppression for public statistics

registerDemoPaths(
  (p) => ["/transparency", "/es", "/help/assistance", "/track/reply", "/api/ledger/checkpoints", "/api/ledger/checkpoints/latest",
    "/api/metrics", "/api/uploads"].includes(p),
  (p) => new RegExp(`^/api/(uploads/${UUID}|events/after/\\d{1,12})$`).test(p),
);

/** Resumable evidence uploads (UFR-028): chunked, offset-checked, token-bound, consumed by a filing. */
class Uploads {
  constructor(pool) { this.pool = pool; }
  async create({ filename, mediaType, size }) {
    if (typeof filename !== "string" || !filename.trim() || filename.length > LIMITS.filename) throw new IntakeError("invalid_filename");
    if (!ALLOWED_MEDIA_TYPES.includes(mediaType)) throw new IntakeError("unsupported_file_type");
    if (!Number.isSafeInteger(size) || size < 1 || size > LIMITS.fileBytes) throw new IntakeError("file_too_large");
    const id = randomUUID(); const token = randomBytes(24).toString("base64url");
    await this.pool.query("DELETE FROM upload_sessions WHERE expires_at < clock_timestamp()");
    await this.pool.query(`INSERT INTO upload_sessions (id, token_hash, filename, media_type, total_size, expires_at)
      VALUES ($1,$2,$3,$4,$5, clock_timestamp() + interval '24 hours')`, [id, sha(token), filename.trim(), mediaType, size]);
    return { uploadId: id, uploadToken: token, chunkLimit: CHUNK };
  }
  async #session(id, token, c = this.pool) {
    const s = (await c.query("SELECT * FROM upload_sessions WHERE id = $1 AND expires_at > clock_timestamp()", [id])).rows[0];
    if (!s || typeof token !== "string" || !eqHash(s.token_hash, sha(token))) throw new IntakeError("upload_not_found", 404);
    return s;
  }
  async status(id, token) { const s = await this.#session(id, token); return { received: s.received, total: s.total_size, completed: s.completed }; }
  async put(id, token, range, data) {
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range ?? "");
    if (!m) throw new IntakeError("invalid_content_range");
    const [start, end, total] = m.slice(1).map(Number);
    const s = await this.#session(id, token);
    if (s.completed || s.consumed) throw new IntakeError("upload_complete", 409);
    if (total !== s.total_size || end - start + 1 !== data.length || end >= total) throw new IntakeError("invalid_content_range");
    if (start !== s.received) return { received: s.received, total, completed: false, offsetMismatch: true };
    await this.pool.query("INSERT INTO upload_chunks (session_id, start_offset, data) VALUES ($1,$2,$3)", [id, start, data]);
    const done = end + 1 === total;
    await this.pool.query("UPDATE upload_sessions SET received = $2, completed = $3 WHERE id = $1", [id, end + 1, done]);
    return { received: end + 1, total, completed: done };
  }
  /** Resolves "id:token,id:token" into completed documents; validated again by the filing path. */
  async resolve(field) {
    if (!field) return [];
    const out = [];
    for (const pair of String(field).split(",").map((x) => x.trim()).filter(Boolean).slice(0, LIMITS.files)) {
      const [id, token] = pair.split(":");
      if (!new RegExp(`^${UUID}$`).test(id ?? "")) throw new IntakeError("upload_not_found", 404);
      const s = await this.#session(id, token);
      if (!s.completed || s.consumed) throw new IntakeError("upload_incomplete", 409);
      const chunks = (await this.pool.query("SELECT data FROM upload_chunks WHERE session_id = $1 ORDER BY start_offset", [id])).rows;
      out.push({ filename: s.filename, mediaType: s.media_type, content: Buffer.concat(chunks.map((r) => r.data)), uploadId: id });
    }
    return out;
  }
  async consume(ids) { if (ids.length) await this.pool.query("UPDATE upload_sessions SET consumed = true WHERE id = ANY($1)", [ids]); }
}

function guidePage() {
  return layout({ title: "Filing guide", path: "/file", body: `<p class="eyebrow">Guided filing</p><h1>What do you need to do?</h1>` +
    `<p class="lead">Choose the closest description. You will get a form with the details that kind of filing usually needs. Fictional agencies only; this is not legal advice.</p>` +
    `<ul class="guide-list">${GUIDE.map((g) => `<li><a href="/file/guide/${h(g.type)}"><strong>${h(g.purpose)}</strong></a><br><span class="small">${h(g.detail)}</span></li>`).join("")}</ul>` });
}

function spanishPage() {
  return layout({ title: "Español", path: "/es", body: `<div lang="es"><p class="eyebrow">Prototipo de demostración</p><h1>Presentación electrónica y acuse de recibo (demostración)</h1>` +
    `<section class="error-summary" role="note"><p><strong>No es un servicio oficial del Gobierno de los Estados Unidos.</strong> Use solo datos ficticios. Los acuses de esta página no son acuses del gobierno y no preservan ningún plazo legal.</p></section>` +
    `<h2>Cómo usar la demostración</h2><ol><li><a href="/file/guide">Elija qué necesita presentar</a> y complete el formulario con información inventada.</li>` +
    `<li>Guarde el <strong>número de seguimiento</strong> y el <strong>código de acceso</strong>; el código se muestra una sola vez.</li>` +
    `<li><a href="/track">Consulte el estado</a> con ambos datos. Puede agregar documentos complementarios, pedir correcciones o retirar la presentación.</li>` +
    `<li><a href="/verify">Verifique un acuse</a> pegando el JSON firmado; la verificación no revela el contenido.</li></ol>` +
    `<h2>Seguridad</h2><p>No envíe información clasificada ni datos personales reales. Si el sistema detecta marcas de clasificación, detiene el envío y no guarda el contenido.</p>` +
    `<h2>Ayuda</h2><p>Consulte la <a href="/help/assistance">página de asistencia</a> (en inglés). Los formularios todavía están en inglés; la traducción completa está pendiente.</p></div>` });
}

function assistancePage() {
  return layout({ title: "Assistance", path: "/help", body: `<p class="eyebrow">Public assistance</p><h1>Getting help with the demonstration</h1>` +
    `<section class="prose"><h2>Accessible by design</h2><p>Every page works without JavaScript, with a keyboard and with screen readers. Pages are small for slow connections, and receipts have a <a href="/track">plain-text version</a> for low-bandwidth use and printing.</p>` +
    `<h2>Language</h2><p><a href="/es" lang="es" hreflang="es">Información en español</a>.</p>` +
    `<h2>Representatives</h2><p>From the status page, a filer can create a separate, revocable code for a representative, who can view or also supplement the filing.</p>` +
    `<h2>Human assistance</h2><p>A production service would list staffed phone, TTY and in-person options from the receiving institution. This demonstration has no staffed assistance line and no real agency contacts.</p>` +
    `<h2>Emergencies</h2><p>For an immediate danger, contact local emergency services. The demo's emergency flag only prioritizes fictional routing.</p></section>` });
}

export async function loadFeatureModules({ backend, platform, env = {}, logger = () => {} }) {
  const workflows = new WorkflowServices({ backend, platform, logger });
  const uploads = new Uploads(backend.pool);
  backend.onFiled.push((result) => workflows.onFiled(result));
  platform.uploads = uploads;
  platform.workflows = workflows;
  const caiae = caiaeConfig(env);
  const caiaeSync = caiae ? new CaiaeEventSync({ pool: backend.pool, client: new CaiaeClient({ ...caiae, fetchImpl: env.__caiaeFetch }),
    externalRef: caiae.externalRef, keyId: backend.signer.keyId, logger }) : null;

  async function oversightData() {
    const q = async (sql, p = []) => (await backend.pool.query(sql, p)).rows;
    const [statuses, deadlines, routing, reveals, misc, ledger, checkpoint] = await Promise.all([
      q(`SELECT st, count(*)::int n FROM (SELECT DISTINCT ON (submission_id) submission_id, status st FROM status_events ORDER BY submission_id, id DESC) x GROUP BY st ORDER BY n DESC`),
      q("SELECT state, count(*)::int n FROM deadlines GROUP BY state"),
      q("SELECT state, count(*)::int n, count(*) FILTER (WHERE state = 'pending' AND due_by < clock_timestamp())::int overdue FROM routing_outbox GROUP BY state"),
      q("SELECT count(*)::int requested, count(approved_at)::int approved, count(consumed_at)::int consumed FROM reveal_requests"),
      q(`SELECT (SELECT count(*)::int FROM submissions) filings, (SELECT count(*)::int FROM submissions WHERE emergency) emergencies,
        (SELECT count(*)::int FROM legal_holds WHERE released_at IS NULL) holds, (SELECT count(*)::int FROM dispositions) disposed,
        (SELECT count(*)::int FROM staff_users WHERE NOT mfa_enabled AND NOT disabled) staff_without_mfa,
        (SELECT count(*)::int FROM ledger_entries WHERE event_type = 'intake.classified_marking_refused') classified_refusals,
        (SELECT count(*)::int FROM corrections WHERE decision IS NULL) open_corrections,
        (SELECT count(*)::int FROM scan_results WHERE verdict <> 'clean') quarantined`),
      verifyLedger(backend.pool),
      q("SELECT seq, created_at FROM ledger_checkpoints ORDER BY seq DESC LIMIT 1"),
    ]);
    return { statuses, deadlines, routing, reveals: reveals[0], misc: misc[0], ledger, checkpoint: checkpoint[0] ?? null,
      caiae: caiaeSync ? await caiaeSync.status() : null };
  }

  async function transparencyData() {
    const q = async (sql) => (await backend.pool.query(sql)).rows;
    const [byAgency, ack, deadlines, routing] = await Promise.all([
      q(`SELECT a.name, s.filing_type, count(*)::int n FROM submissions s JOIN agencies a ON a.id = s.agency_id WHERE s.kind = 'original' GROUP BY 1, 2 ORDER BY 1, 2`),
      q(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e.at - s.received_at)) / 3600) median_hours, count(*)::int n
         FROM submissions s JOIN LATERAL (SELECT at FROM status_events WHERE submission_id = s.id AND status = 'acknowledged' ORDER BY id LIMIT 1) e ON true`),
      q("SELECT count(*) FILTER (WHERE state = 'met')::int met, count(*) FILTER (WHERE state = 'missed')::int missed FROM deadlines WHERE rule_id NOT IN ('records.appeal_window', 'tort.suit_window', 'defect.cure')"),
      q("SELECT count(*) FILTER (WHERE state = 'delivered' AND delivered_at <= due_by)::int on_time, count(*) FILTER (WHERE state = 'delivered')::int delivered FROM routing_outbox"),
    ]);
    return { byAgency, ack: ack[0], deadlines: deadlines[0], routing: routing[0] };
  }

  async function metricsText() {
    const r = (await backend.pool.query(`SELECT (SELECT count(*) FROM submissions WHERE kind = 'original') originals, (SELECT count(*) FROM submissions WHERE kind = 'amendment') amendments,
      (SELECT seq FROM ledger_head) ledger_seq, (SELECT count(*) FROM routing_outbox WHERE state = 'pending') routing_pending,
      (SELECT count(*) FROM routing_outbox WHERE state = 'dead') routing_dead, (SELECT count(*) FROM deadlines WHERE state = 'open') deadlines_open,
      (SELECT count(*) FROM deadlines WHERE state = 'missed') deadlines_missed, (SELECT count(*) FROM notification_outbox WHERE state = 'pending') notifications_pending,
      (SELECT EXTRACT(EPOCH FROM clock_timestamp() - max(created_at)) FROM ledger_checkpoints) checkpoint_age`)).rows[0];
    const line = (name, help, value, labels = "") => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${labels} ${Number(value ?? 0)}`;
    return [line("ufr_submissions", "Demo filings by kind", r.originals, '{kind="original"}'), `ufr_submissions{kind="amendment"} ${Number(r.amendments)}`,
      line("ufr_ledger_seq", "Ledger head sequence", r.ledger_seq), line("ufr_routing_pending", "Pending routing deliveries", r.routing_pending),
      line("ufr_routing_dead", "Dead-lettered routing deliveries", r.routing_dead), line("ufr_deadlines_open", "Open deadlines", r.deadlines_open),
      line("ufr_deadlines_missed", "Missed deadlines", r.deadlines_missed), line("ufr_notifications_pending", "Pending notifications", r.notifications_pending),
      line("ufr_checkpoint_age_seconds", "Age of newest signed ledger checkpoint", r.checkpoint_age ?? -1),
      ...(caiaeSync ? [line("ufr_caiae_event_lag", "Ledger entries not yet delivered to the Compliance Engine", (await caiaeSync.status()).lag)] : []),
      line("process_resident_memory_bytes", "RSS", process.memoryUsage().rss), line("process_uptime_seconds", "Uptime", Math.floor(process.uptime()))].join("\n") + "\n";
  }

  async function extension(ctx) {
    const { path, isGet, isPost, html, json, redirect, req, method } = ctx;
    let m;
    // ------------------------------------------------ guided filing (UFR-017/018)
    if (path === "/file/guide" && isGet) return html(200, guidePage());
    if ((m = /^\/file\/guide\/([a-z-]{2,40})$/.exec(path))) {
      const entry = GUIDE.find((g) => g.type === m[1]);
      if (!entry || !isGet) return json(404, { error: "not_found" });
      const agencies = (await backend.listAgencies()).filter((a) => a.filingTypes.includes(entry.type));
      const values = { filingType: entry.type };
      return html(200, filePage2({ agencies, idempotencyKey: randomBytes(18).toString("base64url"), values,
        structuredHtml: structuredForms.render(entry.type, values) }).replace("<h1>Submit a demonstration filing</h1>", `<h1>${h(entry.purpose)}</h1>`));
    }
    // ------------------------------------------------ public pages
    if (path === "/es" && isGet) return html(200, spanishPage());
    if (path === "/help/assistance" && isGet) return html(200, assistancePage());
    if (path === "/transparency" && isGet) {
      const t = await transparencyData();
      const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
      return html(200, layout({ title: "Transparency", path: "/transparency", body: `<p class="eyebrow">Public accountability (UFR-051)</p><h1>Demonstration service statistics</h1>` +
        `<p class="lead">Aggregate statistics computed live from <strong>synthetic demonstration data</strong> and fictional agencies. Counts from 1 to 4 are suppressed to protect privacy.</p>` +
        `<div class="table-wrap"><table><caption>Original filings by fictional agency and type</caption><thead><tr><th scope="col">Agency</th><th scope="col">Type</th><th scope="col">Filings</th></tr></thead><tbody>` +
        (t.byAgency.length ? t.byAgency.map((r) => `<tr><td>${h(r.name)}</td><td>${h(r.filing_type)}</td><td>${k(r.n)}</td></tr>`).join("") : `<tr><td colspan="3">No filings yet.</td></tr>`) + `</tbody></table></div>` +
        `<dl class="facts"><dt>Routing delivered on time</dt><dd>${pct(t.routing.on_time, t.routing.delivered)} of ${k(t.routing.delivered)}</dd>` +
        `<dt>Agency deadlines met</dt><dd>${pct(t.deadlines.met, t.deadlines.met + t.deadlines.missed)} (${k(t.deadlines.met)} met, ${k(t.deadlines.missed)} missed)</dd>` +
        `<dt>Median hours to acknowledgement</dt><dd>${t.ack.n >= 5 ? Number(t.ack.median_hours).toFixed(1) : "suppressed (fewer than 5)"}</dd>` +
        `<dt>Ledger checkpoints</dt><dd><a href="/api/ledger/checkpoints">Signed ledger checkpoints (JSON)</a></dd><dt>Deadline rules</dt><dd>${h(RULESET_VERSION)} (demonstration estimates)</dd></dl>` }));
    }
    // ------------------------------------------------ checkpoints, metrics, events feed (UFR-049/058/048)
    if (path === "/api/ledger/checkpoints" && isGet) return json(200, { schema: "ufr-demo-ledger-checkpoints-v1", demo: true, keys: backend.publicKeys(), checkpoints: await workflows.checkpoints() });
    if (path === "/api/ledger/checkpoints/latest" && isGet) {
      const [latest] = await workflows.checkpoints(1);
      return latest ? json(200, latest) : json(404, { error: "no_checkpoint" });
    }
    if (path === "/api/metrics") {
      const token = env.METRICS_TOKEN;
      if (!token || !isGet) return json(404, { error: "not_found" });
      if (!eqHash(sha(bearer(req)), sha(token))) return { status: 401, body: { error: "unauthorized" }, headers: { "www-authenticate": "Bearer" } };
      return { status: 200, contentType: "text/plain; version=0.0.4; charset=utf-8", rawBody: await metricsText() };
    }
    if ((m = /^\/api\/events\/after\/(\d{1,12})$/.exec(path))) {
      const token = env.EVENTS_FEED_TOKEN;
      if (!token || !isGet) return json(404, { error: "not_found" });
      if (!eqHash(sha(bearer(req)), sha(token))) return { status: 401, body: { error: "unauthorized" }, headers: { "www-authenticate": "Bearer" } };
      const rows = (await backend.pool.query(`SELECT seq, recorded_at, event_type, subject, payload, prev_hash, entry_hash FROM ledger_entries
        WHERE seq > $1 ORDER BY seq LIMIT 100`, [Number(m[1])])).rows;
      return json(200, { schema: "ufr-demo-event-feed-v1", demo: true, events: rows.map((r) => ({ seq: Number(r.seq), recordedAt: r.recorded_at.toISOString(),
        eventType: r.event_type, subject: r.subject, payload: r.payload, prevHash: r.prev_hash, entryHash: r.entry_hash })) });
    }
    // ------------------------------------------------ resumable uploads (UFR-028), token-authenticated JSON API
    if (path === "/api/uploads") {
      if (!isPost) return { status: 405, body: { error: "method_not_allowed" }, allow: "POST" };
      await ctx.limit(req, "upload-create", 30, 600);
      let body; try { body = JSON.parse((await readBody(req, 4096)).toString("utf8")); } catch { return json(400, { error: "invalid_request" }); }
      try { return json(201, await uploads.create(body ?? {})); } catch (e) { if (e instanceof IntakeError) return json(e.status ?? 400, { error: e.code }); throw e; }
    }
    if ((m = new RegExp(`^/api/uploads/(${UUID})$`).exec(path))) {
      const token = req.headers["x-upload-token"];
      try {
        if (isGet) return json(200, await uploads.status(m[1], token));
        if (method === "PUT") {
          await ctx.limit(req, "upload-chunk", 600, 600);
          const r = await uploads.put(m[1], token, req.headers["content-range"], await readBody(req, CHUNK));
          return json(r.offsetMismatch ? 409 : 200, r);
        }
        return { status: 405, body: { error: "method_not_allowed" }, allow: "GET, PUT" };
      } catch (e) { if (e instanceof IntakeError) return json(e.status ?? 400, { error: e.code }); throw e; }
    }

    // ------------------------------------------------ participant hooks: deadlines, notices, replies
    ctx.caseExtraHtml = async (session, view) => {
      const rootId = view.filings[0].id;
      await workflows.markNoticesRead(session, rootId);
      const [notices, deadlines] = await Promise.all([workflows.notices(rootId), workflows.deadlines(rootId)]);
      return `<h2>Notices and messages</h2>${notices.length ? `<ul class="notices">${notices.map((n) => `<li><strong>${h(n.kind.replace(/_/g, " "))}</strong> · ${h(when(n.sent_at))} · from ${h(n.author.startsWith("staff:") ? "the fictional agency" : n.author)}${n.cure_due_at ? ` · <strong>cure by ${h(when(n.cure_due_at))}</strong>` : ""}${n.cure_outcome ? ` · ${h(n.cure_outcome.replace(/_/g, " "))}` : ""}<br>${h(n.body)}</li>`).join("")}</ul>` : "<p>No notices.</p>"}` +
        (session.scope !== "view" ? `<form class="demo-form" method="post" action="/track/reply">${csrfField(session.csrf)}<label for="reply">Reply to the fictional agency</label><textarea id="reply" name="body" rows="3" maxlength="4000" required></textarea><button class="button secondary" type="submit">Send reply</button></form>` : "") +
        `<h2>Deadlines (demonstration estimates)</h2>${deadlines.length ? `<ul>${deadlines.map((d) => `<li>${h(d.label)} · due ${h(d.due_date.toISOString().slice(0, 10))} (Eastern) · ${h(d.state)} · ${d.party === "claimant" ? "your window" : "agency clock"}</li>`).join("")}</ul>` : "<p>None yet.</p>"}` +
        `<p class="small">Deadline estimates use ${h(RULESET_VERSION)}. They are not legal deadlines.</p>`;
    };
    ctx.participantPost = async (session, fields) => {
      if (ctx.path !== "/track/reply") return null;
      await workflows.claimantReply(session, fields.body);
      return redirect("/track/case");
    };

    // ------------------------------------------------ staff hooks: workflow panel, transitions, notices, oversight
    ctx.staffSubmissionExtra = async ({ s, user, csrf }) => {
      const [allowed, notices, deadlines] = await Promise.all([workflows.allowedTransitions(s.id), workflows.notices(s.id), workflows.deadlines(s.id)]);
      return `<h2>Workflow (${h(s.filing_type)})</h2>${allowed.length && s.kind === "original" ? `<form class="demo-form" method="post" action="/staff/submissions/${h(s.id)}/transition">${csrfField(csrf)}<label for="to">Next step</label><select id="to" name="to">${allowed.map((x) => `<option value="${h(x)}">${h(statusText(x))}</option>`).join("")}</select><label for="tnote">Note to the claimant (included in notices)</label><textarea id="tnote" name="note" rows="2" maxlength="1000"></textarea><button class="button" type="submit">Advance workflow</button></form>` : "<p>No workflow steps available.</p>"}` +
        `<h3>Deadlines</h3>${deadlines.length ? `<ul>${deadlines.map((d) => `<li>${h(d.label)} · due ${h(when(d.due_at))} · ${h(d.state)} (${h(d.party)})</li>`).join("")}</ul>` : "<p>None.</p>"}` +
        `<h3>Notices</h3>${notices.length ? `<ul>${notices.map((n) => `<li>${h(n.kind)} · ${h(when(n.sent_at))} · ${h(n.author)} · ${n.kind === "claimant_reply" ? "" : n.read_at ? `read ${h(when(n.read_at))} (ledger #${h(n.read_ledger_seq)})` : "unread"}${n.cure_outcome ? ` · ${h(n.cure_outcome)}` : ""}<br>${h(n.body)}</li>`).join("")}</ul>` : "<p>None.</p>"}` +
        (s.kind === "original" ? `<form class="demo-form" method="post" action="/staff/submissions/${h(s.id)}/notice">${csrfField(csrf)}<label for="nkind">Send notice</label><select id="nkind" name="kind"><option value="general">General message</option><option value="information_request">Request information (tolls agency clock)</option><option value="defect">Defect notice (opens 30-day cure period)</option></select><label for="nbody">Notice text</label><textarea id="nbody" name="body" rows="3" maxlength="4000" required></textarea><button class="button secondary" type="submit">Send notice</button></form>` : "");
    };
    ctx.staffExtension = async ({ user, csrf, form, denied }) => {
      let mm;
      if ((mm = new RegExp(`^/staff/submissions/(${UUID})/(transition|notice)$`).exec(path))) {
        try {
          if (mm[2] === "transition") await workflows.transition(user, mm[1], form.to, form.note);
          else await workflows.issueNotice(user, mm[1], form.kind, form.body);
        } catch (e) { if (e instanceof IntakeError) return e.status === 403 ? denied() : json(e.status ?? 400, { error: e.code, message: msg(e.code) }); throw e; }
        return redirect(`/staff/submissions/${mm[1]}`);
      }
      if (path === "/staff/oversight") {
        if (!hasRole(user, "oversight")) return denied();
        const o = await oversightData();
        const rows = (list, a, b) => list.map((r) => `<tr><td>${h(statusText(r[a]))}</td><td>${h(r[b])}</td></tr>`).join("");
        return html(200, layout({ title: "Oversight", path: "/staff/oversight", staff: true, staffUser: user, body: `<p class="eyebrow">Independent oversight view (UFR-050)</p><h1>Oversight dashboard</h1>` +
          `<section class="${o.ledger.valid ? "verify-ok" : "error-summary"}" role="status"><p>Ledger hash chain ${o.ledger.valid ? "valid" : "INVALID"} across ${o.ledger.checked} entries${o.checkpoint ? `; latest signed checkpoint #${h(o.checkpoint.seq)} at ${h(when(o.checkpoint.created_at))}` : ""}.</p></section>` +
          `<dl class="facts"><dt>Filings</dt><dd>${o.misc.filings} (${o.misc.emergencies} emergency)</dd><dt>Open corrections and complaints</dt><dd>${o.misc.open_corrections}</dd><dt>Quarantined attachments</dt><dd>${o.misc.quarantined}</dd>` +
          `<dt>Classified-marking refusals</dt><dd>${o.misc.classified_refusals}</dd><dt>Identity reveals</dt><dd>${o.reveals.requested} requested, ${o.reveals.approved} approved, ${o.reveals.consumed} viewed</dd>` +
          `<dt>Legal holds / dispositions</dt><dd>${o.misc.holds} / ${o.misc.disposed}</dd><dt>Active staff without MFA</dt><dd>${o.misc.staff_without_mfa}</dd>` +
          `<dt>Compliance Engine event feed (UFR-048)</dt><dd>${o.caiae ? `delivered through #${o.caiae.deliveredSeq} of #${o.caiae.headSeq} (lag ${o.caiae.lag})${o.caiae.lastError ? ` · retrying after: ${h(o.caiae.lastError)}` : ""}` : "not configured"}</dd></dl>` +
          `<div class="table-wrap"><table><caption>Current status</caption><tbody>${rows(o.statuses, "st", "n")}</tbody></table></div>` +
          `<div class="table-wrap"><table><caption>Deadlines</caption><tbody>${rows(o.deadlines, "state", "n")}</tbody></table></div>` +
          `<div class="table-wrap"><table><caption>Routing</caption><tbody>${o.routing.map((r) => `<tr><td>${h(r.state)}</td><td>${r.n}${r.overdue ? ` (${r.overdue} overdue)` : ""}</td></tr>`).join("")}</tbody></table></div>` }));
      }
      return null;
    };
    return null;
  }

  return {
    names: [...(caiaeSync ? ["caiae-event-sync"] : []), "guided-forms", "workflows", "deadlines", "notices", "uploads", "oversight", "transparency", "checkpoints", "metrics", "events-feed", "i18n-es"],
    extensions: [extension], structuredForms, workflows, uploads,
    jobs: [() => workflows.runJobs(), ...(caiaeSync ? [() => caiaeSync.run()] : [])], caiaeSync,
  };
}
