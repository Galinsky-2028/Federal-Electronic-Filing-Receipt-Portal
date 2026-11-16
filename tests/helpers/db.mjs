import pg from "pg";
import { randomBytes } from "node:crypto";
import { createPool, migrate, seedAgencies } from "../../src/demo/db.mjs";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Skip DB suites locally when no database is configured; CI sets REQUIRE_DB_TESTS=1 so they cannot be skipped. */
export function dbTestOptions() {
  if (TEST_DATABASE_URL) return {};
  if (process.env.REQUIRE_DB_TESTS === "1") throw new Error("TEST_DATABASE_URL is required in CI");
  return { skip: "TEST_DATABASE_URL not set" };
}

/** Fresh isolated schema per test file. */
export async function freshPool(t) {
  const schema = "t_" + randomBytes(6).toString("hex");
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const url = new URL(TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = createPool(url.toString());
  await migrate(pool);
  await seedAgencies(pool);
  t.after(async () => {
    await pool.end();
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    await c.query(`DROP SCHEMA ${schema} CASCADE`);
    await c.end();
  });
  return pool;
}
