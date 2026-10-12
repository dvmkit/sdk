/**
 * Shared plumbing for the `test:db` suites that build a platform schema off to
 * one side of `public` — `init-migration.db.test.ts` (per-incident downgrades),
 * `init-concurrency.db.test.ts` (racing boots) and `baseline-migration.db.test.ts`
 * (a frozen production schema migrated to head). Each owns its own schema
 * namespace and its own assertions; only the connection plumbing is common.
 */
import type { Pool } from "pg";

/**
 * Open a Pool whose every connection pins `search_path` to a single schema via
 * the libpq `options` startup parameter — so both the advisory-locked client
 * and the bare `this.pool.query(...)` calls inside `init()` resolve to that
 * schema rather than `public`.
 *
 * This is what lets a suite build a whole platform schema while `public` holds
 * the current shape: `current_schema()`-relative guards resolve locally,
 * hard-coded `public.` / unfiltered `information_schema` ones don't, and the
 * per-file TRUNCATE hook (which only touches `public`) never sees it.
 */
export async function pinnedPool(schema: string): Promise<Pool> {
  const pg = await import("pg");
  return new pg.default.Pool({
    connectionString: testDatabaseUrl(),
    options: `-c search_path=${schema}`,
  });
}

/** Run `fn` against an unpinned pool — for the DDL that creates and drops schemas. */
export async function withAdminPool(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: testDatabaseUrl() });
  try {
    await fn(admin);
  } finally {
    await admin.end();
  }
}

/** Drop `schema` and recreate it empty, so a suite always starts from nothing. */
export async function recreateSchema(schema: string): Promise<void> {
  await withAdminPool(async (admin) => {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
  });
}

/** Tear down every named schema. Safe on schemas that were never created. */
export async function dropSchemas(...schemas: string[]): Promise<void> {
  await withAdminPool(async (admin) => {
    for (const schema of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
}

/**
 * Resolved per call rather than at import: the same fallback the platform
 * itself uses, and unset simply means "not running under `test:db`" — which
 * each suite turns into a skip before any of these helpers is reached.
 */
function testDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL;
}
