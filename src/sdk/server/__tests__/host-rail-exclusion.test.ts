import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import type { PaymentMethod } from "../../types";
import { createDVMHost } from "../host";
import { secp256k1Auth } from "../secp256k1-auth";

const payTo = `0x${"11".repeat(20)}`;
const fx = {
  fetch: async () => ({ rates: { usd: 100_000 }, as_of: "2026-08-23T00:00:00Z" }),
  supportedCurrencies: () => ["usd" as const],
};

describe("host rail initialization before listening", () => {
  it.each<{ rail: string; env: Record<string, string> }>([
    { rail: "x402", env: { DVMKIT_X402_PAY_TO: payTo, DVMKIT_X402_NETWORK: "eip155:8453" } },
    { rail: "Tempo", env: { DVMKIT_TEMPO_RECIPIENT: payTo } },
    { rail: "malformed settings", env: { DVMKIT_X402_PAY_TO: "invalid", DVMKIT_TEMPO_RECIPIENT: "invalid" } },
  ])("reaches onBoot without initializing excluded $rail", async ({ env }) => {
    const requests = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ kinds: [], extensions: [], signers: {} })
    );
    // onBoot runs after mount initialization and before listen. Stop there so
    // this test exercises real boot and rollback without requiring a port.
    const stopBeforeListen = new Error("stop before listen");
    const host = createDVMHost({
      devMode: true, env: { ...env, DVMKIT_FAIL_FAST: "true", DVMKIT_PLATFORM_URL: "https://platform.example.com" },
      fx,
    });
    host.mount(configureDVM({
      name: "excluded", capability: "test", paymentMethods: ["cashu"],
      auth: secp256k1Auth(), credit: { min: "$0.10", max: "$5.00", allowOneShotStablecoin: true },
      async onBoot() {
        const info = await (await host.app.request("/v1/info")).json();
        expect(info.payment.methods).toEqual(["cashu"]);
        expect(info).not.toHaveProperty("x402");
        expect(info).not.toHaveProperty("tempo");
        expect(info.credit).toMatchObject({ funding: [] });
        expect(info.credit).not.toHaveProperty("x402");
        expect(info.credit).not.toHaveProperty("tempo");
        throw stopBeforeListen;
      },
      onJob(ctx) { ctx.complete("ok"); },
    }));
    await expect(host.serve()).rejects.toBe(stopBeforeListen);
    expect(requests).not.toHaveBeenCalled();
  });

  it.each([
    { descriptorMethods: [] as PaymentMethod[], hostMethods: undefined },
    { descriptorMethods: ["x402", "tempo"] as PaymentMethod[], hostMethods: ["cashu"] as PaymentMethod[] },
  ])("honors empty methods and host overrides before normalizing explicit rails: %j", async ({ descriptorMethods, hostMethods }) => {
    const stopBeforeListen = new Error("stop before listen");
    const requests = vi.spyOn(globalThis, "fetch");
    const host = createDVMHost({
      devMode: true, fx, env: { DVMKIT_FAIL_FAST: "true", DVMKIT_TEMPO_RECIPIENT: "invalid" },
      paymentMethods: hostMethods,
      x402: { network: "unsupported", payTo },
    });
    host.mount(configureDVM({
      name: "explicit-excluded", capability: "test", paymentMethods: descriptorMethods,
      x402: { network: "unsupported", payTo },
      onBoot() { throw stopBeforeListen; },
      onJob(ctx) { ctx.complete("ok"); },
    }));
    await expect(host.serve()).rejects.toBe(stopBeforeListen);
    expect(requests).not.toHaveBeenCalled();
  });
});
