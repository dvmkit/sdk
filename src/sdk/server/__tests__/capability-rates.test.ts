import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { z } from "zod";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { CapabilityConfig, CapabilityRate } from "../../types";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";

interface Fixture {
  valid: { name: string; rates: CapabilityRate[] }[];
  invalid: { name: string; rates: unknown; field: string }[];
}

const fixture = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/capability-rates.json", import.meta.url), {
    encoding: "utf8",
  })
) as Fixture;

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-08-23T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const onJob: CapabilityConfig["onJob"] = (ctx) => {
  ctx.complete("done");
};

const quoted = (): CapabilityConfig["onQuote"] => ({
  schema: z.object({ text: z.string() }),
  handler: () =>
    Promise.resolve({ upfront: { amount: 0.01, currency: "usd" }, description: "one unit" }),
});

async function start(capabilities: Record<string, CapabilityConfig>) {
  const dvm = configureDVM({ name: "rates", capabilities });
  return createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    mints: ["https://mint.example.com"],
    paymentMethods: ["cashu"],
    fxFetcher: stubFx,
  });
}

async function publishedPricing(
  capabilities: Record<string, CapabilityConfig>
): Promise<Record<string, Record<string, unknown> | undefined>> {
  const { app } = await start(capabilities);
  const raw = await (await app.request("/v1/info")).text();
  const body = JSON.parse(raw) as {
    capabilities: Record<string, { pricing?: Record<string, unknown> }>;
  };
  return Object.fromEntries(
    Object.entries(body.capabilities).map(([name, cap]) => [name, cap.pricing])
  );
}

describe("capability rate card on /v1/info", () => {
  it.each(fixture.valid)(
    "publishes the $name card exactly as declared on static and quoted capabilities",
    async ({ rates }) => {
      const pricing = await publishedPricing({
        fixed: { price: "$0.05", rates: structuredClone(rates), onJob },
        quoted: { onQuote: quoted(), rates: structuredClone(rates), onJob },
      });
      // Byte comparison: reordering, trimming or reformatting an amount fails.
      expect(JSON.stringify(pricing.fixed?.rates)).toBe(JSON.stringify(rates));
      expect(JSON.stringify(pricing.quoted?.rates)).toBe(JSON.stringify(rates));
      // Rates join the existing pricing object rather than replacing it.
      expect(pricing.fixed?.max).toEqual({ amount: 0.05, currency: "usd" });
      expect(pricing.quoted?.quote).toHaveProperty("schema");
    }
  );

  it("publishes no rates key when a capability declares none", async () => {
    const pricing = await publishedPricing({
      fixed: { price: "$0.05", onJob },
      quoted: { onQuote: quoted(), onJob },
      free: { onJob },
    });
    expect(pricing.fixed).toEqual({ max: { amount: 0.05, currency: "usd" } });
    expect(Object.keys(pricing.quoted ?? {})).toEqual(["quote"]);
    expect(pricing.free).toBeUndefined();
  });

  it("publishes a flat-shape capability's rates", async () => {
    const rates = fixture.valid[0].rates;
    const dvm = configureDVM({
      name: "flat",
      capability: "speak",
      price: "$0.05",
      rates: structuredClone(rates),
      onJob,
    });
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      mints: ["https://mint.example.com"],
      paymentMethods: ["cashu"],
      fxFetcher: stubFx,
    });
    const body = (await (await app.request("/v1/info")).json()) as {
      capabilities: Record<string, { pricing?: { rates?: unknown } }>;
    };
    expect(JSON.stringify(body.capabilities.speak.pricing?.rates)).toBe(JSON.stringify(rates));
  });
});

describe("capability rate card snapshots", () => {
  it("keeps publishing the validated card after the builder mutates its array", async () => {
    const declared = structuredClone(fixture.valid[0].rates);
    const expected = JSON.stringify(declared);
    const { app } = await start({ fixed: { price: "$0.05", rates: declared, onJob } });
    declared[0].amount = "-1";
    declared.reverse();
    declared.push({ amount: "0", currency: "USD", per: " unchecked " });
    const body = (await (await app.request("/v1/info")).json()) as {
      capabilities: Record<string, { pricing?: { rates?: unknown } }>;
    };
    expect(JSON.stringify(body.capabilities.fixed.pricing?.rates)).toBe(expected);
  });

  it("creates the pricing object for a quoted capability that publishes no quote schema", async () => {
    const rates = fixture.valid[1].rates;
    // Untyped JavaScript can omit the schema; rates still need somewhere to go.
    const onQuote = { ...quoted(), schema: undefined } as unknown as CapabilityConfig["onQuote"];
    const pricing = await publishedPricing({
      quoted: { onQuote, rates: structuredClone(rates), onJob },
    });
    expect(JSON.stringify(pricing.quoted)).toBe(JSON.stringify({ rates }));
  });
});

describe("capability rate card limits", () => {
  it.each(fixture.invalid)(
    "refuses the $name declaration at server construction",
    async ({ rates, field }) => {
      const escaped = field.replace(/[[\].]/g, "\\$&");
      await expect(
        start({ synthesise: { price: "$0.05", rates: rates as CapabilityRate[], onJob } })
      ).rejects.toThrow(new RegExp(`capability "synthesise": ${escaped} `));
    }
  );

  it("refuses rates on a free capability", async () => {
    await expect(
      start({ synthesise: { rates: structuredClone(fixture.valid[0].rates), onJob } })
    ).rejects.toThrow(/capability "synthesise": rates is declared on a free capability/);
  });
});
