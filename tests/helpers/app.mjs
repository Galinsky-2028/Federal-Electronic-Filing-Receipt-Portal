import pg from "pg";
import { randomBytes } from "node:crypto";
import { createPortalServer } from "../../src/server.mjs";
import { createDemoRuntime } from "../../src/demo/runtime.mjs";
import { generateSigningKeyEncoded } from "../../src/demo/signing.mjs";
import { TEST_DATABASE_URL } from "./db.mjs";

export const ADMIN = { user: "demo-admin", pass: "synthetic-admin-password-123" };

/** Full portal (real runtime, isolated schema, worker off) on an ephemeral port. */
export async function buildApp(t, extraEnv = {}) {
  const schema = "t_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
  const url = new URL(TEST_DATABASE_URL); url.searchParams.set("options", `-c search_path=${schema}`);
  const runtime = await createDemoRuntime({ DATABASE_URL: url.toString(), RECEIPT_SIGNING_KEY: generateSigningKeyEncoded(),
    SESSION_SECRET: randomBytes(24).toString("hex"), DATA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    STAFF_USERNAME: ADMIN.user, STAFF_PASSWORD: ADMIN.pass, COOKIE_SECURE: "false", ...extraEnv },
  { startWorker: false, logger: () => {} });
  const server = createPortalServer({ demo: runtime });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections(); await new Promise((r) => server.close(r)); await runtime.close();
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL }); await c.connect(); await c.query(`DROP SCHEMA ${schema} CASCADE`); await c.end();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, runtime, backend: runtime.backend, platform: runtime.platform, pool: runtime.backend.pool, workflows: runtime.features.workflows };
}

export const FORM = "application/x-www-form-urlencoded";
export const form = (o) => new URLSearchParams(o).toString();
export const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
export const field = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
export const post = (base, path, body, { cookie, origin = base, type, headers = {} } = {}) => fetch(base + path, { method: "POST", redirect: "manual", body,
  headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(type ? { "content-type": type } : {}), ...headers } });
export const get = (base, path, cookie) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });

export function filingForm(key, extra = {}) {
  const fd = new FormData();
  const v = { idempotencyKey: key, agencyId: "demo-benefits-claims-office", filingType: "administrative-claim",
    title: "Synthetic claim <script>", body: "Synthetic claim text.", claimantName: "Pat Example", claimantContact: "pat@example.test",
    attest_demo: "yes", attest_synthetic: "yes", attest_unclassified: "yes", ...extra };
  for (const [k, val] of Object.entries(v)) if (val !== undefined) fd.append(k, val);
  return fd;
}

/** Files one synthetic filing over HTTP; returns tracking, access code and the owner session cookie. */
export async function fileAndLogin(base, extra = {}, files = []) {
  const key = field(await (await fetch(base + "/file")).text(), "idempotencyKey");
  const fd = filingForm(key, extra);
  for (const f of files) fd.append("files", new Blob([f.content], { type: f.type }), f.name);
  const res = await post(base, "/file", fd);
  const html = await res.text();
  if (res.status !== 201) throw new Error(`filing failed ${res.status}: ${html.match(/<p>([^<]+)<\/p><\/div>/)?.[1] ?? html.slice(0, 200)}`);
  const tracking = html.match(/Tracking number: <code class="big">(DEMO-[0-9A-Z-]+)<\/code>/)[1];
  const access = html.match(/Access code: <code class="big">([0-9A-Z-]+)<\/code>/)[1];
  const login = await post(base, "/track", form({ trackingNumber: tracking, accessCode: access }), { type: FORM });
  return { tracking, access, cookie: cookieOf(login), html };
}

export async function staffLogin(base, user = ADMIN.user, pass = ADMIN.pass, totp) {
  const res = await post(base, "/staff/login", form({ username: user, password: pass, ...(totp ? { totp } : {}) }), { type: FORM });
  return { status: res.status, cookie: cookieOf(res) };
}
export async function staffCsrf(base, cookie, path = "/staff") {
  return field(await (await get(base, path, cookie)).text(), "csrf");
}
