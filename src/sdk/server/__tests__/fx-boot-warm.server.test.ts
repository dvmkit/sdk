/**
 * Warm the shared FX snapshot before listening, including for free-to-submit jobs whose first
 * priced operation happens mid-job.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import type { Currency, FxFetcher, FxRateSnapshot } from "../../pricing";
import { createDVMHost } from "../host";
import type { MppxServer } from "../mpp-setup";

const SNAPSHOT: FxRateSnapshot = {
  rates: { usd: 100_000, eur: 92_000, gbp: 79_000, jpy: 15_000_000 },
  as_of: "2026-08-20T00:00:00.000Z",
};

/** An `FxFetcher` that records its calls and caches like the real one. */
function recordingFetcher(opts?: { fail?: boolean }): FxFetcher & { calls: () => number } {
  let calls = 0;
  let cached: { snapshot: FxRateSnapshot; cachedAt: number } | null = null;
  return {
    calls: () => calls,
    supportedCurrencies: (): readonly Currency[] => ["usd", "eur", "gbp", "jpy"],
    lastKnown: () => cached,
    fetch: async (): Promise<FxRateSnapshot> => {
      calls++;
      if (opts?.fail) throw new Error("rate source unreachable");
      cached = { snapshot: SNAPSHOT, cachedAt: 0 };
      return await Promise.resolve(SNAPSHOT);
    },
  };
}

describe("boot-time fx warm-up", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
    vi.restoreAllMocks();
  });

  it("warms the shared fetcher for a free-to-submit DVM that only charges mid-job", async () => {
    const fx = recordingFetcher();
    const dvm = configureDVM({
      name: "warm-credit",
      capability: "test",
      tag: "test",
      // No `price`, no `onQuote` — submission is free, so nothing on the
      // request path would ever have fetched a rate before the first ask.
      credit: { min: "$0.10", max: "$5.00" },
      onJob(ctx) {
        ctx.complete("ok");
      },
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {}, fx });
    host.mount(dvm);
    server = await host.serve();

    await vi.waitFor(() => {
      expect(fx.lastKnown?.()).not.toBeNull();
    });
    expect(fx.lastKnown?.()?.snapshot).toEqual(SNAPSHOT);
  });

  it("warms for a free-to-submit DVM that charges only through a mid-job ask", async () => {
    // No price or quote has warmed FX; the configured rail is the only boot signal.
    const fx = recordingFetcher();
    const dvm = configureDVM({
      name: "pay-on-delivery",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        ctx.text("Work done — payment required to release the result.");
        await ctx.requestPayment(5000, "Result delivery");
        ctx.complete("delivered");
      },
    });

    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {},
      mints: ["https://testnut.cashu.space"],
      fx,
    });
    host.mount(dvm);
    server = await host.serve();

    await vi.waitFor(() => {
      expect(fx.calls()).toBeGreaterThan(0);
    });
  });

  it("warms for a descriptor-level MPP handle with no host rail", async () => {
    // The same pay-on-delivery shape, one rail narrower: no host `mints`, no
    // x402, and the Tempo handle lives on the descriptor rather than on the
    // host. `serveFn` resolves `descriptor.mpp ?? mpp` per mount, so this DVM
    // charges mid-job over Tempo and would otherwise boot cold.
    const fx = recordingFetcher();
    const dvm = configureDVM({
      name: "descriptor-mpp",
      capability: "test",
      tag: "test",
      mpp: {
        realm: "test.example",
        methods: [{ name: "tempo", intent: "charge" }],
        issueChallenge: () => Promise.resolve({ id: "ch_1" }),
        broadcastCredential: () => undefined,
      } as unknown as MppxServer,
      async onJob(ctx) {
        await ctx.requestPayment(5000, "Result delivery");
        ctx.complete("delivered");
      },
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {}, fx });
    host.mount(dvm);
    server = await host.serve();

    await vi.waitFor(() => {
      expect(fx.calls()).toBeGreaterThan(0);
    });
  });

  it("warms for a dynamically priced DVM", async () => {
    const fx = recordingFetcher();
    const dvm = configureDVM({
      name: "warm-quote",
      capability: "test",
      tag: "test",
      onQuote: {
        schema: z.object({}).passthrough(),
        handler: () =>
          Promise.resolve({
            upfront: { amount: 0.01, currency: "usd" as const },
            description: "one job",
          }),
      },
      onJob(ctx) {
        ctx.complete("ok");
      },
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {}, fx });
    host.mount(dvm);
    server = await host.serve();

    await vi.waitFor(() => {
      expect(fx.calls()).toBeGreaterThan(0);
    });
  });

  it("warms for a statically priced DVM", async () => {
    const fx = recordingFetcher();
    const dvm = configureDVM({
      name: "warm-static",
      capability: "test",
      tag: "test",
      price: "$0.05",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {}, fx });
    host.mount(dvm);
    server = await host.serve();

    await vi.waitFor(() => {
      expect(fx.calls()).toBeGreaterThan(0);
    });
  });

  it("does not fire for a DVM that declares no price and has no rail to charge on", async () => {
    // No price, no quote, no credit — and no mints, no x402, no MPP handle, so
    // a mid-job ask would have nothing to be paid with either. This DVM can
    // charge nowhere, so a boot fetch buys a rate it will never consult.
    const fx = recordingFetcher();
    const dvm = configureDVM({
      name: "no-fx-surface",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {}, fx });
    host.mount(dvm);
    server = await host.serve();

    // Serving `/v1/info` is the surface most likely to reach for a rate; a free
    // DVM has nothing to translate, so the fetcher stays untouched.
    const res = await fetch(`${server.url}/v1/info`);
    expect(res.status).toBe(200);
    expect(fx.calls()).toBe(0);
  });

  it("boots clean and quiet with the rate source unreachable", async () => {
    const fx = recordingFetcher({ fail: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const dvm = configureDVM({
      name: "warm-offline",
      capability: "test",
      tag: "test",
      credit: { min: "$0.10", max: "$5.00" },
      onJob(ctx) {
        ctx.complete("ok");
      },
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {}, fx });
    host.mount(dvm);
    server = await host.serve();

    await vi.waitFor(() => {
      expect(fx.calls()).toBeGreaterThan(0);
    });
    const res = await fetch(`${server.url}/v1/info`);
    expect(res.status).toBe(200);
    expect(fx.lastKnown?.()).toBeNull();
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/fx|rate/i);
    expect(error).not.toHaveBeenCalled();
  });
});
