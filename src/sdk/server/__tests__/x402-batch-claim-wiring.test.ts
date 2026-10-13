import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { type Channel, InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";

const NETWORK = "eip155:84532";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CALLER = "aa".repeat(32);

const CHANNEL_CONFIG: Channel["channelConfig"] = {
  payer: "0x3333333333333333333333333333333333333333",
  payerAuthorizer: "0x3333333333333333333333333333333333333333",
  receiver: PAY_TO,
  receiverAuthorizer: "0x2222222222222222222222222222222222222222",
  token: TOKEN,
  withdrawDelay: 86_400,
  salt: `0x${"99".repeat(32)}`,
};
// The claim's write-back re-derives the id from the config, so the row and the
// credit have to be bound to the derived one.
const CHANNEL_ID = computeChannelId(CHANNEL_CONFIG, NETWORK).toLowerCase();

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-08-10T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const schema = z.object({ pubkey: z.string(), signature: z.string() });

/** Advertises the channel scheme plus the authorizer boot demands, and records claims. */
function claimingFacilitator(): FacilitatorClient {
  return {
    verify: vi.fn(),
    settle: vi.fn((payload: PaymentPayload) =>
      Promise.resolve({
        success: true,
        transaction: `0x${(payload.payload as unknown as { type: string }).type}`,
        network: NETWORK as `${string}:${string}`,
      })
    ),
    getSupported: vi.fn(() =>
      Promise.resolve({
        kinds: [
          {
            x402Version: 2,
            scheme: "batch-settlement",
            network: NETWORK as `${string}:${string}`,
            extra: { receiverAuthorizer: "0x2222222222222222222222222222222222222222" },
          },
        ],
        extensions: [],
        signers: {},
      })
    ),
  };
}

/** A channel funded with 1000 and nothing claimed yet, as `accept()` would leave it. */
function fundedChannel(): Channel {
  return {
    channelId: CHANNEL_ID,
    channelConfig: CHANNEL_CONFIG,
    chargedCumulativeAmount: "1000",
    signedMaxClaimable: "1000",
    signature: `0x${"11".repeat(65)}`,
    balance: "1000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: 0,
  };
}

function claimedAmounts(facilitator: FacilitatorClient): string[] {
  return (facilitator.settle as ReturnType<typeof vi.fn>).mock.calls
    .map(
      ([payload]) =>
        (payload as PaymentPayload).payload as unknown as { type: string; claims?: unknown[] }
    )
    .filter((raw) => raw.type === "claim")
    .flatMap((raw) => (raw.claims ?? []).map((c) => (c as { totalClaimed: string }).totalClaimed));
}

describe("the DVM's claim job reads the DVM's own credit ledger", () => {
  it("claims the settled draws recorded by the host's ledger, not the deposit", async () => {
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000,
      expiryMs: Date.now() + 3_600_000,
      basis: {
        rail: "x402",
        paidMsats: 1_000,
        nativeAmount: 1_000,
        nativeAsset: "usdc",
        x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: "1000" },
      },
    });
    await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 400 });
    await ledger.settle({ creditId: "c1", drawId: "d1" });

    const storage = new InMemoryChannelStorage();
    await storage.updateChannel(CHANNEL_ID, () => fundedChannel());
    const facilitator = claimingFacilitator();

    const dvm = configureDVM({
      name: "x402-claim-wiring",
      capability: "do",
      input: schema,
      price: "$0.10",
      onJob(ctx) {
        ctx.complete("done");
      },
      auth: secp256k1Auth(),
    });
    const { shutdown } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      fxFetcher: stubFx,
      creditLedger: ledger,
      x402: {
        network: NETWORK,
        payTo: PAY_TO,
        batchSettlement: {
          storage,
          facilitatorClient: facilitator,
          // Fast enough to observe inside the test; the ceiling it applies is
          // the same one the shipped 300s cadence gets.
          autoSettlement: { claimIntervalSecs: 0.02, settleIntervalSecs: 3_600 },
        },
      },
    });

    await vi.waitFor(() => {
      expect(claimedAmounts(facilitator)).toEqual(["400"]);
    });
    expect(await storage.get(CHANNEL_ID)).toMatchObject({
      chargedCumulativeAmount: "1000",
      totalClaimed: "400",
    });
    await shutdown();
  });
});
