import type { FacilitatorClient } from "@x402/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";
import { probeX402FacilitatorSupport, X402FacilitatorHealth } from "../x402-facilitator-support";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const FACILITATOR = "https://facilitator.test";

describe("probeX402FacilitatorSupport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts exact v1 and v2 support in legacy-slug and CAIP-2 forms", async () => {
    const support = await probeX402FacilitatorSupport(
      { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
      {
        client: {
          getSupported: vi.fn().mockResolvedValue({
            kinds: [
              { x402Version: 1, scheme: "exact", network: "base" },
              { x402Version: 2, scheme: "exact", network: "eip155:8453" },
            ],
            extensions: [],
            signers: {},
          }),
        },
      }
    );

    expect(support).toEqual({
      available: true,
      exact: { v1: true, v2: true },
      batchSettlement: false,
      facilitator: FACILITATOR,
      network: "eip155:8453",
    });
  });

  it.each([
    [1, { v1: true, v2: false }],
    [2, { v1: false, v2: true }],
  ])("keeps exact x402 v%i independently available", async (x402Version, exact) => {
    const support = await probeX402FacilitatorSupport(
      { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
      {
        client: {
          getSupported: vi.fn().mockResolvedValue({
            kinds: [{ x402Version, scheme: "exact", network: "eip155:8453" }],
            extensions: [],
            signers: {},
          }),
        },
      }
    );

    expect(support).toMatchObject({
      available: true,
      exact,
      batchSettlement: false,
      facilitator: FACILITATOR,
      network: "eip155:8453",
    });
  });

  it("checks batch settlement independently from exact", async () => {
    const support = await probeX402FacilitatorSupport(
      { payTo: PAY_TO, network: "eip155:84532", facilitator: FACILITATOR },
      {
        client: {
          getSupported: vi.fn().mockResolvedValue({
            kinds: [
              { x402Version: 2, scheme: "exact", network: "eip155:84532" },
              { x402Version: 2, scheme: "batch-settlement", network: "base-sepolia" },
            ],
            extensions: [],
            signers: {},
          }),
        },
      }
    );

    expect(support).toMatchObject({
      available: true,
      exact: { v1: false, v2: true },
      batchSettlement: true,
    });
  });

  it("rejects a facilitator that only supports another scheme or network", async () => {
    const support = await probeX402FacilitatorSupport(
      { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
      {
        client: {
          getSupported: vi.fn().mockResolvedValue({
            kinds: [
              { x402Version: 2, scheme: "upto", network: "eip155:8453" },
              { x402Version: 2, scheme: "exact", network: "eip155:84532" },
            ],
            extensions: [],
            signers: {},
          }),
        },
      }
    );

    expect(support).toMatchObject({
      available: false,
      exact: { v1: false, v2: false },
      batchSettlement: false,
      facilitator: FACILITATOR,
      network: "eip155:8453",
      reason: "unsupported_exact",
    });
  });

  it("fails closed when the capability endpoint is unreachable or malformed", async () => {
    const support = await probeX402FacilitatorSupport(
      { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
      {
        client: {
          getSupported: vi.fn().mockRejectedValue(new Error("invalid supported response")),
        },
      }
    );

    expect(support).toMatchObject({
      available: false,
      reason: "probe_failed",
      error: "invalid supported response",
    });
  });

  it("enforces one hard wall-clock deadline around a stalled client", async () => {
    const support = await probeX402FacilitatorSupport(
      { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
      {
        client: {
          getSupported: vi.fn<FacilitatorClient["getSupported"]>(
            () => new Promise(() => undefined)
          ),
        },
        timeoutMs: 5,
      }
    );

    expect(support).toMatchObject({
      available: false,
      reason: "probe_failed",
      error: "facilitator capability probe timed out after 5ms",
    });
  });
});

describe("X402FacilitatorHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("revalidates on its TTL and replaces a version-specific observation", async () => {
    let nowMs = 1_000;
    const getSupported = vi
      .fn()
      .mockResolvedValueOnce(supported([{ x402Version: 2, scheme: "exact", network: "base" }]))
      .mockResolvedValueOnce(supported([{ x402Version: 1, scheme: "exact", network: "base" }]));
    const health = new X402FacilitatorHealth(
      { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
      { client: { getSupported }, now: () => nowMs, refreshTtlMs: 100 }
    );

    await health.refresh();
    expect(health.support().exact).toEqual({ v1: false, v2: true });
    await health.refresh();
    expect(getSupported).toHaveBeenCalledTimes(1);

    nowMs += 100;
    health.support();
    await health.refresh();
    expect(health.support().exact).toEqual({ v1: true, v2: false });
    expect(getSupported).toHaveBeenCalledTimes(2);
  });

  it("fails open through a transient probe failure, then closes at the staleness ceiling", async () => {
    let nowMs = 1_000;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const health = new X402FacilitatorHealth(
      { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
      {
        client: { getSupported: vi.fn().mockRejectedValue(new Error("offline")) },
        now: () => nowMs,
        maxStalenessMs: 1_000,
      }
    );

    await health.refresh();
    expect(health.support()).toMatchObject({
      available: true,
      exact: { v1: true, v2: true },
      batchSettlement: false,
    });

    nowMs += 1_000;
    expect(health.support()).toMatchObject({
      available: false,
      exact: { v1: false, v2: false },
    });
  });
});

describe("createDVMHost x402 facilitator gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits x402 while preserving other methods when the network is unsupported", async () => {
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (requestUrl(input) === `${FACILITATOR}/supported`) {
        return Promise.resolve(
          Response.json({
            kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
            extensions: [],
            signers: {},
          })
        );
      }
      return originalFetch(input, init);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {},
      paymentMethods: ["cashu", "x402"],
      x402: { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
    });
    host.mount(testDvm());
    const server = await host.serve();

    try {
      const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
        payment?: { methods?: string[] };
        x402?: unknown;
      };
      expect(info.payment?.methods).toEqual(["cashu"]);
      expect(info.x402).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("x402_facilitator_unavailable"));
    } finally {
      await server.close();
    }
  });

  it("keeps x402 when the facilitator advertises exact v1 and v2 support", async () => {
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (requestUrl(input) === `${FACILITATOR}/supported`) {
        return Promise.resolve(
          Response.json({
            kinds: [
              { x402Version: 1, scheme: "exact", network: "base" },
              { x402Version: 2, scheme: "exact", network: "eip155:8453" },
            ],
            extensions: [],
            signers: {},
          })
        );
      }
      return originalFetch(input, init);
    });
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {},
      x402: { payTo: PAY_TO, network: "eip155:8453", facilitator: FACILITATOR },
    });
    host.mount(testDvm());
    const server = await host.serve();

    try {
      const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
        payment?: { methods?: string[] };
        x402?: { network?: string };
      };
      expect(info.payment?.methods).toEqual(["x402"]);
      expect(info.x402?.network).toBe("eip155:8453");
    } finally {
      await server.close();
    }
  });

  it("keeps a v2-only exact rail, normalizes a network slug, and drops unsupported batch settlement", async () => {
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (requestUrl(input) === `${FACILITATOR}/supported`) {
        return Promise.resolve(
          Response.json(supported([{ x402Version: 2, scheme: "exact", network: "eip155:8453" }]))
        );
      }
      return originalFetch(input, init);
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {},
      x402: {
        payTo: PAY_TO,
        network: "base",
        facilitator: FACILITATOR,
        batchSettlement: {},
      },
    });
    host.mount(testDvm());
    const server = await host.serve();

    try {
      const info = (await (await fetch(`${server.url}/v1/info`)).json()) as {
        payment?: { methods?: string[] };
        x402?: { network?: string };
      };
      expect(info.payment?.methods).toEqual(["x402"]);
      expect(info.x402?.network).toBe("eip155:8453");
    } finally {
      await server.close();
    }
  });

  it("reuses the bounded probe response when batch settlement initializes", async () => {
    const originalFetch = globalThis.fetch;
    let supportedCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (requestUrl(input) === `${FACILITATOR}/supported`) {
        supportedCalls += 1;
        return Promise.resolve(
          Response.json(
            supported([
              { x402Version: 2, scheme: "exact", network: "eip155:84532" },
              {
                x402Version: 2,
                scheme: "batch-settlement",
                network: "eip155:84532",
                extra: { receiverAuthorizer: "0x2222222222222222222222222222222222222222" },
              },
            ])
          )
        );
      }
      return originalFetch(input, init);
    });
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {},
      x402: {
        payTo: PAY_TO,
        network: "base-sepolia",
        facilitator: FACILITATOR,
        batchSettlement: { autoSettlement: false },
      },
    });
    host.mount(testDvm());
    const server = await host.serve();

    try {
      expect(supportedCalls).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("rejects an unsupported network before any emitter is mounted", async () => {
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {},
      x402: { payTo: PAY_TO, network: "eip155:1", facilitator: FACILITATOR },
    });
    host.mount(testDvm());

    await expect(host.serve()).rejects.toThrow("Unsupported x402 network: eip155:1");
  });
});

function testDvm() {
  return configureDVM({
    name: "x402-facilitator-gate",
    capability: "test",
    tag: "test",
    onJob(ctx) {
      ctx.complete("ok");
    },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}

function supported(
  kinds: {
    x402Version: 1 | 2;
    scheme: "exact" | "batch-settlement";
    network: string;
    extra?: Record<string, unknown>;
  }[]
) {
  return { kinds, extensions: [], signers: {} };
}
