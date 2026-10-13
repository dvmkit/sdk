import { describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { durableLedger, fundCredit } from "./__helpers__/credit-fixtures";

const CALLER = "aa".repeat(32);
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-08-23T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

async function info(credit: boolean): Promise<Record<string, unknown>> {
  const ledger = durableLedger();
  await fundCredit(ledger, {
    creditId: "private-credit",
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 2_000_000,
    expiryMs: Date.now() + 86_400_000,
  });
  const dvm = configureDVM({
    name: "credit-info",
    capability: "run",
    auth: secp256k1Auth(),
    ...(credit && { credit: { min: "$0.10", max: "$5.00" } }),
    onJob(ctx) {
      ctx.complete("done");
    },
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    creditLedger: ledger,
    mints: ["https://mint.example.com"],
    paymentMethods: ["cashu"],
    fxFetcher: stubFx,
  });
  return (await (await app.request("/v1/info")).json()) as Record<string, unknown>;
}

describe("prepaid credit on /v1/info", () => {
  it("advertises public terms for an opted-in container DVM", async () => {
    const body = await info(true);
    expect(body.credit).toMatchObject({
      min_micro: 100_000,
      max_micro: 5_000_000,
      currency: "usd",
      funding: ["cashu"],
    });
    const credit = body.credit as Record<string, unknown>;
    expect(credit).not.toHaveProperty("credit_id");
    expect(credit).not.toHaveProperty("balance_micro");
    expect(credit).not.toHaveProperty("remaining_micro");
    expect(credit).not.toHaveProperty("expiry_ms");
  });

  it("omits the block when the DVM did not opt in", async () => {
    expect(await info(false)).not.toHaveProperty("credit");
  });
});
