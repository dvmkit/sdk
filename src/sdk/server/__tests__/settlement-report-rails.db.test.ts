import { randomBytes, randomUUID } from "node:crypto";

import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { type Channel, InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { Store } from "mppx";
import type { Pool } from "pg";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const chain = vi.hoisted(() => ({
  client: {
    getChainId: vi.fn(), getBlock: vi.fn(), getTransactionReceipt: vi.fn(),
    getTransaction: vi.fn(), readContract: vi.fn(),
  },
}));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: vi.fn(() => chain.client),
}));

import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { MemoryJobStore } from "../memory-job-store";
import { createMppFromOpts } from "../mpp-setup";
import { secp256k1Auth } from "../secp256k1-auth";
import { PostgresTempoSessionStore } from "../tempo-session-store";
import { PostgresX402ChannelStorage } from "../x402-channel-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const NETWORK = "eip155:84532";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const AUTHORIZER = privateKeyToAccount(`0x${"22".repeat(32)}`);
const CHANNEL_CONFIG: Channel["channelConfig"] = {
  payer: "0x3333333333333333333333333333333333333333",
  payerAuthorizer: "0x3333333333333333333333333333333333333333",
  receiver: PAY_TO, receiverAuthorizer: AUTHORIZER.address, token: TOKEN,
  withdrawDelay: 86_400, salt: `0x${"99".repeat(32)}`,
};
const CHANNEL_ID = computeChannelId(CHANNEL_CONFIG, NETWORK).toLowerCase();
const CLAIM_TX = `0x${"c1".repeat(32)}`;
const SETTLE_TX = `0x${"5e".repeat(32)}`;
const BLOCK = `0x${"bb".repeat(32)}`;
const DEPOSIT = 1_000;
const EARNED = 400;
const PLATFORM = { platformUrl: "https://platform.invalid", platformToken: "local-token" };

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-08-10T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

type Effect = { type: string; obligations: { operation: string; state: string; tx_hash: string | null }[] };

describe.skipIf(!RUN)("settlement-report rails (real Postgres)", () => {
  const schemas: string[] = [];
  const pools: Pool[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
    vi.unstubAllGlobals();
    await Promise.all(pools.splice(0).map((pool) => pool.end().catch(() => undefined)));
    await dropSchemas(...schemas.splice(0));
  });

  /** A pool on a fresh schema, or another pool on an existing one to stand in for a later process. */
  async function database(schema?: string): Promise<{ schema: string; pool: Pool }> {
    const name = schema ?? `settlement_rails_${randomUUID().slice(0, 8)}`;
    if (!schema) {
      await recreateSchema(name);
      schemas.push(name);
    }
    const pool = await pinnedPool(name);
    pools.push(pool);
    return { schema: name, pool };
  }

  const complete = async (pool: Pool) => (await pool.query<{ complete: boolean }>(
    "SELECT complete FROM sdk_hosted_settlement_report_history"
  )).rows[0]?.complete;

  const obligationRows = async (pool: Pool) => (await pool.query<Effect["obligations"][number]>(
    `SELECT operation,state,tx_hash FROM sdk_hosted_settlement_report_obligations
     ORDER BY created_at_ms,operation`
  )).rows;

  /** Payout reports the platform received for this DVM. */
  function platform(dvmId: string) {
    const payouts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>; } catch { /* not a report */ }
      if (body.dvmId === dvmId && typeof body.payoutId === "string") payouts.push(body);
      return new Response(null, { status: 200 });
    }));
    return payouts;
  }

  /** What the chain shows: the claim once it lands, and how far finality has reached. */
  const landed = { claimed: 0n, finalized: 9n };

  /** A facilitator that lands every claim and settle, recording the obligations it found reserved. */
  function facilitator(pool: () => Pool) {
    const effects: Effect[] = [];
    const client: FacilitatorClient = {
      verify: vi.fn(),
      settle: vi.fn(async (payload: PaymentPayload) => {
        const type = (payload.payload as unknown as { type: string }).type;
        const reserved = await pool().query<{ exists: boolean }>(
          "SELECT to_regclass('sdk_hosted_settlement_report_obligations') IS NOT NULL AS exists"
        );
        effects.push({ type, obligations: reserved.rows[0].exists ? await obligationRows(pool()) : [] });
        if (type === "claim") landed.claimed = BigInt(EARNED);
        return { success: true, transaction: type === "claim" ? CLAIM_TX : SETTLE_TX,
          network: NETWORK as `${string}:${string}` };
      }),
      getSupported: vi.fn(() => Promise.resolve({
        kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK as `${string}:${string}`,
          extra: {} }],
        extensions: [], signers: {},
      })),
    };
    return { client, effects };
  }

  async function x402Server(pool: Pool, dvmId: string, options: {
    ledger: CreditLedger; facilitatorClient: FacilitatorClient; reporting?: boolean;
    storage?: InMemoryChannelStorage; claimIntervalSecs?: number; settleIntervalSecs?: number;
  }) {
    const server = await createDVMServer(configureDVM({
      name: "settlement-report-rails", capability: "do", price: "$0.10",
      input: z.object({ pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string() }),
      onJob(ctx) { ctx.complete("done"); },
      auth: secp256k1Auth(),
    }), {
      env: {}, store: new MemoryKVStore(), jobStore: new MemoryJobStore(), fxFetcher: stubFx,
      creditLedger: options.ledger, db: pool, dvmId,
      ...(options.reporting ?? true ? PLATFORM : {}),
      x402: { network: NETWORK, payTo: PAY_TO, batchSettlement: {
        facilitatorClient: options.facilitatorClient, receiverAuthorizerSigner: AUTHORIZER,
        ...(options.storage && { storage: options.storage }),
        autoSettlement: { claimIntervalSecs: options.claimIntervalSecs ?? 3_600,
          settleIntervalSecs: options.settleIntervalSecs ?? 3_600 },
      } },
    });
    closers.push(server.shutdown);
    return server;
  }

  /** A channel funded with the whole deposit whose credit has earned part of it. */
  async function earnedChannel(pool: Pool, ledger: CreditLedger): Promise<void> {
    const storage = new PostgresX402ChannelStorage(pool, { hostedNetwork: NETWORK });
    await storage.updateChannel(CHANNEL_ID, () => ({
      channelId: CHANNEL_ID, channelConfig: CHANNEL_CONFIG,
      chargedCumulativeAmount: String(DEPOSIT), signedMaxClaimable: String(DEPOSIT),
      signature: `0x${"11".repeat(65)}`, balance: String(DEPOSIT), totalClaimed: "0",
      withdrawRequestedAt: 0, refundNonce: 0, onchainSyncedAt: Date.now(), lastRequestTimestamp: Date.now(),
    }));
    await storage.close();
    const creditId = `credit-${randomUUID()}`;
    await ledger.fund({
      creditId, callerPubkey: "aa".repeat(32), currency: "usd", amountMicro: DEPOSIT,
      expiryMs: Date.now() + 3_600_000,
      basis: { rail: "x402", paidMsats: DEPOSIT, nativeAmount: DEPOSIT, nativeAsset: "usdc",
        x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: String(DEPOSIT) } },
    });
    await ledger.draw({ creditId, drawId: "d1", amountMicro: EARNED });
    await ledger.settle({ creditId, drawId: "d1" });
  }

  /** The chain as the reporter reads it: both transactions mined in block 10. */
  function landedChain(pool: () => Pool) {
    Object.assign(landed, { claimed: 0n, finalized: 9n });
    chain.client.getChainId.mockResolvedValue(84532);
    chain.client.getBlock.mockImplementation(async (args: { blockTag?: string }) =>
      args.blockTag === "finalized" ? { number: landed.finalized, hash: `0x${"cc".repeat(32)}` }
        : { number: 10n, hash: BLOCK });
    chain.client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: string }) => ({
      status: "success", blockNumber: 10n, blockHash: BLOCK, transactionHash: hash,
      logs: hash === SETTLE_TX ? [{ address: BATCH_SETTLEMENT_ADDRESS,
        topics: encodeEventTopics({ abi: [parseAbiItem(
          "event Settled(address indexed receiver,address indexed token,address indexed sender,uint128 amount)"
        )], eventName: "Settled", args: { receiver: PAY_TO, token: TOKEN, sender: PAY_TO } }),
        data: encodeAbiParameters([{ type: "uint128" }], [BigInt(EARNED)]) }] : [],
    }));
    // The claim that landed carries the calldata the DVM committed to before submitting it.
    chain.client.getTransaction.mockImplementation(async ({ hash }: { hash: string }) => ({
      to: BATCH_SETTLEMENT_ADDRESS,
      input: hash === CLAIM_TX ? (await pool().query<{ data: string }>(
        `SELECT original->>'authorizationCallData' AS data FROM sdk_hosted_settlement_report_obligations
         WHERE tx_hash=$1`, [CLAIM_TX]
      )).rows[0].data : "0x",
    }));
    chain.client.readContract.mockImplementation(async (args: { functionName: string }) =>
      args.functionName === "channels" ? [BigInt(DEPOSIT), landed.claimed]
        : args.functionName === "pendingWithdrawals" ? [0n, 0] : 0n);
  }

  it("reserves each x402 effect before it happens and a later process delivers the batch report once", async () => {
    const first = await database();
    const dvmId = `dvm-${randomUUID()}`;
    const payouts = platform(dvmId);
    let pool = first.pool;
    landedChain(() => pool);
    const { client, effects } = facilitator(() => pool);
    const ledger = new CreditLedger(pool);
    await ledger.init();
    const server = await x402Server(pool, dvmId, { ledger, facilitatorClient: client,
      claimIntervalSecs: 0.05, settleIntervalSecs: 0.2 });
    expect(await complete(pool)).toBe(true);
    await earnedChannel(pool, ledger);

    // Each effect found its own reservation already written, with no transaction yet.
    await vi.waitFor(() => expect(effects.map((effect) => effect.type)).toEqual(["claim", "settle"]),
      { timeout: 10_000 });
    expect(effects[0].obligations).toEqual([{ operation: "claim", state: "reserved", tx_hash: null }]);
    expect(effects[1].obligations).toEqual([
      { operation: "claim", state: "reserved", tx_hash: CLAIM_TX },
      { operation: "settle", state: "reserved", tx_hash: null },
    ]);
    // The claim presented what the credit earned, not the whole deposit.
    expect((await pool.query<{ charged: string }>(
      `SELECT original->>'charged' AS charged FROM sdk_hosted_settlement_report_obligations
       WHERE operation='claim'`
    )).rows).toEqual([{ charged: String(EARNED) }]);
    await vi.waitFor(async () => expect(await obligationRows(pool)).toEqual([
      { operation: "claim", state: "reserved", tx_hash: CLAIM_TX },
      { operation: "settle", state: "reserved", tx_hash: SETTLE_TX },
    ]));

    // Neither transaction is final, so nothing is reported, and later ticks
    // refuse to repeat an effect whose reservation is still unresolved.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(effects).toHaveLength(2);
    expect(payouts).toEqual([]);
    expect((await pool.query("SELECT to_regclass('sdk_hosting_control') AS control")).rows[0].control).toBeNull();
    await server.shutdown();

    landed.finalized = 11n;
    const restarted = await database(first.schema);
    pool = restarted.pool;
    await x402Server(pool, dvmId, { ledger: new CreditLedger(pool), facilitatorClient: client });
    expect(await complete(pool)).toBe(true);
    await vi.waitFor(async () => expect((await obligationRows(pool)).map((row) => row.state))
      .toEqual(["delivered", "delivered"]), { timeout: 20_000, interval: 250 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ rail: "x402", kind: "batch", nativeAmount: EARNED,
      refs: { txHash: SETTLE_TX } });
    expect(effects).toHaveLength(2);
  }, 60_000);

  it("keeps the earlier x402 reporting, once, on a database whose history is incomplete", async () => {
    const { pool } = await database();
    const dvmId = `dvm-${randomUUID()}`;
    const payouts = platform(dvmId);
    // A channel table from before report history existed.
    const earlier = new PostgresX402ChannelStorage(pool);
    await earlier.init();
    await earlier.close();
    landedChain(() => pool);
    const { client, effects } = facilitator(() => pool);
    const ledger = new CreditLedger(pool);
    await ledger.init();
    await x402Server(pool, dvmId, { ledger, facilitatorClient: client,
      claimIntervalSecs: 0.05, settleIntervalSecs: 0.2 });
    expect(await complete(pool)).toBe(false);
    await earnedChannel(pool, ledger);

    await vi.waitFor(() => expect(payouts).toHaveLength(1), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ rail: "x402", kind: "batch", nativeAmount: EARNED,
      refs: { txHash: SETTLE_TX } });
    expect(effects.map((effect) => effect.type)).toEqual(["claim", "settle"]);
    expect(await obligationRows(pool)).toEqual([]);
    expect(await complete(pool)).toBe(false);
  }, 30_000);

  it.each([
    ["an x402 batch rail on a server that delivers no reports", false, { reporting: false }],
    ["an x402 batch rail on a caller-supplied channel storage", false, { storage: true }],
    ["an x402 batch rail on the SDK's channel storage with report delivery", true, {}],
  ] as const)("%s leaves history complete=%s", async (_name, expected, options: {
    reporting?: boolean; storage?: boolean;
  }) => {
    const { pool } = await database();
    const dvmId = `dvm-${randomUUID()}`;
    platform(dvmId);
    const ledger = new CreditLedger(pool);
    await ledger.init();
    await x402Server(pool, dvmId, { ledger, facilitatorClient: facilitator(() => pool).client,
      ...(options.reporting === false && { reporting: false }),
      ...(options.storage && { storage: new InMemoryChannelStorage() }) });
    expect(await complete(pool)).toBe(expected);
  });

  it.each([
    ["a caller-built Tempo session handle", false],
    ["a Tempo session runtime built to reserve its reports", true],
  ] as const)("%s leaves history complete=%s", async (_name, expected) => {
    const { pool } = await database();
    const dvmId = `dvm-${randomUUID()}`;
    platform(dvmId);
    const session = { account: privateKeyToAccount(generatePrivateKey()),
      getClient: () => Promise.resolve({} as never) };
    const env = { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") } as NodeJS.ProcessEnv;
    let sessions: PostgresTempoSessionStore | undefined;
    let tempoSession;
    if (expected) {
      // The host's order: report history first, then the session store it guards.
      const reports = new HostedSettlementReportObligations(pool, dvmId);
      await reports.init();
      sessions = new PostgresTempoSessionStore(pool);
      await sessions.init();
      tempoSession = { ...session, store: sessions, hostedObligations: reports };
    } else {
      tempoSession = { ...session, store: Store.memory() };
    }
    const mpp = createMppFromOpts({ tempoRecipient: PAY_TO, realm: "rails.example", tempoSession }, env);
    const server = await createDVMServer(configureDVM({
      name: "settlement-report-tempo", capability: "do", tag: "test",
      onJob(ctx) { ctx.complete("done"); },
    }), {
      env: {}, store: new MemoryKVStore(), jobStore: new MemoryJobStore(), db: pool, dvmId, devMode: true,
      ...PLATFORM, mpp: mpp!, ...(sessions && { hostingTempoSessionStore: sessions }),
    });
    closers.push(server.shutdown);
    expect(await complete(pool)).toBe(expected);
  });
});
