import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTestMintUrl } from "../../../lib/mints";
import { configureDVM } from "../../configure";
import { isConfiguredX402Settleable } from "../host";
import { MemoryJobStore } from "../memory-job-store";
import type { MppxServer } from "../mpp-setup";
import { devModeSkipsPaymentVerification } from "../payment";
import { resolvePaymentMode } from "../payment-mode";
import { serve } from "../serve";
import { X402FacilitatorHealth, type X402FacilitatorSupport } from "../x402-facilitator-support";

const x402 = { network: "eip155:84532", payTo: `0x${"11".repeat(20)}` };
const mpp = { methods: [{ name: "tempo" }], tempoConfiguration: { chainId: 42431 } } as unknown as MppxServer;
const dvm = configureDVM({ name: "mode", capability: "test", tag: "test", price: "$0.01", onJob(ctx) { ctx.complete("ok"); } });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe("effective payment mode", () => {
  it("skips only absent rails, preserving empty-mints semantics in both call paths", () => {
    expect(devModeSkipsPaymentVerification({ devMode: true })).toBe(true);
    for (const config of [{ mints: [] }, { mints: ["http://localhost:3338"] }, { x402 }, { mpp }, { paymentMethods: ["tempo"] as const }]) {
      expect(devModeSkipsPaymentVerification({ devMode: true, ...config } as Parameters<typeof devModeSkipsPaymentVerification>[0])).toBe(false);
    }
    expect(devModeSkipsPaymentVerification({})).toBe(false);
  });
  it("reports absent, unavailable, verifying, test funds and production accurately", () => {
    const base = { mount: "one", devMode: true, cashuReady: false, x402Available: false, durable: false };
    expect(resolvePaymentMode(base).verification).toBe("skipped");
    expect(resolvePaymentMode(base).rails.cashu.status).toBe("absent");
    expect(resolvePaymentMode({ ...base, mints: [] }).rails.cashu.status).toBe("unavailable");
    expect(resolvePaymentMode({ ...base, x402 }).verification).toBe("required");
    expect(resolvePaymentMode({ ...base, x402 }).rails.x402).toEqual({ status: "unavailable", testFunds: true });
    expect(resolvePaymentMode({ ...base, x402, x402Available: true }).rails.x402.status).toBe("verifying");
    expect(resolvePaymentMode({ ...base, mpp }).rails.tempo).toEqual({ status: "verifying", testFunds: true });
    expect(resolvePaymentMode({ ...base, devMode: false, durable: true })).toMatchObject({ verification: "required", storage: "durable" });
  });
  it("rejects unknown/real mints without disposable storage and guards the hosted test mint", async () => {
    await expect(serve(dvm, { devMode: true, env: {}, port: 0, mints: ["https://mint.example.com"] })).rejects.toThrow("Real or unknown mints");
    expect(isTestMintUrl("https://dvmkit-testmint.fly.dev")).toBe(true);
    await expect(serve(dvm, { env: { DVMKIT_PLATFORM_URL: "https://example.com" }, jobStore: new MemoryJobStore(), port: 0, mints: ["https://dvmkit-testmint.fly.dev"] })).rejects.toThrow("Refusing to boot");
  });
  it("keeps unusable x402 payment-required and fails fast without changing network", async () => {
    const facilitator = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ kinds: [], extensions: [], signers: {} }));
    });
    await new Promise<void>((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () => new Promise<void>((resolve, reject) => facilitator.close((error) => (error ? reject(error) : resolve())))
    );
    const address = facilitator.address() as { port: number };
    const config = {
      ...x402,
      network: "eip155:8453",
      facilitator: `http://127.0.0.1:${address.port}`
    };
    const running = await serve(dvm, {
      devMode: true,
      env: {},
      port: 0,
      x402: config
    });
    cleanup.unshift(running.close);
    expect(running.paymentModes[0]).toMatchObject({
      verification: "required",
      rails: { x402: { status: "unavailable", testFunds: false } }
    });
    expect(
      (
        await fetch(`${running.url}/v1/job`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capability: "test" })
        })
      ).status
    ).toBe(402);
    await expect(
      serve(dvm, {
        devMode: true,
        env: { DVMKIT_FAIL_FAST: "true" },
        port: 0,
        x402: config
      })
    ).rejects.toThrow(/eip155:8453.*facilitator.*eip155:84532/);
  });
  it("uses batch-only support only when batch settlement is configured", async () => {
    const facilitator = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          kinds: [
            {
              x402Version: 2,
              scheme: "batch-settlement",
              network: "eip155:84532",
              extra: { receiverAuthorizer: `0x${"22".repeat(20)}` }
            }
          ],
          extensions: [],
          signers: {}
        })
      );
    });
    await new Promise<void>((resolve) => facilitator.listen(0, "127.0.0.1", resolve));
    cleanup.push(
      () => new Promise<void>((resolve, reject) => facilitator.close((error) => (error ? reject(error) : resolve())))
    );
    const address = facilitator.address() as { port: number };
    const base = { ...x402, facilitator: `http://127.0.0.1:${address.port}` };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const unavailable = await serve(dvm, {
      devMode: true,
      env: {},
      port: 0,
      x402: base
    });
    cleanup.unshift(unavailable.close);
    expect(unavailable.paymentModes[0]?.rails.x402.status).toBe("unavailable");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("x402_network_unsupported"));
    await expect(
      serve(dvm, {
        devMode: true,
        env: { DVMKIT_FAIL_FAST: "true" },
        port: 0,
        x402: base
      })
    ).rejects.toThrow(/has no settleable kind/);

    const verifying = await serve(dvm, {
      devMode: true,
      env: {},
      port: 0,
      x402: { ...base, batchSettlement: { autoSettlement: false } }
    });
    cleanup.unshift(verifying.close);
    expect(verifying.paymentModes[0]?.rails.x402.status).toBe("verifying");
    const capabilityWarning = warn.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes("x402_facilitator_unavailable"));
    expect(capabilityWarning).toBeDefined();
    expect(capabilityWarning).not.toContain("Exact x402 is unavailable");
  });
  it("counts self-relay as settleable and warns only that exact x402 is unavailable", async () => {
    const unsupported: X402FacilitatorSupport = {
      available: false,
      exact: { v1: false, v2: false },
      batchSettlement: false,
      facilitator: "https://example.com",
      network: "eip155:8453",
      reason: "unsupported_exact"
    };
    expect(isConfiguredX402Settleable(unsupported, x402)).toBe(false);
    const selfRelayConfig = {
      ...x402,
      network: "eip155:8453",
      batchSettlement: {
        selfRelay: {
          privateKey: `0x${"33".repeat(32)}` as `0x${string}`,
          rpcUrl: "https://example.com"
        }
      }
    };
    expect(isConfiguredX402Settleable(unsupported, selfRelayConfig)).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const health = new X402FacilitatorHealth(selfRelayConfig, {
      client: {
        getSupported: vi.fn().mockResolvedValue({ kinds: [], extensions: [], signers: {} })
      }
    });
    await health.refresh();
    const capabilityWarning = warn.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes("x402_facilitator_unavailable"));
    expect(capabilityWarning).toBeDefined();
    expect(capabilityWarning).not.toContain("Exact x402 is unavailable");
  });
});
