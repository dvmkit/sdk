/**
 * A hosted host's cooperative Tempo close, driven through the real drain route.
 *
 * Real: the Postgres credit ledger, Tempo session store, close intents,
 * hosting control and settlement-report obligations; the mppx handle from
 * `createMppFromOpts` with its Tempo session runtime, challenge authentication
 * and the stored-channel voucher check; the hosted close guard
 * `createDVMServer` installs; and, for the payout report, the real payout and
 * revenue reporters over the same pool.
 * Mocked: the chain, through the runtime's chain-operation seam, and the
 * broadcast beneath the guard. The broadcast stub refuses a voucher the
 * channel's signer did not sign, as mppx's close does before it submits, and
 * otherwise records whether the obligation row existed when it ran.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Credential, Errors as MppxErrors } from "mppx";
import { Session as TempoSession } from "mppx/tempo";
import pg from "pg";
import { type Client, WaitForTransactionReceiptTimeoutError } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loggers } from "../../../observability/loggers";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { HostingControl } from "../hosting-control";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { _testing, createMppFromOpts, type MppxServer } from "../mpp-setup";
import { PayoutReporter } from "../payout-reporter";
import { PostgresJobStore } from "../postgres-job-store";
import { RevenueReporter } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { PostgresTempoSessionStore } from "../tempo-session-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const SCHEMA = `hosted_tempo_close_${process.pid}`;
const SECRET = "test-only-hosting-close-secret-32-bytes!";
const CHAIN_ID = 4217;
const ESCROW = TempoSession.Precompile.Constants.tip20ChannelEscrow;
const PAYEE = `0x${"22".repeat(20)}`;
/** The mainnet payment token `resolveTempoNetwork` selects for chain 4217. */
const TOKEN = "0x20C000000000000000000000b9537d11c60E8b50";
const PRIVKEY = new Uint8Array(32).fill(7);
const CALLER = Buffer.from(schnorr.getPublicKey(PRIVKEY)).toString("hex");
const TX_HASH = `0x${"9a".repeat(32)}` as const;
const DEPOSIT = 200_000n;
const SPENT = 50_000n;

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-10-12T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};
const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

type BroadcastMode = "lands" | "lands-then-receipt-times-out";

describe.skipIf(!RUN)("hosted Tempo close through the drain route (real Postgres)", () => {
  let pool: pg.Pool;
  let sessions: PostgresTempoSessionStore;
  let ledger: CreditLedger;
  let jobs: PostgresJobStore;

  beforeAll(async () => {
    await recreateSchema(SCHEMA);
    pool = await pinnedPool(SCHEMA);
    sessions = new PostgresTempoSessionStore(pool);
    ledger = new CreditLedger(pool, sessions);
    jobs = new PostgresJobStore(pool);
    await Promise.all([sessions.init(), ledger.init(), jobs.init()]);
  });

  afterAll(async () => {
    await pool.end();
    await dropSchemas(SCHEMA);
  });

  /** A resumed hosted server whose one Tempo-funded credit is backed by an open channel. */
  async function hostedCredit(
    payer: PrivateKeyAccount, mode: BroadcastMode = "lands", closeOnChain = true
  ) {
    const dvmId = `dvm-${randomUUID()}`;
    const scope = `deployment-${randomUUID()}`;
    const operator = privateKeyToAccount(generatePrivateKey());
    const descriptor = {
      payer: payer.address, payee: PAYEE as `0x${string}`, operator: operator.address,
      token: TOKEN as `0x${string}`, authorizedSigner: payer.address,
      salt: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
      expiringNonceHash: `0x${randomBytes(32).toString("hex")}` as `0x${string}`,
    };
    const channelId = TempoSession.Precompile.Channel.computeId(
      { ...descriptor, chainId: CHAIN_ID, escrow: ESCROW }
    );
    const creditId = `credit-${randomUUID()}`;
    await sessions.put(channelId, {
      backend: "precompile", descriptor,
      channelId, chainId: CHAIN_ID, escrowContract: ESCROW, payee: PAYEE,
      payer: payer.address, authorizedSigner: payer.address, token: TOKEN,
      operator: operator.address, highestVoucherAmount: SPENT, settledOnChain: 0n,
      spent: SPENT, units: 0, deposit: DEPOSIT, closeRequestedAt: 0n, finalized: false,
    });
    await ledger.fund({
      creditId, callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
      expiryMs: Date.now() + 86_400_000,
      basis: { rail: "tempo", paidMsats: 0, nativeAmount: 100_000, nativeAsset: "usdc",
        tempoSession: { channelId, cumulativeAmount: SPENT.toString() } },
    });

    const control = new HostingControl(pool, dvmId, { secret: SECRET, scope });
    await control.init();
    expect(await control.transition({ action: "resume", version: 2, dvmId, scope,
      generation: 1, leaseExpiresAtMs: Date.now() + 60_000, deadlineMs: Date.now() + 90_000,
      timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}` })).toBe("ok");

    // Route resolution only checks the client's chain; every chain read goes
    // through the runtime's chain-operation seam below.
    const getClient = () => ({ chain: { id: CHAIN_ID } }) as unknown as Client;
    const tempoSession = { store: sessions, account: operator, getClient };
    const mpp = createMppFromOpts(
      { tempoRecipient: PAYEE, realm: "hosted.example", tempoSession },
      { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") } as NodeJS.ProcessEnv
    ) as MppxServer;
    // The chain, as the escrow sees it: open until a close lands, then
    // finalized with the payee's capture settled.
    const chain = { deposit: DEPOSIT, settled: 0n };
    const findChannelClose = vi.fn(async () =>
      (closeOnChain && chain.deposit === 0n ? TX_HASH : null));
    // The obligations the host hands its Tempo session runtime, as `host.ts` does.
    const hostedObligations = new HostedSettlementReportObligations(pool, dvmId, scope);
    _testing.attachTempoSessionRuntime(mpp, { ...tempoSession, hostedObligations }, {
      getChannelStatesBatch: () => Promise.resolve([
        { settled: chain.settled, deposit: chain.deposit, closeRequestedAt: 0 },
      ]),
      readChannelClose: () => Promise.resolve({ settledToPayee: SPENT,
        refundedToPayer: DEPOSIT - SPENT }),
      findChannelClose,
    });
    const broadcasts: { obligationStates: string[] }[] = [];
    // Installed before the server so the hosted close guard wraps it.
    mpp.broadcastCredential = async (input) => {
      const credential = typeof input === "string" ? Credential.deserialize(input) : input;
      const payload = credential.payload as { cumulativeAmount: string; signature: `0x${string}` };
      const { rows } = await pool.query<{ state: string }>(
        "SELECT state FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1",
        [channelId]
      );
      broadcasts.push({ obligationStates: rows.map((row) => row.state) });
      const signed = TempoSession.Precompile.Voucher.verifyVoucher(ESCROW, CHAIN_ID, {
        channelId, cumulativeAmount: BigInt(payload.cumulativeAmount),
        signature: payload.signature }, payer.address);
      if (!signed) throw new MppxErrors.InvalidSignatureError({ reason: "invalid voucher signature" });
      chain.deposit = 0n;
      chain.settled = SPENT;
      if (mode === "lands-then-receipt-times-out") {
        throw new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH });
      }
      return { method: "tempo", status: "success", reference: channelId, txHash: TX_HASH,
        timestamp: new Date().toISOString() } as never;
    };

    const server = await createDVMServer(configureDVM({
      name: "hosted-tempo-close", capability: "echo", tag: "test", price: "$0.10",
      input: z.object({ text: z.string() }),
      onJob(ctx) { ctx.complete("done"); },
      credit: { min: "$0.10", max: "$5.00" },
      auth: secp256k1Auth(),
    }), {
      env: {}, store: new MemoryKVStore(), jobStore: jobs, db: pool, dvmId, fxFetcher: stubFx,
      creditLedger: ledger, hostingControl: { secret: SECRET, scope }, mpp,
      hostingTempoSessionStore: sessions,
    });

    const drain = async (signer: PrivateKeyAccount) => {
      const request = creditSigner.signRequest(PRIVKEY, {
        op: "drain", credit_id: creditId, drain: { drain_id: "d1", method: "tempo" },
      });
      const challenge = await mpp.issueChallenge("tempo", "session", {
        amount: "0.050000", suggestedDeposit: "0.050000", unitType: "request",
        meta: { path: "/v1/credit", nonce: randomBytes(16).toString("hex") },
      });
      const signature = await TempoSession.Precompile.Voucher.signVoucher({} as Client, signer,
        { channelId, cumulativeAmount: SPENT }, ESCROW, CHAIN_ID);
      const credential = Credential.serialize(Credential.from({ challenge,
        payload: { action: "close", channelId, descriptor,
          cumulativeAmount: SPENT.toString(), signature } }));
      const response = await server.app.request("/v1/credit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: credential },
        body: JSON.stringify(request),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const obligations = async () => (await pool.query<{ state: string; tx_hash: string | null }>(
      "SELECT state, tx_hash FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1",
      [channelId]
    )).rows;
    return { server, creditId, channelId, dvmId, scope, drain, broadcasts, obligations,
      findChannelClose };
  }

  it("persists the close obligation before the broadcast and records its transaction", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, drain, broadcasts, obligations } = await hostedCredit(payer);
    try {
      expect(await drain(payer)).toMatchObject({ status: 200 });
      expect(broadcasts).toEqual([{ obligationStates: ["reserved"] }]);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
    } finally {
      await server.shutdown();
    }
  });

  it("leaves no obligation behind for a voucher the channel's signer did not sign", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, drain, broadcasts, obligations } = await hostedCredit(payer);
    try {
      const refused = await drain(privateKeyToAccount(generatePrivateKey()));
      expect(refused.status).toBe(402);
      expect(broadcasts).toEqual([]);
      expect(await obligations()).toEqual([]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "pending" });

      // The same drain then closes with the channel signer's voucher.
      const retried = await drain(payer);
      expect(retried.status).toBe(200);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
    } finally {
      await server.shutdown();
    }
  });

  it("reports the payout of a close that landed after its receipt wait timed out, once", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, dvmId, scope, drain, obligations, findChannelClose } =
      await hostedCredit(payer, "lands-then-receipt-times-out");
    const sentPayouts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { payoutId?: unknown };
      if (body.payoutId === `tempo:${TX_HASH}`) sentPayouts.push(body);
      return new Response(null, { status: 200 });
    }));
    const reporterObligations = new HostedSettlementReportObligations(pool, dvmId, scope);
    reporterObligations.configureTempo({ network: `eip155:${CHAIN_ID}`, escrow: ESCROW,
      payee: PAYEE, token: TOKEN });
    const transport = new RevenueReporter(pool, "https://platform.invalid", "local-token",
      reporterObligations);
    const reporter = new PayoutReporter({ dvmId, db: pool, transport,
      hostedObligations: reporterObligations, snapshotIntervalMs: 50 });
    try {
      // The drain completes from the landed chain state; its refund is owed
      // whether or not the receipt arrived.
      expect((await drain(payer)).status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
      // The close's transaction is on the obligation, which is what the payout
      // reporter needs to send the builder's payout report.
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      expect((await sessions.getClose(channelId))?.reference).toBe(TX_HASH);

      // A retried drain neither searches again nor rewrites the obligation.
      expect((await drain(payer)).status).toBe(200);
      expect(findChannelClose).toHaveBeenCalledOnce();
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);

      // Finality is a chain read; stand in for it as the reporter's own tests do.
      await pool.query(
        `UPDATE sdk_hosted_settlement_report_obligations
            SET block_hash=$2,block_number=10,delta_native=$3,state='observed'
          WHERE channel_id=$1`, [channelId, `0x${"bc".repeat(32)}`, SPENT.toString()]
      );
      await transport.init();
      await reporter.init();
      reporter.start();
      await vi.waitFor(async () => {
        expect((await obligations())[0]?.state).toBe("delivered");
      }, { timeout: 4_000 });
      // Further reconcile ticks find nothing left to report.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sentPayouts).toHaveLength(1);
      expect(sentPayouts[0]).toMatchObject({ rail: "tempo", kind: "close",
        nativeAmount: Number(SPENT) });
    } finally {
      reporter.stop();
      vi.unstubAllGlobals();
      await server.shutdown();
    }
  });

  it("warns when recovery finds no close transaction for the reserved obligation", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, drain, obligations } =
      await hostedCredit(payer, "lands-then-receipt-times-out", false);
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
      expect((await sessions.getClose(channelId))?.reference).toBe(`channel:${channelId}`);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
      expect(warn).toHaveBeenCalledWith("tempo_session_close_recovery_unmatched",
        expect.objectContaining({ channel_id: channelId, drain_id: "d1" }));
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });
});
