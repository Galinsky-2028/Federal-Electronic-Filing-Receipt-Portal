import { createAuth } from "./auth.mjs";
import { LocalIntakeBackend } from "./backend.mjs";
import { createPool, migrate, seedAgencies } from "./db.mjs";
import { createDemoHandler } from "./routes.mjs";
import { loadSigningKey } from "./signing.mjs";
import { DataKeys, loadKek } from "../platform/crypto.mjs";
import { PlatformServices } from "../platform/services.mjs";
import { loadFeatureModules } from "../platform/features.mjs";

export const DEMO_KEYS = ["DATABASE_URL", "RECEIPT_SIGNING_KEY", "SESSION_SECRET", "DATA_ENCRYPTION_KEY"];

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
  const keys = new DataKeys(loadKek(env.DATA_ENCRYPTION_KEY));
  const auth = createAuth({ secret: env.SESSION_SECRET, secureCookies: env.COOKIE_SECURE !== "false" });
  const pool = createPool(env.DATABASE_URL);
  const applied = await migrate(pool);
  const agencies = await seedAgencies(pool);
  const backend = new LocalIntakeBackend({ pool, signer, keys });
  const platform = new PlatformServices({ backend, keys });
  const bootstrapped = await platform.bootstrapAdmin(env.STAFF_USERNAME?.trim().toLowerCase(), env.STAFF_PASSWORD);
  const features = await loadFeatureModules({ backend, platform, env, logger });
  logger("demo.started", { migrationsApplied: applied, fictionalAgencies: agencies, keyId: signer.keyId,
    staffAccounts: await platform.staffCount(), adminBootstrapped: bootstrapped, features: features.names });
  const handler = createDemoHandler({ backend, auth, platform, publicOrigin: env.PUBLIC_ORIGIN || null,
    trustProxy: env.TRUST_PROXY === "true", logger, extensions: features.extensions, structuredForms: features.structuredForms });
  let timer = null;
  if (startWorker) {
    let running = false;
    timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const n = await backend.deliverDueRoutings();
        if (n) logger("routing.delivered", { count: n });
        const k = await platform.deliverNotifications(logger);
        if (k) logger("notifications.delivered", { count: k });
        for (const job of features.jobs) await job();
      } catch (error) { logger("worker.error", { code: error?.code ?? error?.name, message: String(error?.message ?? "").slice(0, 160) }); }
      finally { running = false; }
    }, Number(env.ROUTING_INTERVAL_MS ?? 5000));
    timer.unref();
  }
  return {
    backend, platform, handler, features,
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
