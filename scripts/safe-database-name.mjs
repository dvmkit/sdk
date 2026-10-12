/**
 * The database-name shape every migrated `*.db.test.ts` suite requires before running any
 * destructive statement against `DATABASE_URL` (duplicated verbatim across those test files, e.g.
 * `src/sdk/server/__tests__/credit-ledger.db.test.ts`). Keep this pattern byte-for-byte identical to
 * theirs — it exists so a real accident cannot point the suite at a database that isn't a throwaway
 * test database.
 */
export const SAFE_DATABASE_NAME = /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/u;
