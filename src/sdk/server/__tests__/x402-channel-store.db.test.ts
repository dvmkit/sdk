import { createHash } from "node:crypto";

import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  computeChannelId,
  createBatchSettlementEIP3009DepositPayload,
  signVoucher,
} from "@x402/evm/batch-settlement/client";
import type { Channel } from "@x402/evm/batch-settlement/server";
import pg from "pg";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { formatPostgresApplicationName } from "../../../lib/pg-retry";
import { loggers } from "../../../observability/loggers";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { createX402BatchSettlementServer } from "../x402-batch-settlement";
import { PostgresX402ChannelStorage } from "../x402-channel-store";
import type { X402FacilitatorHealthLike } from "../x402-facilitator-support";
import { createX402SelfRelaySigner } from "../x402-self-relay";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = `dvm_batch_funding_channels_${process.pid}`;
const DEADLOCK_SCHEMA = `dvm_channel_deadlock_channels_${process.pid}`;
const CHANNEL_ID = `0x${"ab".repeat(32)}`;
const NETWORK = "eip155:84532" as const;
const X402_PAY_TO = "0x2222222222222222222222222222222222222222";

/** Claim ceiling stand-in: these fixtures fund without drawing. */
const earnedNothing = (): Promise<number> => Promise.resolve(0);

function channel(): Channel {
  return {
    channelId: CHANNEL_ID,
    channelConfig: {
      payer: "0x1111111111111111111111111111111111111111",
      payerAuthorizer: "0x1111111111111111111111111111111111111111",
      receiver: "0x2222222222222222222222222222222222222222",
      receiverAuthorizer: "0x2222222222222222222222222222222222222222",
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      withdrawDelay: 86_400,
      salt: `0x${"44".repeat(32)}`,
    },
    chargedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    signature: `0x${"55".repeat(65)}`,
    balance: "1000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    onchainSyncedAt: Date.now(),
    lastRequestTimestamp: Date.now(),
  };
}

function encodeHeader(
  payload: Pick<PaymentPayload, "x402Version" | "payload">,
  accepted: PaymentRequirements
): string {
  return Buffer.from(
    JSON.stringify({ ...payload, accepted, resource: { url: "/v1/credit" } })
  ).toString("base64");
}

function settlementRequirements(): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: NETWORK,
    asset: channel().channelConfig.token,
    amount: "1",
    payTo: channel().channelConfig.receiver,
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

function settlementDepositPayload(
  requirements: PaymentRequirements,
  validBefore: string,
  signature: string,
  salt = `0x${"66".repeat(32)}`
): PaymentPayload {
  return {
    x402Version: 2,
    accepted: requirements,
    payload: {
      type: "deposit",
      channelConfig: channel().channelConfig,
      voucher: {
        channelId: CHANNEL_ID,
        maxClaimableAmount: "9",
        signature: channel().signature,
      },
      deposit: {
        amount: "1",
        authorization: {
          erc3009Authorization: {
            validAfter: "0",
            validBefore,
            salt,
            signature,
          },
        },
      },
    },
  } as PaymentPayload;
}

describe.skipIf(!RUN)("Postgres x402 ChannelStorage", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let storage: PostgresX402ChannelStorage;
  let ledger: CreditLedger;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}` });
    storage = new PostgresX402ChannelStorage(pool);
    ledger = new CreditLedger(pool);
    await storage.init();
    await ledger.init();
  });

  afterAll(async () => {
    await storage.close();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  it("stores the complete upstream channel shape and serializes concurrent updates", async () => {
    await storage.updateChannel(CHANNEL_ID, () => channel());
    await Promise.all(
      Array.from({ length: 8 }, () =>
        storage.updateChannel(CHANNEL_ID, (current) => {
          const stored = requireChannel(current);
          return {
            ...stored,
            chargedCumulativeAmount: String(BigInt(stored.chargedCumulativeAmount) + 1n),
            signedMaxClaimable: String(BigInt(stored.signedMaxClaimable) + 1n),
          };
        })
      )
    );

    expect(await storage.get(CHANNEL_ID)).toMatchObject({
      chargedCumulativeAmount: "8",
      signedMaxClaimable: "8",
      balance: "1000",
      refundNonce: 0,
    });

  });

  it("rejects immutable config changes and rolls channel updates back with ledger failures", async () => {
    await expect(
      storage.updateChannel(CHANNEL_ID, (current) => {
        const stored = requireChannel(current);
        return {
          ...stored,
          channelConfig: { ...stored.channelConfig, withdrawDelay: 90_000 },
        };
      })
    ).rejects.toThrow("immutable channelConfig");
    await expect(
      storage.updateChannel(CHANNEL_ID, (current) => ({
        ...requireChannel(current),
        chargedCumulativeAmount: "7",
      }))
    ).rejects.toThrow("attempted to decrease chargedCumulativeAmount");

    await expect(
      storage.withChannelTransaction(CHANNEL_ID, async () => {
        await storage.updateChannel(CHANNEL_ID, (current) => ({
          ...requireChannel(current),
          chargedCumulativeAmount: "9",
          signedMaxClaimable: "9",
        }));
        throw new Error("ledger failed");
      })
    ).rejects.toThrow("ledger failed");
    expect((await storage.get(CHANNEL_ID))?.chargedCumulativeAmount).toBe("8");
  });

  it("carries the settle-pending marker across processes and reads unset scopes as false", async () => {
    const scope = `${NETWORK}|receiver|token`;
    expect(await storage.isSettlePending(scope)).toBe(false);

    await storage.setSettlePending(scope, true);
    // A second instance stands in for the machine that wins the next settle
    // tick: the marker upstream keeps in process memory has to be readable
    // fleet-wide or an idle-looking machine never transfers claimed funds.
    const other = new PostgresX402ChannelStorage(pool);
    try {
      expect(await other.isSettlePending(scope)).toBe(true);

      const settlementBackends = await admin.query<{ application_name: string }>(
        `SELECT application_name
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = $1`,
        [formatPostgresApplicationName("x402-settlement")]
      );
      expect(settlementBackends.rows.length).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
    expect(await storage.isSettlePending(`${NETWORK}|other|token`)).toBe(false);

    await storage.setSettlePending(scope, false);
    expect(await storage.isSettlePending(scope)).toBe(false);
  });

  /**
   * The withdraw race claims outside the scheduler, so it is the one claim on a
   * Postgres fleet that no later job knows about. Without the marker its funds
   * sit in the contract until an unrelated channel happens to claim.
   */
  it("raises the settle-pending marker for a claim the withdraw race rushed", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    let withdrawRequestedAt = 0;
    const facilitator: FacilitatorClient = {
      getSupported: vi.fn(async () => ({
        kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }],
        extensions: [],
        signers: {},
      })),
      verify: vi.fn(async (payload: PaymentPayload): Promise<VerifyResponse> => {
        const raw = payload.payload as {
          channelConfig: { payer: string };
          voucher: { channelId: string };
        };
        return {
          isValid: true,
          payer: raw.channelConfig.payer,
          extra: {
            channelId: raw.voucher.channelId,
            balance: "1000",
            totalClaimed: "0",
            withdrawRequestedAt,
            refundNonce: "0",
          },
        };
      }),
      settle: vi.fn(
        async (
          payload: PaymentPayload,
          requirements: PaymentRequirements
        ): Promise<SettleResponse> => {
          const raw = payload.payload as {
            type: string;
            channelConfig?: { payer: string };
            voucher?: { channelId: string };
          };
          if (raw.type === "claim") {
            return { success: true, transaction: "0xclaim", network: requirements.network };
          }
          return {
            success: true,
            transaction: "0xdeposit",
            network: requirements.network,
            payer: raw.channelConfig?.payer,
            amount: "1000",
            extra: {
              channelState: {
                channelId: raw.voucher?.channelId,
                balance: "1000",
                totalClaimed: "0",
                withdrawRequestedAt,
                refundNonce: "0",
              },
            },
          };
        }
      ),
    };
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      db: pool,
      // The rush claim protects earned-but-unclaimed value, so this channel's
      // credit has to have earned the 100 charged to it for a claim to run at
      // all.
      earnedNative: () => Promise.resolve(100),
      config: {
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
      settlementEvidenceReader: {
        getBlockNumber: async () => 100n,
        findAppliedSettlement: async () => undefined,
      },
    });
    try {
      const [built] = await server.buildRequirements("100");
      const requirements = built as PaymentRequirements;
      const scope = `${NETWORK}|${receiver.address.toLowerCase()}|${requirements.asset.toLowerCase()}`;
      expect(await storage.isSettlePending(scope)).toBe(false);

      const channelConfig: Channel["channelConfig"] = {
        payer: payer.address,
        payerAuthorizer: payer.address,
        receiver: receiver.address,
        receiverAuthorizer: receiver.address,
        token: requirements.asset as `0x${string}`,
        withdrawDelay: 86_400,
        salt: generatePrivateKey(),
      };
      const channelId = computeChannelId(channelConfig, NETWORK);
      const deposit = await createBatchSettlementEIP3009DepositPayload(
        payer,
        2,
        requirements,
        channelConfig,
        "1000",
        "100"
      );
      const opened = await server.accept({
        paymentHeader: encodeHeader(deposit, requirements),
        amount: "100",
        operation: "fund",
        effectId: "withdraw-race-credit:fund-1",
        commit: async (funding) => funding.paymentId,
      });
      expect(opened).toMatchObject({ ok: true });
      // A deposit is not a claim, so nothing is owed a settlement yet.
      expect(await storage.isSettlePending(scope)).toBe(false);

      // The payer's new withdrawal is observable only after the mirrored
      // on-chain state reaches its refresh boundary.
      await storage.updateChannel(channelId, (current) =>
        current ? { ...current, onchainSyncedAt: 0 } : current
      );
      withdrawRequestedAt = 123;
      const voucher = await signVoucher(payer, channelId, "200", NETWORK);
      const refused = await server.accept({
        paymentHeader: encodeHeader(
          { x402Version: 2, payload: { type: "voucher", channelConfig, voucher } },
          requirements
        ),
        amount: "100",
        operation: "fund",
        effectId: "withdraw-race-credit:fund-2",
        commit: async () => "must not run",
      });
      expect(refused).toMatchObject({ ok: false, reason: "withdrawal_pending" });
      expect(await storage.isSettlePending(scope)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("separates same-sized deposits on a reused channel by ERC-3009 authorization", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const balances = new Map<string, bigint>();
    const facilitator = recordingFacilitator(balances);
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      db: pool,
      earnedNative: earnedNothing,
      config: {
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
      settlementEvidenceReader: {
        getBlockNumber: async () => 100n,
        findAppliedSettlement: async () => undefined,
      },
    });
    try {
      const [built] = await server.buildRequirements("100");
      const requirements = built as PaymentRequirements;
      const channelConfig: Channel["channelConfig"] = {
        payer: payer.address,
        payerAuthorizer: payer.address,
        receiver: receiver.address,
        receiverAuthorizer: receiver.address,
        token: requirements.asset as `0x${string}`,
        withdrawDelay: 86_400,
        salt: generatePrivateKey(),
      };
      const channelId = computeChannelId(channelConfig, NETWORK);
      const first = await createBatchSettlementEIP3009DepositPayload(
        payer,
        2,
        requirements,
        channelConfig,
        "1000",
        "100"
      );
      const second = await createBatchSettlementEIP3009DepositPayload(
        payer,
        2,
        requirements,
        channelConfig,
        "1000",
        "100"
      );
      const firstHeader = encodeHeader(first, requirements);
      const secondHeader = encodeHeader(second, requirements);

      await expect(
        server.accept({
          paymentHeader: firstHeader,
          amount: "100",
          operation: "fund",
          effectId: "reused-channel-credit:fund-1",
          commit: async (funding) => funding.paymentId,
        })
      ).resolves.toMatchObject({ ok: true });

      // A full cooperative refund removes the live channel projection and its
      // balance, while the completed funding settlement remains durable for
      // replay detection. Recreate that terminal state without exercising the
      // refund path this identity-focused test covers elsewhere.
      await storage.updateChannel(channelId, () => undefined);
      balances.set(channelId.toLowerCase(), 0n);

      await expect(
        server.accept({
          paymentHeader: secondHeader,
          amount: "100",
          operation: "fund",
          effectId: "reused-channel-credit:fund-2",
          commit: async (funding) => funding.paymentId,
        })
      ).resolves.toMatchObject({ ok: true });

      const firstIntent = await storage.getSettlement("fund", "reused-channel-credit:fund-1");
      const secondIntent = await storage.getSettlement("fund", "reused-channel-credit:fund-2");
      expect(firstIntent?.paymentId).toContain(":deposit:");
      expect(secondIntent?.paymentId).toContain(":deposit:");
      expect(secondIntent?.paymentId).not.toBe(firstIntent?.paymentId);
      expect(balances.get(channelId.toLowerCase())).toBe(1000n);

      await storage.updateChannel(channelId, () => undefined);
      balances.set(channelId.toLowerCase(), 0n);
      await expect(
        server.accept({
          paymentHeader: firstHeader,
          amount: "100",
          operation: "fund",
          effectId: "reused-channel-credit:fund-replayed-credential",
          commit: async () => "must not commit",
        })
      ).rejects.toThrow("x402 settlement identity conflicts with a prior credit effect");
      expect(facilitator.settle).toHaveBeenCalledTimes(2);
    } finally {
      await server.stop();
    }
  });

  it("accepts one fresh authorization for the same prepared funding effect", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const balances = new Map<string, bigint>();
    const facilitator = recordingFacilitator(balances);
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      db: pool,
      earnedNative: earnedNothing,
      config: {
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
      settlementEvidenceReader: {
        getBlockNumber: async () => 100n,
        findAppliedSettlement: async () => undefined,
      },
    });
    try {
      const [built] = await server.buildRequirements("100");
      const requirements = built as PaymentRequirements;
      const channelConfig: Channel["channelConfig"] = {
        payer: payer.address,
        payerAuthorizer: payer.address,
        receiver: receiver.address,
        receiverAuthorizer: receiver.address,
        token: requirements.asset as `0x${string}`,
        withdrawDelay: 86_400,
        salt: generatePrivateKey(),
      };
      const channelId = computeChannelId(channelConfig, NETWORK);
      const expired = await createBatchSettlementEIP3009DepositPayload(
        payer,
        2,
        requirements,
        channelConfig,
        "1000",
        "100"
      );
      const expiredRaw = expired.payload as {
        voucher: { signature: `0x${string}` };
        deposit: { authorization: { erc3009Authorization: { validBefore: string; salt: string } } };
      };
      expiredRaw.deposit.authorization.erc3009Authorization.validBefore = "1";
      const fresh = await createBatchSettlementEIP3009DepositPayload(
        payer,
        2,
        requirements,
        channelConfig,
        "1000",
        "100"
      );
      const freshRaw = fresh.payload as {
        deposit: { authorization: { erc3009Authorization: { salt: string } } };
      };
      const effectId = "prepared-authorization-refresh-credit:fund-1";
      const settlementId = createHash("sha256")
        .update("fund")
        .update("\0")
        .update(effectId)
        .digest("hex");
      const expiredPayment = JSON.parse(
        Buffer.from(encodeHeader(expired, requirements), "base64").toString("utf8")
      ) as PaymentPayload;
      await storage.prepareSettlement({
        settlementId,
        channelId,
        operation: "fund",
        effectId,
        paymentId: `${channelId.toLowerCase()}:deposit:${expiredRaw.deposit.authorization.erc3009Authorization.salt.toLowerCase()}`,
        payload: expiredPayment,
        requirements,
        channelBefore: {
          channelId,
          channelConfig,
          chargedCumulativeAmount: "0",
          signedMaxClaimable: "0",
          signature: expiredRaw.voucher.signature,
          balance: "0",
          totalClaimed: "0",
          withdrawRequestedAt: 0,
          refundNonce: 0,
          onchainSyncedAt: Date.now(),
          lastRequestTimestamp: Date.now(),
        },
      });

      await expect(
        server.accept({
          paymentHeader: encodeHeader(fresh, requirements),
          amount: "100",
          operation: "fund",
          effectId,
          commit: async (funding) => funding.paymentId,
        })
      ).resolves.toMatchObject({ ok: true });
      expect(await storage.getSettlement("fund", effectId)).toMatchObject({
        status: "complete",
        paymentId: `${channelId.toLowerCase()}:deposit:${freshRaw.deposit.authorization.erc3009Authorization.salt.toLowerCase()}`,
      });
      expect(facilitator.settle).toHaveBeenCalledOnce();
    } finally {
      await server.stop();
    }
  });

  it("admits exactly one refreshed authorization for an expired prepared deposit", async () => {
    const requirements = settlementRequirements();
    const identity = {
      settlementId: "settlement-expired-authorization",
      channelId: CHANNEL_ID,
      operation: "fund" as const,
      effectId: "credit:fund-expired-authorization",
      paymentId: `${CHANNEL_ID}:deposit:expired-authorization`,
      requirements,
      channelBefore: channel(),
      pendingId: "pending-expired-authorization",
    };
    await storage.prepareSettlement({
      ...identity,
      payload: settlementDepositPayload(requirements, "1", "0xexpired"),
    });

    const validBefore = String(Math.floor(Date.now() / 1_000) + 3_600);
    const candidates = [
      {
        paymentId: `${CHANNEL_ID}:deposit:refresh-a`,
        payload: settlementDepositPayload(
          requirements,
          validBefore,
          "0xrefresh-a",
          `0x${"67".repeat(32)}`
        ),
      },
      {
        paymentId: `${CHANNEL_ID}:deposit:refresh-b`,
        payload: settlementDepositPayload(
          requirements,
          validBefore,
          "0xrefresh-b",
          `0x${"68".repeat(32)}`
        ),
      },
    ];
    const results = await Promise.allSettled(
      candidates.map((candidate) => storage.prepareSettlement({ ...identity, ...candidate }))
    );
    const fulfilled = results.filter(
      (
        result
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof storage.prepareSettlement>>> =>
        result.status === "fulfilled"
    );
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toContain(
      "x402 settlement identity conflicts with a prior credit effect"
    );
    const winner = fulfilled[0];
    if (!winner) throw new Error("expected one refreshed authorization winner");
    expect(await storage.getSettlementById(identity.settlementId)).toMatchObject({
      status: "prepared",
      payload: winner.value.payload,
      paymentId: winner.value.paymentId,
      requirements,
      pendingId: identity.pendingId,
    });
    await expect(
      storage.prepareSettlement({
        ...identity,
        paymentId: winner.value.paymentId,
        payload: winner.value.payload,
      })
    ).resolves.toMatchObject({ payload: winner.value.payload, status: "prepared" });
  });

  it("rejects unexpired and structurally changed prepared deposit authorizations", async () => {
    const requirements = settlementRequirements();
    const validBefore = String(Math.floor(Date.now() / 1_000) + 3_600);
    const identity = {
      settlementId: "settlement-unexpired-authorization",
      channelId: CHANNEL_ID,
      operation: "fund" as const,
      effectId: "credit:fund-unexpired-authorization",
      paymentId: `${CHANNEL_ID}:9:unexpired-authorization`,
      requirements,
      channelBefore: channel(),
    };
    await storage.prepareSettlement({
      ...identity,
      payload: settlementDepositPayload(requirements, validBefore, "0xcurrent"),
    });
    await expect(
      storage.prepareSettlement({
        ...identity,
        payload: settlementDepositPayload(
          requirements,
          String(BigInt(validBefore) + 60n),
          "0xnext"
        ),
      })
    ).rejects.toThrow("x402 settlement identity conflicts with a prior credit effect");

    const drifted = {
      ...identity,
      settlementId: "settlement-drifted-authorization",
      effectId: "credit:fund-drifted-authorization",
      paymentId: `${CHANNEL_ID}:9:drifted-authorization`,
    };
    await storage.prepareSettlement({
      ...drifted,
      payload: settlementDepositPayload(requirements, "1", "0xexpired"),
    });
    const changedAmount = settlementDepositPayload(
      requirements,
      validBefore,
      "0xrefresh",
      `0x${"77".repeat(32)}`
    );
    const changedBody = changedAmount.payload as {
      deposit: { amount: string };
    };
    changedBody.deposit.amount = "2";
    await expect(
      storage.prepareSettlement({
        ...drifted,
        paymentId: `${CHANNEL_ID}:deposit:drifted-refresh`,
        payload: changedAmount,
      })
    ).rejects.toThrow("x402 settlement identity conflicts with a prior credit effect");
  });

  it("keeps an independently recorded facilitator settlement recoverable after rollback", async () => {
    const requirements = {
      scheme: "batch-settlement",
      network: "eip155:84532",
      asset: channel().channelConfig.token,
      amount: "1",
      payTo: channel().channelConfig.receiver,
      maxTimeoutSeconds: 60,
      extra: {},
    } satisfies PaymentRequirements;
    const payload = {
      x402Version: 2,
      accepted: requirements,
      payload: {
        type: "deposit",
        channelConfig: channel().channelConfig,
        voucher: {
          channelId: CHANNEL_ID,
          maxClaimableAmount: "9",
          signature: channel().signature,
        },
      },
    } as PaymentPayload;
    const response = {
      success: true,
      transaction: "0xsettled",
      network: "eip155:84532",
      amount: "1",
    } satisfies SettleResponse;
    const prepared = await storage.prepareSettlement({
      settlementId: "settlement-rollback",
      channelId: CHANNEL_ID,
      operation: "fund",
      effectId: "credit:fund-rollback",
      paymentId: `${CHANNEL_ID}:9`,
      payload,
      requirements,
      channelBefore: channel(),
      pendingId: "pending-rollback",
    });

    await expect(
      storage.withChannelTransaction(CHANNEL_ID, async () => {
        await storage.markSettlementSubmitting(prepared.settlementId, "100");
        await storage.recordSettlementResponse(prepared.settlementId, response);
        await storage.completeSettlement(prepared.settlementId);
        throw new Error("commit failed");
      })
    ).rejects.toThrow("commit failed");
    expect(await storage.getSettlement("fund", "credit:fund-rollback")).toMatchObject({
      status: "settled",
      submissionBlock: "100",
      response: { success: true, transaction: "0xsettled" },
    });

    await storage.withChannelTransaction(CHANNEL_ID, () =>
      storage.completeSettlement(prepared.settlementId)
    );
    expect(await storage.getSettlement("fund", "credit:fund-rollback")).toMatchObject({
      status: "complete",
    });
  });

  it("reconciles a mined deposit without submitting it twice when response persistence crashes", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const minedTransaction = `0x${"66".repeat(32)}`;
    let liveBalance = 0n;
    let settleCalls = 0;
    const facilitator: FacilitatorClient = {
      getSupported: vi.fn(async () => ({
        kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }],
        extensions: [],
        signers: {},
      })),
      verify: vi.fn(async (payload: PaymentPayload): Promise<VerifyResponse> => {
        const raw = payload.payload as {
          channelConfig: { payer: string };
          voucher: { channelId: string };
        };
        return {
          isValid: true,
          payer: raw.channelConfig.payer,
          extra: {
            channelId: raw.voucher.channelId,
            balance: liveBalance.toString(),
            totalClaimed: "0",
            withdrawRequestedAt: 0,
            refundNonce: "0",
          },
        };
      }),
      settle: vi.fn(
        async (
          payload: PaymentPayload,
          requirements: PaymentRequirements
        ): Promise<SettleResponse> => {
          const raw = payload.payload as {
            type: string;
            channelConfig: { payer: string };
            voucher: { channelId: string };
            deposit: { amount: string };
          };
          settleCalls++;
          liveBalance += BigInt(raw.deposit.amount);
          return {
            success: true,
            transaction: "0xdeposit",
            network: requirements.network,
            payer: raw.channelConfig.payer,
            amount: raw.deposit.amount,
            extra: {
              channelState: {
                channelId: raw.voucher.channelId,
                balance: liveBalance.toString(),
                totalClaimed: "0",
                withdrawRequestedAt: 0,
                refundNonce: "0",
              },
            },
          };
        }
      ),
    };
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      db: pool,
      earnedNative: earnedNothing,
      config: {
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
      settlementEvidenceReader: {
        getBlockNumber: async () => 100n,
        findAppliedSettlement: vi.fn(async () =>
          liveBalance === 1000n ? { transaction: minedTransaction, amount: "1000" } : undefined
        ),
      },
    });
    const [built] = await server.buildRequirements("100");
    const requirements = built as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: requirements.asset as `0x${string}`,
      withdrawDelay: 86_400,
      salt: generatePrivateKey(),
    };
    const channelId = computeChannelId(channelConfig, NETWORK);
    const deposit = await createBatchSettlementEIP3009DepositPayload(
      payer,
      2,
      requirements,
      channelConfig,
      "1000",
      "100"
    );
    const paymentHeader = Buffer.from(
      JSON.stringify({ ...deposit, accepted: requirements, resource: { url: "/v1/credit" } })
    ).toString("base64");
    const persist = vi
      .spyOn(PostgresX402ChannelStorage.prototype, "recordSettlementResponse")
      .mockRejectedValueOnce(new Error("simulated crash before settlement response persistence"));
    try {
      await expect(
        server.accept({
          paymentHeader,
          amount: "100",
          operation: "fund",
          effectId: "recovery-credit:fund-1",
          commit: async () => "first-attempt",
        })
      ).rejects.toThrow("simulated crash");
      expect(settleCalls).toBe(1);
      expect(liveBalance).toBe(1000n);

      const recovered = await server.accept({
        paymentHeader,
        amount: "100",
        operation: "fund",
        effectId: "recovery-credit:fund-1",
        commit: async () => "recovered",
      });
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          committed: "recovered",
          settlement: { success: true, transaction: minedTransaction, amount: "1000" },
        },
      });
      expect(settleCalls).toBe(1);
      expect(await server.getChannel(channelId)).toMatchObject({
        chargedCumulativeAmount: "100",
        balance: "1000",
      });
      expect(await storage.getSettlement("fund", "recovery-credit:fund-1")).toMatchObject({
        status: "complete",
      });
    } finally {
      persist.mockRestore();
      await server.stop();
    }
  });

  it("reconciles a mined deposit when the facilitator reports a post-submit failure", async () => {
    const receiver = privateKeyToAccount(generatePrivateKey());
    const minedTransaction = `0x${"67".repeat(32)}`;
    const balances = new Map<string, bigint>();
    const applied = recordingFacilitator(balances);
    const facilitator: FacilitatorClient = {
      ...applied,
      settle: vi.fn(
        async (
          payload: PaymentPayload,
          requirements: PaymentRequirements
        ): Promise<SettleResponse> => {
          await applied.settle(payload, requirements);
          return {
            success: false,
            transaction: "",
            network: requirements.network,
            errorReason: "invalid_batch_settlement_evm_deposit_transaction_failed",
            errorMessage: "post-submit channel read failed: over rate limit",
          };
        }
      ),
    };
    const evidence = vi.fn(async () => {
      const balance = [...balances.values()][0] ?? 0n;
      return balance === 1000n ? { transaction: minedTransaction, amount: "1000" } : undefined;
    });
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      db: pool,
      earnedNative: earnedNothing,
      config: {
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
      settlementEvidenceReader: {
        getBlockNumber: async () => 100n,
        findAppliedSettlement: evidence,
      },
    });
    const [built] = await server.buildRequirements("100");
    const requirements = built as PaymentRequirements;
    const deposit = await depositPayment(receiver.address, requirements);
    const effectId = "reported-failure-recovery-credit:fund-1";

    try {
      await expect(
        server.accept({
          paymentHeader: deposit.paymentHeader,
          amount: "100",
          operation: "fund",
          effectId,
          commit: async () => "first-attempt",
        })
      ).rejects.toMatchObject({ code: "x402_settlement_submission_failed" });
      expect(facilitator.settle).toHaveBeenCalledOnce();
      expect(balances.get(deposit.channelId.toLowerCase())).toBe(1000n);
      expect(await storage.getSettlement("fund", effectId)).toMatchObject({
        status: "submitting",
        submissionBlock: "100",
      });

      const recovered = await server.accept({
        paymentHeader: deposit.paymentHeader,
        amount: "100",
        operation: "fund",
        effectId,
        commit: async () => "recovered",
      });
      expect(recovered).toMatchObject({
        ok: true,
        value: {
          committed: "recovered",
          settlement: { success: true, transaction: minedTransaction, amount: "1000" },
        },
      });
      expect(evidence).toHaveBeenCalledOnce();
      expect(facilitator.settle).toHaveBeenCalledOnce();
      expect(balances.get(deposit.channelId.toLowerCase())).toBe(1000n);
      expect(await storage.getSettlement("fund", effectId)).toMatchObject({ status: "complete" });
    } finally {
      await server.stop();
    }
  });

  it("returns a confirmed absence to prepared but keeps an unreadable chain submitting", async () => {
    const absent = await wedgeRefund(pool, "caller-absent", {
      findAppliedSettlement: () => Promise.resolve(undefined),
    });
    try {
      await resetWedgeToSubmitting(pool, absent.effectId);
      await expect(retryWedgedRefund(absent)).resolves.toMatchObject({
        ok: false,
        reason: "settlement_not_on_chain",
      });
      const absentSettlement = await storage.getSettlement("refund", absent.effectId);
      expect(absentSettlement).toMatchObject({
        status: "prepared",
      });
      expect(absentSettlement?.submissionBlock).toBeUndefined();
    } finally {
      await absent.server.stop();
    }

    const unreachable = await wedgeRefund(pool, "caller-unreachable", {
      findAppliedSettlement: () => Promise.reject(new Error("rpc timeout")),
    });
    const warn = vi.spyOn(loggers.x402, "warn");
    try {
      await resetWedgeToSubmitting(pool, unreachable.effectId);
      await expect(retryWedgedRefund(unreachable)).resolves.toMatchObject({
        ok: false,
        reason: "chain_unreachable",
      });
      expect(await storage.getSettlement("refund", unreachable.effectId)).toMatchObject({
        status: "submitting",
        submissionBlock: "100",
      });
      expect(warn).toHaveBeenCalledWith(
        "x402_settlement_reconciliation_chain_unreachable",
        expect.objectContaining({
          "channel.id": unreachable.channelId,
          "credit.effect_id": unreachable.effectId,
          error: "rpc timeout",
        })
      );
    } finally {
      warn.mockRestore();
      await unreachable.server.stop();
    }
  }, 30_000);

  it("keeps unbookmarked and facilitator-unavailable settlements distinct", async () => {
    const unbookmarked = await wedgeRefund(pool, "caller-unbookmarked");
    try {
      await resetWedgeToSubmitting(pool, unbookmarked.effectId, false);
      await expect(retryWedgedRefund(unbookmarked)).resolves.toMatchObject({
        ok: false,
        reason: "settlement_unbookmarked",
      });
      const unbookmarkedSettlement = await storage.getSettlement("refund", unbookmarked.effectId);
      expect(unbookmarkedSettlement).toMatchObject({
        status: "submitting",
      });
      expect(unbookmarkedSettlement?.submissionBlock).toBeUndefined();
    } finally {
      await unbookmarked.server.stop();
    }

    const facilitatorUnavailable = await wedgeRefund(pool, "caller-facilitator");
    const warn = vi.spyOn(loggers.x402, "warn");
    try {
      await resetWedgeToSubmitting(pool, facilitatorUnavailable.effectId);
      facilitatorUnavailable.verify.mockRejectedValueOnce(new Error("facilitator timeout"));
      await expect(retryWedgedRefund(facilitatorUnavailable)).resolves.toMatchObject({
        ok: false,
        reason: "facilitator_channel_state_unavailable",
      });
      expect(await storage.getSettlement("refund", facilitatorUnavailable.effectId)).toMatchObject({
        status: "submitting",
      });
      expect(warn).toHaveBeenCalledWith(
        "x402_settlement_reconciliation_facilitator_unavailable",
        expect.objectContaining({ error: "facilitator timeout" })
      );

      facilitatorUnavailable.verify.mockResolvedValueOnce({
        isValid: true,
        payer: "0x1111111111111111111111111111111111111111",
        extra: {
          channelId: `0x${"ff".repeat(32)}`,
          balance: "0",
          totalClaimed: "0",
          withdrawRequestedAt: 0,
          refundNonce: "0",
        },
      });
      await expect(retryWedgedRefund(facilitatorUnavailable)).resolves.toMatchObject({
        ok: false,
        reason: "facilitator_channel_state_unavailable",
      });
      expect(warn).toHaveBeenLastCalledWith(
        "x402_settlement_reconciliation_facilitator_unavailable",
        expect.objectContaining({
          error: "facilitator returned state for a different or unreadable channel",
        })
      );
    } finally {
      warn.mockRestore();
      await facilitatorUnavailable.server.stop();
    }
  }, 30_000);

  it("refreshes a prepared refund reservation after a failed commit and retries the same effect", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    let liveBalance = 0n;
    let totalClaimed = 0n;
    const settlementTypes: string[] = [];
    const facilitator: FacilitatorClient = {
      getSupported: vi.fn(async () => ({
        kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }],
        extensions: [],
        signers: {},
      })),
      verify: vi.fn(async (payload: PaymentPayload): Promise<VerifyResponse> => {
        const raw = payload.payload as {
          channelConfig: { payer: string };
          voucher: { channelId: string };
        };
        return {
          isValid: true,
          payer: raw.channelConfig.payer,
          extra: {
            channelId: raw.voucher.channelId,
            balance: liveBalance.toString(),
            totalClaimed: totalClaimed.toString(),
            withdrawRequestedAt: 0,
            refundNonce: "0",
          },
        };
      }),
      settle: vi.fn(
        async (
          payload: PaymentPayload,
          requirements: PaymentRequirements
        ): Promise<SettleResponse> => {
          const raw = payload.payload as {
            type: string;
            channelConfig: { payer: string };
            voucher: { channelId: string };
            deposit?: { amount: string };
            amount?: string;
            claims?: { totalClaimed: string }[];
          };
          settlementTypes.push(raw.type);
          if (raw.type === "deposit") liveBalance = BigInt(raw.deposit?.amount ?? "0");
          if (raw.type === "refund") {
            totalClaimed = (raw.claims ?? []).reduce(
              (max, claim) => (BigInt(claim.totalClaimed) > max ? BigInt(claim.totalClaimed) : max),
              totalClaimed
            );
            liveBalance -= BigInt(raw.amount ?? "0");
          }
          return {
            success: true,
            transaction: `0x${raw.type}`,
            network: requirements.network,
            payer: raw.channelConfig.payer,
            amount: raw.type === "refund" ? raw.amount : raw.deposit?.amount,
            extra: {
              channelState: {
                channelId: raw.voucher.channelId,
                balance: liveBalance.toString(),
                totalClaimed: totalClaimed.toString(),
                withdrawRequestedAt: 0,
                refundNonce: raw.type === "refund" ? "1" : "0",
              },
            },
          };
        }
      ),
    };
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      db: pool,
      earnedNative: earnedNothing,
      config: {
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
      settlementEvidenceReader: {
        getBlockNumber: async () => 100n,
        findAppliedSettlement: vi.fn(async () =>
          liveBalance === 0n ? { transaction: "0xrefund", amount: "100" } : undefined
        ),
      },
    });
    const [fundBuilt] = await server.buildRequirements("100");
    const fundRequirements = fundBuilt as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: fundRequirements.asset as `0x${string}`,
      withdrawDelay: 86_400,
      salt: generatePrivateKey(),
    };
    const channelId = computeChannelId(channelConfig, NETWORK);
    const deposit = await createBatchSettlementEIP3009DepositPayload(
      payer,
      2,
      fundRequirements,
      channelConfig,
      "100",
      "100"
    );
    const depositHeader = Buffer.from(
      JSON.stringify({
        ...deposit,
        accepted: fundRequirements,
        resource: { url: "/v1/credit" },
      })
    ).toString("base64");
    await expect(
      server.accept({
        paymentHeader: depositHeader,
        amount: "100",
        operation: "fund",
        effectId: "prepared-retry-credit:fund-1",
        commit: async () => "funded",
      })
    ).resolves.toMatchObject({ ok: true });

    const [refundBuilt] = await server.buildRequirements("0");
    const refundRequirements = refundBuilt as PaymentRequirements;
    const refundVoucher = await signVoucher(payer, channelId, "0", NETWORK);
    const refundHeader = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: refundRequirements,
        resource: { url: "/v1/credit" },
        payload: { type: "refund", channelConfig, voucher: refundVoucher },
      })
    ).toString("base64");
    const effectId = "prepared-retry-credit:drain-1";
    try {
      await expect(
        server.accept({
          paymentHeader: refundHeader,
          amount: "0",
          operation: "refund",
          expectedChannelId: channelId,
          effectId,
          refundBoundNative: 100,
          commit: async () => {
            throw new Error("ledger commit failed");
          },
        })
      ).rejects.toThrow("ledger commit failed");
      const firstIntent = await storage.getSettlement("refund", effectId);
      expect(firstIntent).toMatchObject({ status: "prepared" });
      expect(firstIntent?.pendingId).toBeDefined();
      const restoredChannel = await server.getChannel(channelId);
      expect(restoredChannel).toMatchObject({
        chargedCumulativeAmount: "100",
        signedMaxClaimable: "100",
      });
      expect(restoredChannel?.pendingRequest).toBeUndefined();

      const persist = vi
        .spyOn(PostgresX402ChannelStorage.prototype, "recordSettlementResponse")
        .mockRejectedValueOnce(new Error("simulated crash before refund response persistence"));
      try {
        await expect(
          server.accept({
            paymentHeader: refundHeader,
            amount: "0",
            operation: "refund",
            expectedChannelId: channelId,
            effectId,
            refundBoundNative: 100,
            commit: async () => "second-attempt",
          })
        ).rejects.toThrow("simulated crash");
        const submitting = await storage.getSettlement("refund", effectId);
        expect(submitting).toMatchObject({ status: "submitting" });
        expect(submitting?.pendingId).not.toBe(firstIntent?.pendingId);

        await expect(
          server.accept({
            paymentHeader: refundHeader,
            amount: "0",
            operation: "refund",
            expectedChannelId: channelId,
            effectId,
            refundBoundNative: 100,
            commit: async () => "drained",
          })
        ).resolves.toMatchObject({ ok: true, value: { committed: "drained" } });
        const completed = await storage.getSettlement("refund", effectId);
        expect(completed).toMatchObject({ status: "complete" });
        expect(completed?.pendingId).toBe(submitting?.pendingId);
        expect(settlementTypes).toEqual(["deposit", "refund"]);
        expect(await server.getChannel(channelId)).toBeUndefined();
      } finally {
        persist.mockRestore();
      }
    } finally {
      await server.stop();
    }
  });

  it("keeps voucher channel-first funding compatible with a concurrent credit draw", async () => {
    const creditId = "channel-lock-credit";
    await ledger.fund({
      creditId,
      callerPubkey: "caller",
      currency: "usd",
      amountMicro: 10,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "x402",
        paidMsats: 10_000,
        nativeAmount: 10,
        nativeAsset: "usdc",
        fundingRef: `${CHANNEL_ID}:8`,
        x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: "8" },
      },
    });

    const work = Promise.all([
      storage.withChannelTransaction(CHANNEL_ID, async (tx) => {
        await ledger.recordFunding({
          creditId,
          fundId: "concurrent-fund",
          amountMicro: 1,
          rail: "x402",
          tx,
        });
        return ledger.fund({
          creditId,
          callerPubkey: "caller",
          currency: "usd",
          amountMicro: 1,
          expiryMs: Date.now() + 60_000,
          basis: {
            rail: "x402",
            paidMsats: 1_000,
            nativeAmount: 1,
            nativeAsset: "usdc",
            fundingRef: `${CHANNEL_ID}:9`,
            x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: "9" },
          },
          tx,
        });
      }),
      ledger.draw({ creditId, drawId: "concurrent-draw", amountMicro: 1 }),
    ]);
    await expect(
      Promise.race([
        work,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("channel/credit lock order deadlocked")), 2_000)
        ),
      ])
    ).resolves.toBeDefined();
    expect(await ledger.get(creditId)).toMatchObject({
      balanceMicro: 11,
      availableMicro: 10,
      lastLedgerSeq: 1,
    });
    expect(await ledger.getFunding({ creditId, fundId: "concurrent-fund" })).toMatchObject({
      amountMicro: 1,
      rail: "x402",
    });
    expect(await ledger.getDraw({ creditId, drawId: "concurrent-draw" })).toMatchObject({
      amountMicro: 1,
      status: "pending",
      ledgerSeq: 1,
    });
    const { rows } = await pool.query<{ funding_count: string; draw_count: string }>(
      `SELECT
         (SELECT COUNT(*) FROM credit_fundings WHERE credit_id = $1) AS funding_count,
         (SELECT COUNT(*) FROM credit_draws WHERE credit_id = $1) AS draw_count`,
      [creditId]
    );
    expect(rows[0]).toEqual({ funding_count: "1", draw_count: "1" });
  });

  it("retires bound credit on a fresh terminal chain observation under the channel lock", async () => {
    const channelId = `0x${"88".repeat(32)}`;
    const creditId = "timed-exit-credit";
    const terminalizingStorage = new PostgresX402ChannelStorage(pool, {
      terminalizeUnbackedCredit: (evidence, tx) => ledger.terminalizeX402Credit(evidence, tx),
    });
    await terminalizingStorage.init();
    try {
      await ledger.fund({
        creditId,
        callerPubkey: "timed-exit-caller",
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: Date.now() + 60_000,
        basis: {
          rail: "x402",
          paidMsats: 1,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          x402Channel: { channelId, maxClaimableAmount: "100000" },
        },
      });
      await ledger.draw({ creditId, drawId: "served", amountMicro: 3_000 });
      await ledger.settle({ creditId, drawId: "served" });
      const initial = {
        ...channel(),
        channelId,
        chargedCumulativeAmount: "3000",
        signedMaxClaimable: "3000",
        balance: "100000",
        totalClaimed: "3000",
        withdrawRequestedAt: 123,
        onchainSyncedAt: 1000,
      };
      await terminalizingStorage.updateChannel(channelId, () => initial);

      await terminalizingStorage.updateChannel(channelId, (current) => ({
        ...requireChannel(current),
        balance: "3000",
        withdrawRequestedAt: 0,
        onchainSyncedAt: 1001,
      }));

      expect(await ledger.get(creditId)).toMatchObject({
        status: "unbacked",
        balanceMicro: 97_000,
        availableMicro: 0,
      });
      await expect(ledger.listX402CreditLosses()).resolves.toEqual([
        expect.objectContaining({
          creditId,
          channelId,
          formerBalanceMicro: 97_000,
          channelBalanceNative: 3_000n,
          totalClaimedNative: 3_000n,
          observedAt: 1001,
        }),
      ]);
    } finally {
      await terminalizingStorage.close();
    }
  });

  it("repairs a zero-liability terminal row before a refill commits under the channel lock", async () => {
    const channelId = `0x${"89".repeat(32)}`;
    const creditId = "empty-channel-refill-credit";
    const terminalizingStorage = new PostgresX402ChannelStorage(pool, {
      terminalizeUnbackedCredit: (evidence, tx) => ledger.terminalizeX402Credit(evidence, tx),
    });
    await terminalizingStorage.init();
    const basis = {
      rail: "x402",
      paidMsats: 1,
      nativeAmount: 100_000,
      nativeAsset: "usdc",
      x402Channel: { channelId, maxClaimableAmount: "100000" },
    } as const;
    try {
      await ledger.fund({
        creditId,
        callerPubkey: "empty-channel-caller",
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: Date.now() + 60_000,
        basis,
      });
      await ledger.requestDrain({
        creditId,
        drainId: "settled-drain",
        callerPubkey: "empty-channel-caller",
        method: "x402",
        payout: { address: `0x${"ab".repeat(20)}` },
        requireNoPending: true,
      });
      await ledger.markDrainSent({
        creditId,
        drainId: "settled-drain",
        sentRef: { transaction: "0xsettled" },
      });

      // Simulate the former terminalization of an otherwise settled credit.
      await pool.query(`UPDATE credits SET status = 'unbacked' WHERE credit_id = $1`, [creditId]);
      await pool.query(
        `INSERT INTO x402_credit_losses
           (credit_id, channel_id, caller_pubkey, currency, former_balance_micro,
            channel_balance_native, total_claimed_native, consumed_service_micro, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [creditId, channelId, "empty-channel-caller", "usd", 0, 0, 0, 0, 1]
      );

      await expect(
        terminalizingStorage.withChannelTransaction(channelId, async (tx) => {
          await terminalizingStorage.updateChannel(channelId, () => ({
            ...channel(),
            channelId,
            balance: "0",
            totalClaimed: "0",
            onchainSyncedAt: 2,
          }));
          return ledger.fund({
            creditId,
            callerPubkey: "empty-channel-caller",
            currency: "usd",
            amountMicro: 100_000,
            expiryMs: Date.now() + 60_000,
            basis,
            tx,
          });
        })
      ).resolves.toMatchObject({ status: "active", balanceMicro: 100_000 });
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM x402_credit_losses WHERE credit_id = $1`,
        [creditId]
      );
      expect(rows[0]).toEqual({ count: "0" });
    } finally {
      await terminalizingStorage.close();
    }
  });
});

/**
 * the settlement markers write outside the ledger transaction, so
 * they take a second connection while the transaction's client is still held.
 * On one shared pool that is a self-deadlock as soon as concurrent deposits
 * reach `max` — every client held, every holder waiting for one more. These run
 * against `max: 2` so the wedge, if it returns, is immediate rather than a
 * production-only tail behaviour.
 */
describe.skipIf(!RUN)("concurrent deposits against an exhausted pool", () => {
  const CONCURRENCY = 6;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let storage: PostgresX402ChannelStorage;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${DEADLOCK_SCHEMA}"`);
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${DEADLOCK_SCHEMA}`,
      max: 2,
    });
    storage = new PostgresX402ChannelStorage(pool);
    await storage.init();
  });

  afterAll(async () => {
    await storage.close();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${DEADLOCK_SCHEMA}" CASCADE`);
    await admin.end();
  });

  it("settles more concurrent deposits than the pool has connections", async () => {
    const receiver = privateKeyToAccount(generatePrivateKey());
    const balances = new Map<string, bigint>();
    const events: string[] = [];
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      db: pool,
      earnedNative: earnedNothing,
      config: {
        facilitatorClient: recordingFacilitator(balances),
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
      settlementEvidenceReader: {
        getBlockNumber: async () => {
          events.push("block");
          return 100n;
        },
        findAppliedSettlement: async () => undefined,
      },
    });
    const [built] = await server.buildRequirements("100");
    const requirements = built as PaymentRequirements;

    try {
      const deposits = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, index) =>
          depositPayment(receiver.address, requirements).then((deposit) => ({ ...deposit, index }))
        )
      );

      const accepted = Promise.all(
        deposits.map((deposit) =>
          server.accept({
            paymentHeader: deposit.paymentHeader,
            amount: "100",
            operation: "fund",
            effectId: `pool-exhaustion:${deposit.index}`,
            commit: async () => {
              events.push("commit");
              return deposit.index;
            },
          })
        )
      );
      await expect(
        Promise.race([
          accepted,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("x402 settlement wedged the pool")), 20_000)
          ),
        ])
      ).resolves.toHaveLength(CONCURRENCY);

      for (const deposit of deposits) {
        expect(await server.getChannel(deposit.channelId)).toMatchObject({ balance: "1000" });
        expect(
          await storage.getSettlement("fund", `pool-exhaustion:${deposit.index}`)
        ).toMatchObject({ status: "complete", submissionBlock: "100" });
      }
      expect(events.filter((event) => event === "block")).toHaveLength(CONCURRENCY);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("reads the chain bookmark before the funding transaction opens", async () => {
    const receiver = privateKeyToAccount(generatePrivateKey());
    const events: string[] = [];
    const originalTransaction = PostgresX402ChannelStorage.prototype.withChannelTransaction;
    const transaction = vi
      .spyOn(PostgresX402ChannelStorage.prototype, "withChannelTransaction")
      .mockImplementation(function <T>(
        this: PostgresX402ChannelStorage,
        channelId: string,
        operation: (tx: pg.PoolClient) => Promise<T>
      ): Promise<T> {
        events.push("transaction");
        return originalTransaction.call(this, channelId, operation) as Promise<T>;
      });
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      db: pool,
      earnedNative: earnedNothing,
      config: {
        facilitatorClient: recordingFacilitator(new Map()),
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
      settlementEvidenceReader: {
        getBlockNumber: async () => {
          events.push("block");
          return 100n;
        },
        findAppliedSettlement: async () => undefined,
      },
    });
    const [built] = await server.buildRequirements("100");
    const requirements = built as PaymentRequirements;

    try {
      const deposit = await depositPayment(receiver.address, requirements);
      await server.accept({
        paymentHeader: deposit.paymentHeader,
        amount: "100",
        operation: "fund",
        effectId: "bookmark-ordering",
        commit: async () => {
          events.push("commit");
          return "committed";
        },
      });
      expect(events).toEqual(["block", "transaction", "commit"]);
    } finally {
      transaction.mockRestore();
      await server.stop();
    }
  }, 30_000);

  it("rejects same-tick overlapping non-waiting fleet work", async () => {
    let startFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      startFirst = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondOperation = vi.fn(() => Promise.resolve());

    const first = storage.withFleetSettlementLock(async () => {
      startFirst?.();
      await firstReleased;
    });
    // Deliberately no await between the calls: the second must see the local
    // reservation before the first promise chain reaches the pool acquire.
    const second = storage.withFleetSettlementLock(secondOperation);
    await firstStarted;
    try {
      await expect(Promise.race([second, Promise.resolve("still queued" as const)])).resolves.toBe(
        false
      );
      expect(secondOperation).not.toHaveBeenCalled();
    } finally {
      releaseFirst?.();
      await Promise.all([first, second]);
    }
  }, 30_000);

  it("runs nested waiting fleet-locked settlement work without exhausting the pool", async () => {
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, index) => {
        const channelId = `0x${String(index).padStart(2, "0").repeat(32)}`;
        return storage.withFleetSettlementLock(async () => {
          await storage.updateChannel(channelId, () => ({ ...channel(), channelId }));
        }, true);
      })
    );
    // Waiting callers queue in-process and each acquires in turn. Every one must
    // run its nested `updateChannel` against the `max: 2` pool.
    expect(results).toEqual(Array.from({ length: CONCURRENCY }, () => true));
  }, 30_000);

  // the self-relay's submission lock is the third nesting site. On a
  // self-relay DVM it is reached from `resource.settlePayment` inside the
  // channel transaction, so it used to take a *second* host-pool client while
  // the first was still held — the exact shape the two tests above exist to
  // forbid. Both host clients are held here, so this can only resolve if the
  // acquire lands on the terminal settlement pool.
  it("submits under the relay lock with every host-pool connection held", async () => {
    const wallet = {
      address: "0x1111111111111111111111111111111111111111" as const,
      readContract: vi.fn(async () => 0n),
      verifyTypedData: vi.fn(async () => true),
      writeContract: vi.fn(async () => `0x${"33".repeat(32)}` as const),
      sendTransaction: vi.fn(async () => `0x${"33".repeat(32)}` as const),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const, logs: [] })),
      getCode: vi.fn(async () => undefined),
    };
    const signer = createX402SelfRelaySigner({
      backend: wallet,
      network: "eip155:8453",
      submissionLock: storage,
    });

    // The second of the pool's two connections, checked out by hand: the
    // channel transaction below takes the first, so a host-pool acquire from
    // inside it has nothing left to get and waits forever.
    const hog = await pool.connect();
    try {
      const submitted = storage.withChannelTransaction(CHANNEL_ID, async () => {
        await signer.sendTransaction({ to: wallet.address, data: "0x1234" });
        return "submitted" as const;
      });
      await expect(
        Promise.race([
          submitted,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("relay submission lock wedged the host pool")),
              15_000
            )
          ),
        ])
      ).resolves.toBe("submitted");
      expect(wallet.sendTransaction).toHaveBeenCalledOnce();
    } finally {
      hog.release();
    }
  }, 30_000);

  it("reconciles a refund wedged on its ledger leg, once, against the chain's own figure", async () => {
    const wedged = await wedgeRefund(pool, "repair-reconcile");
    try {
      const repair = wedged.server.repair;
      if (!repair) throw new Error("expected a repair surface on a Postgres-backed server");

      // The wedge itself: the chain paid, the response is durable, and the
      // ledger leg rolled back — which is exactly what every retry re-enters.
      const stuck = await storage.getSettlement("refund", wedged.effectId);
      expect(stuck).toMatchObject({ status: "settled" });

      const queue = await repair.list({ limit: 10, updatedBeforeMs: Date.now() + 1_000 });
      expect(queue.settlements.map((row) => row.intent.settlementId)).toContain(
        stuck?.settlementId
      );
      expect(
        queue.settlements.find((row) => row.intent.settlementId === stuck?.settlementId)?.evidence
      ).toEqual({ chain: "found", transaction: "0xrefund", amount: "100" });
      // A settlement younger than the staleness floor is in flight, not stuck.
      expect(await repair.list({ limit: 10, updatedBeforeMs: Date.now() - 60_000 })).toEqual({
        settlements: [],
      });

      const settlementId = stuck?.settlementId ?? "";
      let commits = 0;
      const first = await repair.reconcile({
        settlementId,
        commit: () => {
          commits += 1;
          return Promise.resolve("debited");
        },
        complete: (evidence, committed) => {
          expect(evidence).toEqual({ transaction: "0xrefund", amount: "100" });
          return Promise.resolve(`${committed}+booked`);
        },
      });
      expect(first).toMatchObject({ replayed: false, committed: "debited+booked" });
      expect(await storage.getSettlement("refund", wedged.effectId)).toMatchObject({
        status: "complete",
      });

      // Idempotent on the settlement row's own status: a replay returns the
      // recorded row and books nothing again.
      const replay = await repair.reconcile({
        settlementId,
        commit: () => {
          commits += 1;
          return Promise.resolve("debited-again");
        },
        complete: (_evidence, committed) => Promise.resolve(committed),
      });
      expect(replay).toMatchObject({ replayed: true });
      expect(commits).toBe(1);
    } finally {
      await wedged.server.stop();
    }
  }, 30_000);

  it("recovers a settled refund row persisted with the legacy replay key", async () => {
    const wedged = await wedgeRefund(pool, "repair-legacy-recovery");
    try {
      const legacyPaymentId = await setLegacyRefundPaymentId(
        pool,
        wedged.effectId,
        wedged.channelId
      );

      await expect(retryWedgedRefund(wedged)).resolves.toMatchObject({
        ok: true,
        value: { committed: "unused" },
      });
      expect(await storage.getSettlement("refund", wedged.effectId)).toMatchObject({
        status: "complete",
        paymentId: expect.not.stringMatching(`^${legacyPaymentId}$`),
      });
    } finally {
      await wedged.server.stop();
    }
  }, 30_000);

  it("writes a wedged refund off without booking it, and takes a later reconcile", async () => {
    const wedged = await wedgeRefund(pool, "repair-write-off");
    try {
      const repair = wedged.server.repair;
      if (!repair) throw new Error("expected a repair surface on a Postgres-backed server");
      const settlementId = (await storage.getSettlement("refund", wedged.effectId))?.settlementId;
      if (!settlementId) throw new Error("expected a wedged settlement");

      const closed = await repair.writeOff({ settlementId, note: "chain and ledger disagree" });
      expect(closed).toMatchObject({
        written: true,
        intent: { status: "written_off", writeOffNote: "chain and ledger disagree" },
      });
      const legacyPaymentId = await setLegacyRefundPaymentId(
        pool,
        wedged.effectId,
        wedged.channelId
      );

      // Idempotent, and the first note wins — the transition bit is what the
      // route logs on, so a repeat must not read as a second decision.
      const again = await repair.writeOff({ settlementId, note: "second thoughts" });
      expect(again).toMatchObject({
        written: false,
        intent: { status: "written_off", writeOffNote: "chain and ledger disagree" },
      });

      // Hidden from the queue by default, visible in the audit view.
      const stale = Date.now() + 1_000;
      expect(
        (await repair.list({ limit: 10, updatedBeforeMs: stale, evidence: false })).settlements.map(
          (row) => row.intent.settlementId
        )
      ).not.toContain(settlementId);
      expect(
        (
          await repair.list({
            limit: 10,
            updatedBeforeMs: stale,
            includeResolved: true,
            evidence: false,
          })
        ).settlements.map((row) => row.intent.settlementId)
      ).toContain(settlementId);

      // A caller re-presenting the same voucher is told the settlement was
      // closed, rather than 500ing on "no longer prepared for retry".
      await expect(
        wedged.server.accept({
          paymentHeader: wedged.refundHeader,
          amount: "0",
          operation: "refund",
          expectedChannelId: wedged.channelId,
          effectId: wedged.effectId,
          refundBoundNative: 100,
          commit: () => Promise.resolve("unused"),
        })
        // Not corrective: a 402 with fresh requirements would have an agent
        // re-sign the same drain id and land straight back here.
      ).resolves.toMatchObject({
        ok: false,
        reason: "settlement_written_off",
        corrective: false,
      });
      expect(await storage.getSettlement("refund", wedged.effectId)).toMatchObject({
        status: "written_off",
        paymentId: expect.not.stringMatching(`^${legacyPaymentId}$`),
      });

      // Reversible, precisely because the write-off unwound nothing.
      const reconciled = await repair.reconcile({
        settlementId,
        commit: () => Promise.resolve("debited"),
        complete: (_evidence, committed) => Promise.resolve(committed),
      });
      expect(reconciled).toMatchObject({ replayed: false });
      expect(await storage.getSettlement("refund", wedged.effectId)).toMatchObject({
        status: "complete",
      });
    } finally {
      await wedged.server.stop();
    }
  }, 30_000);

  it("lets a fresh drain settle an unchanged channel after the prior refund is written off", async () => {
    const wedged = await wedgeRefund(pool, "repair-write-off-fresh-drain", {
      applyRefundToLiveBalance: false,
      refundSettlementAmount: "100",
    });
    try {
      const repair = wedged.server.repair;
      if (!repair) throw new Error("expected a repair surface on a Postgres-backed server");
      const first = await storage.getSettlement("refund", wedged.effectId);
      if (!first) throw new Error("expected a wedged settlement");
      const legacyPaymentId = await setLegacyRefundPaymentId(
        pool,
        wedged.effectId,
        wedged.channelId
      );
      await repair.writeOff({ settlementId: first.settlementId, note: "no chain refund found" });

      const freshEffectId = "repair-write-off-fresh-drain-credit:drain-2";
      await expect(
        wedged.server.accept({
          paymentHeader: wedged.refundHeader,
          amount: "0",
          operation: "refund",
          expectedChannelId: wedged.channelId,
          effectId: freshEffectId,
          refundBoundNative: 100,
          commit: () => Promise.resolve("debited"),
          complete: (settlement, committed) => {
            expect(settlement.amount).toBe("100");
            return Promise.resolve(`${committed}+booked`);
          },
        })
      ).resolves.toMatchObject({ ok: true, value: { committed: "debited+booked" } });

      const fresh = await storage.getSettlement("refund", freshEffectId);
      expect(first).toMatchObject({ status: "settled" });
      expect(await storage.getSettlement("refund", wedged.effectId)).toMatchObject({
        status: "written_off",
        paymentId: legacyPaymentId,
      });
      expect(fresh).toMatchObject({ status: "complete" });
      expect(fresh?.paymentId).not.toBe(first.paymentId);
    } finally {
      await wedged.server.stop();
    }
  }, 30_000);

  it("keeps a chain that cannot be read apart from one that says nothing happened", async () => {
    const unreachable = await wedgeRefund(pool, "repair-unreachable", {
      findAppliedSettlement: () => Promise.reject(new Error("rpc timeout")),
    });
    try {
      const repair = unreachable.server.repair;
      if (!repair) throw new Error("expected a repair surface on a Postgres-backed server");
      const settlementId = (await storage.getSettlement("refund", unreachable.effectId))
        ?.settlementId;
      await expect(
        repair.reconcile({
          settlementId: settlementId ?? "",
          commit: () => Promise.resolve("debited"),
          complete: (_evidence, committed) => Promise.resolve(committed),
        })
      ).resolves.toMatchObject({ refusal: "chain_unreachable" });
    } finally {
      await unreachable.server.stop();
    }

    const absent = await wedgeRefund(pool, "repair-absent", {
      findAppliedSettlement: () => Promise.resolve(undefined),
    });
    try {
      const repair = absent.server.repair;
      if (!repair) throw new Error("expected a repair surface on a Postgres-backed server");
      const settlementId = (await storage.getSettlement("refund", absent.effectId))?.settlementId;
      await expect(
        repair.reconcile({
          settlementId: settlementId ?? "",
          commit: () => Promise.resolve("debited"),
          complete: (_evidence, committed) => Promise.resolve(committed),
        })
      ).resolves.toMatchObject({ refusal: "settlement_not_on_chain" });
    } finally {
      await absent.server.stop();
    }
  }, 30_000);

  it("advances the queue one row at a time instead of re-serving the cursor's own row", async () => {
    const first = await wedgeRefund(pool, "repair-page-a");
    const second = await wedgeRefund(pool, "repair-page-b");
    try {
      const repair = first.server.repair;
      if (!repair) throw new Error("expected a repair surface on a Postgres-backed server");
      const wanted = [
        (await storage.getSettlement("refund", first.effectId))?.settlementId,
        (await storage.getSettlement("refund", second.effectId))?.settlementId,
      ];

      // `limit: 1` is the sharpest form of the bug this pages against: a cursor
      // that lands before the row it was taken from returns that same row
      // forever and never reaches the second one.
      const walked: string[] = [];
      let after;
      for (let page = 0; page < 20; page += 1) {
        const result = await repair.list({
          limit: 1,
          updatedBeforeMs: Date.now() + 1_000,
          evidence: false,
          ...(after ? { after } : {}),
        });
        walked.push(...result.settlements.map((row) => row.intent.settlementId));
        if (!result.nextAfter) break;
        after = result.nextAfter;
      }

      expect(new Set(walked).size).toBe(walked.length);
      expect(walked).toEqual(expect.arrayContaining(wanted));
    } finally {
      await first.server.stop();
      await second.server.stop();
    }
  }, 30_000);

  it("puts the operator's write-off back when the reconcile's ledger leg refuses", async () => {
    const wedged = await wedgeRefund(pool, "repair-restore");
    try {
      const repair = wedged.server.repair;
      if (!repair) throw new Error("expected a repair surface on a Postgres-backed server");
      const settlementId = (await storage.getSettlement("refund", wedged.effectId))?.settlementId;
      if (!settlementId) throw new Error("expected a wedged settlement");

      await repair.writeOff({ settlementId, note: "chain and ledger disagree", nowMs: 4_242 });

      // The refusal a written-off settlement was closed for in the first place.
      await expect(
        repair.reconcile({
          settlementId,
          commit: () => Promise.reject(new Error("drain_conflict")),
          complete: (_evidence, committed) => Promise.resolve(committed),
        })
      ).rejects.toThrow("drain_conflict");

      // Recording the response lifted the row to `settled` before the ledger
      // leg ran; a rolled-back leg must not leave it in the live queue carrying
      // a note that says an operator already closed it.
      expect(await storage.getSettlementById(settlementId)).toMatchObject({
        status: "written_off",
        writeOffNote: "chain and ledger disagree",
        resolvedAt: 4_242,
      });
    } finally {
      await wedged.server.stop();
    }
  }, 30_000);

  it("answers a settlement completed under it with a refusal, not a rollback error", async () => {
    const wedged = await wedgeRefund(pool, "repair-race");
    try {
      const repair = wedged.server.repair;
      if (!repair) throw new Error("expected a repair surface on a Postgres-backed server");
      const settlementId = (await storage.getSettlement("refund", wedged.effectId))?.settlementId;
      if (!settlementId) throw new Error("expected a wedged settlement");

      // Stands in for the second repair (or the caller retry) that completes the
      // settlement between this one's read and its own CAS.
      await expect(
        repair.reconcile({
          settlementId,
          commit: () => Promise.resolve("debited"),
          complete: async (_evidence, committed) => {
            await storage.completeSettlement(settlementId);
            return committed;
          },
        })
      ).resolves.toMatchObject({ refusal: "settlement_raced" });
    } finally {
      await wedged.server.stop();
    }
  }, 30_000);

  it("stops a wedged refund's credit being respent, and lets it spend again once reconciled", async () => {
    const wedged = await wedgeRefund(pool, "spend-gate");
    try {
      const repair = wedged.server.repair;
      const gate = wedged.server.settlementGate;
      if (!repair || !gate) throw new Error("expected a repair surface and a settlement gate");
      const settlementId = (await storage.getSettlement("refund", wedged.effectId))?.settlementId;
      if (!settlementId) throw new Error("expected a wedged settlement");

      const gated = new CreditLedger(pool);
      await gated.init();
      const creditId = "spend-gate-credit";
      // Funded before the gate goes on, matching the order production reaches
      // this state in: the deposit opened the channel, the refund wedged later.
      await gated.fund({
        creditId,
        callerPubkey: "cd".repeat(32),
        currency: "usd",
        amountMicro: 400_000,
        expiryMs: Date.now() + 60_000,
        basis: {
          rail: "x402",
          paidMsats: 40_000,
          nativeAmount: 100,
          nativeAsset: "usdc",
          fundingRef: "0xdeposit",
          x402Channel: { channelId: wedged.channelId, maxClaimableAmount: "100" },
        },
      });
      gated.useX402SettlementGate(gate);

      expect(
        await gate.pendingRefundSettlement(wedged.channelId, ["submitting", "settled"])
      ).toMatchObject({ settlementId, status: "settled" });

      // The chain already paid this escrow out, so neither a full nor a partial
      // respend may place a hold the DVM could never claim against.
      for (const [drawId, amountMicro] of [
        ["respend-full", 400_000],
        ["respend-partial", 1_000],
      ] as const) {
        await expect(gated.draw({ creditId, drawId, amountMicro })).rejects.toMatchObject({
          code: "settlement_pending",
          details: { settlementId, settlementStatus: "settled" },
        });
      }

      await expect(
        repair.reconcile({
          settlementId,
          commit: () => Promise.resolve("debited"),
          complete: (_evidence, committed) => Promise.resolve(`${committed}+booked`),
        })
      ).resolves.toMatchObject({ replayed: false, committed: "debited+booked" });

      // Nothing blocks the channel any more, so the refusal a draw meets is the
      // ordinary balance answer again. (These stub ledger legs book nothing, so
      // the credit still carries its balance.)
      expect(
        await gate.pendingRefundSettlement(wedged.channelId, [
          "submitting",
          "settled",
          "written_off",
        ])
      ).toBeUndefined();
      await expect(
        gated.draw({ creditId, drawId: "after-repair", amountMicro: 1_000 })
      ).resolves.toMatchObject({ replayed: false });
    } finally {
      await wedged.server.stop();
    }
  }, 30_000);

  it("binds the spend gate through createDVMServer on a boot whose facilitator probe failed", async () => {
    // The gate used to be installed inside the batch-settlement factory, and
    // every door to that factory requires the probe reporting batch settlement
    // live. `refreshOnce` records no observation on `probe_failed`, so a boot
    // during a facilitator outage answered `false` for the outage's whole
    // duration — while `/v1/job` draws, which need no facilitator at all, ran
    // ungated against escrow the chain had already refunded.
    //
    // Nothing is hand-installed here: the ledger goes into `createDVMServer`
    // bare and the wiring is what has to bind it.
    const wedged = await wedgeRefund(pool, "boot-gate");
    const gated = new CreditLedger(pool);
    await gated.init();
    const creditId = "boot-gate-credit";
    const callerPubkey = "ef".repeat(32);
    const basis = {
      rail: "x402",
      paidMsats: 40_000,
      nativeAmount: 100,
      nativeAsset: "usdc",
      fundingRef: "0xdeposit",
      x402Channel: { channelId: wedged.channelId, maxClaimableAmount: "100" },
    } as const;
    // Seeded before the boot, in the order production reaches this state: the
    // deposit opened the channel, the refund wedged afterwards.
    await gated.fund({
      creditId,
      callerPubkey,
      currency: "usd",
      amountMicro: 400_000,
      expiryMs: Date.now() + 60_000,
      basis,
    });

    const { shutdown } = await createDVMServer(probeDownDVM(), {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      fxFetcher: stubFx(),
      creditLedger: gated,
      db: pool,
      x402: { network: NETWORK, payTo: X402_PAY_TO, batchSettlement: { autoSettlement: false } },
      x402FacilitatorHealth: probeDownHealth(),
    });
    try {
      const settlementId = (await storage.getSettlement("refund", wedged.effectId))?.settlementId;
      if (!settlementId) throw new Error("expected a wedged settlement");
      const blocked = { code: "settlement_pending", details: { settlementId } };
      await expect(
        gated.draw({ creditId, drawId: "respend", amountMicro: 1_000 })
      ).rejects.toMatchObject(blocked);
      await expect(
        gated.requestDrain({
          creditId,
          drainId: "second-drain",
          callerPubkey,
          method: "x402",
          payout: { channel_id: wedged.channelId },
        })
      ).rejects.toMatchObject(blocked);
      await expect(
        gated.fund({
          creditId,
          callerPubkey,
          currency: "usd",
          amountMicro: 100_000,
          expiryMs: Date.now() + 60_000,
          basis,
        })
      ).rejects.toMatchObject(blocked);
      // The refusal is read above the upsert, so the top-up left no balance.
      expect((await gated.get(creditId))?.balanceMicro).toBe(400_000);

      const repair = wedged.server.repair;
      if (!repair) throw new Error("expected a repair surface");
      await repair.reconcile({
        settlementId,
        commit: () => Promise.resolve("debited"),
        complete: (_evidence, committed) => Promise.resolve(committed),
      });
      await expect(
        gated.draw({ creditId, drawId: "after-repair", amountMicro: 1_000 })
      ).resolves.toMatchObject({ replayed: false });
    } finally {
      await shutdown();
      await wedged.server.stop();
    }
  }, 30_000);

  it("bookmarks the channel the settlement was submitted from, and clears it with the block", async () => {
    const requirements = {
      scheme: "batch-settlement",
      network: NETWORK,
      asset: channel().channelConfig.token,
      amount: "0",
      payTo: channel().channelConfig.receiver,
      maxTimeoutSeconds: 60,
      extra: {},
    } satisfies PaymentRequirements;
    const settlementId = "settlement-submission-snapshot";
    const prepared = await storage.prepareSettlement({
      settlementId,
      channelId: CHANNEL_ID,
      operation: "refund",
      effectId: "credit:drain-snapshot",
      paymentId: `${CHANNEL_ID}:0:${settlementId}`,
      payload: {
        x402Version: 2,
        accepted: requirements,
        payload: {
          type: "refund",
          channelConfig: channel().channelConfig,
          voucher: {
            channelId: CHANNEL_ID,
            maxClaimableAmount: "0",
            signature: channel().signature,
          },
        },
      } as PaymentPayload,
      requirements,
      channelBefore: channel(),
    });

    // The live pair the facilitator sizes and signs from — deliberately unequal
    // to the pre-refresh mirror `channelBefore` carries.
    const live: Channel = { ...channel(), balance: "1500", refundNonce: 2 };
    await storage.markSettlementSubmitting(prepared.settlementId, "77", live);
    expect(await storage.getSettlementById(settlementId)).toMatchObject({
      submissionBlock: "77",
      channelAtSubmission: { balance: "1500", refundNonce: 2 },
      channelBefore: { balance: "1000", refundNonce: 0 },
    });

    // A retryable failure returns the row to `prepared`, and the snapshot has to
    // leave with the bookmark: the next attempt submits from different state.
    await storage.markSettlementRetryable(prepared.settlementId);
    const retried = await storage.getSettlementById(settlementId);
    expect(retried?.status).toBe("prepared");
    expect(retried?.submissionBlock).toBeUndefined();
    expect(retried?.channelAtSubmission).toBeUndefined();
  });
});

/**
 * Drive one cooperative refund to the wedge: the facilitator settles,
 * the response is recorded durably on the settlement pool, and the ledger leg
 * then refuses — so the intent stays `settled` while nothing was booked.
 */
async function wedgeRefund(
  pool: pg.Pool,
  prefix: string,
  options?: Partial<{
    findAppliedSettlement: () => Promise<{ transaction: string; amount: string } | undefined>;
    applyRefundToLiveBalance: boolean;
    refundSettlementAmount: string;
  }>
): Promise<{
  server: Awaited<ReturnType<typeof createX402BatchSettlementServer>>;
  effectId: string;
  channelId: string;
  refundHeader: string;
  verify: ReturnType<typeof vi.fn>;
}> {
  const payer = privateKeyToAccount(generatePrivateKey());
  const receiver = privateKeyToAccount(generatePrivateKey());
  let liveBalance = 0n;
  const verify = vi.fn(async (payload: PaymentPayload): Promise<VerifyResponse> => {
    const raw = payload.payload as {
      channelConfig: { payer: string };
      voucher: { channelId: string };
    };
    return {
      isValid: true,
      payer: raw.channelConfig.payer,
      extra: {
        channelId: raw.voucher.channelId,
        balance: liveBalance.toString(),
        totalClaimed: "0",
        withdrawRequestedAt: 0,
        refundNonce: "0",
      },
    };
  });
  const facilitator: FacilitatorClient = {
    getSupported: vi.fn(async () => ({
      kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }],
      extensions: [],
      signers: {},
    })),
    verify,
    settle: vi.fn(
      async (
        payload: PaymentPayload,
        requirements: PaymentRequirements
      ): Promise<SettleResponse> => {
        const raw = payload.payload as {
          type: string;
          channelConfig: { payer: string };
          voucher: { channelId: string };
          deposit?: { amount: string };
          amount?: string;
        };
        if (raw.type === "deposit") liveBalance = BigInt(raw.deposit?.amount ?? "0");
        if (raw.type === "refund" && (options?.applyRefundToLiveBalance ?? true)) {
          liveBalance -= BigInt(raw.amount ?? "0");
        }
        return {
          success: true,
          transaction: raw.type === "refund" ? "0xrefund" : "0xdeposit",
          network: requirements.network,
          payer: raw.channelConfig.payer,
          // Exercise the refusal path with a facilitator that reports an amount
          // different from the expected refund leg.
          amount:
            raw.type === "refund"
              ? (options?.refundSettlementAmount ?? "999")
              : raw.deposit?.amount,
          extra: {
            channelState: {
              channelId: raw.voucher.channelId,
              balance: liveBalance.toString(),
              totalClaimed: "0",
              withdrawRequestedAt: 0,
              refundNonce: raw.type === "refund" ? "1" : "0",
            },
          },
        };
      }
    ),
  };
  const server = await createX402BatchSettlementServer({
    network: NETWORK,
    payTo: receiver.address,
    db: pool,
    earnedNative: earnedNothing,
    config: {
      facilitatorClient: facilitator,
      receiverAuthorizerSigner: receiver,
      autoSettlement: false,
    },
    settlementEvidenceReader: {
      getBlockNumber: async () => 100n,
      findAppliedSettlement:
        options?.findAppliedSettlement ??
        (() => Promise.resolve({ transaction: "0xrefund", amount: "100" })),
    },
  });

  const [fundBuilt] = await server.buildRequirements("100");
  const fundRequirements = fundBuilt as PaymentRequirements;
  const channelConfig: Channel["channelConfig"] = {
    payer: payer.address,
    payerAuthorizer: payer.address,
    receiver: receiver.address,
    receiverAuthorizer: receiver.address,
    token: fundRequirements.asset as `0x${string}`,
    withdrawDelay: 86_400,
    salt: generatePrivateKey(),
  };
  const channelId = computeChannelId(channelConfig, NETWORK);
  const deposit = await createBatchSettlementEIP3009DepositPayload(
    payer,
    2,
    fundRequirements,
    channelConfig,
    "100",
    "100"
  );
  await server.accept({
    paymentHeader: encodeHeader(deposit, fundRequirements),
    amount: "100",
    operation: "fund",
    effectId: `${prefix}-credit:fund-1`,
    commit: () => Promise.resolve("funded"),
  });

  const [refundBuilt] = await server.buildRequirements("0");
  const refundRequirements = refundBuilt as PaymentRequirements;
  const refundVoucher = await signVoucher(payer, channelId, "0", NETWORK);
  const refundHeader = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: refundRequirements,
      resource: { url: "/v1/credit" },
      payload: { type: "refund", channelConfig, voucher: refundVoucher },
    })
  ).toString("base64");
  const effectId = `${prefix}-credit:drain-1`;
  await expect(
    server.accept({
      paymentHeader: refundHeader,
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId,
      refundBoundNative: 100,
      commit: () => Promise.resolve("debited"),
      complete: (settlement) =>
        Promise.reject(
          new Error(`x402 refund settled ${settlement.amount ?? "?"} for a drain of 100`)
        ),
    })
  ).rejects.toThrow("for a drain of 100");

  return { server, effectId, channelId, refundHeader, verify };
}

/** A minimal free DVM: the subject is the wiring, not anything it serves. */
function probeDownDVM(): ReturnType<typeof configureDVM> {
  return configureDVM({
    name: "boot-gate",
    capability: "noop",
    input: z.object({ text: z.string() }),
    onJob: (ctx) => {
      ctx.complete("done");
    },
  });
}

/** The cold-start `probe_failed` view: exact stays optimistic, batch never is. */
function probeDownHealth(): X402FacilitatorHealthLike {
  return {
    refresh: () => Promise.resolve(),
    support: () => ({
      available: true,
      exact: { v1: true, v2: true },
      batchSettlement: false,
      facilitator: "https://facilitator.invalid",
      network: NETWORK,
      reason: "probe_failed",
    }),
  };
}

function stubFx(): FxFetcher {
  return {
    fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date(0).toISOString() }),
    lastKnown: () => null,
    supportedCurrencies: () => ["usd"],
  };
}

async function resetWedgeToSubmitting(
  pool: pg.Pool,
  effectId: string,
  bookmarked = true
): Promise<void> {
  await pool.query(
    `UPDATE x402_batch_settlements
        SET status = 'submitting', settle_response = NULL,
            submission_block = $2, updated_at = NOW()
      WHERE operation = 'refund' AND effect_id = $1`,
    [effectId, bookmarked ? "100" : null]
  );
}

function retryWedgedRefund(
  wedged: Awaited<ReturnType<typeof wedgeRefund>>
): ReturnType<typeof wedged.server.accept> {
  return wedged.server.accept({
    paymentHeader: wedged.refundHeader,
    amount: "0",
    operation: "refund",
    expectedChannelId: wedged.channelId,
    effectId: wedged.effectId,
    refundBoundNative: 100,
    commit: () => Promise.resolve("unused"),
  });
}

async function setLegacyRefundPaymentId(
  pool: pg.Pool,
  effectId: string,
  channelId: string
): Promise<string> {
  const legacyPaymentId = `${channelId}:0`;
  const result = await pool.query(
    `UPDATE x402_batch_settlements
        SET payment_id = $2
      WHERE operation = 'refund' AND effect_id = $1`,
    [effectId, legacyPaymentId]
  );
  if (result.rowCount !== 1) throw new Error(`expected refund settlement ${effectId}`);
  return legacyPaymentId;
}

function requireChannel(current: Channel | undefined): Channel {
  if (!current) throw new Error("expected stored channel");
  return current;
}

/** One signed deposit on its own channel, ready to hand to `server.accept`. */
async function depositPayment(
  receiver: `0x${string}`,
  requirements: PaymentRequirements
): Promise<{ channelId: string; paymentHeader: string }> {
  const payer = privateKeyToAccount(generatePrivateKey());
  const channelConfig: Channel["channelConfig"] = {
    payer: payer.address,
    payerAuthorizer: payer.address,
    receiver,
    receiverAuthorizer: receiver,
    token: requirements.asset as `0x${string}`,
    withdrawDelay: 86_400,
    salt: generatePrivateKey(),
  };
  const payload = await createBatchSettlementEIP3009DepositPayload(
    payer,
    2,
    requirements,
    channelConfig,
    "1000",
    "100"
  );
  return {
    channelId: computeChannelId(channelConfig, NETWORK),
    paymentHeader: Buffer.from(
      JSON.stringify({ ...payload, accepted: requirements, resource: { url: "/v1/credit" } })
    ).toString("base64"),
  };
}

/** Facilitator stub that credits each channel's deposit against live state. */
function recordingFacilitator(balances: Map<string, bigint>): FacilitatorClient {
  const balanceOf = (channelId: string): bigint => balances.get(channelId.toLowerCase()) ?? 0n;
  return {
    getSupported: vi.fn(async () => ({
      kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }],
      extensions: [],
      signers: {},
    })),
    verify: vi.fn(async (payload: PaymentPayload): Promise<VerifyResponse> => {
      const raw = payload.payload as {
        channelConfig: { payer: string };
        voucher: { channelId: string };
      };
      return {
        isValid: true,
        payer: raw.channelConfig.payer,
        extra: {
          channelId: raw.voucher.channelId,
          balance: balanceOf(raw.voucher.channelId).toString(),
          totalClaimed: "0",
          withdrawRequestedAt: 0,
          refundNonce: "0",
        },
      };
    }),
    settle: vi.fn(
      async (
        payload: PaymentPayload,
        requirements: PaymentRequirements
      ): Promise<SettleResponse> => {
        const raw = payload.payload as {
          channelConfig: { payer: string };
          voucher: { channelId: string };
          deposit: { amount: string };
        };
        const channelId = raw.voucher.channelId.toLowerCase();
        const balance = balanceOf(channelId) + BigInt(raw.deposit.amount);
        balances.set(channelId, balance);
        return {
          success: true,
          transaction: `0xdeposit${channelId.slice(2, 10)}`,
          network: requirements.network,
          payer: raw.channelConfig.payer,
          amount: raw.deposit.amount,
          extra: {
            channelState: {
              channelId: raw.voucher.channelId,
              balance: balance.toString(),
              totalClaimed: "0",
              withdrawRequestedAt: 0,
              refundNonce: "0",
            },
          },
        };
      }
    ),
  };
}
