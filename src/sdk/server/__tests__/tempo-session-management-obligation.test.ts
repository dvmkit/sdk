import { randomBytes } from "node:crypto";

import { Credential, Errors as MppxErrors, Store } from "mppx";
import { Session as TempoSession } from "mppx/tempo";
import type { Client } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { createMppFromOpts, installHostedTempoCloseGuard, type MppxServer } from "../mpp-setup";
import type { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { verifyTempoSessionManagementCredential } from "../payment";

const CHANNEL = `0x${"67".repeat(32)}`;

function closeCredential(channelId = CHANNEL): string {
  return Credential.serialize({
    challenge: { id: "original-close", realm: "managed.example", method: "tempo",
      intent: "session", request: { amount: "100000", currency: `0x${"11".repeat(20)}`,
        recipient: `0x${"22".repeat(20)}`, unitType: "request" } },
    payload: { action: "close", channelId, cumulativeAmount: "10000",
      signature: `0x${"ab".repeat(65)}` },
  });
}

describe("managed Tempo close effect boundary", () => {
  it("validates the original credential before reserving and broadcasts with the same verified request", async () => {
    const order: string[] = [];
    const validateCredential = vi.fn(async () => { order.push("validate"); });
    const assertTempoSessionCloseVoucher = vi.fn(async () => { order.push("voucher"); });
    const broadcastCredential = vi.fn(async () => { order.push("broadcast");
      return { reference: "fallback", txHash: `0x${"ab".repeat(32)}` }; });
    const mpp = { validateCredential, assertTempoSessionCloseVoucher,
      broadcastCredential } as unknown as MppxServer;
    const result = await verifyTempoSessionManagementCredential({
      credential: closeCredential(), mpp, resourcePath: "/v1/credit", action: "close",
      expectedChannelId: CHANNEL, preflightBeforeBound: true,
      onBound: async () => { order.push("reserve"); },
    });
    expect(order).toEqual(["validate", "voucher", "reserve", "broadcast"]);
    expect(result.reference).toBe(`0x${"ab".repeat(32)}`);
    expect(validateCredential).toHaveBeenCalledOnce();
    expect(broadcastCredential).toHaveBeenCalledOnce();
    expect(broadcastCredential.mock.calls[0]).toEqual(validateCredential.mock.calls[0]);
  });

  it.each(["invalid_hmac", "replayed_challenge"])(
    "refuses %s before any reservation or broadcast", async (failure) => {
      const onBound = vi.fn();
      const broadcastCredential = vi.fn();
      const mpp = { validateCredential: vi.fn().mockRejectedValue(new Error(failure)),
        broadcastCredential } as unknown as MppxServer;
      await expect(verifyTempoSessionManagementCredential({
        credential: closeCredential(), mpp, resourcePath: "/v1/credit", action: "close",
        expectedChannelId: CHANNEL, preflightBeforeBound: true, onBound,
      })).rejects.toThrow(failure);
      expect(onBound).not.toHaveBeenCalled();
      expect(broadcastCredential).not.toHaveBeenCalled();
    }
  );

  describe("against the real mppx tempo/session method", () => {
    const RESOURCE = "/v1/credit/drain";
    const ESCROW = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    const CHAIN_ID = 4217;
    const PAYEE = `0x${"22".repeat(20)}` as const;
    /** The mainnet payment token `resolveTempoNetwork` selects for chain 4217. */
    const TOKEN = "0x20C000000000000000000000b9537d11c60E8b50" as const;

    type Descriptor = Omit<
      Parameters<typeof TempoSession.Precompile.Channel.computeId>[0], "chainId" | "escrow"
    >;

    /** A real handle whose store holds the open channel `payer` authorized. */
    async function sessionChannel(payer: PrivateKeyAccount) {
      const operator = privateKeyToAccount(generatePrivateKey());
      const descriptor: Descriptor = {
        payer: payer.address, payee: PAYEE, operator: operator.address, token: TOKEN,
        authorizedSigner: payer.address, salt: `0x${randomBytes(32).toString("hex")}`,
        expiringNonceHash: `0x${randomBytes(32).toString("hex")}`,
      };
      const channelId = TempoSession.Precompile.Channel.computeId(
        { ...descriptor, chainId: CHAIN_ID, escrow: ESCROW }
      );
      const store = Store.memory();
      await store.put(channelId, { backend: "precompile", descriptor, channelId,
        chainId: CHAIN_ID, escrowContract: ESCROW, payee: PAYEE, payer: payer.address,
        authorizedSigner: payer.address, token: TOKEN, operator: operator.address,
        highestVoucherAmount: 10_000n, settledOnChain: 0n, spent: 5_000n, units: 0,
        deposit: 100_000n, closeRequestedAt: 0n, finalized: false });
      const mpp = createMppFromOpts(
        { tempoRecipient: PAYEE, realm: "managed.example",
          tempoSession: { store, account: operator } },
        { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") } as NodeJS.ProcessEnv
      );
      if (!mpp) throw new Error("expected a Tempo handle");
      return { mpp, channelId, descriptor };
    }

    type Channel = Awaited<ReturnType<typeof sessionChannel>>;

    async function signedClose(
      channel: Channel, signer: PrivateKeyAccount, cumulativeAmount: bigint
    ): Promise<string> {
      return TempoSession.Precompile.Voucher.signVoucher({} as Client, signer,
        { channelId: channel.channelId, cumulativeAmount }, ESCROW, CHAIN_ID);
    }

    async function issuedCloseCredential(
      channel: Channel, signature: string, cumulativeAmount = 10_000n,
      descriptor: Descriptor = channel.descriptor
    ): Promise<Credential.Credential> {
      const challenge = await channel.mpp.issueChallenge("tempo", "session", {
        amount: "0.010000", suggestedDeposit: "0.010000", unitType: "request",
        meta: { path: RESOURCE, nonce: randomBytes(16).toString("hex") },
      });
      return Credential.from({ challenge, payload: { action: "close",
        channelId: channel.channelId, descriptor,
        cumulativeAmount: cumulativeAmount.toString(), signature } });
    }

    async function preflight(channel: Channel, credential: string, resourcePath = RESOURCE) {
      const onBound = vi.fn(async () => { throw reserved; });
      const broadcastCredential = vi.spyOn(channel.mpp, "broadcastCredential");
      const outcome = verifyTempoSessionManagementCredential({
        credential, mpp: channel.mpp, resourcePath, action: "close",
        expectedChannelId: channel.channelId, preflightBeforeBound: true, onBound,
      });
      return { outcome, onBound, broadcastCredential };
    }

    // The sentinel stops the call at the reservation seam, before any chain broadcast.
    const reserved = new Error("reservation reached");

    it("authenticates a hosted close and reaches the reservation", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const channel = await sessionChannel(payer);
      const credential = await issuedCloseCredential(channel,
        await signedClose(channel, payer, 10_000n));
      const { outcome, onBound, broadcastCredential } =
        await preflight(channel, Credential.serialize(credential));
      await expect(outcome).rejects.toBe(reserved);
      expect(onBound).toHaveBeenCalledOnce();
      expect(broadcastCredential).not.toHaveBeenCalled();
    });

    it("still refuses a close whose challenge this server did not issue before reserving", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const channel = await sessionChannel(payer);
      const genuine = await issuedCloseCredential(channel,
        await signedClose(channel, payer, 10_000n));
      const { outcome, onBound } = await preflight(channel, Credential.serialize({ ...genuine,
        challenge: { ...genuine.challenge, id: randomBytes(32).toString("base64url") } }));
      await expect(outcome).rejects.toBeInstanceOf(MppxErrors.InvalidChallengeError);
      expect(onBound).not.toHaveBeenCalled();
    });

    it("still refuses a close bound to another resource path before reserving", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const channel = await sessionChannel(payer);
      const credential = await issuedCloseCredential(channel,
        await signedClose(channel, payer, 10_000n));
      const { outcome, onBound } =
        await preflight(channel, Credential.serialize(credential), "/v1/job");
      await expect(outcome).rejects.toBeInstanceOf(MppxErrors.InvalidChallengeError);
      expect(onBound).not.toHaveBeenCalled();
    });

    // mppx checks these only inside the broadcast, after the hosted obligation
    // would already be reserved; each must now stop the close before it.
    it("refuses a close voucher the channel's signer did not sign before reserving", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const channel = await sessionChannel(payer);
      const stranger = privateKeyToAccount(generatePrivateKey());
      const credential = await issuedCloseCredential(channel,
        await signedClose(channel, stranger, 10_000n));
      const { outcome, onBound } = await preflight(channel, Credential.serialize(credential));
      await expect(outcome).rejects.toBeInstanceOf(MppxErrors.InvalidSignatureError);
      expect(onBound).not.toHaveBeenCalled();
    });

    it("refuses a close voucher below the channel's spent amount before reserving", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const channel = await sessionChannel(payer);
      const credential = await issuedCloseCredential(channel,
        await signedClose(channel, payer, 4_000n), 4_000n);
      const { outcome, onBound } = await preflight(channel, Credential.serialize(credential));
      await expect(outcome).rejects.toBeInstanceOf(MppxErrors.VerificationFailedError);
      expect(onBound).not.toHaveBeenCalled();
    });

    it.each([
      ["has no descriptor", () => null, "descriptor required"],
      ["names another channel's descriptor", (d: Descriptor) =>
        ({ ...d, salt: `0x${"99".repeat(32)}` }), "does not match channelId"],
    ])("refuses a close whose credential %s before reserving", async (_case, change, reason) => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const channel = await sessionChannel(payer);
      const credential = await issuedCloseCredential(channel,
        await signedClose(channel, payer, 10_000n), 10_000n,
        change(channel.descriptor) as Descriptor);
      const { outcome, onBound } = await preflight(channel, Credential.serialize(credential));
      await expect(outcome).rejects.toThrow(reason);
      expect(onBound).not.toHaveBeenCalled();
    });
  });

  it("does not broadcast when the durable reservation refuses the validated credential", async () => {
    const validateCredential = vi.fn().mockResolvedValue(undefined);
    const broadcastCredential = vi.fn();
    const mpp = { validateCredential, broadcastCredential,
      assertTempoSessionCloseVoucher: vi.fn().mockResolvedValue(undefined) } as unknown as MppxServer;
    await expect(verifyTempoSessionManagementCredential({
      credential: closeCredential(), mpp, resourcePath: "/v1/credit", action: "close",
      expectedChannelId: CHANNEL, preflightBeforeBound: true,
      onBound: async () => { throw new Error("original drain is unresolved"); },
    })).rejects.toThrow("original drain is unresolved");
    expect(validateCredential).toHaveBeenCalledOnce();
    expect(broadcastCredential).not.toHaveBeenCalled();
  });

  it("refuses another channel before validation or reservation", async () => {
    const validateCredential = vi.fn();
    const broadcastCredential = vi.fn();
    const onBound = vi.fn();
    await expect(verifyTempoSessionManagementCredential({
      credential: closeCredential(`0x${"68".repeat(32)}`),
      mpp: { validateCredential, broadcastCredential } as unknown as MppxServer,
      resourcePath: "/v1/credit", action: "close", expectedChannelId: CHANNEL,
      preflightBeforeBound: true, onBound,
    })).rejects.toThrow("different channel");
    expect(validateCredential).not.toHaveBeenCalled();
    expect(onBound).not.toHaveBeenCalled();
    expect(broadcastCredential).not.toHaveBeenCalled();
  });

  it("requires a one-shot original drain permit even for a directly presented close", async () => {
    const broadcastCredential = vi.fn().mockResolvedValue({ reference: "original-close" });
    const assertReservedTempoClose = vi.fn().mockResolvedValue(undefined);
    const mpp = { broadcastCredential } as unknown as MppxServer;
    installHostedTempoCloseGuard(mpp, { assertReservedTempoClose } as unknown as
      HostedSettlementReportObligations);
    const credential = closeCredential();
    await expect(mpp.broadcastCredential(credential)).rejects.toThrow("original drain permit");
    expect(broadcastCredential).not.toHaveBeenCalled();
    mpp.permitHostedTempoClose!(credential, "reserved-close");
    await expect(mpp.broadcastCredential(credential)).resolves.toMatchObject({
      reference: "original-close",
    });
    expect(assertReservedTempoClose).toHaveBeenCalledWith("reserved-close", CHANNEL);
    expect(broadcastCredential).toHaveBeenCalledOnce();
    await expect(mpp.broadcastCredential(credential)).rejects.toThrow("original drain permit");
    expect(broadcastCredential).toHaveBeenCalledOnce();
  });

  it("consumes the original close permit before concurrent authentication waits", async () => {
    let releaseAssertion: (() => void) | undefined;
    const assertionStarted = new Promise<void>((resolve) => { releaseAssertion = resolve; });
    let allowAssertion: (() => void) | undefined;
    const assertionHeld = new Promise<void>((resolve) => { allowAssertion = resolve; });
    const broadcastCredential = vi.fn().mockResolvedValue({ reference: "one-close" });
    const assertReservedTempoClose = vi.fn(async () => {
      releaseAssertion?.();
      await assertionHeld;
    });
    const mpp = { broadcastCredential } as unknown as MppxServer;
    installHostedTempoCloseGuard(mpp, { assertReservedTempoClose } as unknown as
      HostedSettlementReportObligations);
    const credential = closeCredential();
    mpp.permitHostedTempoClose!(credential, "original-close");
    const first = mpp.broadcastCredential(credential);
    await assertionStarted;
    const second = mpp.broadcastCredential(credential);
    const assertionCountBeforeRelease = assertReservedTempoClose.mock.calls.length;
    allowAssertion?.();
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(assertionCountBeforeRelease).toBe(1);
    expect(firstResult).toMatchObject({ status: "fulfilled",
      value: { reference: "one-close" } });
    expect(secondResult).toMatchObject({ status: "rejected",
      reason: expect.objectContaining({ message: expect.stringContaining("original drain permit") }) });
    expect(broadcastCredential).toHaveBeenCalledOnce();
  });

  it("does not restore a close permit after its original reservation check fails", async () => {
    const broadcastCredential = vi.fn();
    const assertReservedTempoClose = vi.fn().mockRejectedValue(new Error("original drain expired"));
    const mpp = { broadcastCredential } as unknown as MppxServer;
    installHostedTempoCloseGuard(mpp, { assertReservedTempoClose } as unknown as
      HostedSettlementReportObligations);
    const credential = closeCredential();
    mpp.permitHostedTempoClose!(credential, "original-close");
    await expect(mpp.broadcastCredential(credential)).rejects.toThrow("original drain expired");
    await expect(mpp.broadcastCredential(credential)).rejects.toThrow("original drain permit");
    expect(assertReservedTempoClose).toHaveBeenCalledOnce();
    expect(broadcastCredential).not.toHaveBeenCalled();
  });
});
