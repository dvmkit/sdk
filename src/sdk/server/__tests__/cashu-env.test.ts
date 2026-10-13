import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCashuOptsFromEnv } from "../cashu-env";

const DVM_ID = "dvm-lightning-admin";
const LOCK_PUBKEY = `02${"11".repeat(32)}`;

function fakePool(failOn?: string): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const query = vi.fn(async (text: string) => {
    queries.push(text);
    if (failOn && text.includes(failOn)) throw new Error("storage unavailable");
    return { rows: [], rowCount: 0 };
  });
  const lockClient = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn()
  };
  const pool = {
    query,
    connect: vi.fn(async () => lockClient)
  } as unknown as Pool;
  return { pool, queries };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveCashuOptsFromEnv builder admin bootstrap", () => {
  it("initializes lock state for a Lightning-only DVM without creating the accumulator", async () => {
    const { pool, queries } = fakePool();

    const resolved = await resolveCashuOptsFromEnv(
      {
        DVMKIT_DVM_ID: DVM_ID,
        DVMKIT_CASHU_LOCK_PUBKEY: LOCK_PUBKEY,
        DVMKIT_NWC_RECEIVE_URI: "nostr+walletconnect://receive.example"
      },
      pool
    );

    expect(resolved.db).toBe(pool);
    expect(resolved.cashuMode).toBeUndefined();
    expect(queries.some((text) => text.includes("CREATE TABLE IF NOT EXISTS dvm_lock_pubkeys"))).toBe(true);
    expect(queries.some((text) => text.includes("INSERT INTO dvm_lock_pubkeys"))).toBe(true);
    expect(queries.some((text) => text.includes("CREATE TABLE IF NOT EXISTS wallet_accumulator"))).toBe(false);
  });

  it("reports the missing lock identity for Lightning credit recovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pool, queries } = fakePool();

    const resolved = await resolveCashuOptsFromEnv(
      {
        DVMKIT_DVM_ID: DVM_ID,
        DVMKIT_NWC_RECEIVE_URI: "nostr+walletconnect://receive.example"
      },
      pool
    );

    expect(resolved.db).toBeUndefined();
    expect(queries).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
      event: "admin_surface_missing_config",
      level: "warn"
    });
  });

  it("retains accumulator initialization for a dual-rail DVM", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { pool, queries } = fakePool();

    const resolved = await resolveCashuOptsFromEnv(
      {
        DVMKIT_DVM_ID: DVM_ID,
        DVMKIT_CASHU_LOCK_PUBKEY: LOCK_PUBKEY,
        DVMKIT_CASHU_MINTS: "https://mint.example",
        DVMKIT_NWC_RECEIVE_URI: "nostr+walletconnect://receive.example"
      },
      pool
    );

    expect(resolved.db).toBe(pool);
    expect(resolved.cashuMode).toBe("p2pk-accumulator");
    expect(queries.some((text) => text.includes("CREATE TABLE IF NOT EXISTS wallet_accumulator"))).toBe(true);
    expect(queries.some((text) => text.includes("CREATE TABLE IF NOT EXISTS dvm_lock_pubkeys"))).toBe(true);
  });

  it("rejects configured Cashu startup when its storage initialization fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pool } = fakePool("CREATE TABLE IF NOT EXISTS wallet_accumulator");

    await expect(
      resolveCashuOptsFromEnv(
        {
          DVMKIT_DVM_ID: DVM_ID,
          DVMKIT_CASHU_LOCK_PUBKEY: LOCK_PUBKEY,
          DVMKIT_CASHU_MINTS: "https://mint.example"
        },
        pool
      )
    ).rejects.toThrow("storage unavailable");
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "accumulator_table_init_failed",
      level: "error"
    });
  });
});
