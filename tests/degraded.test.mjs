import test from "node:test";
import assert from "node:assert/strict";
import { createPortalServer } from "../src/server.mjs";
import { createAuth } from "../src/demo/auth.mjs";
import { LocalIntakeBackend } from "../src/demo/backend.mjs";
import { createDemoHandler } from "../src/demo/routes.mjs";
import { createPool } from "../src/demo/db.mjs";
import { generateSigningKeyEncoded, loadSigningKey } from "../src/demo/signing.mjs";

test("storage outage fails closed with an honest 503 (degraded mode)", async (t) => {
  const pool = createPool("postgres://nobody@127.0.0.1:1/none");
  const backend = new LocalIntakeBackend({ pool, signer: loadSigningKey(generateSigningKeyEncoded()) });
  const handler = createDemoHandler({ backend, auth: createAuth({ secret: "s".repeat(40), secureCookies: false }), platform: {} });
  const server = createPortalServer({ demo: { handler, ready: async () => false } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + "/file");
  assert.equal(page.status, 503);
  assert.equal(page.headers.get("retry-after"), "60");
  assert.match(await page.text(), /Nothing you submitted was saved and no filing date was preserved/);
  assert.equal((await fetch(base + "/api/demo/agencies")).status, 503);
  const ready = await fetch(base + "/api/ready");
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).reason, "demo_storage_unavailable");
});
