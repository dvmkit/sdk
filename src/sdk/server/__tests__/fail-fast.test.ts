import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createDVMServer } from "../app";

// Minimal duck-typed pg.Pool sufficient for the opts.db guard inside the SDK
// server. We don't open a real Postgres — the partial-wiring check fires
// before anything queries the pool.
const fakePool = { query: vi.fn(), end: vi.fn() } as unknown as Pool;

const PAID_DVM = configureDVM({
  name: "ffast-paid",
  capability: "test",
  tag: "test",
  price: "$0.01",
  onJob(ctx) {
    ctx.complete("ok");
  },
});

describe("Reporter check at host boundary", () => {
  let server: { close: () => Promise<void> } | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    vi.restoreAllMocks();
  });

  it("platform-hosted partial wiring crashes regardless of failFast=false", async () => {
    await expect(
      createDVMServer(PAID_DVM, {
        env: {
          DVMKIT_PLATFORM_URL: "http://platform.invalid",
        },
        store: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => {},
          list: async () => [],
        },
        mints: ["https://mint.example.com"],
        db: fakePool,
        dvmId: "dvm-abc",
        failFast: false,
        onJobCompleted: () => {},
        fxFetcher: {
          fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
          supportedCurrencies: () => ["usd"],
        },
      })
    ).rejects.toThrow(/Platform-hosted DVM/);
  });

  it("platform-hosted partial wiring crashes regardless of failFast=true", async () => {
    await expect(
      createDVMServer(PAID_DVM, {
        env: {
          DVMKIT_FAIL_FAST: "true",
          DVMKIT_PLATFORM_URL: "http://platform.invalid",
        },
        store: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => {},
          list: async () => [],
        },
        mints: ["https://mint.example.com"],
        db: fakePool,
        dvmId: "dvm-abc",
        failFast: true,
        fxFetcher: {
          fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
          supportedCurrencies: () => ["usd"],
        },
      })
    ).rejects.toThrow(/DVMKIT_PLATFORM_TOKEN/);
  });

  it("platform-hosted error names every missing piece", async () => {
    await expect(
      createDVMServer(PAID_DVM, {
        env: { DVMKIT_PLATFORM_URL: "http://platform.invalid" },
        store: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => {},
          list: async () => [],
        },
        mints: ["https://mint.example.com"],
        failFast: false,
        fxFetcher: {
          fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
          supportedCurrencies: () => ["usd"],
        },
      })
    ).rejects.toThrow(/DVMKIT_PLATFORM_TOKEN.*DVMKIT_DVM_ID.*database/);
  });

  it("self-hosted with failFast=true stays silent (footgun guard)", async () => {
    const { revenueReporterActive } = await createDVMServer(PAID_DVM, {
      env: { DVMKIT_FAIL_FAST: "true" },
      store: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      mints: ["https://mint.example.com"],
      failFast: true,
      fxFetcher: {
        fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
        supportedCurrencies: () => ["usd"],
      },
    });
    expect(revenueReporterActive).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("platform-hosted + fully wired stays silent with failFast=true", async () => {
    // RevenueReporter wants a real pool — bypass auto-wire with onJobCompleted.
    const { revenueReporterActive } = await createDVMServer(PAID_DVM, {
      env: {
        DVMKIT_FAIL_FAST: "true",
        DVMKIT_PLATFORM_TOKEN: "tok",
        DVMKIT_PLATFORM_URL: "http://platform.invalid",
      },
      store: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      mints: ["https://mint.example.com"],
      db: fakePool,
      dvmId: "dvm-abc",
      failFast: true,
      onJobCompleted: () => {},
      fxFetcher: {
        fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
        supportedCurrencies: () => ["usd"],
      },
    });
    expect(revenueReporterActive).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
