/*
 * Route responses must publish the exact fiat micro integer beside rail requirements;
 * a rendered decimal can lose the funding ratio. Pure derivation is covered separately.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-31T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/*
 * Finer than the rendered four-decimal price, so the integer wire field must retain it.
 */
const FINE_USD = 0.003174;
const FINE_MICRO = 3174;

const inputSchema = z.object({ n: z.number() });

const servers = servedApps();

async function startServer(pricing: "static" | "dynamic" | "free"): Promise<string> {
  const priced =
    pricing === "static"
      ? { price: "$0.10" as const }
      : pricing === "dynamic"
        ? {
            onQuote: {
              schema: inputSchema,
              handler: () =>
                Promise.resolve({
                  upfront: { amount: FINE_USD, currency: "usd" as const },
                  description: "fine-grained",
                }),
            },
          }
        : {};
  const dvm = configureDVM({
    name: "exact-price-micro",
    capability: "do",
    input: inputSchema,
    ...priced,
    onJob(ctx) {
      ctx.complete("done");
    },
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
  });
  return servers.serve(app);
}

function post(url: string, path: string): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "do", data: { n: 1 }, input: JSON.stringify({ n: 1 }) }),
  });
}

describe("/v1/quote states the exact micro price", () => {
  it("carries the ledger's own integer beside a static price's decimal", async () => {
    const url = await startServer("static");
    const body = (await (await post(url, "/v1/quote")).json()) as {
      upfront: { amount: number; amount_micro?: number; currency: string };
    };
    expect(body.upfront).toEqual({ amount: 0.1, amount_micro: 100_000, currency: "usd" });
  });

  it("carries a dynamic price finer than four decimals without rounding it", async () => {
    const url = await startServer("dynamic");
    const body = (await (await post(url, "/v1/quote")).json()) as {
      upfront: { amount: number; amount_micro?: number };
    };
    expect(body.upfront.amount_micro).toBe(FINE_MICRO);

    expect(body.upfront.amount).toBe(FINE_USD);
  });

  it("omits the field on a free quote — there is no ledger figure to state", async () => {
    const url = await startServer("free");
    const body = (await (await post(url, "/v1/quote")).json()) as {
      upfront: Record<string, unknown>;
    };
    expect(body.upfront).toEqual({ amount: 0, currency: "usd" });
  });
});

describe("the upfront 402 states the exact micro price", () => {
  it("puts both halves of the fund-and-draw ratio on one envelope", async () => {
    const url = await startServer("dynamic");
    const res = await post(url, "/v1/job");
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    /* Fiat and rail requirements must come from one price resolution; a second quote can change dynamic price. */
    expect(body.error).toBe("payment_required");
    expect(body.price_micro).toBe(FINE_MICRO);
    expect(body.price_currency).toBe("usd");
    // $0.003174 @ $100k/BTC is 3.174 sats, which `fiatToSatsCeil` takes to 4 —
    // the ceil is exactly why the ratio's two halves must come off one
    // envelope rather than two independently-resolved ones.
    expect(body.required_msats).toBe(4000);
  });

  it("states a static price's integer too", async () => {
    const url = await startServer("static");
    const body = (await (await post(url, "/v1/job")).json()) as Record<string, unknown>;
    expect(body.price_micro).toBe(100_000);
    expect(body.price_currency).toBe("usd");
  });

  it("omits both fields on a free job, which has no price to state", async () => {
    const url = await startServer("free");
    const res = await post(url, "/v1/job");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("price_micro");
    expect(body).not.toHaveProperty("price_currency");
  });
});
