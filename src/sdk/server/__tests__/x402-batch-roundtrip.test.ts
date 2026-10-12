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
import { type Channel, InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { createX402BatchSettlementServer } from "../x402-batch-settlement";
import type { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import type { X402PayoutObserver } from "../payout-reporter";

const NETWORK = "eip155:84532" as const;
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

interface BatchRaw {
  type: "deposit" | "voucher" | "refund" | "claim" | "settle";
  channelConfig?: Channel["channelConfig"];
  voucher?: { channelId: string };
}

class StatefulFacilitator implements FacilitatorClient {
  withdrawRequestedAt = 0;
  claimFails = false;
  balance = 1_000n;
  totalClaimed = 0n;
  settleNothingResponses = 0;

  readonly verify = vi.fn(
    async (payload: PaymentPayload): Promise<VerifyResponse> => ({
      isValid: true,
      payer: (payload.payload as unknown as BatchRaw).channelConfig?.payer,
      extra: {
        channelId: (payload.payload as unknown as BatchRaw).voucher?.channelId,
        balance: this.balance.toString(),
        totalClaimed: this.totalClaimed.toString(),
        withdrawRequestedAt: this.withdrawRequestedAt,
        refundNonce: "0",
      },
    })
  );

  readonly settle = vi.fn(
    async (payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
      const raw = payload.payload as unknown as BatchRaw;
      if (raw.type === "claim" && this.claimFails) {
        return {
          success: false,
          errorReason: "claim rejected",
          transaction: "",
          network: requirements.network,
        };
      }
      if (raw.type === "settle" && this.settleNothingResponses > 0) {
        this.settleNothingResponses--;
        return {
          success: false,
          errorReason:
            "invalid_batch_settlement_evm_nothing_to_settle — nothing to settle for receiver and token",
          transaction: "",
          network: requirements.network,
        };
      }
      if (raw.type === "claim" || raw.type === "settle") {
        return {
          success: true,
          transaction: raw.type === "claim" ? "0xclaim" : "0xsettle",
          network: requirements.network,
        };
      }
      if (raw.type === "deposit") {
        this.balance = BigInt(
          (raw as BatchRaw & { deposit?: { amount?: string } }).deposit?.amount ?? "0"
        );
      }
      if (raw.type === "refund") {
        // Model the contract's multicall: the bundled claims move the DVM's
        // earnings out first, then `refund(config, amount)` pays the enriched
        // amount. A payout derived from `balance − totalClaimed` instead would
        // agree with the very bug this file has to catch.
        const enriched = raw as BatchRaw & {
          amount?: string;
          claims?: { totalClaimed?: string }[];
        };
        this.totalClaimed = (enriched.claims ?? []).reduce(
          (max, claim) =>
            BigInt(claim.totalClaimed ?? "0") > max ? BigInt(claim.totalClaimed ?? "0") : max,
          this.totalClaimed
        );
        this.balance -= BigInt(enriched.amount ?? "0");
      }
      const refund = raw.type === "refund";
      return {
        success: true,
        payer: raw.channelConfig?.payer,
        transaction: refund ? "0xrefund" : "0xdeposit",
        network: requirements.network,
        amount: refund
          ? (raw as BatchRaw & { amount?: string }).amount
          : (raw as BatchRaw & { deposit?: { amount?: string } }).deposit?.amount,
        extra: {
          channelState: {
            channelId: raw.voucher?.channelId,
            balance: this.balance.toString(),
            totalClaimed: this.totalClaimed.toString(),
            withdrawRequestedAt: 0,
            refundNonce: refund ? "1" : "0",
          },
        },
      };
    }
  );

  readonly getSupported = vi.fn(async () => ({
    kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }],
    extensions: [],
    signers: {},
  }));
}

/**
 * Ledger stand-in for the claim ceiling. A claim never exceeds the
 * credit's settled draws, so a test that funds without drawing claims nothing —
 * which is what most of these want, since they exercise the accept lifecycle
 * rather than the claim.
 */
const earnedNothing = (): Promise<number> => Promise.resolve(0);

function header(
  payload: Pick<PaymentPayload, "x402Version" | "payload">,
  accepted: PaymentRequirements
) {
  return Buffer.from(
    JSON.stringify({ ...payload, accepted, resource: { url: "/v1/credit" } })
  ).toString("base64");
}

describe("x402 batch-settlement stateful round trip", () => {
  it.each(
    (["deposit", "voucher", "refund"] as const).flatMap((type) =>
      (["channelId", "maxClaimableAmount", "signature"] as const).flatMap((field) =>
        [
          { valueType: "number", value: 7 },
          { valueType: "object", value: {} },
          { valueType: "null", value: null },
        ].map((invalid) => ({ type, field, ...invalid }))
      )
    )
  )("refuses $type payloads with a $valueType voucher.$field before side effects", async ({ type, field, value }) => {
    const payer = privateKeyToAccount(`0x${"01".repeat(32)}`);
    const receiver = privateKeyToAccount(`0x${"02".repeat(32)}`);
    const facilitator = new StatefulFacilitator();
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative: earnedNothing,
      config: {
        storage: new InMemoryChannelStorage(),
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    try {
      const [fundRequirements] = await server.buildRequirements("100");
      const channelConfig: Channel["channelConfig"] = {
        payer: payer.address,
        payerAuthorizer: payer.address,
        receiver: receiver.address,
        receiverAuthorizer: receiver.address,
        token: TOKEN,
        withdrawDelay: 86_400,
        salt: `0x${"33".repeat(32)}`,
      };
      const channelId = computeChannelId(channelConfig, NETWORK);
      const deposit = await createBatchSettlementEIP3009DepositPayload(
        payer, 2, fundRequirements as PaymentRequirements, channelConfig, "1000", "100"
      );
      await expect(server.accept({
        paymentHeader: header(deposit, fundRequirements as PaymentRequirements),
        amount: "100",
        operation: "fund",
        effectId: "malformed-voucher:initial-fund",
        commit: async () => "funded",
      })).resolves.toMatchObject({ ok: true });
      const funded = structuredClone(await server.getChannel(channelId));
      facilitator.verify.mockClear();
      facilitator.settle.mockClear();

      const amount = type === "refund" ? "0" : "100";
      const [requirements] = await server.buildRequirements(amount);
      const maximum = type === "refund" ? "0" : type === "deposit" ? "100" : "200";
      const voucher = await signVoucher(payer, channelId, maximum, NETWORK);
      const payload = type === "deposit" ? deposit.payload : { type, channelConfig, voucher };
      const commit = vi.fn(async () => "must not commit");
      const complete = vi.fn(async () => "must not complete");
      await expect(server.accept({
        paymentHeader: header({
          x402Version: 2,
          payload: { ...payload, voucher: { ...voucher, [field]: value } },
        }, requirements as PaymentRequirements),
        amount,
        effectId: "malformed-voucher:refused",
        ...(type === "refund"
          ? { operation: "refund" as const, expectedChannelId: channelId, refundBoundNative: 100 }
          : { operation: "fund" as const }),
        commit,
        complete,
      })).resolves.toMatchObject({ ok: false, reason: "decode_failed", requirements: [requirements] });
      expect(facilitator.verify).not.toHaveBeenCalled();
      expect(facilitator.settle).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(await server.getChannel(channelId)).toEqual(funded);
    } finally {
      await server.stop();
    }
  });

  it("refuses a cooperative refund before facilitator submission when its original effect cannot be reserved", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const facilitator = new StatefulFacilitator();
    const reserveX402 = vi.fn().mockRejectedValue(new Error("original refund reservation unavailable"));
    const server = await createX402BatchSettlementServer({
      network: NETWORK, payTo: receiver.address, earnedNative: earnedNothing,
      config: { storage: new InMemoryChannelStorage(), facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver, autoSettlement: false },
      hostedObligations: { reserveX402 } as unknown as HostedSettlementReportObligations,
    });
    try {
      const [built] = await server.buildRequirements("100");
      const requirements = built as PaymentRequirements;
      const channelConfig: Channel["channelConfig"] = {
        payer: payer.address, payerAuthorizer: payer.address,
        receiver: receiver.address, receiverAuthorizer: receiver.address,
        token: TOKEN, withdrawDelay: 86_400, salt: `0x${"79".repeat(32)}`,
      };
      const channelId = computeChannelId(channelConfig, NETWORK);
      const deposit = await createBatchSettlementEIP3009DepositPayload(
        payer, 2, requirements, channelConfig, "100", "100"
      );
      expect(await server.accept({ paymentHeader: header(deposit, requirements),
        amount: "100", operation: "fund", effectId: "reserved-refund:fund",
        commit: async () => "funded" })).toMatchObject({ ok: true });
      facilitator.settle.mockClear();
      const voucher = await signVoucher(payer, channelId, "0", NETWORK);
      await expect(server.accept({
        paymentHeader: header({ x402Version: 2,
          payload: { type: "refund", channelConfig, voucher } },
        { ...requirements, amount: "0" }),
        amount: "0", operation: "refund", effectId: "reserved-refund:drain",
        expectedChannelId: channelId, refundBoundNative: 100,
        commit: async () => "drained",
      })).rejects.toThrow("original refund reservation unavailable");
      expect(reserveX402).toHaveBeenCalledOnce();
      expect(facilitator.settle).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("opens a deposit, verifies the next voucher locally, and cooperatively refunds", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const storage = new InMemoryChannelStorage();
    const facilitator = new StatefulFacilitator();
    // What the credit these vouchers fund has drawn so far, moved as the test
    // narrates spending — the claim ceiling reads it.
    let earnedNative = 0;
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative: () => Promise.resolve(earnedNative),
      config: {
        storage,
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [builtRequirements] = await server.buildRequirements("100");
    const requirements = builtRequirements as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"44".repeat(32)}`,
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
    const first = await server.accept({
      paymentHeader: header(deposit, requirements),
      amount: "100",
      operation: "fund",
      effectId: "credit-1:fund-1",
      commit: async (funding) => funding.paymentId,
    });
    expect(first).toMatchObject({ ok: true });
    expect(await server.getChannel(channelId)).toMatchObject({
      balance: "1000",
      chargedCumulativeAmount: "100",
    });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);

    const liveVerify = facilitator.verify.getMockImplementation();
    if (!liveVerify) throw new Error("expected the stateful facilitator verify implementation");
    facilitator.verify.mockRejectedValue(new Error("facilitator offline"));

    const voucher = await signVoucher(payer, channelId, "200", NETWORK);
    const secondPayload = {
      x402Version: 2,
      payload: { type: "voucher", channelConfig, voucher },
    } as const;
    await expect(
      server.accept({
        paymentHeader: header(secondPayload, requirements),
        amount: "100",
        operation: "fund",
        effectId: "credit-1:fund-2-failed",
        commit: async () => {
          throw new Error("ledger refused");
        },
      })
    ).rejects.toThrow("ledger refused");
    expect(await server.getChannel(channelId)).toMatchObject({
      chargedCumulativeAmount: "100",
      pendingRequest: undefined,
    });

    const second = await server.accept({
      paymentHeader: header(secondPayload, requirements),
      amount: "100",
      operation: "fund",
      effectId: "credit-1:fund-2",
      commit: async (funding) => funding.paymentId,
    });
    expect(second).toMatchObject({ ok: true });
    // The deposit's mirrored state is still within its TTL, so both voucher
    // attempts verify locally and survive a facilitator outage.
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(await server.getChannel(channelId)).toMatchObject({ chargedCumulativeAmount: "200" });

    // 150 of the 200 funded has been drawn and settled, so the rush claim the
    // withdrawal race triggers takes exactly that — not the 200 charged.
    earnedNative = 150;
    facilitator.verify.mockImplementation(liveVerify);
    await storage.updateChannel(channelId, (current) =>
      current ? { ...current, onchainSyncedAt: 0 } : current
    );
    facilitator.withdrawRequestedAt = 123;
    const withdrawingVoucher = await signVoucher(payer, channelId, "300", NETWORK);
    const withdrawing = await server.accept({
      paymentHeader: header(
        {
          x402Version: 2,
          payload: { type: "voucher", channelConfig, voucher: withdrawingVoucher },
        },
        requirements
      ),
      amount: "100",
      operation: "fund",
      effectId: "credit-1:fund-withdrawing",
      commit: async () => "must not run",
    });
    expect(withdrawing).toMatchObject({
      ok: false,
      reason: "withdrawal_pending",
      requirements: [
        {
          extra: {
            channelState: expect.objectContaining({ channelId, withdrawRequestedAt: 123 }),
            voucherState: expect.objectContaining({ signedMaxClaimable: "300" }),
          },
        },
      ],
    });
    expect(facilitator.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "claim",
          claims: [expect.objectContaining({ totalClaimed: "150" })],
        }),
      }),
      expect.anything()
    );
    facilitator.withdrawRequestedAt = 0;

    const stale = await server.accept({
      paymentHeader: header(secondPayload, requirements),
      amount: "100",
      operation: "fund",
      effectId: "credit-1:fund-stale",
      commit: () => Promise.resolve("must not run"),
    });
    expect(stale).toMatchObject({
      ok: false,
      reason: "invalid_batch_settlement_evm_cumulative_amount_mismatch",
      requirements: [
        {
          extra: {
            channelState: { chargedCumulativeAmount: "200" },
            voucherState: { signedMaxClaimable: "200" },
          },
        },
      ],
    });

    const refundPayload = {
      x402Version: 2,
      payload: {
        type: "refund",
        channelConfig,
        voucher: await signVoucher(payer, channelId, "150", NETWORK),
      },
    } as const;
    const refund = await server.accept({
      paymentHeader: header(refundPayload, { ...requirements, amount: "0" }),
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId: "credit-1:drain-1",
      // 200 was funded and 150 drawn, so 50 is owed — and the base drops to the
      // 150 earned, which returns the 800 of deposit that was never credited
      // along with the payer's unspent balance.
      refundBoundNative: 50,
      commit: async () => "drained",
    });
    expect(refund).toMatchObject({ ok: true, value: { committed: "drained" } });
    expect(await server.getChannel(channelId)).toBeUndefined();
    expect(facilitator.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ type: "refund" }) }),
      expect.anything()
    );
    await server.stop();
  });

  /**
   * A rebuilt fleet meets a channel it holds no row for, and the payer is
   * withdrawing. Upstream's verify synthesises the row from the facilitator's
   * `extra`, so the voucher it just banked is the only payer signature anyone
   * has for the value already charged — the refusal must not take it away, on
   * either outcome of the rush claim.
   */
  it("keeps the payer signature through a withdrawal race on a channel with no local row", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const storage = new InMemoryChannelStorage();
    const facilitator = new StatefulFacilitator();
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      // The credit this channel funded has drawn everything charged to it, so
      // the rush claim has the full 100 to protect.
      earnedNative: () => Promise.resolve(100),
      config: {
        storage,
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [builtRequirements] = await server.buildRequirements("100");
    const requirements = builtRequirements as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"55".repeat(32)}`,
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
      paymentHeader: header(deposit, requirements),
      amount: "100",
      operation: "fund",
      effectId: "credit-2:fund-1",
      commit: async (funding) => funding.paymentId,
    });
    expect(opened).toMatchObject({ ok: true });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);

    const voucher = await signVoucher(payer, channelId, "200", NETWORK);
    const voucherPayload = {
      x402Version: 2,
      payload: { type: "voucher", channelConfig, voucher },
    } as const;

    // The fleet lost its channel state; the payer starts a withdrawal.
    await storage.updateChannel(channelId, () => undefined);
    expect(await server.getChannel(channelId)).toBeUndefined();
    facilitator.withdrawRequestedAt = 123;
    facilitator.claimFails = true;

    const claimFailed = await server.accept({
      paymentHeader: header(voucherPayload, requirements),
      amount: "100",
      operation: "fund",
      effectId: "credit-2:fund-withdrawing-1",
      commit: async () => "must not run",
    });
    expect(claimFailed).toMatchObject({ ok: false, reason: "withdrawal_pending" });
    // With no mirrored row, upstream owns the single live verification. The
    // dvmkit preflight must not spend a second facilitator round trip.
    expect(facilitator.verify).toHaveBeenCalledTimes(2);
    expect(await server.getChannel(channelId)).toMatchObject({
      signature: voucher.signature,
      signedMaxClaimable: "200",
      chargedCumulativeAmount: "100",
      pendingRequest: undefined,
    });

    // Same shape again, this time with a claim the facilitator accepts: the
    // row that just recorded `totalClaimed` has to survive too.
    await storage.updateChannel(channelId, () => undefined);
    facilitator.claimFails = false;
    const claimLanded = await server.accept({
      paymentHeader: header(voucherPayload, requirements),
      amount: "100",
      operation: "fund",
      effectId: "credit-2:fund-withdrawing-2",
      commit: async () => "must not run",
    });
    expect(claimLanded).toMatchObject({ ok: false, reason: "withdrawal_pending" });
    expect(facilitator.verify).toHaveBeenCalledTimes(3);
    expect(facilitator.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ type: "claim" }) }),
      expect.anything()
    );
    expect(await server.getChannel(channelId)).toMatchObject({
      signature: voucher.signature,
      totalClaimed: "100",
      pendingRequest: undefined,
    });
    await server.stop();
  });

  it("revokes an unclaimed voucher and refunds a channel whose deposit equals its charge", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const storage = new InMemoryChannelStorage();
    const facilitator = new StatefulFacilitator();
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative: earnedNothing,
      config: {
        storage,
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [builtRequirements] = await server.buildRequirements("100");
    const requirements = builtRequirements as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"55".repeat(32)}`,
    };
    const channelId = computeChannelId(channelConfig, NETWORK);
    const deposit = await createBatchSettlementEIP3009DepositPayload(
      payer,
      2,
      requirements,
      channelConfig,
      "100",
      "100"
    );
    await expect(
      server.accept({
        paymentHeader: header(deposit, requirements),
        amount: "100",
        operation: "fund",
        effectId: "credit-exact:fund-1",
        commit: async () => "funded",
      })
    ).resolves.toMatchObject({ ok: true });
    expect(await server.getChannel(channelId)).toMatchObject({
      balance: "100",
      totalClaimed: "0",
      chargedCumulativeAmount: "100",
    });

    const refundVoucher = await signVoucher(payer, channelId, "0", NETWORK);
    const refundHeader = header(
      {
        x402Version: 2,
        payload: { type: "refund", channelConfig, voucher: refundVoucher },
      },
      { ...requirements, amount: "0" }
    );
    await expect(
      server.accept({
        paymentHeader: refundHeader,
        amount: "0",
        operation: "refund",
        expectedChannelId: channelId,
        effectId: "credit-exact:drain-empty-bound",
        refundBoundNative: 0,
        commit: async () => "must not run",
      })
    ).resolves.toMatchObject({
      ok: false,
      reason: "refund_bound_unavailable",
      corrective: false,
    });
    await expect(
      server.accept({
        paymentHeader: refundHeader,
        amount: "0",
        operation: "refund",
        expectedChannelId: channelId,
        effectId: "credit-exact:drain-rollback",
        refundBoundNative: 100,
        commit: async () => {
          throw new Error("draw still pending");
        },
      })
    ).rejects.toThrow("draw still pending");
    expect(await server.getChannel(channelId)).toMatchObject({
      balance: "100",
      totalClaimed: "0",
      chargedCumulativeAmount: "100",
      signedMaxClaimable: "100",
      pendingRequest: undefined,
    });

    let releaseFailedCommit = (): void => undefined;
    const failedCommitGate = new Promise<void>((resolve) => {
      releaseFailedCommit = resolve;
    });
    let failedCommitStarted = (): void => undefined;
    const failedCommitEntered = new Promise<void>((resolve) => {
      failedCommitStarted = resolve;
    });
    const failedDrain = server.accept({
      paymentHeader: refundHeader,
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId: "credit-exact:drain-1",
      refundBoundNative: 100,
      commit: async () => {
        failedCommitStarted();
        await failedCommitGate;
        throw new Error("draw still pending");
      },
    });
    await failedCommitEntered;
    const verifyCallsBeforeRetry = facilitator.verify.mock.calls.length;
    const retriedDrain = server.accept({
      paymentHeader: refundHeader,
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId: "credit-exact:drain-1",
      refundBoundNative: 100,
      commit: async () => "drained",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(facilitator.verify).toHaveBeenCalledTimes(verifyCallsBeforeRetry);
    releaseFailedCommit();
    await expect(failedDrain).rejects.toThrow("draw still pending");
    await expect(retriedDrain).resolves.toMatchObject({
      ok: true,
      value: { committed: "drained" },
    });
    expect(facilitator.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ type: "refund", amount: "100" }),
      }),
      expect.anything()
    );
    expect(await server.getChannel(channelId)).toBeUndefined();
    await server.stop();
  });
  it("sizes a drain to the credit's unspent balance, not the unclaimed deposit", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const facilitator = new StatefulFacilitator();
    const recordSubmitted = vi.fn().mockResolvedValue(undefined);
    const recordRefundClaim = vi.fn().mockResolvedValue(undefined);
    const hostedObligations = {
      reserveX402: vi.fn().mockResolvedValue({ id: "original-refund", replayed: false }),
      recordSubmitted, refundClaimDelta: vi.fn().mockResolvedValue(60n),
    } as unknown as HostedSettlementReportObligations;
    const payout = { attach: vi.fn(), trackManager: <M>(manager: M) => manager,
      recordSettle: vi.fn(), recordSettleFailure: vi.fn(), recordRefundClaim,
    } as X402PayoutObserver;
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative: earnedNothing,
      hostedObligations,
      payout,
      config: {
        storage: new InMemoryChannelStorage(),
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [builtRequirements] = await server.buildRequirements("100");
    const requirements = builtRequirements as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"66".repeat(32)}`,
    };
    const channelId = computeChannelId(channelConfig, NETWORK);
    const deposit = await createBatchSettlementEIP3009DepositPayload(
      payer,
      2,
      requirements,
      channelConfig,
      "100",
      "100"
    );
    await expect(
      server.accept({
        paymentHeader: header(deposit, requirements),
        amount: "100",
        operation: "fund",
        effectId: "credit-spent:fund-1",
        commit: async () => "funded",
      })
    ).resolves.toMatchObject({ ok: true });
    // The whole deposit is charged to the channel at fund time and the DVM has
    // not claimed any of it yet, so the escrow the payer could strip is 100 —
    // but 60 of it has since been drawn against the credit.
    expect(await server.getChannel(channelId)).toMatchObject({
      balance: "100",
      totalClaimed: "0",
      chargedCumulativeAmount: "100",
    });

    // Signing at the contract floor is what the caller's first attempt does; it
    // is corrected, not blocked, and the reason has to be upstream's own code
    // or the client cannot recognise the 402 as correctable.
    const floorVoucher = await signVoucher(payer, channelId, "0", NETWORK);
    const uncorrected = await server.accept({
      paymentHeader: header(
        { x402Version: 2, payload: { type: "refund", channelConfig, voucher: floorVoucher } },
        { ...requirements, amount: "0" }
      ),
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId: "credit-spent:drain-1",
      refundBoundNative: 40,
      commit: async () => "must not run",
    });
    expect(uncorrected).toMatchObject({
      ok: false,
      reason: "invalid_batch_settlement_evm_cumulative_amount_mismatch",
      requirements: [
        expect.objectContaining({
          extra: expect.objectContaining({
            channelState: expect.objectContaining({ chargedCumulativeAmount: "60" }),
          }),
        }),
      ],
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);

    const basedVoucher = await signVoucher(payer, channelId, "60", NETWORK);
    const drained = await server.accept({
      paymentHeader: header(
        { x402Version: 2, payload: { type: "refund", channelConfig, voucher: basedVoucher } },
        { ...requirements, amount: "0" }
      ),
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId: "credit-spent:drain-1",
      refundBoundNative: 40,
      commit: async () => "drained",
    });
    expect(drained).toMatchObject({ ok: true, value: { committed: "drained" } });
    // The payer gets the 40 it never spent; the bundled claim still pays the
    // DVM the 60 it earned. Refunding `balance − totalClaimed` would have
    // handed the payer all 100 and left the DVM nothing.
    expect(facilitator.settle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "refund",
          amount: "40",
          claims: [expect.objectContaining({ totalClaimed: "60" })],
          claimAuthorizerSignature: expect.stringMatching(/^0x[0-9a-f]+$/i),
          refundAuthorizerSignature: expect.stringMatching(/^0x[0-9a-f]+$/i),
        }),
      }),
      expect.anything()
    );
    const refundCall = vi.mocked(hostedObligations.reserveX402).mock.calls.find(
      (call) => call[1] === "refund"
    );
    expect(refundCall?.[2].authorizationPayload).toEqual(
      vi.mocked(facilitator.settle).mock.lastCall?.[0].payload
    );
    expect(refundCall?.[2].authorizationRequirements).toEqual(
      vi.mocked(facilitator.settle).mock.lastCall?.[1]
    );
    expect(recordSubmitted).toHaveBeenCalledWith("original-refund", "0xrefund");
    expect(recordRefundClaim).toHaveBeenCalledWith("0xrefund", 60n);
    await server.stop();
  });

  it("refuses a drain whose escrow the DVM has already claimed", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const facilitator = new StatefulFacilitator();
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative: earnedNothing,
      config: {
        storage: new InMemoryChannelStorage(),
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [builtRequirements] = await server.buildRequirements("100");
    const requirements = builtRequirements as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"77".repeat(32)}`,
    };
    const channelId = computeChannelId(channelConfig, NETWORK);
    const deposit = await createBatchSettlementEIP3009DepositPayload(
      payer,
      2,
      requirements,
      channelConfig,
      "100",
      "100"
    );
    await expect(
      server.accept({
        paymentHeader: header(deposit, requirements),
        amount: "100",
        operation: "fund",
        effectId: "credit-claimed:fund-1",
        commit: async () => "funded",
      })
    ).resolves.toMatchObject({ ok: true });

    // The 300s claim job has since pulled the whole deposit, so the channel
    // holds nothing to return even though the ledger still owes 40.
    facilitator.totalClaimed = 100n;
    const settleCallsBeforeDrain = facilitator.settle.mock.calls.length;
    const refused = await server.accept({
      paymentHeader: header(
        {
          x402Version: 2,
          payload: {
            type: "refund",
            channelConfig,
            voucher: await signVoucher(payer, channelId, "60", NETWORK),
          },
        },
        { ...requirements, amount: "0" }
      ),
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId: "credit-claimed:drain-1",
      refundBoundNative: 40,
      commit: async () => "must not run",
    });
    expect(refused).toMatchObject({
      ok: false,
      reason: "refund_exceeds_channel_escrow",
      corrective: false,
    });
    expect(facilitator.settle).toHaveBeenCalledTimes(settleCallsBeforeDrain);
    expect(await server.getChannel(channelId)).toMatchObject({
      chargedCumulativeAmount: "100",
      pendingRequest: undefined,
    });
    await server.stop();
  });

  it("refuses a refund voucher signed for a channel other than the credit's own", async () => {
    // A payer with two channels at one DVM could otherwise drain the
    // credit bound to channel X while presenting channel Y's voucher: X's ledger
    // balance is extinguished and the payout leaves Y's escrow, which the credit
    // bound to Y still has full claim on. The comparison is against the same
    // `voucher.channelId` that revokes and pays, so nothing can pay from a
    // channel this check did not see.
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const facilitator = new StatefulFacilitator();
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative: earnedNothing,
      config: {
        storage: new InMemoryChannelStorage(),
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [builtRequirements] = await server.buildRequirements("100");
    const requirements = builtRequirements as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"99".repeat(32)}`,
    };
    const channelId = computeChannelId(channelConfig, NETWORK);
    const deposit = await createBatchSettlementEIP3009DepositPayload(
      payer,
      2,
      requirements,
      channelConfig,
      "100",
      "100"
    );
    await expect(
      server.accept({
        paymentHeader: header(deposit, requirements),
        amount: "100",
        operation: "fund",
        effectId: "credit-other-channel:fund-1",
        commit: async () => "funded",
      })
    ).resolves.toMatchObject({ ok: true });
    const funded = await server.getChannel(channelId);
    const settleCallsBeforeDrain = facilitator.settle.mock.calls.length;
    const verifyCallsBeforeDrain = facilitator.verify.mock.calls.length;

    const refundVoucher = await signVoucher(payer, channelId, "0", NETWORK);
    const refused = await server.accept({
      paymentHeader: header(
        { x402Version: 2, payload: { type: "refund", channelConfig, voucher: refundVoucher } },
        { ...requirements, amount: "0" }
      ),
      amount: "0",
      operation: "refund",
      // The credit being drained is bound elsewhere — a second channel this
      // payer opened after reconnecting a wallet, say.
      expectedChannelId: `0x${"5e".repeat(32)}`,
      effectId: "credit-other-channel:drain-1",
      refundBoundNative: 100,
      commit: async () => "must not run",
    });

    // Terminal, not corrective: the payer's wallet would re-sign the same
    // channel off a fresh 402 and land straight back here.
    expect(refused).toMatchObject({ ok: false, reason: "wrong_channel", corrective: false });
    // Nothing was revoked, reserved, verified or paid, and the channel is
    // byte-identical to how the fund left it.
    expect(facilitator.settle).toHaveBeenCalledTimes(settleCallsBeforeDrain);
    expect(facilitator.verify).toHaveBeenCalledTimes(verifyCallsBeforeDrain);
    expect(await server.getChannel(channelId)).toEqual(funded);
    await server.stop();
  });

  it("refuses a refund payload that names its own payout", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const facilitator = new StatefulFacilitator();
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative: earnedNothing,
      config: {
        storage: new InMemoryChannelStorage(),
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [builtRequirements] = await server.buildRequirements("0");
    const requirements = builtRequirements as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"88".repeat(32)}`,
    };
    const channelId = computeChannelId(channelConfig, NETWORK);
    const refused = await server.accept({
      paymentHeader: header(
        {
          x402Version: 2,
          payload: {
            type: "refund",
            channelConfig,
            voucher: await signVoucher(payer, channelId, "0", NETWORK),
            amount: "1000000",
          },
        },
        requirements
      ),
      amount: "0",
      operation: "refund",
      expectedChannelId: channelId,
      effectId: "credit-greedy:drain-1",
      refundBoundNative: 40,
      commit: async () => "must not run",
    });
    expect(refused).toMatchObject({ ok: false, reason: "refund_amount_not_payer_chosen" });
    expect(facilitator.verify).not.toHaveBeenCalled();
    await server.stop();
  });

  it("refreshes a channel from contract views without settling or broadcasting", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const storage = new InMemoryChannelStorage();
    const facilitator = new StatefulFacilitator();
    const channelStateReader = vi.fn().mockResolvedValue({
      balance: "100",
      totalClaimed: "100",
      withdrawRequestedAt: 0,
      refundNonce: 0,
    });
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative: earnedNothing,
      channelStateReader,
      config: {
        storage,
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
        onchainStateTtlMs: 1,
      },
    });
    const [builtRequirements] = await server.buildRequirements("100");
    const requirements = builtRequirements as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"77".repeat(32)}`,
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
    await expect(
      server.accept({
        paymentHeader: header(deposit, requirements),
        amount: "100",
        operation: "fund",
        effectId: "credit-observe:fund-1",
        commit: async () => "funded",
      })
    ).resolves.toMatchObject({ ok: true });
    await storage.updateChannel(channelId, (current) =>
      current ? { ...current, onchainSyncedAt: Date.now() } : current
    );
    facilitator.balance = 1_000n;
    facilitator.totalClaimed = 0n;
    const settleCalls = facilitator.settle.mock.calls.length;

    await expect(server.observeChannel(channelId)).resolves.toMatchObject({
      balance: "100",
      totalClaimed: "100",
      withdrawRequestedAt: 0,
    });
    expect(channelStateReader).toHaveBeenCalledWith(channelId);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    expect(facilitator.settle).toHaveBeenCalledTimes(settleCalls);
    await server.stop();
  });
});

/**
 * The claim ceiling. A fund charges the whole deposit to the
 * channel — that figure is the payer's cumulative authorization and has to
 * advance once per payment — so the claim, not the charge, is what tracks
 * earnings.
 */
describe("x402 batch-settlement claim ceiling", () => {
  async function fundedChannel(earnedNative: () => Promise<number | undefined>) {
    const payer = privateKeyToAccount(generatePrivateKey());
    const receiver = privateKeyToAccount(generatePrivateKey());
    const facilitator = new StatefulFacilitator();
    const server = await createX402BatchSettlementServer({
      network: NETWORK,
      payTo: receiver.address,
      earnedNative,
      config: {
        storage: new InMemoryChannelStorage(),
        facilitatorClient: facilitator,
        receiverAuthorizerSigner: receiver,
        autoSettlement: false,
      },
    });
    const [built] = await server.buildRequirements("100");
    const requirements = built as PaymentRequirements;
    const channelConfig: Channel["channelConfig"] = {
      payer: payer.address,
      payerAuthorizer: payer.address,
      receiver: receiver.address,
      receiverAuthorizer: receiver.address,
      token: TOKEN,
      withdrawDelay: 86_400,
      salt: `0x${"99".repeat(32)}`,
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
    await expect(
      server.accept({
        paymentHeader: header(deposit, requirements),
        amount: "100",
        operation: "fund",
        effectId: "credit-ceiling:fund-1",
        commit: async () => "funded",
      })
    ).resolves.toMatchObject({ ok: true });
    expect(await server.getChannel(channelId)).toMatchObject({
      chargedCumulativeAmount: "100",
      totalClaimed: "0",
    });
    return { server, facilitator, channelId };
  }

  function claimedAmounts(facilitator: StatefulFacilitator): string[] {
    return facilitator.settle.mock.calls
      .map(([payload]) => payload.payload as unknown as { type: string; claims?: unknown[] })
      .filter((raw) => raw.type === "claim")
      .flatMap((raw) =>
        (raw.claims ?? []).map((c) => (c as { totalClaimed: string }).totalClaimed)
      );
  }

  it("claims cumulative draws, advances with them, and never claws a claim back", async () => {
    let earned = 40;
    const { server, facilitator, channelId } = await fundedChannel(() => Promise.resolve(earned));

    await server.claimAndSettle();
    // 100 is charged and authorized; 40 has been drawn. The escrow keeps the
    // rest, which is what leaves a cooperative drain something to return.
    expect(claimedAmounts(facilitator)).toEqual(["40"]);
    expect(await server.getChannel(channelId)).toMatchObject({
      chargedCumulativeAmount: "100",
      totalClaimed: "40",
    });

    earned = 100;
    await server.claimAndSettle();
    // Cumulative, not incremental: the second claim presents the running total.
    expect(claimedAmounts(facilitator)).toEqual(["40", "100"]);

    await server.claimAndSettle();
    expect(claimedAmounts(facilitator)).toEqual(["40", "100"]);

    // A ledger that reports less than the chain has already paid out is not a
    // clawback instruction — the ceiling is derived, and its floor is what has
    // been claimed.
    earned = 10;
    await server.claimAndSettle();
    expect(claimedAmounts(facilitator)).toEqual(["40", "100"]);
    expect(await server.getChannel(channelId)).toMatchObject({ totalClaimed: "100" });
    await server.stop();
  });

  it("retries a stale nothing-to-settle response after the claim lands", async () => {
    const { server, facilitator, channelId } = await fundedChannel(() => Promise.resolve(40));
    facilitator.settleNothingResponses = 1;

    await expect(server.claimAndSettle()).resolves.toBeUndefined();
    expect(await server.getChannel(channelId)).toMatchObject({ totalClaimed: "40" });
    expect(
      facilitator.settle.mock.calls.filter(
        ([payload]) => (payload.payload as unknown as { type: string }).type === "settle"
      )
    ).toHaveLength(2);
    await server.stop();
  });

  it("claims nothing for a channel whose credit has drawn nothing", async () => {
    const { server, facilitator } = await fundedChannel(earnedNothing);
    await server.claimAndSettle();
    expect(claimedAmounts(facilitator)).toEqual([]);
    await server.stop();
  });

  it("claims nothing for a channel no credit is bound to", async () => {
    const { server, facilitator } = await fundedChannel(() => Promise.resolve(undefined));
    await server.claimAndSettle();
    expect(claimedAmounts(facilitator)).toEqual([]);
    await server.stop();
  });

  it("claims nothing when the ledger read fails", async () => {
    const { server, facilitator } = await fundedChannel(() =>
      Promise.reject(new Error("ledger unreachable"))
    );
    await expect(server.claimAndSettle()).resolves.toBeUndefined();
    expect(claimedAmounts(facilitator)).toEqual([]);
    await server.stop();
  });

  it("does not read the ledger for a channel with nothing left to claim", async () => {
    const earnedNative = vi.fn(() => Promise.resolve(5_000));
    const { server, facilitator } = await fundedChannel(earnedNative);
    await server.claimAndSettle();
    expect(claimedAmounts(facilitator)).toEqual(["100"]);
    expect(earnedNative).toHaveBeenCalledTimes(1);

    // The whole authorization is claimed, so upstream would drop this channel
    // whatever the ledger says. `storage.list()` is unbounded and the selector
    // is sequential under the fleet lock, so every settled channel would
    // otherwise cost a round-trip — and warn — on every 300s cycle.
    await server.claimAndSettle();
    expect(earnedNative).toHaveBeenCalledTimes(1);
    await server.stop();
  });
});
