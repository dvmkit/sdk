import type { FacilitatorClient } from "@x402/core/server";
import { InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { createX402BatchSettlementServer } from "../x402-batch-settlement";

const PAY_TO = "0x1111111111111111111111111111111111111111";

/** Claim ceiling stand-in; no fixture here reaches a claim. */
const earnedNothing = (): Promise<number> => Promise.resolve(0);

function facilitatorWithoutAuthorizer(): FacilitatorClient {
  return {
    verify: vi.fn(),
    settle: vi.fn(),
    getSupported: vi.fn(async () => ({
      kinds: [
        {
          x402Version: 2,
          scheme: "batch-settlement",
          network: "eip155:84532" as const,
        },
      ],
      extensions: [],
      signers: {},
    })),
  };
}

describe("x402 batch-settlement boot policy", () => {
  it("reuses the bounded host observation instead of fetching facilitator support again", async () => {
    const getSupported = vi.fn().mockRejectedValue(new Error("unexpected second probe"));
    const facilitator: FacilitatorClient = {
      verify: vi.fn(),
      settle: vi.fn(),
      getSupported,
    };
    const supportedResponse = {
      kinds: [
        {
          x402Version: 2,
          scheme: "batch-settlement",
          network: "eip155:84532" as const,
          extra: { receiverAuthorizer: "0x2222222222222222222222222222222222222222" },
        },
      ],
      extensions: [],
      signers: {},
    };

    const server = await createX402BatchSettlementServer({
      network: "eip155:84532",
      payTo: PAY_TO,
      earnedNative: earnedNothing,
      supportedResponse,
      config: {
        storage: new InMemoryChannelStorage(),
        facilitatorClient: facilitator,
        autoSettlement: false,
      },
    });

    expect(getSupported).not.toHaveBeenCalled();
    await server.stop();
  });

  it.each([900, 901, 86_399, 86_400, undefined])(
    "advertises the configured Sepolia withdrawal grace %s, defaulting to 24 hours",
    async (withdrawDelay) => {
      const server = await createX402BatchSettlementServer({
        network: "eip155:84532", payTo: PAY_TO, earnedNative: earnedNothing,
        config: {
          storage: new InMemoryChannelStorage(),
          facilitatorClient: facilitatorWithoutAuthorizer(),
          receiverAuthorizerSigner: privateKeyToAccount(`0x${"22".repeat(32)}`),
          autoSettlement: false, withdrawDelay,
        },
      });
      try {
        expect(await server.buildRequirements("100000")).toEqual([
          expect.objectContaining({ extra: expect.objectContaining({
            withdrawDelay: withdrawDelay ?? 86_400,
          }) }),
        ]);
      } finally {
        await server.stop();
      }
    }
  );

  it.each([899, 900.5, -1, NaN, Infinity])(
    "rejects an invalid Sepolia withdrawal grace %s before advertising",
    async (withdrawDelay) => {
      await expect(createX402BatchSettlementServer({
        network: "eip155:84532", payTo: PAY_TO, earnedNative: earnedNothing,
        config: { storage: new InMemoryChannelStorage(), withdrawDelay },
      })).rejects.toThrow("at least 900 seconds");
    }
  );

  it.each([900, 86_399])("retains the mainnet floor even with in-memory mode: %s", async (withdrawDelay) => {
    await expect(createX402BatchSettlementServer({
      network: "eip155:8453", payTo: PAY_TO, earnedNative: earnedNothing,
      allowInMemory: true,
      config: {
        withdrawDelay, autoSettlement: false,
        receiverAuthorizerSigner: privateKeyToAccount(`0x${"22".repeat(32)}`),
        selfRelay: { privateKey: `0x${"11".repeat(32)}`, rpcUrl: "https://base.example.invalid" },
      },
    })).rejects.toThrow("at least 86400 seconds");
  });

  it("does not extend the testnet exception to another network", async () => {
    await expect(createX402BatchSettlementServer({
      network: "eip155:1", payTo: PAY_TO, earnedNative: earnedNothing,
      config: { storage: new InMemoryChannelStorage(), withdrawDelay: 900 },
    })).rejects.toThrow("requires selfRelay");
  });

  it("refuses boot when neither the facilitator nor the DVM can authorize claims", async () => {
    await expect(
      createX402BatchSettlementServer({
        network: "eip155:84532",
        payTo: PAY_TO,
        earnedNative: earnedNothing,
        config: {
          storage: new InMemoryChannelStorage(),
          facilitatorClient: facilitatorWithoutAuthorizer(),
          autoSettlement: false,
        },
      })
    ).rejects.toThrow(/authorizer/i);
  });

  it("refuses an auto-refund selector, which would claim the deposit and refund nothing", async () => {
    // The earned ceiling rides `selectClaimChannels`; upstream's refund job
    // reads the stored charge instead, so a channel it picked up would be
    // claimed in full and the caller's unspent balance paid to nobody
    // Boot is where that has to be caught — the alternative is a
    // configuration whose money loss shows up only on the payer's side.
    await expect(
      createX402BatchSettlementServer({
        network: "eip155:84532",
        payTo: PAY_TO,
        earnedNative: earnedNothing,
        config: {
          storage: new InMemoryChannelStorage(),
          facilitatorClient: facilitatorWithoutAuthorizer(),
          autoSettlement: { selectRefundChannels: (channels) => channels },
        },
      })
    ).rejects.toThrow("selectRefundChannels is unsupported");
  });

  it("keeps hosted-facilitator channels off mainnet", async () => {
    await expect(
      createX402BatchSettlementServer({
        network: "eip155:8453",
        payTo: PAY_TO,
        earnedNative: earnedNothing,
        config: { storage: new InMemoryChannelStorage() },
      })
    ).rejects.toThrow("Base mainnet requires selfRelay");
  });

  it("allows Base mainnet only when the self-relay path is explicitly configured", async () => {
    const onBalance = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(init?.body as string) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x38d7ea4c68000" });
    });
    let server: Awaited<ReturnType<typeof createX402BatchSettlementServer>> | undefined;
    try {
      server = await createX402BatchSettlementServer({
        network: "eip155:8453",
        payTo: PAY_TO,
        earnedNative: earnedNothing,
        config: {
          storage: new InMemoryChannelStorage(),
          autoSettlement: false,
          receiverAuthorizerSigner: privateKeyToAccount(`0x${"22".repeat(32)}`),
          selfRelay: {
            privateKey: `0x${"11".repeat(32)}`,
            rpcUrl: "https://base.example.invalid",
            onBalance,
          },
        },
      });

      await vi.waitFor(() => expect(onBalance).toHaveBeenCalledOnce());
      expect(fetchSpy).toHaveBeenCalledOnce();
      await expect(server.buildRequirements("100000")).resolves.toEqual([
        expect.objectContaining({
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          extra: expect.objectContaining({
            name: "USD Coin",
            version: "2",
            assetTransferMethod: "eip3009",
            withdrawDelay: 86_400,
          }),
        }),
      ]);
    } finally {
      await server?.stop();
      fetchSpy.mockRestore();
    }
  });

  it("refuses to fund the signing-only receiver authorizer as the relay EOA", async () => {
    const sharedKey = `0x${"11".repeat(32)}` as const;
    await expect(
      createX402BatchSettlementServer({
        network: "eip155:8453",
        payTo: PAY_TO,
        earnedNative: earnedNothing,
        config: {
          storage: new InMemoryChannelStorage(),
          facilitatorClient: facilitatorWithoutAuthorizer(),
          receiverAuthorizerSigner: privateKeyToAccount(sharedKey),
          selfRelay: { privateKey: sharedKey, rpcUrl: "https://base.example.invalid" },
        },
      })
    ).rejects.toThrow("must use different keys");
  });
});
