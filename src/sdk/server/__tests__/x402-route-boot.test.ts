/*
 * Configuration checks an x402 capability against stand-ins for what only
 * the server knows. The server reruns the checks with its own values, since a
 * host can override the descriptor's payment methods and the public origin
 * lands in every challenge's resource.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { diagnosticConsole } from "../../../observability/diagnostic-console";
import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { X402Listing } from "../../types";
import { createDVMServer } from "../app";
import { createDVMHost } from "../host";

const x402 = { payTo: "0x1111111111111111111111111111111111111111", network: "eip155:8453", facilitator: "https://facilitator.example.com" };
const listing: X402Listing = {
  description: "Fetch a public web page and return its readable text.",
  example: { url: "https://example.com/article" },
};
// A hostname at the DNS limit: 253 characters in labels of at most 63.
const LONG_ORIGIN = `https://${["a", "b", "c"].map((c) => c.repeat(63)).join(".")}.${"d".repeat(57)}.example`;

function dvm(outputBytes: number, paymentMethods?: ("cashu" | "x402")[]) {
  return configureDVM({
    name: "boot-check",
    x402,
    ...(paymentMethods && { paymentMethods }),
    capabilities: {
      fetch: {
        input: z.object({ url: z.string() }),
        price: "$0.01",
        maxRuntimeSeconds: 5,
        channels: { job: false, x402: { listing: { ...listing, outputExample: { text: "x".repeat(outputBytes) } } } },
        onJob(ctx) {
          ctx.complete("done");
        },
      },
    },
  });
}

function configures(outputBytes: number): boolean {
  try {
    dvm(outputBytes);
    return true;
  } catch {
    return false;
  }
}

function boot(descriptor: ReturnType<typeof dvm>, env: Record<string, string> = {}, devMode?: boolean) {
  return createDVMServer(descriptor, { env, store: new MemoryKVStore(), x402, fxFetcher: createFxFetcher(), devMode });
}

beforeEach(() => {
  // Keep boot off the network: no facilitator or FX source answers in this test.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("x402 route boot checks", () => {
  it("refuses to start when the public origin pushes a listing's challenge past the size limit", async () => {
    let lo = 0;
    let hi = 8192;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (configures(mid)) lo = mid;
      else hi = mid;
    }
    // The largest listing configuration accepts at its 100-character stand-in host.
    const descriptor = dvm(lo);

    await expect(boot(descriptor, { DVMKIT_PUBLIC_URL: LONG_ORIGIN })).rejects.toThrow(
      /capability "fetch" channels\.x402\.listing makes the encoded PAYMENT-REQUIRED header \d+ bytes, over the 7168-byte limit.*DVMKIT_PUBLIC_URL/
    );
    await expect(boot(descriptor, { DVMKIT_PUBLIC_URL: "https://dvm.example.com" })).resolves.toBeDefined();
  });

  it("refuses to start when the host's payment methods leave out x402", async () => {
    const host = createDVMHost({ devMode: true, port: 0, env: {}, paymentMethods: ["cashu"], fx: createFxFetcher() });
    host.mount(dvm(0));

    await expect(host.serve()).rejects.toThrow(
      'capability "fetch" is offered on x402 but paymentMethods (["cashu"]) leaves out "x402"'
    );
  });

  it("refuses to start without a valid DVMKIT_PUBLIC_URL, since every payment names it as the resource", async () => {
    const envs: Record<string, string>[] = [{}, { DVMKIT_PUBLIC_URL: "dvm.example.com" }];
    for (const env of envs) {
      await expect(boot(dvm(0), env)).rejects.toThrow(
        /capability "fetch" is offered on x402 but DVMKIT_PUBLIC_URL is unset or not an http or https URL/
      );
    }
  });

  it("starts in devMode without DVMKIT_PUBLIC_URL, warning once that the request's origin stands in", async () => {
    const warn = vi.spyOn(diagnosticConsole, "warn");
    await expect(boot(dvm(0), {}, true)).resolves.toBeDefined();
    const warned = warn.mock.calls.filter(([value]) => (value as { event?: string }).event === "x402_route_origin_from_request");
    expect(warned).toHaveLength(1);
  });
});
