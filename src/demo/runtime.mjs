import { createAuth } from "./auth.mjs";
import { LocalIntakeBackend } from "./backend.mjs";
import { createPool, migrate, seedAgencies } from "./db.mjs";
import { createDemoHandler } from "./routes.mjs";
import { loadSigningKey } from "./signing.mjs";

const DEMO_KEYS = ["DATABASE_URL", "RECEIPT_SIGNING_KEY", "SESSION_SECRET"];

/**
 * Builds the portal-local demo filing runtime from environment variables.
 * None set: demo filing is unavailable (returns null). Some but not all set:
 * startup aborts rather than running half-configured. Migrations run here,
 * on the startup path, under an advisory lock.
 */
export async function createDemoRuntime(env = process.env, { logger = defaultLogger, startWorker = true } = {}) {
  const present = DEMO_KEYS.filter((k) => typeof env[k] === "string" && env[k].trim() !== "");
  if (present.length === 0) return null;
  if (present.length !== DEMO_KEYS.length)
    throw new Error(`Demo filing requires ${DEMO_KEYS.join(", ")}; missing ${DEMO_KEYS.filter((k) => !present.includes(k)).join(", ")}`);
  const signer = loadSigningKey(env.RECEIPT_SIGNING_KEY);
  const auth = createAuth({ secret: env.SESSION_SECRET, staffUsername: env.STAFF_USERNAME, staffPassword: env.STAFF_PASSWORD,
    secureCookies: env.COOKIE_SECURE !== "false" });
  const pool = createPool(env.DATABASE_URL);
  const applied = await migrate(pool);
  const agencies = await seedAgencies(pool);
  logger("demo.started", { migrationsApplied: applied, fictionalAgencies: agencies, keyId: signer.keyId,
    staffConfigured: auth.staffConfigured });
  const backend = new LocalIntakeBackend({ pool, signer });
  const handler = createDemoHandler({ backend, auth, publicOrigin: env.PUBLIC_ORIGIN || null,
    trustProxy: env.TRUST_PROXY === "true", logger });
  let timer = null;
  if (startWorker) {
    let running = false;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const n = await backend.deliverDueRoutings();
        if (n) logger("routing.delivered", { count: n });
      } catch (error) { logger("routing.worker_error", { code: error?.code ?? error?.name }); }
      finally { running = false; }
    }, Number(env.ROUTING_INTERVAL_MS ?? 5000));
    timer.unref();
  }
  return {
    backend, handler,
    async ready() {
      try { await pool.query("SELECT 1"); return true; } catch { return false; }
    },
    async close() { if (timer) clearInterval(timer); await pool.end(); },
  };
}

function defaultLogger(event, fields) {
  // Structured, data-minimized logs: no filing content, identities or secrets.
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
