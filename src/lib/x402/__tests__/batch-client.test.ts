import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decodePaymentSignatureHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { BatchSettlementEvmScheme, computeChannelId } from "@x402/evm/batch-settlement/client";
import { encodeAbiParameters, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DvmError } from "../../errors";
import type { PendingX402Funding, StoredX402ChannelMetadata } from "../channel-store";
import { x402NetworkByCaip2 } from "../networks";

const viemClientMock = vi.hoisted(() => ({
  create: vi.fn(),
  actualCreate: undefined as ((...args: unknown[]) => unknown) | undefined,
  // Spied rather than replaced: the endpoint a channel is read through is the
  // load-bearing half of following one onto its own chain, and this
  // is where the resolved URL becomes observable.
  http: vi.fn(),
  actualHttp: undefined as ((...args: unknown[]) => unknown) | undefined,
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<
    Record<string, unknown> & {
      createPublicClient: (...args: unknown[]) => unknown;
      http: (...args: unknown[]) => unknown;
    }
  >();
  viemClientMock.actualCreate = actual.createPublicClient;
  viemClientMock.actualHttp = actual.http;
  return { ...actual, createPublicClient: viemClientMock.create, http: viemClientMock.http };
});

let dir: string;

/** The caller identity and credit every refund case below drains under. */
const CALLER_PUBKEY = "cc".repeat(32);
const CREDIT_ID = "credit-1";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dvm-x402-batch-client-"));
  process.env.DVM_CONFIG_DIR = dir;
  vi.resetModules();
  viemClientMock.create.mockImplementation((...args: unknown[]) =>
    viemClientMock.actualCreate?.(...args)
  );
  viemClientMock.http.mockImplementation((...args: unknown[]) =>
    viemClientMock.actualHttp?.(...args)
  );
});

afterEach(() => {
  delete process.env.DVM_CONFIG_DIR;
  delete process.env.DVM_X402_RPC_URL;
  rmSync(dir, { recursive: true, force: true });
});

describe("x402 batch client", () => {
  it("labels the wallet chain when the DVM offers no matching batch requirement", async () => {
    const key = `0x${"11".repeat(32)}` as `0x${string}`;
    const account = privateKeyToAccount(key);
    const batch = await import("../batch-client");

    await expect(
      batch.createX402BatchPayment({
        wallet: { privateKey: key, address: account.address, network: "eip155:84532" },
        paymentRequired: {
          x402Version: 2,
          resource: { url: "https://dvm.example/v1/credit" },
          accepts: [],
        },
        endpoint: "https://dvm.example",
        callerPubkey: "aa".repeat(32),
        creditId: "credit-no-batch",
        depositMicro: 200_000,
      })
    ).rejects.toMatchObject({
      code: "x402_batch_not_offered",
      message: expect.stringContaining("Base Sepolia (eip155:84532)"),
      hint: expect.stringContaining("Base Sepolia (eip155:84532)"),
    });
  });

  it("keeps the acknowledged association while another scope constructs a voucher", async () => {
    const { key, account, network, channelId, required, record } = await refundFixture();
    const ownerCaller = "aa".repeat(32);
    record({
      endpoint: "https://owner.example",
      callerPubkey: ownerCaller,
      creditId: "credit-a",
    });
    const batch = await import("../batch-client");
    const store = await import("../channel-store");
    await new store.DvmX402ChannelStorage().set(channelId, {
      balance: "0",
      totalClaimed: "0",
      chargedCumulativeAmount: "0",
    });
    const fundingRequired = {
      ...required,
      accepts: required.accepts.map((accepted) => ({ ...accepted, amount: "200000" })),
    };

    const payment = await batch.createX402BatchPayment({
      wallet: { privateKey: key, address: account.address, network },
      paymentRequired: fundingRequired,
      endpoint: "https://attempt.example",
      callerPubkey: CALLER_PUBKEY,
      creditId: "credit-b",
      depositMicro: 200_000,
    });

    expect(payment).toMatchObject({ channelId, maxClaimableMicro: "200000" });
    expect(store.findX402Channel({ channelId })).toMatchObject({
      endpoint: "https://owner.example",
      callerPubkey: ownerCaller,
      creditId: "credit-a",
    });
    expect(store.listX402Channels()[0]).toMatchObject({
      endpoint: "https://owner.example",
      callerPubkey: ownerCaller,
      creditId: "credit-a",
    });
    expect(store.findX402Channel({ creditId: "credit-b" })).toBeUndefined();
  });

  for (const failure of [new Error("unexpected gate failure"), { code: "x402_voucher_pending" }]) {
    it(`preserves an unexpected gate ${failure instanceof Error ? "error" : "malformed refusal"} unchanged`, async () => {
      const { key, account, network, required } = await refundFixture();
      const gate = await import("../voucher-pending");
      vi.spyOn(gate, "assertNoRivalX402Voucher").mockImplementationOnce(() => { throw failure; });
      const batch = await import("../batch-client");
      await expect(batch.createX402BatchPayment({
        wallet: { privateKey: key, address: account.address, network },
        paymentRequired: required,
        endpoint: "https://example.com",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 200_000,
      })).rejects.toBe(failure);
    });
  }

  it("proves an expired ERC-3009 deposit unused on the journalled token and network", async () => {
    const key = `0x${"11".repeat(32)}` as `0x${string}`;
    const account = privateKeyToAccount(key);
    const network = "eip155:84532";
    const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
    const receiver = `0x${"22".repeat(20)}` as `0x${string}`;
    const receiverAuthorizer = `0x${"33".repeat(20)}` as `0x${string}`;
    const config = {
      payer: account.address,
      payerAuthorizer: account.address,
      receiver,
      receiverAuthorizer,
      token,
      withdrawDelay: 86_400,
      salt: keccak256(toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`)),
    };
    const channelId = computeChannelId(config, network);
    const store = await import("../channel-store");
    await new store.DvmX402ChannelStorage().set(channelId, {
      balance: "0",
      totalClaimed: "0",
      chargedCumulativeAmount: "0",
    });
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://dvm.example/v1/credit" },
      accepts: [
        {
          scheme: "batch-settlement",
          network,
          asset: token,
          amount: "200000",
          payTo: receiver,
          maxTimeoutSeconds: 60,
          extra: {
            receiverAuthorizer,
            withdrawDelay: 86_400,
            name: "x402 Batch Settlement",
            version: "1",
            assetTransferMethod: "eip3009",
          },
        },
      ],
    };
    const batch = await import("../batch-client");
    const signed = await batch.createX402BatchPayment({
      wallet: { privateKey: key, address: account.address, network },
      paymentRequired: required,
      endpoint: "https://dvm.example",
      callerPubkey: "aa".repeat(32),
      creditId: "credit-expiry",
      depositMicro: 200_000,
    });
    const decoded = decodePaymentSignatureHeader(signed.paymentHeader);
    const payload = decoded.payload as {
      deposit: { authorization: { erc3009Authorization: { salt: string } } };
      voucher: { channelId: `0x${string}` };
    };
    const expectedNonce = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }],
        [payload.voucher.channelId, BigInt(payload.deposit.authorization.erc3009Authorization.salt)]
      )
    );
    const activeHeader = encodePaymentSignatureHeader(decoded);
    viemClientMock.create.mockClear();
    await expect(
      batch.canReplaceExpiredX402Deposit({
        wallet: { privateKey: key, address: account.address, network },
        paymentHeader: activeHeader,
        nowSeconds: 1,
      })
    ).resolves.toBe(false);
    expect(viemClientMock.create).not.toHaveBeenCalled();

    const expiredHeader = encodePaymentSignatureHeader({
      ...decoded,
      payload: {
        ...decoded.payload,
        deposit: {
          ...(decoded.payload as { deposit: object }).deposit,
          authorization: {
            erc3009Authorization: {
              ...payload.deposit.authorization.erc3009Authorization,
              validBefore: "10",
            },
          },
        },
      },
    });
    const readContract = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    viemClientMock.create.mockReturnValue({ readContract });
    const wallet = { privateKey: key, address: account.address, network };
    await expect(
      batch.canReplaceExpiredX402Deposit({ wallet, paymentHeader: expiredHeader, nowSeconds: 11 })
    ).resolves.toBe(true);
    await expect(
      batch.canReplaceExpiredX402Deposit({ wallet, paymentHeader: expiredHeader, nowSeconds: 11 })
    ).resolves.toBe(false);

    expect(viemClientMock.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ chain: expect.objectContaining({ id: 84_532 }) })
    );
    expect(readContract).toHaveBeenCalledTimes(2);
    expect(readContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: token,
        functionName: "authorizationState",
        args: [account.address, expectedNonce],
      })
    );
  });

  // The chain here comes from the journalled authorization rather than today's
  // pin, so this read spans chains exactly as the drain does — and takes the
  // same endpoint scoping. USDC sits at its own address on each
  // chain, so a wrong-chain read asks a contract that is not USDC at all.
  it("keeps DVM_X402_RPC_URL on the pinned chain when a deposit is journalled off it", async () => {
    const { key, account, channelId, required } = await refundFixture("eip155:8453");
    const store = await import("../channel-store");
    await new store.DvmX402ChannelStorage().set(channelId, {
      balance: "0",
      totalClaimed: "0",
      chargedCumulativeAmount: "0",
    });
    const batch = await import("../batch-client");
    const signed = await batch.createX402BatchPayment({
      wallet: { privateKey: key, address: account.address, network: "eip155:8453" },
      paymentRequired: { ...required, accepts: [{ ...required.accepts[0], amount: "200000" }] },
      endpoint: "https://dvm.example",
      callerPubkey: CALLER_PUBKEY,
      creditId: "credit-expiry-offpin",
      depositMicro: 200_000,
    });
    const decoded = decodePaymentSignatureHeader(signed.paymentHeader);
    const payload = decoded.payload as {
      deposit: { authorization: { erc3009Authorization: { salt: string } } };
    };
    const expiredHeader = encodePaymentSignatureHeader({
      ...decoded,
      payload: {
        ...decoded.payload,
        deposit: {
          ...(decoded.payload as { deposit: object }).deposit,
          authorization: {
            erc3009Authorization: {
              ...payload.deposit.authorization.erc3009Authorization,
              validBefore: "10",
            },
          },
        },
      },
    });

    process.env.DVM_X402_RPC_URL = "https://override.example/rpc";
    viemClientMock.http.mockClear();
    viemClientMock.create.mockReturnValue({ readContract: vi.fn().mockResolvedValue(false) });

    // The wallet has since re-pinned to Base Sepolia; the authorization has not.
    await expect(
      batch.canReplaceExpiredX402Deposit({
        wallet: { privateKey: key, address: account.address, network: "eip155:84532" },
        paymentHeader: expiredHeader,
        nowSeconds: 11,
      })
    ).resolves.toBe(true);

    expect(viemClientMock.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ chain: expect.objectContaining({ id: 8453 }) })
    );
    expect(viemClientMock.http).toHaveBeenCalledWith(chains.base.rpcUrls.default.http[0]);
    expect(viemClientMock.http).not.toHaveBeenCalledWith("https://override.example/rpc");
  });

  it("uses the caller policy size instead of upstream's 5x deposit default", async () => {
    const key = `0x${"11".repeat(32)}` as `0x${string}`;
    const account = privateKeyToAccount(key);
    const network = "eip155:84532";
    const receiver = `0x${"22".repeat(20)}` as `0x${string}`;
    const receiverAuthorizer = `0x${"33".repeat(20)}` as `0x${string}`;
    const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
    const salt = keccak256(
      toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`)
    );
    const config = {
      payer: account.address,
      payerAuthorizer: account.address,
      receiver,
      receiverAuthorizer,
      token,
      withdrawDelay: 86_400,
      salt,
    };
    const channelId = computeChannelId(config, network);
    const store = await import("../channel-store");
    await new store.DvmX402ChannelStorage().set(channelId, {
      balance: "0",
      totalClaimed: "0",
      chargedCumulativeAmount: "0",
    });
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://dvm.example/v1/credit" },
      accepts: [
        {
          scheme: "batch-settlement",
          network,
          asset: token,
          amount: "200000",
          payTo: receiver,
          maxTimeoutSeconds: 60,
          extra: {
            receiverAuthorizer,
            withdrawDelay: 86_400,
            name: "x402 Batch Settlement",
            version: "1",
            assetTransferMethod: "eip3009",
          },
        },
      ],
    };
    const batch = await import("../batch-client");
    const payment = await batch.createX402BatchPayment({
      wallet: { privateKey: key, address: account.address, network },
      paymentRequired: required,
      endpoint: "https://dvm.example",
      callerPubkey: "aa".repeat(32),
      creditId: "credit-1",
      depositMicro: 200_000,
    });
    const decoded = decodePaymentSignatureHeader(payment.paymentHeader);
    expect(decoded.payload).toMatchObject({
      type: "deposit",
      deposit: { amount: "200000" },
      voucher: { channelId, maxClaimableAmount: "200000" },
    });
    expect(store.findX402Channel({ channelId })).toMatchObject({
      endpoint: "https://dvm.example",
      creditId: "credit-1",
      config,
    });

    const response = encodePaymentResponseHeader({
      success: true,
      transaction: "0xsettled",
      network,
      payer: account.address,
      extra: {
        channelState: {
          channelId,
          balance: "200000",
          totalClaimed: "0",
          chargedCumulativeAmount: "200000",
        },
      },
    });
    await batch.processX402BatchResponse(payment.scheme, response);
    await expect(new store.DvmX402ChannelStorage().get(channelId)).resolves.toMatchObject({
      balance: "200000",
      chargedCumulativeAmount: "200000",
    });
    expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeGreaterThan(0);
    await batch.acknowledgeReplayedX402Payment(payment.paymentHeader);
    await expect(new store.DvmX402ChannelStorage().get(channelId)).resolves.toMatchObject({
      balance: "200000",
      chargedCumulativeAmount: "200000",
    });
    // The idempotent replay observes no chain fact, so the DVM-reported marker
    // survives until a general `channels()` reconciliation.
    expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeGreaterThan(0);
  });

  it("blocks even the credit that owns a refused voucher, until its deposit expires", async () => {
    const key = `0x${"11".repeat(32)}` as `0x${string}`;
    const account = privateKeyToAccount(key);
    const network = "eip155:84532";
    const receiver = `0x${"22".repeat(20)}` as const;
    const receiverAuthorizer = `0x${"33".repeat(20)}` as const;
    const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
    const config = {
      payer: account.address,
      payerAuthorizer: account.address,
      receiver,
      receiverAuthorizer,
      token,
      withdrawDelay: 86_400,
      salt: keccak256(toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`)),
    };
    const channelId = computeChannelId(config, network);
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://dvm.example/v1/credit" },
      accepts: [
        {
          scheme: "batch-settlement",
          network,
          asset: token,
          amount: "200000",
          payTo: receiver,
          maxTimeoutSeconds: 60,
          extra: {
            receiverAuthorizer,
            withdrawDelay: 86_400,
            name: "x402 Batch Settlement",
            version: "1",
            assetTransferMethod: "eip3009",
          },
        },
      ],
    };
    const store = await import("../channel-store");
    await new store.DvmX402ChannelStorage().set(channelId, {
      balance: "0",
      totalClaimed: "0",
      chargedCumulativeAmount: "0",
    });
    const batch = await import("../batch-client");
    const sign = () =>
      batch.createX402BatchPayment({
        wallet: { privateKey: key, address: account.address, network },
        paymentRequired: required,
        endpoint: "https://dvm.example",
        callerPubkey: "aa".repeat(32),
        creditId: "credit-1",
        depositMicro: 200_000,
      });

    const refused = {
      endpoint: "https://dvm.example",
      callerPubkey: "aa".repeat(32),
      creditId: "credit-1",
      fundId: "fund-refused",
      amountMicro: 200_000,
      targetMicro: 200_000,
      paymentHeader: "refused-header",
      channelId,
      requestedAt: Date.now(),
      maxClaimableMicro: "200000",
      authorizationValidBefore: String(Math.floor(Date.now() / 1000) + 600),
    };
    store.recordPendingX402Funding(refused);
    store.retirePendingX402Funding(refused);

    const journalBefore = readFileSync(join(dir, "x402-channels.json"), "utf8");
    await expect(sign()).rejects.toMatchObject({
      code: "x402_voucher_pending",
      hint: expect.stringContaining("Fund again after"),
      data: expect.objectContaining({ refused: true, credit_id: "credit-1" }),
    });
    expect(readFileSync(join(dir, "x402-channels.json"), "utf8")).toBe(journalBefore);

    // Once the authorization can no longer be submitted there is no second
    // deposit to prevent, and the block lifts with no caller action at all.
    store.clearPendingX402Funding({ ...refused, refusedAt: 1 });
    store.recordPendingX402Funding({ ...refused, authorizationValidBefore: "1000" });
    store.retirePendingX402Funding({ ...refused, authorizationValidBefore: "1000" });
    await expect(sign()).resolves.toMatchObject({ channelId });
  });

  it("refuses a live rival before chain reconciliation or signing another deposit", async () => {
    const { key, account, network, channelId, required } = await refundFixture();
    const wallet = { privateKey: key, address: account.address, network };
    const { pending } = await refusedDeposit(channelId, wallet);
    const store = await import("../channel-store");
    const batch = await import("../batch-client");
    store.recordPendingX402Funding({
      ...pending,
      creditId: "credit-rival",
      fundId: "fund-rival",
      endpoint: "https://other.example.com",
    });
    const chainRead = vi.fn(async () => { throw new Error("chain must not be read before refusal"); });
    viemClientMock.create.mockImplementation((...args: unknown[]) => ({
      ...(viemClientMock.actualCreate?.(...args) as object), readContract: chainRead,
    }));
    const signPayload = vi.spyOn(BatchSettlementEvmScheme.prototype, "createPaymentPayload");
    const before = readFileSync(join(dir, "x402-channels.json"), "utf8");

    await expect(batch.createX402BatchPayment({
      wallet, paymentRequired: required, endpoint: "https://example.com",
      callerPubkey: CALLER_PUBKEY, creditId: CREDIT_ID, depositMicro: 200_000,
    })).rejects.toMatchObject({
      code: "x402_voucher_pending",
      data: { credit_id: "credit-rival", fund_id: "fund-rival", channel_id: channelId },
    });
    expect(chainRead).not.toHaveBeenCalled();
    expect(signPayload).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "x402-channels.json"), "utf8")).toBe(before);
  });

  it("probes a refund at the contract floor and never names its own payout", async () => {
    const key = `0x${"11".repeat(32)}` as `0x${string}`;
    const account = privateKeyToAccount(key);
    const network = "eip155:84532";
    const receiver = `0x${"22".repeat(20)}` as const;
    const receiverAuthorizer = `0x${"33".repeat(20)}` as const;
    const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
    const config = {
      payer: account.address,
      payerAuthorizer: account.address,
      receiver,
      receiverAuthorizer,
      token,
      withdrawDelay: 86_400,
      salt: keccak256(toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`)),
    };
    const channelId = computeChannelId(config, network);
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://dvm.example/v1/credit" },
      accepts: [
        {
          scheme: "batch-settlement",
          network,
          asset: token,
          amount: "0",
          payTo: receiver,
          maxTimeoutSeconds: 60,
          extra: {
            receiverAuthorizer,
            withdrawDelay: 86_400,
            name: "x402 Batch Settlement",
            version: "1",
            assetTransferMethod: "eip3009",
          },
        },
      ],
    };
    const store = await import("../channel-store");
    await new store.DvmX402ChannelStorage().set(channelId, {
      balance: "200000",
      totalClaimed: "0",
      chargedCumulativeAmount: "200000",
      signedMaxClaimable: "200000",
      signature: `0x${"44".repeat(65)}`,
    });
    const readContract = vi.fn().mockResolvedValue([200_000n, 0n]);
    viemClientMock.create.mockReturnValue({ readContract });
    const paymentResponse = encodePaymentResponseHeader({
      success: true,
      transaction: "0xrefund",
      network,
      payer: account.address,
      amount: "200000",
      extra: {
        channelState: {
          channelId,
          balance: "0",
          totalClaimed: "0",
          chargedCumulativeAmount: "0",
          withdrawRequestedAt: 0,
          refundNonce: "1",
        },
      },
    });
    const drained = {
      op: "drain" as const,
      drain: {
        drain_id: "drain-1",
        credit_id: "credit-1",
        method: "x402" as const,
        status: "sent" as const,
        amount_micro: 200_000,
        currency: "usd",
        ledger_seq: 2,
        created_at: 1,
        receipts: [],
      },
      x402PaymentResponse: paymentResponse,
    };
    const posted: string[] = [];
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new (await import("../../errors")).DvmError(
          "payment_required",
          "Refund approval required.",
          undefined,
          { x402_payment_required: required }
        )
      )
      .mockImplementationOnce((paymentHeader?: string) => {
        if (paymentHeader) posted.push(paymentHeader);
        return Promise.resolve(drained);
      });
    const batch = await import("../batch-client");

    await expect(
      batch.refundX402BatchChannel({
        wallet: { privateKey: key, address: account.address, network },
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 200_000,
        post,
      })
    ).resolves.toMatchObject({ result: drained });

    expect(readContract).toHaveBeenCalledOnce();
    const refund = decodePaymentSignatureHeader(posted[0] ?? "");
    expect(refund.payload).toMatchObject({
      type: "refund",
      voucher: { channelId, maxClaimableAmount: "0" },
    });
    // The payout is the DVM's to size against the credit it owes. Upstream
    // honours a payer-supplied `amount` verbatim, so naming one here would put
    // the figure back under the payer's control.
    expect(refund.payload).not.toHaveProperty("amount");
  });

  it("re-signs the refund at the base a corrective 402 names", async () => {
    const key = `0x${"11".repeat(32)}` as `0x${string}`;
    const account = privateKeyToAccount(key);
    const network = "eip155:84532";
    const receiver = `0x${"22".repeat(20)}` as const;
    const receiverAuthorizer = `0x${"33".repeat(20)}` as const;
    const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
    const config = {
      payer: account.address,
      payerAuthorizer: account.address,
      receiver,
      receiverAuthorizer,
      token,
      withdrawDelay: 86_400,
      salt: keccak256(toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`)),
    };
    const channelId = computeChannelId(config, network);
    const accepts = (extra: Record<string, unknown>) => [
      {
        scheme: "batch-settlement" as const,
        network: network as `${string}:${string}`,
        asset: token,
        amount: "0",
        payTo: receiver,
        maxTimeoutSeconds: 60,
        extra: {
          receiverAuthorizer,
          withdrawDelay: 86_400,
          name: "x402 Batch Settlement",
          version: "1",
          assetTransferMethod: "eip3009",
          ...extra,
        },
      },
    ];
    const required: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://dvm.example/v1/credit" },
      accepts: accepts({}),
    };
    const store = await import("../channel-store");
    const { signVoucher } = await import("@x402/evm/batch-settlement/client");
    // The DVM holds the payer's deposit voucher for the whole 200 000 and has
    // derived a refund base of 120 000 from its own ledger — 80 000 unspent.
    const depositVoucher = await signVoucher(account, channelId, "200000", network);
    await new store.DvmX402ChannelStorage().set(channelId, {
      balance: "200000",
      totalClaimed: "0",
      chargedCumulativeAmount: "200000",
      signedMaxClaimable: "200000",
      signature: depositVoucher.signature,
    });
    viemClientMock.create.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
    });
    const { DvmError } = await import("../../errors");
    const corrective: PaymentRequired = {
      x402Version: 2,
      // The scheme's own code, verbatim. Wrapping it in prose is invisible
      // here and fatal in production: upstream string-compares it before it
      // will resync, so the drain would fail on attempt 1.
      error: "invalid_batch_settlement_evm_cumulative_amount_mismatch",
      resource: { url: "https://dvm.example/v1/credit" },
      accepts: accepts({
        channelState: { chargedCumulativeAmount: "120000" },
        voucherState: {
          signedMaxClaimable: "200000",
          signature: depositVoucher.signature,
        },
      }),
    };
    const drained = {
      op: "drain" as const,
      drain: {
        drain_id: "drain-1",
        credit_id: "credit-1",
        method: "x402" as const,
        status: "sent" as const,
        amount_micro: 80_000,
        currency: "usd",
        ledger_seq: 2,
        created_at: 1,
        receipts: [],
      },
      x402PaymentResponse: encodePaymentResponseHeader({
        success: true,
        transaction: "0xrefund",
        network,
        payer: account.address,
        amount: "80000",
      }),
    };
    const posted: string[] = [];
    const post = vi.fn().mockImplementation((paymentHeader?: string) => {
      if (!paymentHeader) {
        return Promise.reject(
          new DvmError("payment_required", "Refund approval required.", undefined, {
            x402_payment_required: required,
          })
        );
      }
      posted.push(paymentHeader);
      if (posted.length === 1) {
        return Promise.reject(
          new DvmError("payment_invalid", "x402 cooperative refund refused.", undefined, {
            x402_payment_required: corrective,
          })
        );
      }
      return Promise.resolve(drained);
    });
    const batch = await import("../batch-client");

    await expect(
      batch.refundX402BatchChannel({
        wallet: { privateKey: key, address: account.address, network },
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 200_000,
        post,
      })
    ).resolves.toMatchObject({ result: drained });

    expect(posted).toHaveLength(2);
    expect(decodePaymentSignatureHeader(posted[0] ?? "").payload).toMatchObject({
      voucher: { maxClaimableAmount: "0" },
    });
    // The retry adopts the DVM's base, so upstream's settle-side check
    // (`voucher.maxClaimableAmount === chargedCumulativeAmount`) passes and the
    // payout is `balance − 120 000` — the 80 000 the caller had not spent.
    expect(decodePaymentSignatureHeader(posted[1] ?? "").payload).toMatchObject({
      type: "refund",
      voucher: { channelId, maxClaimableAmount: "120000" },
    });
  });

  // viem writes its own `URL:` line into the message, and
  // the providers a caller reaches for put the API key in the path. `data`
  // matters as much as the message — `handleError` spreads it to the top level
  // of the JSON error, so `cause` is a second, independent copy.
  it("redacts the drain's endpoint out of a failed chain read, key and all", async () => {
    const apiKey = "0123456789abcdef0123";
    const { key, network, required } = await refundFixture();
    viemClientMock.create.mockReturnValue({
      readContract: vi
        .fn()
        .mockRejectedValue(
          new Error(`fetch failed\n URL: https://base-sepolia.example/v3/${apiKey}`)
        ),
    });
    const { DvmError } = await import("../../errors");
    const batch = await import("../batch-client");

    const err = (await batch
      .refundX402BatchChannel({
        wallet: { privateKey: key, address: "", network },
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 1,
        post: vi.fn().mockRejectedValue(
          new DvmError("payment_required", "Refund approval required.", undefined, {
            x402_payment_required: required,
          })
        ),
      })
      .catch((e: unknown) => e)) as DvmError;

    expect(err.code).toBe("x402_refund_failed");
    expect(err.message).not.toContain(apiKey);
    expect(err.data?.cause).toBeDefined();
    expect(err.data?.cause).not.toContain(apiKey);
    expect(err.message).toContain("base-sepolia.example");
    expect(err.display).toContain("funds remain in the channel");
    expect(err.hint).toContain("x402-withdraw-initiate");
  });

  it("preserves the DVM's reconciliation reason and relay copy", async () => {
    const { account, channelId, key, network, required } = await refundFixture();
    const store = await import("../channel-store");
    writeFileSync(
      join(dir, "x402-channels.json"),
      `${JSON.stringify(
        {
          version: 1,
          channels: {
            [channelId]: {
              context: {
                balance: "200000",
                totalClaimed: "0",
                chargedCumulativeAmount: "200000",
              },
            },
          },
          pending: [],
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    const storage = new store.DvmX402ChannelStorage();
    await expect(storage.getAcknowledgedCumulativeAmount(channelId)).resolves.toBe("200000");
    viemClientMock.create.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
    });
    const { DvmError } = await import("../../errors");
    const corrective: PaymentRequired = { ...required, error: "chain_unreachable" };
    const post = vi.fn((paymentHeader?: string) =>
      Promise.reject(
        paymentHeader
          ? new DvmError(
              "chain_unreachable",
              "x402 cooperative refund refused: chain_unreachable",
              "Do not re-sign repeatedly; contact the service operator.",
              { x402_payment_required: corrective },
              "The service cannot reach its chain endpoint. This is not a failure of your payment."
            )
          : new DvmError("payment_required", "Refund approval required.", undefined, {
              x402_payment_required: required,
            })
      )
    );
    const batch = await import("../batch-client");

    await expect(
      batch.refundX402BatchChannel({
        wallet: { privateKey: key, address: account.address, network },
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 200_000,
        post,
      })
    ).rejects.toMatchObject({
      code: "chain_unreachable",
      display: expect.stringContaining("not a failure of your payment"),
      hint: expect.stringContaining("Do not re-sign repeatedly"),
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(decodePaymentSignatureHeader(post.mock.calls[1]?.[0] ?? "").payload).toMatchObject({
      type: "refund",
      voucher: { channelId, maxClaimableAmount: "0" },
    });
    await expect(storage.get(channelId)).resolves.toMatchObject({
      chargedCumulativeAmount: "0",
    });
    await expect(storage.getAcknowledgedCumulativeAmount(channelId)).resolves.toBe("200000");
    // The corrective write came directly from `channels()`. A later failed
    // retry must not retroactively label that observation as DVM-reported.
    expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeUndefined();
  });

  it.each(["written_off", "pending_draws", "wrong_channel", "short_payout"] as const)(
    "preserves the DVM's terminal %s refusal and recovery metadata",
    async (kind) => {
      const { account, key, network, required, channelId } = await refundFixture();
      viemClientMock.create.mockReturnValue({
        readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
      });
      const { DvmError } = await import("../../errors");
      const refusals = {
        written_off: new DvmError(
          "drain_conflict",
          "x402 cooperative refund refused: settlement_written_off. Drain drain-1 on credit credit-1 was closed by the operator without booking.",
          "Reclaim it again with 'dvm credit drain <dvm>'",
          { retryable: false, drain_id_retired: true },
          "The service closed this refund attempt without paying it. Your balance is still here."
        ),
        pending_draws: new DvmError(
          "drain_conflict",
          "x402 channel refund requires all pending credit draws to finish first",
          "Wait for every running job on this credit to finish, then retry with a fresh drain_id.",
          {
            retryable: true,
            drain_registered: false,
            display:
              "A job is still running against this prepaid balance, so the refund was not started. Nothing was charged and nothing changed.",
          }
        ),
        wrong_channel: new DvmError(
          "drain_conflict",
          `credit ${CREDIT_ID} is bound to x402 channel ${channelId}, and the refund voucher presented was signed for a different channel`,
          `Re-sign the refund requirement for channel ${channelId} — the one this credit was funded through — and resubmit. The same drain_id still works.`,
          { retryable: false, drain_registered: false, credit_channel_id: channelId },
          "That refund approval was signed for a different payment channel than the one holding this prepaid balance."
        ),
        short_payout: new DvmError(
          "drain_conflict",
          "x402 refund settled 199000 for a drain requiring at least 200000",
          `Report drain drain-short on credit ${CREDIT_ID} to the service operator — only they can reconcile the difference. Retrying this drain, or requesting a new drain_id, lands here again.`,
          { retryable: false, drain_registered: true },
          "The refund reached the chain, but it paid less than the balance this service had recorded, so nothing was booked here."
        ),
      };
      const refusal = refusals[kind];
      const expected = {
        code: refusal.code,
        message: refusal.message,
        hint: refusal.hint,
        data: structuredClone(refusal.data),
        display: refusal.display,
      };
      const post = vi.fn((paymentHeader?: string) =>
        Promise.reject(
          paymentHeader
            ? refusal
            : new DvmError("payment_required", "Refund approval required.", undefined, {
                x402_payment_required: required,
              })
        )
      );
      const batch = await import("../batch-client");
      const err = await catchRefusal(
        batch.refundX402BatchChannel({
          wallet: { privateKey: key, address: account.address, network },
          endpoint: "https://dvm.example",
          callerPubkey: CALLER_PUBKEY,
          creditId: CREDIT_ID,
          depositMicro: 200_000,
          post,
        })
      );
      expect(err).toBe(refusal);
      expect({
        code: err.code,
        message: err.message,
        hint: err.hint,
        data: err.data,
        display: err.display,
      }).toEqual(expected);
      expect(err.hint).not.toContain("x402-withdraw-initiate");
      expect(post).toHaveBeenCalledTimes(2);
    }
  );

  it("still points at the timed exit when the drain never reached the DVM", async () => {
    const { account, key, network, required } = await refundFixture();
    viemClientMock.create.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
    });
    const { DvmError } = await import("../../errors");
    const batch = await import("../batch-client");
    const clientOwned = [
      new DvmError(
        "provider_unreachable",
        "Could not reach https://dvm.example/v1/credit: socket hang up",
        "The provider may be down or unreachable from this network. Retry once it is back."
      ),
      new DvmError("provider_error", "Credit operation failed (502): <html>bad gateway</html>"),
    ];

    for (const failure of clientOwned) {
      const err = await catchRefusal(
        batch.refundX402BatchChannel({
          wallet: { privateKey: key, address: account.address, network },
          endpoint: "https://dvm.example",
          callerPubkey: CALLER_PUBKEY,
          creditId: CREDIT_ID,
          depositMicro: 200_000,
          post: vi.fn((paymentHeader?: string) =>
            Promise.reject(
              paymentHeader
                ? failure
                : new DvmError("payment_required", "Refund approval required.", undefined, {
                    x402_payment_required: required,
                  })
            )
          ),
        })
      );

      expect(err.code).toBe("x402_refund_failed");
      expect(err.hint).toContain("x402-withdraw-initiate");
      expect(err.display).toContain("funds remain in the channel");
    }
  });

  it("never reports a challenge-carrying refusal as the drain's own answer", async () => {
    // The invariant a plausible edit inverts: a 402 with fresh requirements is
    // an instruction to re-sign, which upstream's scheme is about to follow, so
    // it is never the terminal answer — even though the wire carries the same
    // `retryable` marker every structured refusal does. A DVM that keeps asking
    // for a signature it then ignores exhausts the retry budget, and that is a
    // client-side dead end rather than something to relay as `payment_required`.
    const { account, key, network, required } = await refundFixture();
    viemClientMock.create.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
    });
    const { DvmError } = await import("../../errors");
    const post = vi.fn(() =>
      Promise.reject(
        new DvmError("payment_required", "Refund approval required.", "Re-sign and resubmit.", {
          retryable: true,
          x402_payment_required: required,
        })
      )
    );
    const batch = await import("../batch-client");

    const err = await catchRefusal(
      batch.refundX402BatchChannel({
        wallet: { privateKey: key, address: account.address, network },
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 200_000,
        post,
      })
    );

    expect(err.code).toBe("x402_refund_failed");
    expect(err.hint).toContain("x402-withdraw-initiate");
  });

  it("polls an already-sent cooperative drain without minting another refund voucher", async () => {
    const batch = await import("../batch-client");
    const replay = {
      op: "drain" as const,
      drain: {
        drain_id: "drain-1",
        credit_id: "credit-1",
        method: "x402",
        status: "sent",
        amount_micro: 20_000,
        currency: "usd",
        ledger_seq: 2,
        created_at: 1,
        receipts: [],
      },
    };
    const post = vi.fn(() => Promise.resolve(replay));
    await expect(
      batch.refundX402BatchChannel({
        wallet: {
          privateKey: `0x${"11".repeat(32)}`,
          address: "",
          network: "eip155:84532",
        },
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 1,
        post,
      })
    ).resolves.toMatchObject({ result: replay });
    expect(post).toHaveBeenCalledTimes(1);
  });

  // The same already-sent drain, reached one post later: the flip
  // happens between the header-less probe above and the signed post, which a
  // concurrent operator repair can do. The DVM answers from a path that books no
  // fresh settlement, so nothing sets `PAYMENT-RESPONSE` and upstream calls the
  // 200 fatal — which used to surface as `x402_refund_failed`, telling the caller
  // their money was still in a channel it had already left and pointing them at
  // the 24-hour on-chain exit for it.
  it("reports the drain the DVM recorded when upstream rejects the response envelope", async () => {
    const { channelId, network, key, account, required, journal } = await refundFixture();
    // A real reservation, so the report is the chain and journal read rather
    // than the zeros the settled-replay path returns without reading either.
    journal({ maxClaimableMicro: "200000" });
    viemClientMock.create.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
    });
    const { DvmError } = await import("../../errors");
    const settled = refundResponse({
      channelId,
      network,
      payer: account.address,
      amount: "200000",
    });
    const headerless = { op: settled.op, drain: settled.drain };
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Refund approval required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockResolvedValueOnce(headerless);
    const batch = await import("../batch-client");

    const outcome = await batch.refundX402BatchChannel({
      wallet: { privateKey: key, address: account.address, network },
      endpoint: "https://dvm.example",
      callerPubkey: CALLER_PUBKEY,
      creditId: CREDIT_ID,
      depositMicro: 200_000,
      post,
    });

    expect(outcome).toMatchObject({
      result: headerless,
      paymentResponse: "",
      atRiskMicro: 200_000n,
    });
    expect(outcome.pendingFundings).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(decodePaymentSignatureHeader(post.mock.calls[1]?.[0] ?? "").payload).toMatchObject({
      type: "refund",
      voucher: { channelId, maxClaimableAmount: "0" },
    });
  });

  // The outstanding voucher is already signed and never expires, so
  // refusing revokes nothing. Proceed at the acknowledged base and report the
  // whole ordinary stuck-funding exposure instead.
  it("drains when an outstanding voucher puts the whole channel balance at risk", async () => {
    const { channelId, network, key, account, required, journal } = await refundFixture();
    journal({ maxClaimableMicro: "200000" });
    viemClientMock.create.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
    });
    const { DvmError } = await import("../../errors");
    const drained = refundResponse({
      channelId,
      network,
      payer: account.address,
      amount: "200000",
    });
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Refund approval required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockResolvedValueOnce(drained);
    const batch = await import("../batch-client");

    const outcome = await batch.refundX402BatchChannel({
      wallet: { privateKey: key, address: account.address, network },
      endpoint: "https://dvm.example",
      callerPubkey: CALLER_PUBKEY,
      creditId: CREDIT_ID,
      depositMicro: 200_000,
      post,
    });

    expect(outcome).toMatchObject({ result: drained, atRiskMicro: 200_000n });
    expect(outcome.pendingFundings).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(2);
    expect(decodePaymentSignatureHeader(post.mock.calls[1]?.[0] ?? "").payload).toMatchObject({
      type: "refund",
      voucher: { channelId, maxClaimableAmount: "0" },
    });
  });

  // The mirror of the timed exit's rule: an authorization nobody can read is
  // the one case where guessing low signs away money someone else may take.
  it("reports the whole balance at risk and proceeds when a voucher cannot be read", async () => {
    const { channelId, network, key, account, required, journal } = await refundFixture();
    journal({ paymentHeader: "not-a-decodable-header" });
    viemClientMock.create.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
    });
    const { DvmError } = await import("../../errors");
    const batch = await import("../batch-client");
    const drained = refundResponse({
      channelId,
      network,
      payer: account.address,
      amount: "200000",
    });
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Refund approval required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockResolvedValueOnce(drained);

    const outcome = await batch.refundX402BatchChannel({
      wallet: { privateKey: key, address: account.address, network },
      endpoint: "https://dvm.example",
      callerPubkey: CALLER_PUBKEY,
      creditId: CREDIT_ID,
      depositMicro: 200_000,
      post,
    });

    // The reservation is uint128-max internally; what reaches the caller — and
    // whatever agent relays it — has to be the balance actually at risk.
    expect(outcome).toMatchObject({ result: drained, atRiskMicro: 200_000n });
  });

  it("drains what an outstanding voucher leaves, and reports the reservation", async () => {
    const { channelId, network, key, account, required, journal } = await refundFixture();
    journal({ maxClaimableMicro: "200000" });
    viemClientMock.create.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([500_000n, 0n]),
    });
    const drained = {
      op: "drain" as const,
      drain: {
        drain_id: "drain-1",
        credit_id: "credit-1",
        method: "x402" as const,
        status: "sent" as const,
        amount_micro: 300_000,
        currency: "usd",
        ledger_seq: 2,
        created_at: 1,
        receipts: [],
      },
      x402PaymentResponse: encodePaymentResponseHeader({
        success: true,
        transaction: "0xrefund",
        network,
        payer: account.address,
        amount: "300000",
        extra: {
          channelState: {
            channelId,
            balance: "200000",
            totalClaimed: "0",
            chargedCumulativeAmount: "0",
            withdrawRequestedAt: 0,
            refundNonce: "1",
          },
        },
      }),
    };
    const posted: string[] = [];
    const { DvmError } = await import("../../errors");
    const post = vi
      .fn()
      .mockRejectedValueOnce(
        new DvmError("payment_required", "Refund approval required.", undefined, {
          x402_payment_required: required,
        })
      )
      .mockImplementationOnce((paymentHeader?: string) => {
        if (paymentHeader) posted.push(paymentHeader);
        return Promise.resolve(drained);
      });
    const batch = await import("../batch-client");

    const outcome = await batch.refundX402BatchChannel({
      wallet: { privateKey: key, address: account.address, network },
      endpoint: "https://dvm.example",
      callerPubkey: CALLER_PUBKEY,
      creditId: CREDIT_ID,
      depositMicro: 500_000,
      post,
    });

    expect(outcome).toMatchObject({ result: drained, atRiskMicro: 200_000n });
    expect(outcome.pendingFundings).toHaveLength(1);
    const store = await import("../channel-store");
    expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeGreaterThan(0);
    // The exposure is reported but deliberately does not raise the voucher
    // signed here, which would mint the DVM fresh claim authority up to a cap
    // it may never have received.
    expect(decodePaymentSignatureHeader(posted[0] ?? "").payload).toMatchObject({
      type: "refund",
      voucher: { channelId, maxClaimableAmount: "0" },
    });
  });

  // Every input to the channel-id derivation is mutable after the
  // channel opens, and a drifted derivation reads a channel that never existed —
  // which the contract answers (0, 0) for, exactly as it answers for a channel
  // the DVM has emptied. The four cases below are the ways that drift happens.
  describe("follows the recorded channel rather than the current config", () => {
    it("validates a recorded channel against the DVM's current challenge", async () => {
      const { key, account, network, required, record } = await refundFixture();
      const recorded = record();
      const batch = await import("../batch-client");
      const wallet = { privateKey: key, address: account.address, network };

      expect(() =>
        batch.assertX402RequirementDescribesChannel({
          wallet,
          paymentRequired: required,
          recorded,
          depositMicro: 200_000,
        })
      ).not.toThrow();
      expect(() =>
        batch.assertX402RequirementDescribesChannel({
          wallet,
          paymentRequired: required,
          recorded: { ...recorded, channelId: `0x${"99".repeat(32)}` },
          depositMicro: 200_000,
        })
      ).toThrowError(expect.objectContaining({ code: "x402_channel_mismatch" }));
    });

    it("refuses a drain signed by a key that did not open the channel", async () => {
      const { network, required, record } = await refundFixture();
      const recorded = record();
      const stranger = `0x${"77".repeat(32)}` as `0x${string}`;
      const strangerAccount = privateKeyToAccount(stranger);
      const readContract = vi.fn();
      viemClientMock.create.mockReturnValue({ readContract });
      const { DvmError } = await import("../../errors");
      const batch = await import("../batch-client");

      const failure = await catchRefusal(
        batch.refundX402BatchChannel({
          wallet: { privateKey: stranger, address: strangerAccount.address, network },
          endpoint: "https://dvm.example",
          callerPubkey: CALLER_PUBKEY,
          creditId: CREDIT_ID,
          depositMicro: 200_000,
          post: vi.fn().mockRejectedValue(
            new DvmError("payment_required", "Refund approval required.", undefined, {
              x402_payment_required: required,
            })
          ),
        })
      );

      expect(failure).toMatchObject({
        code: "x402_wallet_mismatch",
        data: {
          channel_id: recorded.channelId,
          recorded_payer: recorded.config.payer,
          connected_payer: strangerAccount.address,
        },
      });
      expect(failure.message).toContain(recorded.config.payer);
      // The whole point: an untouched balance must never be reported as taken.
      expect(`${failure.message} ${failure.hint ?? ""}`).not.toContain("already claimed");
      // And the refusal lands before the chain is asked anything at all.
      expect(readContract).not.toHaveBeenCalled();
    });

    it("keeps DVM_X402_RPC_URL on the pinned chain when the drain follows another", async () => {
      process.env.DVM_X402_RPC_URL = "https://override.example/rpc";
      const { key, account, network, channelId, required, record } =
        await refundFixture("eip155:8453");
      record();
      viemClientMock.create.mockReturnValue({
        readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
      });
      const { DvmError } = await import("../../errors");
      const post = vi
        .fn()
        .mockRejectedValueOnce(
          new DvmError("payment_required", "Refund approval required.", undefined, {
            x402_payment_required: required,
          })
        )
        .mockResolvedValue(
          refundResponse({ channelId, network, payer: account.address, amount: "200000" })
        );
      const batch = await import("../batch-client");

      const result = await batch.refundX402BatchChannel({
        wallet: { privateKey: key, address: account.address, network: "eip155:84532" },
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 200_000,
        post,
      });
      expect(result.result).toEqual(refundResponse({ channelId, network, payer: account.address, amount: "200000" }));
      expect(viemClientMock.create).toHaveBeenCalledWith(
        expect.objectContaining({ chain: expect.objectContaining({ id: 8453 }) })
      );

      // The override speaks for the pinned chain and nothing else, so this
      // channel reads through Base's bundled endpoint instead.
      expect(viemClientMock.http).toHaveBeenCalledWith(chains.base.rpcUrls.default.http[0]);
      expect(viemClientMock.http).not.toHaveBeenCalledWith("https://override.example/rpc");
    });

    it("names the scoping only where the endpoint could have caused the failure", async () => {
      process.env.DVM_X402_RPC_URL = "https://override.example/rpc";
      const { key, account, required, record } = await refundFixture("eip155:8453");
      record();
      const { DvmError } = await import("../../errors");
      const batch = await import("../batch-client");
      const drain = () =>
        batch.refundX402BatchChannel({
          wallet: { privateKey: key, address: account.address, network: "eip155:84532" },
          endpoint: "https://dvm.example",
          callerPubkey: CALLER_PUBKEY,
          creditId: CREDIT_ID,
          depositMicro: 200_000,
          post: vi.fn().mockRejectedValue(
            new DvmError("payment_required", "Refund approval required.", undefined, {
              x402_payment_required: required,
            })
          ),
        });

      // A read that answered, and answered that the escrow is gone. The
      // override was never in that answer, so naming it would misdirect.
      viemClientMock.create.mockReturnValue({
        readContract: vi.fn().mockResolvedValue([100_000n, 100_000n]),
      });
      const claimed = await catchRefusal(drain());
      expect(claimed.code).toBe("x402_refund_failed");
      expect(claimed.message).toContain("already claimed");
      expect(claimed.hint).not.toContain("DVM_X402_RPC_URL");

      // The same drain, broken at the read itself — where the endpoint is
      // exactly the thing a caller would go looking at.
      viemClientMock.create.mockReturnValue({
        readContract: vi.fn().mockRejectedValue(new Error("RPC unavailable")),
      });
      const unread = await catchRefusal(drain());
      expect(unread.code).toBe("x402_refund_failed");
      expect(unread.hint).toContain("DVM_X402_RPC_URL");
      expect(unread.hint).toContain("Base (eip155:8453)");
    });

    it("refuses on its own chain's terms when the DVM has retired that chain", async () => {
      const { key, account, record } = await refundFixture("eip155:8453");
      const recorded = record();
      // The DVM has flipped to Base Sepolia and offers Base no longer. The
      // wallet followed it; the channel could not.
      const sepolia = await refundFixture("eip155:84532");
      const readContract = vi.fn();
      viemClientMock.create.mockReturnValue({ readContract });
      const { DvmError } = await import("../../errors");
      const batch = await import("../batch-client");

      const failure = await catchRefusal(
        batch.refundX402BatchChannel({
          wallet: { privateKey: key, address: account.address, network: "eip155:84532" },
          endpoint: "https://dvm.example",
          callerPubkey: CALLER_PUBKEY,
          creditId: CREDIT_ID,
          depositMicro: 200_000,
          post: vi.fn().mockRejectedValue(
            new DvmError("payment_required", "Refund approval required.", undefined, {
              x402_payment_required: sepolia.required,
            })
          ),
        })
      );

      expect(failure).toMatchObject({
        code: "x402_batch_not_offered",
        data: {
          anchor: "x402_batch_chain_retired",
          channel_id: recorded.channelId,
          network: "eip155:8453",
        },
      });
      expect(failure.message).toContain("Base (eip155:8453)");
      // Re-pinning reaches nothing now that the drain follows the channel, so
      // the only honest route left is the timed exit.
      expect(failure.hint).toContain(`x402-withdraw-initiate --channel-id ${recorded.channelId}`);
      expect(failure.hint).not.toContain("dvm wallet x402-network");
      expect(readContract).not.toHaveBeenCalled();
    });

    it("signs against the recorded salt, not the one today's formula derives", async () => {
      const { key, account, network, config, required, record } = await refundFixture();
      // A channel opened under an older salt formula. Nothing in the config
      // reproduces it; only the record knows which channel holds the money.
      const salt = keccak256(toBytes("dvmkit:x402-batch:legacy-formula"));
      const legacyConfig = { ...config, salt };
      const legacyChannelId = computeChannelId(legacyConfig, network);
      record({ channelId: legacyChannelId, config: legacyConfig });
      viemClientMock.create.mockReturnValue({
        readContract: vi.fn().mockResolvedValue([200_000n, 0n]),
      });
      const { DvmError } = await import("../../errors");
      const drained = refundResponse({
        channelId: legacyChannelId,
        network,
        payer: account.address,
        amount: "200000",
      });
      const post = vi
        .fn()
        .mockRejectedValueOnce(
          new DvmError("payment_required", "Refund approval required.", undefined, {
            x402_payment_required: required,
          })
        )
        .mockResolvedValueOnce(drained);
      const batch = await import("../batch-client");

      await expect(
        batch.refundX402BatchChannel({
          wallet: { privateKey: key, address: account.address, network },
          endpoint: "https://dvm.example",
          callerPubkey: CALLER_PUBKEY,
          creditId: CREDIT_ID,
          depositMicro: 200_000,
          post,
        })
      ).resolves.toMatchObject({ result: drained });

      expect(decodePaymentSignatureHeader(post.mock.calls[1]?.[0] ?? "").payload).toMatchObject({
        type: "refund",
        voucher: { channelId: legacyChannelId },
      });
    });

    it("finds the channel of a credit in a legacy wrong-owner record", async () => {
      const { network, required, record } = await refundFixture();
      // Older CLIs relabelled the single channel row before the DVM accepted a
      // second credit. The drain still has to find that channel — and here,
      // still has to refuse for the stranger's key.
      const recorded = record({ creditId: "credit-2" });
      const stranger = `0x${"77".repeat(32)}` as `0x${string}`;
      const { DvmError } = await import("../../errors");
      const batch = await import("../batch-client");

      const failure = await catchRefusal(
        batch.refundX402BatchChannel({
          wallet: {
            privateKey: stranger,
            address: privateKeyToAccount(stranger).address,
            network,
          },
          endpoint: "https://dvm.example",
          callerPubkey: CALLER_PUBKEY,
          creditId: CREDIT_ID,
          depositMicro: 200_000,
          post: vi.fn().mockRejectedValue(
            new DvmError("payment_required", "Refund approval required.", undefined, {
              x402_payment_required: required,
            })
          ),
        })
      );

      expect(failure).toMatchObject({
        code: "x402_wallet_mismatch",
        data: { channel_id: recorded.channelId },
      });
    });

    it("refuses when the DVM's current terms describe a different channel", async () => {
      const { key, account, network, config, required, record } = await refundFixture();
      // The DVM rotated its payout address after this channel opened, so its
      // challenge now derives an id the caller's money was never deposited into.
      const recorded = record({
        channelId: computeChannelId({ ...config, receiver: `0x${"99".repeat(20)}` }, network),
      });
      const readContract = vi.fn();
      viemClientMock.create.mockReturnValue({ readContract });
      const { DvmError } = await import("../../errors");
      const batch = await import("../batch-client");

      const failure = await catchRefusal(
        batch.refundX402BatchChannel({
          wallet: { privateKey: key, address: account.address, network },
          endpoint: "https://dvm.example",
          callerPubkey: CALLER_PUBKEY,
          creditId: CREDIT_ID,
          depositMicro: 200_000,
          post: vi.fn().mockRejectedValue(
            new DvmError("payment_required", "Refund approval required.", undefined, {
              x402_payment_required: required,
            })
          ),
        })
      );

      expect(failure).toMatchObject({
        code: "x402_channel_mismatch",
        data: { channel_id: recorded.channelId },
      });
      expect(failure.hint).toContain(`--channel-id ${recorded.channelId}`);
      expect(readContract).not.toHaveBeenCalled();
    });
  });

  /**
   * The stored `balance` is a running local sum, and exactly one
   * write advances it on this side's own authority: the replay acknowledgement,
   * which counts the deposit its journalled payload authorized. A DVM that
   * refuses the funding afterwards leaves that deposit in the wallet, its
   * authorization lapsing unconsumed — and nothing ever took the figure back
   * off, so the projection stayed permanently optimistic.
   */
  describe("refused-deposit reconciliation", () => {
    it("brings the stored balance back to the channels() figure once the deposit lapses", async () => {
      const { key, account, network, channelId, record } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      const { pending } = await refusedDeposit(channelId, wallet);

      // The replay acknowledgement counts a deposit that never reached chain.
      await batch.acknowledgeReplayedX402Payment(pending.paymentHeader);
      await expect(new store.DvmX402ChannelStorage().get(channelId)).resolves.toMatchObject({
        balance: "100000",
      });
      expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeGreaterThan(0);

      viemClientMock.create.mockReturnValue({ readContract: chainReader() });
      await expect(
        batch.reconcileRefusedX402Deposits({
          wallet,
          channelId,
          pending: store.listPendingX402FundingsForChannel(channelId),
          nowSeconds: 11,
        })
      ).resolves.toMatchObject({
        channelId,
        previousBalanceMicro: "100000",
        balanceMicro: "9000",
        totalClaimedMicro: "9000",
        fundIds: ["fund-refused"],
      });

      await expect(new store.DvmX402ChannelStorage().get(channelId)).resolves.toMatchObject({
        balance: "9000",
        totalClaimed: "9000",
        // The base the next voucher signs from is never lowered to a figure the
        // DVM has already exceeded.
        chargedCumulativeAmount: "100000",
      });
      expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeUndefined();
    });

    it("repairs the projection on the next funding, before it sizes the deposit", async () => {
      const { key, account, network, channelId, record, required } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      const { pending } = await refusedDeposit(channelId, wallet);
      await batch.acknowledgeReplayedX402Payment(pending.paymentHeader);

      const reader = chainReader();
      viemClientMock.create.mockImplementation((...args: unknown[]) => ({
        ...(viemClientMock.actualCreate?.(...args) as object),
        readContract: reader,
      }));
      const signed = await batch.createX402BatchPayment({
        wallet,
        paymentRequired: { ...required, accepts: [{ ...required.accepts[0], amount: "5000" }] },
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        depositMicro: 200_000,
      });

      await expect(new store.DvmX402ChannelStorage().get(channelId)).resolves.toMatchObject({
        balance: "9000",
      });
      expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeUndefined();
      // Sized against the repaired figure: $0.009 on chain against a $0.105
      // cumulative cap is a top-up, not the voucher-only payload the inflated
      // projection would have produced.
      expect(decodePaymentSignatureHeader(signed.paymentHeader).payload).toMatchObject({
        type: "deposit",
      });
    });

    // The proof is "expired and never consumed", not "refused". Inside the
    // validity window the deposit can still land, and a `channels()` read taken
    // one block early would push the projection *below* chain — the same drift
    // in the other direction.
    it("leaves the projection alone while a refused deposit can still be submitted", async () => {
      const { key, account, network, channelId, record } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      await refusedDeposit(channelId, wallet);
      await batch.acknowledgeReplayedX402Payment(
        store.listPendingX402FundingsForChannel(channelId)[0].paymentHeader
      );

      const readContract = chainReader();
      viemClientMock.create.mockReturnValue({ readContract });
      await expect(
        batch.reconcileRefusedX402Deposits({
          wallet,
          channelId,
          pending: store.listPendingX402FundingsForChannel(channelId),
          nowSeconds: 9,
        })
      ).resolves.toBeUndefined();

      expect(readContract).not.toHaveBeenCalled();
      await expect(new store.DvmX402ChannelStorage().get(channelId)).resolves.toMatchObject({
        balance: "100000",
      });
      expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeGreaterThan(0);
    });

    it("leaves the projection alone when the lapsed deposit was consumed onchain", async () => {
      const { key, account, network, channelId, record } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      await refusedDeposit(channelId, wallet);
      await batch.acknowledgeReplayedX402Payment(
        store.listPendingX402FundingsForChannel(channelId)[0].paymentHeader
      );

      viemClientMock.create.mockReturnValue({ readContract: chainReader({ consumed: true }) });
      await expect(
        batch.reconcileRefusedX402Deposits({
          wallet,
          channelId,
          pending: store.listPendingX402FundingsForChannel(channelId),
          nowSeconds: 11,
        })
      ).resolves.toBeUndefined();

      await expect(new store.DvmX402ChannelStorage().get(channelId)).resolves.toMatchObject({
        balance: "100000",
      });
    });

    // A live entry is not evidence of anything: the DVM may still answer it, so
    // its deposit is not provably dead however old the header is.
    it("ignores an entry the DVM never refused", async () => {
      const { key, account, network, channelId, record } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      await refusedDeposit(channelId, wallet, { refuse: false });

      const readContract = chainReader();
      viemClientMock.create.mockReturnValue({ readContract });
      await expect(
        batch.reconcileRefusedX402Deposits({
          wallet,
          channelId,
          pending: store.listPendingX402FundingsForChannel(channelId),
          nowSeconds: 11,
        })
      ).resolves.toBeUndefined();
      expect(readContract).not.toHaveBeenCalled();
    });

    // The `alreadyApplied` guard is the existing correctness property: a second
    // replay of the same voucher must credit nothing. It must also leave the
    // stamp alone, in both directions — it neither applied a deposit nor
    // observed anything, so it may not re-stamp and it may not certify.
    //
    // This is the crash window `fundOverX402` designs for: the acknowledgement
    // lands, the journal clear does not, and the next run replays the same
    // header. Clearing here would hand a clean bill of health to the very
    // record most likely to be carrying the drift.
    it("credits a replayed deposit exactly once, and its second pass keeps the stamp intact", async () => {
      const { key, account, network, channelId, record } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      const { pending } = await refusedDeposit(channelId, wallet);

      await batch.acknowledgeReplayedX402Payment(pending.paymentHeader);
      const stampedAt = store.x402ChannelBalanceUnreconciledAt(channelId);
      expect(stampedAt).toBeGreaterThan(0);

      await batch.acknowledgeReplayedX402Payment(pending.paymentHeader);

      await expect(new store.DvmX402ChannelStorage().get(channelId)).resolves.toMatchObject({
        balance: "100000",
        chargedCumulativeAmount: "100000",
      });
      expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBe(stampedAt);
    });

    // `channels()` answers for the whole channel, so a second proof changes
    // nothing about the figure it returns. Probing past the first would buy an
    // extra chain read per refused entry on every single funding, forever — a
    // retired entry is never removed without `--force`.
    it("stops probing at the first proven lapse, and still names every entry it supersedes", async () => {
      const { key, account, network, channelId, record } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      const { pending } = await refusedDeposit(channelId, wallet);
      store.recordPendingX402Funding({ ...pending, fundId: "fund-refused-2" });
      store.retirePendingX402Funding({ ...pending, fundId: "fund-refused-2" });
      expect(store.listPendingX402FundingsForChannel(channelId)).toHaveLength(2);
      await batch.acknowledgeReplayedX402Payment(pending.paymentHeader);

      const readContract = chainReader();
      viemClientMock.create.mockReturnValue({ readContract });
      await expect(
        batch.reconcileRefusedX402Deposits({
          wallet,
          channelId,
          pending: store.listPendingX402FundingsForChannel(channelId),
          nowSeconds: 11,
        })
      ).resolves.toMatchObject({
        balanceMicro: "9000",
        fundIds: ["fund-refused", "fund-refused-2"],
      });

      // One `authorizationState` for the proof, one `channels` for the figure.
      expect(readContract).toHaveBeenCalledTimes(2);
      expect(
        readContract.mock.calls.filter(
          ([call]) => (call as { functionName: string }).functionName === "authorizationState"
        )
      ).toHaveLength(1);
    });

    // The other half of "preserve": with no stamp to keep, a no-op replay must
    // not invent one either. This is the ordinary post-settlement replay, where
    // the DVM's own channel state already answered the question.
    it("raises no stamp when a replay follows a settled acknowledgement", async () => {
      const { key, account, network, channelId, record } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      const { pending } = await refusedDeposit(channelId, wallet);
      await new store.DvmX402ChannelStorage().set(channelId, {
        balance: "100000",
        totalClaimed: "0",
        chargedCumulativeAmount: "100000",
      });

      await batch.acknowledgeReplayedX402Payment(pending.paymentHeader);

      expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeUndefined();
    });

    // Upstream's recovery writes are direct chain observations, so they settle
    // the question the stamp asks. DVM responses take the separate marked path.
    it("clears the stamp when upstream recovers from chain", async () => {
      const { key, account, network, channelId, record } = await refundFixture();
      record();
      const batch = await import("../batch-client");
      const store = await import("../channel-store");
      const wallet = { privateKey: key, address: account.address, network };
      const { pending } = await refusedDeposit(channelId, wallet);
      await batch.acknowledgeReplayedX402Payment(pending.paymentHeader);
      expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeGreaterThan(0);

      await new store.DvmX402ChannelStorage().set(channelId, {
        balance: "9000",
        totalClaimed: "9000",
        chargedCumulativeAmount: "100000",
      });

      expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeUndefined();
    });
  });
});

/** Re-encode a real deposit with validBefore=10 to exercise either side of expiry. */
async function refusedDeposit(
  channelId: `0x${string}`,
  wallet: { privateKey: `0x${string}`; address: string; network: string },
  opts: { refuse?: boolean } = {}
): Promise<{ pending: PendingX402Funding }> {
  const batch = await import("../batch-client");
  const store = await import("../channel-store");
  const { required } = await refundFixture(wallet.network as `${string}:${string}`);
  await new store.DvmX402ChannelStorage().set(channelId, {
    balance: "0",
    totalClaimed: "0",
    chargedCumulativeAmount: "0",
  });
  const signed = await batch.createX402BatchPayment({
    wallet,
    paymentRequired: { ...required, accepts: [{ ...required.accepts[0], amount: "100000" }] },
    endpoint: "https://dvm.example",
    callerPubkey: CALLER_PUBKEY,
    creditId: CREDIT_ID,
    depositMicro: 100_000,
  });
  const decoded = decodePaymentSignatureHeader(signed.paymentHeader);
  const deposit = (
    decoded.payload as {
      deposit: { authorization: { erc3009Authorization: Record<string, unknown> } };
    }
  ).deposit;
  const paymentHeader = encodePaymentSignatureHeader({
    ...decoded,
    payload: {
      ...decoded.payload,
      deposit: {
        ...deposit,
        authorization: {
          erc3009Authorization: {
            ...deposit.authorization.erc3009Authorization,
            validBefore: "10",
          },
        },
      },
    },
  });
  const pending: PendingX402Funding = {
    endpoint: "https://dvm.example",
    callerPubkey: CALLER_PUBKEY,
    creditId: CREDIT_ID,
    fundId: "fund-refused",
    amountMicro: 100_000,
    targetMicro: 100_000,
    paymentHeader,
    channelId,
    requestedAt: Date.now(),
    maxClaimableMicro: "100000",
    depositMicro: "100000",
    authorizationValidBefore: "10",
  };
  store.recordPendingX402Funding(pending);
  if (opts.refuse !== false) store.retirePendingX402Funding(pending);
  return { pending };
}

/** Stub nonce consumption and the channel's $0.009 held/$0.009 claimed views. */
function chainReader(opts: { consumed?: boolean } = {}) {
  return vi.fn((call: { functionName: string }) =>
    Promise.resolve(
      call.functionName === "authorizationState" ? (opts.consumed ?? false) : [9_000n, 9_000n]
    )
  );
}

/** Await a drain expected to refuse, and hand back the refusal it threw. */
async function catchRefusal(operation: Promise<unknown>): Promise<DvmError> {
  try {
    await operation;
  } catch (err) {
    return err as DvmError;
  }
  throw new Error("expected the drain to refuse");
}

/** A completed cooperative refund response for proceed-and-report cases. */
function refundResponse(args: {
  channelId: `0x${string}`;
  network: `${string}:${string}`;
  payer: `0x${string}`;
  amount: string;
}) {
  return {
    op: "drain" as const,
    drain: {
      drain_id: "drain-1",
      credit_id: "credit-1",
      method: "x402" as const,
      status: "sent" as const,
      amount_micro: Number(args.amount),
      currency: "usd",
      ledger_seq: 2,
      created_at: 1,
      receipts: [],
    },
    x402PaymentResponse: encodePaymentResponseHeader({
      success: true,
      transaction: "0xrefund",
      network: args.network,
      payer: args.payer,
      amount: args.amount,
      extra: {
        channelState: {
          channelId: args.channelId,
          balance: "0",
          totalClaimed: "0",
          chargedCumulativeAmount: "0",
          withdrawRequestedAt: 0,
          refundNonce: "1",
        },
      },
    }),
  };
}

/**
 * The channel, challenge and journal seam every refund test above shares.
 *
 * `network` is the chain the *channel* lives on — the wallet's pin is passed
 * separately at the call, so a test can open the two apart and drain across
 * them.
 */
async function refundFixture(network: `${string}:${string}` = "eip155:84532") {
  const key = `0x${"11".repeat(32)}` as `0x${string}`;
  const account = privateKeyToAccount(key);
  const receiver = `0x${"22".repeat(20)}` as const;
  const receiverAuthorizer = `0x${"33".repeat(20)}` as const;
  const token = x402NetworkByCaip2(network)?.usdc as `0x${string}`;
  const config = {
    payer: account.address,
    payerAuthorizer: account.address,
    receiver,
    receiverAuthorizer,
    token,
    withdrawDelay: 86_400,
    salt: keccak256(toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`)),
  };
  const channelId = computeChannelId(config, network);
  const required: PaymentRequired = {
    x402Version: 2,
    resource: { url: "https://dvm.example/v1/credit" },
    accepts: [
      {
        scheme: "batch-settlement",
        network,
        asset: token,
        amount: "0",
        payTo: receiver,
        maxTimeoutSeconds: 60,
        extra: {
          receiverAuthorizer,
          withdrawDelay: 86_400,
          name: "x402 Batch Settlement",
          version: "1",
          assetTransferMethod: "eip3009",
        },
      },
    ],
  };
  const store = await import("../channel-store");
  return {
    key,
    account,
    network,
    channelId,
    config,
    required,
    /** Record the channel the way funding does, optionally with drifted terms. */
    record(overrides: Partial<StoredX402ChannelMetadata> = {}) {
      const merged: StoredX402ChannelMetadata = {
        channelId,
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        network,
        config,
        updatedAt: Date.now(),
        ...overrides,
      };
      store.recordX402ChannelMetadata(merged);
      return merged;
    },
    /** Seed one unacknowledged funding on this channel's real journal. */
    journal(overrides: Partial<PendingX402Funding>) {
      store.recordPendingX402Funding({
        endpoint: "https://dvm.example",
        callerPubkey: CALLER_PUBKEY,
        creditId: CREDIT_ID,
        fundId: "fund-1",
        amountMicro: 200_000,
        targetMicro: 200_000,
        paymentHeader: "verbatim-header",
        channelId,
        requestedAt: Date.now(),
        ...overrides,
      });
    },
  };
}
