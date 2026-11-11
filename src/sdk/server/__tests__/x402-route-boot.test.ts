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

function dvm(outputBytes: number, paymentMethods?: ("cashu" | "x402")[], extra: { currency?: "eur"; x402?: typeof x402 & { dualServe?: boolean } } = {}) {
  return configureDVM({
    name: "boot-check",
    x402: extra.x402 ?? x402,
    ...(extra.currency && { currency: extra.currency }),
    ...(paymentMethods && { paymentMethods }),
    capabilities: {
      fetch: {
        input: z.object({ url: z.string() }),
        // A static price is a USD literal, so another currency is quoted.
        ...(extra.currency
          ? { onQuote: { schema: z.object({}), handler: async () => ({ upfront: { amount: 0.01, currency: extra.currency! }, description: "One cent." }) } }
          : { price: "$0.01" }),
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

function boot(
  descriptor: ReturnType<typeof dvm>,
  env: Record<string, string> = {},
  devMode?: boolean,
  extra: { mountPrefix?: string; x402?: typeof x402 & { dualServe?: boolean } } = {}
) {
  return createDVMServer(descriptor, {
    env,
    store: new MemoryKVStore(),
    x402: extra.x402 ?? x402,
    fxFetcher: createFxFetcher({ currencies: ["usd", "eur"] }),
    devMode,
    ...(extra.mountPrefix !== undefined && { mountPrefix: extra.mountPrefix }),
  });
}

function noRailDvm(extra: { currency?: "eur" } = {}) {
  return configureDVM({
    name: "missing-rail",
    ...(extra.currency && { currency: extra.currency }),
    capabilities: {
      fetch: {
        channels: { job: false, x402: {} },
        ...(extra.currency
          ? { onQuote: { schema: z.object({}), handler: async () => ({ upfront: { amount: 0.01, currency: extra.currency! }, description: "One cent." }) } }
          : { price: "$0.01" }),
        maxRuntimeSeconds: 5,
        onJob(ctx) { ctx.complete("done"); },
      },
    },
  });
}

/** The largest `outputExample` a listing configures with at its 100-character stand-in host. */
function largestConfigurable(): number {
  let lo = 0;
  let hi = 8192;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (configures(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Events the server logged at warn, as they reach the log after projection. */
function warnedEvents(): string[] {
  return vi.mocked(console.warn).mock.calls.flatMap(([line]) => {
    try {
      return [(JSON.parse(String(line)) as { event: string }).event];
    } catch {
      return [];
    }
  });
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
  it("starts without a rail, serving /v1/job while the x402 route refuses without a 402 and /v1/info omits it", async () => {
    const descriptor = configureDVM({
      name: "missing-rail",
      capabilities: {
        echo: {
          input: z.object({ text: z.string() }),
          onJob(ctx) { ctx.complete(`echo ${(ctx.input as { text: string }).text}`); },
        },
        paid: {
          input: z.object({ text: z.string() }),
          price: "$0.01",
          onJob(ctx) { ctx.complete("paid"); },
        },
        fetch: {
          input: z.object({ url: z.string() }),
          channels: { job: false, x402: {} },
          price: "$0.01",
          maxRuntimeSeconds: 5,
          onJob(ctx) { ctx.complete("done"); },
        },
      },
    });
    const origin = "https://dvm.example.com";
    const server = await createDVMServer(descriptor, {
      env: { DVMKIT_PUBLIC_URL: origin },
      store: new MemoryKVStore(),
      fxFetcher: createFxFetcher(),
      // An explicit list must name x402 to offer the channel at all.
      paymentMethods: ["cashu", "x402"],
    });
    try {
      const job = await server.app.request(`${origin}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "echo", data: { text: "hi" } }),
      });
      expect(job.status).toBeLessThan(300);
      expect(await job.json()).toMatchObject({ status: "completed", summary: "echo hi" });

      // A paid attempt is refused the same way: no route here can take it.
      for (const headers of [{}, { "PAYMENT-SIGNATURE": "e30=" }] as Record<string, string>[]) {
        const route = await server.app.request(`${origin}/v1/x402/fetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ url: "https://example.com" }),
        });
        expect(route.status).toBe(503);
        expect(route.headers.get("PAYMENT-REQUIRED")).toBeNull();
        const body = (await route.json()) as { error: string; retryable: boolean; hint: string };
        expect(body.error).toBe("x402_not_offered");
        expect(body.retryable).toBe(false);
        expect(body.hint).toContain("x402 is not configured for this DVM");
      }

      const info = (await (await server.app.request(`${origin}/v1/info`)).json()) as Record<string, unknown>;
      expect(info).not.toHaveProperty("x402_capabilities");
      expect(Object.keys(info.capabilities as object)).toEqual(["echo", "paid"]);
      expect((info.payment as { methods: string[] }).methods).toEqual(["cashu"]);

      const quote = await server.app.request(`${origin}/v1/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "paid", data: { text: "hi" } }),
      });
      const quoted = (await quote.json()) as { payment: { methods: string[]; refundable?: Record<string, boolean> } };
      expect(quoted.payment.methods).toEqual(["cashu"]);
      expect(quoted.payment.refundable ?? {}).not.toHaveProperty("x402");
    } finally {
      await server.shutdown();
    }
  });

  it("refuses a descriptor whose own x402 rail was not passed to createDVMServer", async () => {
    await expect(
      createDVMServer(dvm(0), { env: { DVMKIT_PUBLIC_URL: "https://dvm.example.com" }, store: new MemoryKVStore(), devMode: true })
    ).rejects.toThrow("DVMConfig.x402 is set, but the server was given no x402 configuration; pass the x402 option to createDVMServer");
  });

  it("logs one x402_rail_missing warning naming every affected capability, in devMode too", async () => {
    const descriptor = configureDVM({
      name: "missing-rail",
      capabilities: Object.fromEntries(["fetch", "summarize"].map((name) => [name, {
        channels: { job: false, x402: {} },
        price: "$0.01",
        maxRuntimeSeconds: 5,
        onJob(ctx: { complete(result: string): void }) { ctx.complete("done"); },
      }])),
    });
    await expect(createDVMServer(descriptor, { env: {}, store: new MemoryKVStore(), devMode: true })).resolves.toBeDefined();
    const lines = vi.mocked(console.warn).mock.calls
      .map(([line]) => JSON.parse(String(line)) as { event: string; capabilities?: string[] })
      .filter((line) => line.event === "x402_rail_missing");
    expect(lines).toEqual([{ event: "x402_rail_missing", level: "warn", capabilities: ["fetch", "summarize"] }]);
    // The route checks that need a rail stay quiet when there is none.
    expect(warnedEvents()).not.toContain("x402_route_origin_from_request");
    expect(warnedEvents()).not.toContain("x402_route_settlement_store_missing");
  });

  it("refuses to start when the public origin pushes a listing's challenge past the size limit", async () => {
    const descriptor = dvm(largestConfigurable());

    await expect(boot(descriptor, { DVMKIT_PUBLIC_URL: LONG_ORIGIN })).rejects.toThrow(
      /capability "fetch" channels\.x402\.listing makes the encoded PAYMENT-REQUIRED header \d+ bytes, over the 7168-byte limit.*DVMKIT_PUBLIC_URL/
    );
    await expect(boot(descriptor, { DVMKIT_PUBLIC_URL: "https://dvm.example.com" }, true)).resolves.toBeDefined();
  });

  it("measures the challenge at the host's mount prefix, which lands in the listed resource", async () => {
    const descriptor = dvm(largestConfigurable());
    const env = { DVMKIT_PUBLIC_URL: "https://dvm.example.com" };
    await expect(boot(descriptor, env, true, { mountPrefix: "/feed" })).resolves.toBeDefined();
    await expect(boot(descriptor, env, true, { mountPrefix: `/${"p".repeat(300)}` })).rejects.toThrow(
      /capability "fetch" channels\.x402\.listing makes the encoded PAYMENT-REQUIRED header \d+ bytes, over the 7168-byte limit/
    );
  });

  it("measures the challenge at a host mount's prefix", async () => {
    const host = createDVMHost({ devMode: true, port: 0, env: { DVMKIT_PUBLIC_URL: "https://dvm.example.com" }, x402, fx: createFxFetcher() });
    host.mount(dvm(largestConfigurable()), { prefix: `/${"p".repeat(300)}` });
    await expect(host.serve()).rejects.toThrow(/over the 7168-byte limit/);
  });

  it("refuses to start outside devMode without durable exact settlement, and warns in devMode, since every route request would answer 503", async () => {
    const env = { DVMKIT_PUBLIC_URL: "https://dvm.example.com" };
    await expect(boot(dvm(0), env)).rejects.toThrow(
      /capability "fetch" is offered on x402 but the server has no durable x402 settlement store/
    );
    await expect(boot(dvm(0), env, true)).resolves.toBeDefined();
    expect(warnedEvents()).toContain("x402_route_settlement_store_missing");
  });

  it("refuses to start, or warns in devMode, when the DVM prices in a currency x402 cannot charge", async () => {
    const env = { DVMKIT_PUBLIC_URL: "https://dvm.example.com" };
    await expect(boot(dvm(0, undefined, { currency: "eur" }), env)).rejects.toThrow(
      /capability "fetch" is offered on x402 but this DVM prices in "eur"/
    );
    await expect(boot(dvm(0, undefined, { currency: "eur" }), env, true)).resolves.toBeDefined();
    expect(warnedEvents()).toContain("x402_route_currency_unsupported");
  });

  it("refuses to start, or warns in devMode, when x402 dual-serve is off, so no 402 would offer x402", async () => {
    const env = { DVMKIT_PUBLIC_URL: "https://dvm.example.com" };
    const off = { ...x402, dualServe: false };
    await expect(boot(dvm(0, undefined, { x402: off }), env, false, { x402: off })).rejects.toThrow(
      /capability "fetch" is offered on x402 but x402\.dualServe is false/
    );
    await expect(boot(dvm(0, undefined, { x402: off }), env, true, { x402: off })).resolves.toBeDefined();
    expect(warnedEvents()).toContain("x402_route_dual_serve_off");
  });

  it("refuses to start when the host's payment methods leave out x402", async () => {
    const host = createDVMHost({ devMode: true, port: 0, env: {}, paymentMethods: ["cashu"], fx: createFxFetcher() });
    host.mount(dvm(0));

    await expect(host.serve()).rejects.toThrow(
      'capability "fetch" is offered on x402 but paymentMethods (["cashu"]) leaves out "x402"'
    );
  });

  it("keeps refusing a payment-methods or public-origin contradiction when there is no rail", async () => {
    const host = createDVMHost({ devMode: true, port: 0, env: {}, paymentMethods: ["cashu"], fx: createFxFetcher() });
    host.mount(noRailDvm());
    await expect(host.serve()).rejects.toThrow('paymentMethods (["cashu"]) leaves out "x402"');
    await expect(createDVMServer(noRailDvm(), { env: {}, store: new MemoryKVStore(), fxFetcher: createFxFetcher() })).rejects.toThrow(
      /capability "fetch" is offered on x402 but DVMKIT_PUBLIC_URL is unset/
    );
    // A server that refuses to start does not also report itself as starting without x402.
    expect(warnedEvents()).not.toContain("x402_rail_missing");
  });

  // Turning a rail on later must not make a starting DVM refuse to boot.
  it("refuses, without a rail, the contradictions a rail would later expose", async () => {
    const options = { env: { DVMKIT_PUBLIC_URL: "https://dvm.example.com" }, store: new MemoryKVStore(), fxFetcher: createFxFetcher({ currencies: ["usd", "eur"] }) };
    await expect(createDVMServer(noRailDvm({ currency: "eur" }), options)).rejects.toThrow(
      /capability "fetch" is offered on x402 but this DVM prices in "eur"/
    );
    // 5 s runtime plus the default 10 s facilitator timeout.
    await expect(
      createDVMServer(noRailDvm(), { ...options, env: { ...options.env, DVMKIT_X402_RESPONSE_LIMIT_MS: "14999" } })
    ).rejects.toThrow(/over DVMKIT_X402_RESPONSE_LIMIT_MS \(14999 ms\)/);
    await expect(
      createDVMServer(noRailDvm(), { ...options, env: { ...options.env, DVMKIT_X402_RESPONSE_LIMIT_MS: "15000" } })
    ).resolves.toBeDefined();
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

// The capability's deadline is its 5 s runtime bound plus the facilitator timeout.
describe("DVMKIT_X402_RESPONSE_LIMIT_MS", () => {
  const PUBLIC = { DVMKIT_PUBLIC_URL: "https://dvm.example.com" };

  it("refuses to start when a capability's deadline, default facilitator timeout included, exceeds the limit", async () => {
    const refused = boot(dvm(0), { ...PUBLIC, DVMKIT_X402_RESPONSE_LIMIT_MS: "14999" });
    await expect(refused).rejects.toThrow(
      'capability "fetch" is offered on x402 with maxRuntimeSeconds 5 and a 10000 ms facilitator timeout, ' +
        "so a paid request can take 15000 ms to answer, over DVMKIT_X402_RESPONSE_LIMIT_MS (14999 ms)"
    );
    await expect(refused).rejects.toThrow(/or offer the capability on the job channel only/);
  });

  it("counts the configured facilitator timeout, not the default", async () => {
    const quick = { ...x402, facilitatorTimeoutMs: 2_000 };
    await expect(
      boot(dvm(0, undefined, { x402: quick }), { ...PUBLIC, DVMKIT_X402_RESPONSE_LIMIT_MS: "6999" }, false, { x402: quick })
    ).rejects.toThrow("a 2000 ms facilitator timeout, so a paid request can take 7000 ms to answer");
  });

  it("passes a deadline exactly at the limit", async () => {
    // Past this check, boot stops at the next one: no durable settlement store.
    await expect(boot(dvm(0), { ...PUBLIC, DVMKIT_X402_RESPONSE_LIMIT_MS: "15000" })).rejects.toThrow(
      /no durable x402 settlement store/
    );
    await expect(boot(dvm(0), { ...PUBLIC, DVMKIT_X402_RESPONSE_LIMIT_MS: "15000" }, true)).resolves.toBeDefined();
    expect(warnedEvents()).not.toContain("x402_route_response_limit_exceeded");
  });

  it("checks nothing when unset", async () => {
    await expect(boot(dvm(0), PUBLIC)).rejects.toThrow(/no durable x402 settlement store/);
    await expect(boot(dvm(0), PUBLIC, true)).resolves.toBeDefined();
    expect(warnedEvents()).not.toContain("x402_route_response_limit_exceeded");
  });

  it("warns instead of refusing in devMode", async () => {
    await expect(boot(dvm(0), { ...PUBLIC, DVMKIT_X402_RESPONSE_LIMIT_MS: "14999" }, true)).resolves.toBeDefined();
    expect(warnedEvents()).toContain("x402_route_response_limit_exceeded");
  });

  it.each(["0", "-1", "abc", "1.5", "15000ms", " 15000", "1e4", "99999999999999999999"])(
    "refuses to start on the invalid value %j, in devMode too",
    async (value) => {
      for (const devMode of [false, true]) {
        await expect(boot(dvm(0), { ...PUBLIC, DVMKIT_X402_RESPONSE_LIMIT_MS: value }, devMode)).rejects.toThrow(
          "DVMKIT_X402_RESPONSE_LIMIT_MS is " + JSON.stringify(value) + ", not a positive whole number of milliseconds"
        );
      }
    }
  );
});
