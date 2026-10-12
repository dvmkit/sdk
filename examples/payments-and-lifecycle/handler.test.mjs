import assert from "node:assert/strict";
import test from "node:test";

import { createTestContext } from "@dvmkit/sdk/testing";

import dvm, { lifecycle } from "./handler.mjs";

test("payment and lifecycle behavior is testable without a live rail", async () => {
  await dvm.config.onBoot({ PROVIDER_MODE: "example" });
  const ctx = createTestContext({
    input: { units: 3 },
    payment: { amount_msats: 6_000 },
  });

  await dvm.capabilities.process.onJob(ctx);
  await dvm.config.onShutdown();

  assert.equal(lifecycle.boots, 1);
  assert.equal(lifecycle.shutdowns, 1);
  assert.equal(ctx.completed, true);
  assert.equal(ctx.summary, "Processed 3 units");
  assert.deepEqual(ctx.reportedCost, { amountMicro: 1_500, currency: "usd" });
  assert.equal(ctx.messages[0]?.type, "payment-request");
});
