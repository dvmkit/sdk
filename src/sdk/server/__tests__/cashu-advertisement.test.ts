import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer, type SDKServerOpts } from "../app";
import { createDisposableCashuStore } from "../disposable-cashu-store";
import { MintHealthTracker } from "../mint-health-tracker";

const ready = {
  cashuMode: "p2pk-accumulator" as const,
  lockPubkey: `02${"11".repeat(32)}`,
  disposableCashu: createDisposableCashuStore().accumulator,
};

describe("Cashu advertisement boot diagnostics", () => {
  it.each([
    [{ lockPubkey: undefined }, { cashu_lock_pubkey_missing: true }],
    [{ disposableCashu: undefined }, { cashu_store_missing: true }],
    [{ cashuMode: undefined }, { cashu_mode_missing: true }],
    [{ lockPubkey: undefined, disposableCashu: undefined },
      { cashu_lock_pubkey_missing: true, cashu_store_missing: true }],
    [{ paymentMethods: [] }, { cashu_explicitly_excluded: true }],
  ] satisfies [Partial<SDKServerOpts>, Record<string, boolean>][])(
    "warns once at boot with the reason Cashu is not advertised: %j", async (overrides, reason) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const mints = ["https://mint.example.com"];
      const server = await createDVMServer(configureDVM({ name: "cashu-warning", onJob(ctx) { ctx.complete("done"); } }), {
        env: {}, store: new MemoryKVStore(), mints,
        mintHealthTracker: new MintHealthTracker({ mints, env: {} }),
        ...ready, ...overrides,
      });
      try {
        const warnings = () => warn.mock.calls.map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>)
          .filter((entry) => entry.event === "cashu_not_advertised");
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toMatchObject({ level: "warn", ...reason });
        for (let i = 0; i < 2; i++) {
          const body = await (await server.app.request("/v1/info")).json();
          expect(body.payment.methods).not.toContain("cashu");
        }
        expect(warnings()).toHaveLength(1);
      } finally {
        await server.shutdown();
      }
    }
  );

  it.each([false, true])("does not warn without mints or when Cashu is advertised (mints: %s)", async (hasMints) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mints = hasMints ? ["https://mint.example.com"] : [];
    const server = await createDVMServer(configureDVM({ name: "cashu-ready", onJob(ctx) { ctx.complete("done"); } }), {
      env: {}, store: new MemoryKVStore(), mints,
      mintHealthTracker: new MintHealthTracker({ mints, env: {} }), ...ready,
    });
    try {
      const body = await (await server.app.request("/v1/info")).json();
      expect(body.payment.methods).toEqual(hasMints ? ["cashu"] : []);
      expect(warn.mock.calls.some(([entry]) => String(entry).includes("cashu_not_advertised"))).toBe(false);
    } finally {
      await server.shutdown();
    }
  });
});
