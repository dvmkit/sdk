import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, SettleResponse, SupportedResponse } from "@x402/core/types";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import type { AutoSettlementConfig, Channel, ChannelStorage } from "@x402/evm/batch-settlement/server";
import { vi } from "vitest";

import { PayoutReporter, type PayoutTransport, type X402BatchStore } from "../../payout-reporter";
import { createX402BatchSettlementServer } from "../../x402-batch-settlement";
import { PostgresX402ChannelStorage } from "../../x402-channel-store";

export const NETWORK = "eip155:84532";
export const PAY_TO = `0x${"22".repeat(20)}` as const;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const SCOPE = `${NETWORK}|${PAY_TO}|${TOKEN.toLowerCase()}`;

export async function claimRecoveryFixture(storage: ChannelStorage, batches: X402BatchStore, count: number) {
  const channels: Channel[] = [];
  for (let index = 0; index < count; index++) {
    const channelConfig: Channel["channelConfig"] = {
      payer: `0x${"11".repeat(20)}`, payerAuthorizer: `0x${"11".repeat(20)}`,
      receiver: PAY_TO, receiverAuthorizer: PAY_TO, token: TOKEN,
      withdrawDelay: 86_400, salt: `0x${index.toString(16).padStart(64, "0")}`,
    };
    const channel: Channel = {
      channelId: computeChannelId(channelConfig, NETWORK).toLowerCase(), channelConfig,
      chargedCumulativeAmount: "100", signedMaxClaimable: "100", signature: `0x${"44".repeat(65)}`,
      balance: "1000", totalClaimed: "10", withdrawRequestedAt: 0, refundNonce: 0, lastRequestTimestamp: 0,
    };
    channels.push(channel);
    await storage.updateChannel(channel.channelId, () => channel);
  }
  const transport: PayoutTransport = {
    enqueuePayout: vi.fn(async () => undefined), reportPayout: vi.fn(async () => undefined),
    reportPayoutPending: vi.fn(async () => undefined), drainPending: vi.fn(async () => undefined),
  };
  let submissions = 0;
  let failClaims = true;
  let timeout = false;
  const facilitator: FacilitatorClient = {
    verify: vi.fn(),
    getSupported: vi.fn(async (): Promise<SupportedResponse> => ({
      kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK,
        extra: { receiverAuthorizer: PAY_TO } }], extensions: [], signers: {},
    })),
    settle: vi.fn(async (payment: PaymentPayload): Promise<SettleResponse> => {
      if (payment.payload.type === "claim" && ++submissions > 1 && failClaims) {
        if (timeout) throw new Error("facilitator timeout");
        return { success: false, errorReason: "rejected", transaction: "", network: NETWORK };
      }
      return { success: true, transaction: `0x${String(submissions).padStart(64, "a")}`, network: NETWORK };
    }),
  };
  const earned = new Set(channels.map((channel) => channel.channelId));
  const createServer = async (owner = storage, autoSettlement: AutoSettlementConfig | false = false) => {
    const reporter = new PayoutReporter({ dvmId: "example-dvm", transport, batchStore: batches });
    return createX402BatchSettlementServer({
      network: NETWORK, payTo: PAY_TO, earnedNative: async (id) => earned.has(id) ? 40 : 0,
      payout: reporter.x402Observer(),
      ...(owner instanceof PostgresX402ChannelStorage ? { channelStorage: owner } : {}),
      config: { facilitatorClient: facilitator, autoSettlement,
        ...(owner instanceof PostgresX402ChannelStorage ? {} : { storage: owner }) },
    });
  };
  return { channels, transport, facilitator, earned, createServer,
    allowClaims: () => { failClaims = false; }, timeOutClaims: () => { timeout = true; } };
}
