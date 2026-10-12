
import type { FacilitatorClient } from "@x402/core/server";
import { InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import type { X402FacilitatorHealthLike } from "../x402-facilitator-support";
import { durableLedger } from "./__helpers__/credit-fixtures";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const BASE_SEPOLIA = "eip155:84532";
const PRIVKEY = new Uint8Array(32).fill(9);

const stubFx: FxFetcher = {
  fetch: () =>
    Promise.resolve({ rates: { usd: 100_000, eur: 90_000 }, as_of: "2026-08-09T00:00:00Z" }),
  supportedCurrencies: () => ["usd", "eur"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
});

function channelFacilitator(network = BASE_SEPOLIA): FacilitatorClient {
  return {
    verify: vi.fn(),
    settle: vi.fn(),
    getSupported: vi.fn(() =>
      Promise.resolve({
        kinds: [
          {
            x402Version: 2,
            scheme: "batch-settlement",
            network: network as `${string}:${string}`,
            extra: { receiverAuthorizer: "0x2222222222222222222222222222222222222222" },
          },
        ],
        extensions: [],
        signers: {},
      })
    ),
  };
}

const servers = servedApps();

interface CreditBlock {
  funding: string[];
  x402?: { schemes: { scheme: string; network: string }[] };
}

async function gate(
  x402: X402Config,
  x402FacilitatorHealth?: X402FacilitatorHealthLike,
  allowOneShotStablecoin = false,
  currency: "usd" | "eur" = "usd"
): Promise<{ credit?: CreditBlock; methods?: string[]; x402?: unknown }> {
  const dvm = configureDVM({
    name: "x402-channel-menu",
    capability: "do",
    input: signedSchema,
    ...(currency === "usd"
      ? { price: "$0.10" as const }
      : {
          currency,
          onQuote: {
            schema: signedSchema,
            async handler() {
              return { upfront: { amount: 0.1, currency }, description: "test" };
            },
          },
        }),
    onJob(ctx) {
      ctx.complete("done");
    },
    credit: { min: "$0.10", max: "$5.00", allowOneShotStablecoin },
    auth: secp256k1Auth(),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    creditLedger: durableLedger(),
    x402,
    x402FacilitatorHealth,
  });
  const url = await servers.serve(app);
  const signer = createSignedRequestVerifier(signedSchema);
  const response = await fetch(`${url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "do", data: signer.signRequest(PRIVKEY, {}) }),
  });
  expect(response.status).toBe(402);
  const body = (await response.json()) as { credit?: CreditBlock };
  const info = (await (await fetch(`${url}/v1/info`)).json()) as {
    payment?: { methods: string[] };
    x402?: unknown;
  };
  return {
    ...(body.credit ? { credit: body.credit } : {}),
    ...(info.payment ?? {}),
    ...(info.x402 ? { x402: info.x402 } : {}),
  };
}

describe("x402 on the credit funding menu", () => {
  it("omits exact-only x402 from credit while preserving it for per-call payment", async () => {
    const body = await gate({ payTo: PAY_TO, network: BASE_SEPOLIA });

    expect(body.credit?.funding).not.toContain("x402");
    expect(body.methods).toContain("x402");
    expect(body.credit?.x402).toBeUndefined();
  });

  it("adds the channel scheme once batch settlement is wired", async () => {
    const body = await gate({
      payTo: PAY_TO,
      network: BASE_SEPOLIA,
      batchSettlement: {
        storage: new InMemoryChannelStorage(),
        facilitatorClient: channelFacilitator(),
        autoSettlement: false,
      },
    });

    expect(body.credit?.funding).toContain("x402");
    expect(body.methods).toContain("x402");
    expect(body.credit?.x402).toEqual({
      schemes: [{ scheme: "batch-settlement", network: BASE_SEPOLIA }],
    });
  });

  it("restores exact credit funding only under explicit builder opt-in", async () => {
    const body = await gate({ payTo: PAY_TO, network: BASE_SEPOLIA }, undefined, true);
    expect(body.credit?.funding).toContain("x402");
    expect(body.credit?.x402).toEqual({
      schemes: [{ scheme: "exact", network: BASE_SEPOLIA }],
    });
    expect(body.methods).toContain("x402");
  });

  it("withholds x402 credit funding from a non-USD DVM", async () => {
    const body = await gate(
      { payTo: PAY_TO, network: BASE_SEPOLIA },
      undefined,
      true,
      "eur"
    );

    expect(body.methods).not.toContain("x402");
    expect(body.x402).toBeUndefined();
    expect(body.credit?.funding).not.toContain("x402");
    expect(body.credit?.x402).toBeUndefined();
  });

  it("keeps local mainnet batch funding live without re-advertising unavailable hosted exact", async () => {
    const mainnet = "eip155:8453";
    const unavailableHostedExact: X402FacilitatorHealthLike = {
      refresh: vi.fn(async () => undefined),
      support: () => ({
        available: false,
        exact: { v1: false, v2: false },
        batchSettlement: false,
        facilitator: "https://hosted.example.invalid",
        network: mainnet,
        reason: "probe_failed",
      }),
    };
    const body = await gate(
      {
        payTo: PAY_TO,
        network: mainnet,
        batchSettlement: {
          storage: new InMemoryChannelStorage(),
          facilitatorClient: channelFacilitator(mainnet),
          receiverAuthorizerSigner: privateKeyToAccount(`0x${"22".repeat(32)}`),
          autoSettlement: false,
          selfRelay: {
            privateKey: `0x${"11".repeat(32)}`,
            rpcUrl: "https://base.example.invalid",
          },
        },
      },
      unavailableHostedExact
    );

    expect(body.methods).not.toContain("x402");
    expect(body.x402).toBeUndefined();
    expect(body.credit?.funding).toContain("x402");
    expect(body.credit?.x402).toEqual({
      schemes: [{ scheme: "batch-settlement", network: mainnet }],
    });
  });

  it("keeps hosted exact available when the local self-relay RPC is unavailable", async () => {
    const mainnet = "eip155:8453";
    const availableHostedExact: X402FacilitatorHealthLike = {
      refresh: vi.fn(async () => undefined),
      support: () => ({
        available: true,
        exact: { v1: false, v2: true },
        batchSettlement: true,
        facilitator: "https://hosted.example.invalid",
        network: mainnet,
      }),
    };
    const body = await gate(
      {
        payTo: PAY_TO,
        network: mainnet,
        batchSettlement: {
          storage: new InMemoryChannelStorage(),
          facilitatorClient: channelFacilitator(mainnet),
          receiverAuthorizerSigner: privateKeyToAccount(`0x${"22".repeat(32)}`),
          autoSettlement: false,
          selfRelay: {
            privateKey: `0x${"11".repeat(32)}`,
            rpcUrl: "http://127.0.0.1:1/rpc/client-secret",
          },
        },
      },
      availableHostedExact
    );

    expect(body.methods).toContain("x402");
    expect(body.x402).toBeDefined();
    expect(body.credit?.funding).toContain("x402");
    expect(body.credit?.x402).toEqual({
      schemes: [{ scheme: "batch-settlement", network: mainnet }],
    });
  });
});
