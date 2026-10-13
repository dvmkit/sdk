import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  computeChannelId,
  createBatchSettlementEIP3009DepositPayload,
  signVoucher,
} from "@x402/evm/batch-settlement/client";
import { InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { announceTier } from "../../test-support/tier-announce";
import { createX402BatchSettlementServer } from "../server/x402-batch-settlement";
import {
  BASE_SEPOLIA_CAIP2,
  isBaseSepoliaReachable,
  isFacilitatorReachable,
  loadFundedPayerKey,
  usdcBalance,
  X402_FACILITATOR,
  X402_FACILITATOR_AUTH,
} from "./__helpers__/base-sepolia";
import { x402FacilitatorEndpointClass } from "./__helpers__/x402-live-tier";

const ENABLED =
  process.env.X402_BATCH_TESTNET_ENABLED === "true" &&
  Boolean(process.env.X402_TESTNET_RPC && process.env.X402_TESTNET_PRIVATE_KEY);
const probes = ENABLED
  ? await Promise.allSettled([isBaseSepoliaReachable(), isFacilitatorReachable()])
  : [];
for (const probe of probes) if (probe.status === "rejected") throw probe.reason;
const REACHABLE =
  ENABLED && probes.every((probe) => probe.status === "fulfilled" && probe.value === true);
if (ENABLED) {
  announceTier(
    "x402 batch-settlement integration",
    REACHABLE ? "ran" : "skipped",
    REACHABLE
      ? `Base Sepolia and ${x402FacilitatorEndpointClass(X402_FACILITATOR)} support batch settlement`
      : "batch testnet was enabled but Base Sepolia or its facilitator is unavailable"
  );
}

function header(
  payload: Pick<PaymentPayload, "x402Version" | "payload">,
  accepted: PaymentRequirements
): string {
  return Buffer.from(
    JSON.stringify({ ...payload, accepted, resource: { url: "/v1/credit" } })
  ).toString("base64");
}

describe.skipIf(!REACHABLE)("x402 batch settlement on Base Sepolia", () => {
  it("deposits, claims and settles one voucher, then cooperatively refunds", async () => {
    const payerKey = loadFundedPayerKey();
    if (!payerKey) throw new Error("unreachable: testnet gate requires a funded payer key");
    const payer = privateKeyToAccount(payerKey);
    const receiver = privateKeyToAccount(generatePrivateKey());
    const receiverBefore = await usdcBalance(receiver.address);
    const server = await createX402BatchSettlementServer({
      network: BASE_SEPOLIA_CAIP2,
      payTo: receiver.address,
      facilitator: X402_FACILITATOR,
      ...(X402_FACILITATOR_AUTH ? { facilitatorAuth: X402_FACILITATOR_AUTH } : {}),
      // Both vouchers' value has been drawn against the credit, so the claim
      // ceiling admits the whole 2000 charged.
      earnedNative: () => Promise.resolve(2000),
      config: {
        storage: new InMemoryChannelStorage(),
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [built] = await server.buildRequirements("1000");
    const requirements = built as PaymentRequirements;
    const channelConfig = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: requirements.asset as `0x${string}`,
      withdrawDelay: 86_400,
      salt: generatePrivateKey(),
    };
    const deposit = await createBatchSettlementEIP3009DepositPayload(
      payer,
      2,
      requirements,
      channelConfig,
      "5000",
      "1000"
    );
    const opened = await server.accept({
      paymentHeader: header(deposit, requirements),
      amount: "1000",
      operation: "fund",
      effectId: "credit-live:fund-1",
      commit: () => Promise.resolve(true),
    });
    expect(opened.ok).toBe(true);

    const channelId = computeChannelId(channelConfig, BASE_SEPOLIA_CAIP2);
    const voucher = await signVoucher(payer, channelId, "2000", BASE_SEPOLIA_CAIP2);
    const charged = await server.accept({
      paymentHeader: header(
        {
          x402Version: 2,
          payload: { type: "voucher", channelConfig, voucher },
        },
        requirements
      ),
      amount: "1000",
      operation: "fund",
      effectId: "credit-live:fund-2",
      commit: () => Promise.resolve(true),
    });
    expect(charged.ok).toBe(true);
    await server.claimAndSettle();

    const channel = await server.getChannel(channelId);
    if (!channel) throw new Error("facilitator settled deposit without returning channel state");
    const refund = await server.accept({
      paymentHeader: header(
        {
          x402Version: 2,
          payload: {
            type: "refund",
            channelConfig,
            voucher,
          },
        },
        { ...requirements, amount: "0" }
      ),
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId: "credit-live:drain-1",
      commit: () => Promise.resolve(true),
    });
    expect(refund.ok).toBe(true);
    expect(await server.getChannel(channelId)).toBeUndefined();

    const deadline = Date.now() + 30_000;
    let delta = 0n;
    while (Date.now() < deadline) {
      delta = (await usdcBalance(receiver.address)) - receiverBefore;
      if (delta >= 2000n) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    expect(delta).toBe(2000n);
    await server.stop();
  }, 120_000);
});
