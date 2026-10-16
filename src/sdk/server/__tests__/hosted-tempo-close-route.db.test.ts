/**
 * A hosted host's cooperative Tempo close, driven through the real drain route.
 *
 * Real: the Postgres credit ledger, Tempo session store, close intents,
 * hosting control and settlement-report obligations; the mppx handle from
 * `createMppFromOpts` with its Tempo session runtime, challenge authentication
 * and the stored-channel voucher check; the hosted close guard
 * `createDVMServer` installs; and, for the payout report, the real payout and
 * revenue reporters over the same pool.
 * Mocked: the chain, through the runtime's chain-operation seam for channel
 * state and close amounts and through a JSON-RPC stand-in for the recovery's
 * log search, and the broadcast beneath the guard. The broadcast stub refuses
 * a voucher the channel's signer did not sign, as mppx's close does before it
 * submits, and otherwise records whether the obligation row existed when it
 * ran. mppx's session method is wrapped only to keep the settlement callback
 * the SDK hands it; the stub fires that callback after a close it lands and
 * returns, with the arguments mppx's close passes.
 */
import { randomBytes, randomUUID } from "node:crypto";

import terminalCloseContract from "../../../../protocol-fixtures/tempo-close-terminal.json";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Credential, Errors as MppxErrors } from "mppx";
import { Session as TempoSession } from "mppx/tempo";
import pg from "pg";
import {
  type Client, createPublicClient, custom, defineChain, encodeAbiParameters, encodeEventTopics,
  type Hex, toHex, WaitForTransactionReceiptTimeoutError,
} from "viem";
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
import { HostingControl, signHostingClosure } from "../hosting-control";
import { retryHostedTempoCloseReport } from "../index";
import { HostedSettlementReportObligations, HOSTED_SETTLEMENT_UNRESOLVED_SQL } from "../hosting-settlement-report-obligations";
import { _testing, createMppFromOpts, type MppxServer } from "../mpp-setup";
import { PayoutReporter } from "../payout-reporter";
import { PostgresJobStore } from "../postgres-job-store";
import { RevenueReporter } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { PostgresTempoSessionStore } from "../tempo-session-store";

/** The `onSessionSettlement` the SDK last handed mppx's `tempo.session`. */
const mppxSession = vi.hoisted(() => ({
  onSessionSettlement: undefined as ((context: unknown) => unknown) | undefined,
}));
vi.mock("mppx/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mppx/server")>();
  const session = (parameters: Parameters<typeof actual.tempo.session>[0]) => {
    mppxSession.onSessionSettlement = parameters?.onSessionSettlement as
      ((context: unknown) => unknown) | undefined;
    return actual.tempo.session(parameters);
  };
  return { ...actual, tempo: Object.assign(
    (parameters: Parameters<typeof actual.tempo>[0]) => actual.tempo(parameters),
    actual.tempo, { session }
  ) };
});

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
const EXIT_TX_HASH = `0x${"7e".repeat(32)}` as const;
const HEAD = 1_000_000n;
const DEPOSIT = 200_000n;
const SPENT = 50_000n;

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-10-12T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};
const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

type BroadcastMode =
  | "lands"
  | "lands-then-receipt-times-out"
  /** mppx's verify fails on a chain read before anything is submitted. */
  | "fails-before-submit"
  /** Submitted, but the receipt wait gives up while the transaction is pending. */
  | "submits-then-times-out"
  /** The earlier pending close lands now, so mppx refuses this one on a finalized channel. */
  | "earlier-close-lands";

interface ChainLog {
  event: "ChannelClosed" | "CloseRequested" | "CloseRequestCancelled";
  block: bigint;
  txHash: Hex;
  from: Hex;
  /** A `CloseRequested`'s grace end, in seconds; long past unless set. */
  closeGraceEnd?: bigint;
}

/**
 * The JSON-RPC methods recovery's close search sends. Blocks at or above
 * `recentFrom` carry the current time; older ones the epoch, which ends a
 * search at the reservation's age.
 */
function fakeTempoRpc(args: {
  channelId: Hex; payer: Hex; head: bigint; recentFrom: bigint; logs: ChainLog[];
}) {
  const requests: { method: string; params: unknown[] }[] = [];
  const topicOf = (event: ChainLog["event"]) => encodeEventTopics({
    abi: TempoSession.Precompile.escrowAbi, eventName: event,
  })[0];
  const rpcLog = (log: ChainLog) => ({
    address: ESCROW,
    topics: encodeEventTopics({ abi: TempoSession.Precompile.escrowAbi, eventName: log.event,
      args: { channelId: args.channelId, payer: args.payer, payee: PAYEE as Hex } }),
    data: log.event === "ChannelClosed"
      ? encodeAbiParameters([{ type: "uint96" }, { type: "uint96" }], [SPENT, DEPOSIT - SPENT])
      : log.event === "CloseRequested"
        ? encodeAbiParameters([{ type: "uint256" }], [log.closeGraceEnd ?? 1n]) : "0x",
    blockNumber: toHex(log.block), blockHash: `0x${"b1".repeat(32)}`,
    transactionHash: log.txHash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
  });
  const request = async ({ method, params }: { method: string; params: unknown[] }) => {
    requests.push({ method, params });
    switch (method) {
      case "eth_blockNumber":
        return toHex(args.head);
      case "eth_getLogs": {
        const filter = params[0] as { topics: Hex[]; fromBlock: Hex; toBlock: Hex };
        return args.logs.filter((log) => topicOf(log.event) === filter.topics[0] &&
          log.block >= BigInt(filter.fromBlock) && log.block <= BigInt(filter.toBlock)).map(rpcLog);
      }
      case "eth_getBlockByNumber": {
        const number = params[0] === "latest" ? args.head : BigInt(params[0] as Hex);
        return { number: toHex(number), hash: `0x${"b2".repeat(32)}`,
          parentHash: `0x${"b3".repeat(32)}`, transactions: [], logsBloom: null, nonce: null,
          timestamp: toHex(number >= args.recentFrom ? Math.floor(Date.now() / 1000) : 0) };
      }
      case "eth_getTransactionByHash": {
        const log = args.logs.find((candidate) => candidate.txHash === params[0]);
        return log && { hash: log.txHash, from: log.from, to: ESCROW, input: "0x",
          blockNumber: toHex(log.block), blockHash: `0x${"b1".repeat(32)}`, nonce: "0x0",
          value: "0x0", gas: "0x0", gasPrice: "0x0", type: "0x0", transactionIndex: "0x0",
          v: "0x0", r: "0x0", s: "0x0", chainId: toHex(CHAIN_ID) };
      }
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  };
  const client = createPublicClient({
    chain: defineChain({ id: CHAIN_ID, name: "tempo-test",
      nativeCurrency: { name: "USD", symbol: "USD", decimals: 6 },
      rpcUrls: { default: { http: ["https://rpc.example.com"] } } }),
    transport: custom({ request }),
  });
  return { client, requests };
}

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

  /**
   * A server whose one Tempo-funded credit is backed by an open channel: a
   * resumed hosted server, or with `hosted: false` a self-hosted one.
   */
  async function hostedCredit(payer: PrivateKeyAccount, options: {
    modes?: BroadcastMode[];
    /** Whether a landing close leaves a `ChannelClosed` log for recovery to find. */
    closeLogged?: boolean;
    hosted?: boolean;
    reporting?: boolean;
    withoutExitCapability?: boolean;
    head?: bigint;
    recentFrom?: bigint;
    closeBlock?: bigint;
    /** Who sent the landing close: the channel's operator unless set. */
    closeSender?: Hex;
    /** Runs inside each broadcast before its mode; a returned mode replaces the queued one. */
    beforeBroadcast?: (call: number) => Promise<BroadcastMode | "refused-finalized" | undefined>;
  } = {}) {
    const modes = [...(options.modes ?? ["lands"])];
    const hosted = options.hosted ?? true;
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

    if (hosted) {
      const control = new HostingControl(pool, dvmId, { secret: SECRET, scope });
      await control.init();
      expect(await control.transition({ action: "resume", version: 2, dvmId, scope,
        generation: 1, leaseExpiresAtMs: Date.now() + 60_000, deadlineMs: Date.now() + 90_000,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}` })).toBe("ok");
    }

    const head = options.head ?? HEAD;
    const logs: ChainLog[] = [];
    const rpc = fakeTempoRpc({ channelId, payer: payer.address, head,
      recentFrom: options.recentFrom ?? head - 20_000n, logs });
    const getClient = () => rpc.client as unknown as Client;
    const settlements: unknown[] = [];
    const onSessionSettlement = (settlement: unknown) => { settlements.push(settlement); };
    const tempoSession = { store: sessions, account: operator, getClient,
      ...(!hosted && { onSessionSettlement }) };
    mppxSession.onSessionSettlement = undefined;
    const mpp = createMppFromOpts(
      { tempoRecipient: PAYEE, realm: "hosted.example", tempoSession },
      { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") } as NodeJS.ProcessEnv
    ) as MppxServer;
    // Read through a cast: the reset above narrows the property to `undefined`.
    const mppxCloseCallback = mppxSession.onSessionSettlement as
      ((context: unknown) => unknown) | undefined;
    // The chain, as the escrow sees it: open until a close lands, then
    // finalized with the payee's capture settled.
    const chain = { deposit: DEPOSIT, settled: 0n, closeRequestedAt: 0, pendingClose: false, rpcFailure: false };
    const landClose = () => {
      chain.deposit = 0n;
      chain.settled = SPENT;
      if (options.closeLogged ?? true) {
        logs.push({ event: "ChannelClosed", block: options.closeBlock ?? head - 3n,
          txHash: TX_HASH, from: options.closeSender ?? operator.address });
      }
    };
    // The obligations the host hands its Tempo session runtime, as `host.ts` does.
    const hostedObligations = new HostedSettlementReportObligations(pool, dvmId, scope);
    const readChannelClose = vi.fn(() => Promise.resolve({ settledToPayee: SPENT,
      refundedToPayer: DEPOSIT - SPENT }));
    const runtimeConfig = { ...tempoSession, ...(hosted && { hostedObligations }) };
    const chainOps = {
      // A sweep reads every open channel in the schema; the others stay open and idle.
      getChannelStatesBatch: (_client: Client, ids: Hex[]) => chain.rpcFailure && ids.includes(channelId)
        ? Promise.reject(new Error("RPC unavailable")) : Promise.resolve(ids.map((id) =>
        id.toLowerCase() === channelId.toLowerCase()
          ? { settled: chain.settled, deposit: chain.deposit, closeRequestedAt: chain.closeRequestedAt }
          : { settled: 0n, deposit: DEPOSIT, closeRequestedAt: 0 })),
      readChannelClose,
    };
    _testing.attachTempoSessionRuntime(mpp, runtimeConfig, chainOps);
    const broadcasts: { obligationStates: string[] }[] = [];
    // Installed before the server so the hosted close guard wraps it.
    mpp.broadcastCredential = async (input) => {
      const credential = typeof input === "string" ? Credential.deserialize(input) : input;
      const payload = credential.payload as { cumulativeAmount: string; signature: `0x${string}` };
      const { rows } = await pool.query<{ state: string }>(
        "SELECT state FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1 ORDER BY created_at_ms",
        [channelId]
      );
      broadcasts.push({ obligationStates: rows.map((row) => row.state) });
      const signed = TempoSession.Precompile.Voucher.verifyVoucher(ESCROW, CHAIN_ID, {
        channelId, cumulativeAmount: BigInt(payload.cumulativeAmount),
        signature: payload.signature }, payer.address);
      if (!signed) throw new MppxErrors.InvalidSignatureError({ reason: "invalid voucher signature" });
      const override = await options.beforeBroadcast?.(broadcasts.length);
      if (override === "refused-finalized") {
        throw new MppxErrors.VerificationFailedError({ reason: "channel is finalized on-chain" });
      }
      const queued = modes.length > 1 ? modes.shift()! : modes[0];
      const mode = override ?? queued;
      switch (mode) {
        case "fails-before-submit":
          throw new Error("eth_call failed: upstream RPC unavailable");
        case "submits-then-times-out":
          chain.pendingClose = true;
          throw new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH });
        case "earlier-close-lands":
          if (!chain.pendingClose) throw new Error("no earlier close is pending");
          landClose();
          throw new MppxErrors.VerificationFailedError({ reason: "channel is finalized on-chain" });
        case "lands-then-receipt-times-out":
          landClose();
          throw new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH });
        case "lands": {
          const settledBefore = chain.settled;
          landClose();
          try {
            await mppxCloseCallback?.(Object.freeze({ txHash: TX_HASH, channelId, trigger: "close",
              amount: SPENT, delta: SPENT - settledBefore }));
          } catch {
            // mppx isolates the callback's errors from the close.
          }
          return { method: "tempo", status: "success", reference: channelId, txHash: TX_HASH,
            timestamp: new Date().toISOString() } as never;
        }
      }
    };

    // Keep route recovery separate from explicit sweeps in this harness.
    const manualSweep = mpp.sweepTempoSessions;
    mpp.sweepTempoSessions = undefined;
    const routeLedger = options.withoutExitCapability ? new Proxy(ledger, {
      get(target, key) {
        if (key === "requireTempoDrainExit") return undefined;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) : ledger;
    const server = await createDVMServer(configureDVM({
      name: "hosted-tempo-close", capability: "echo", tag: "test", price: "$0.10",
      input: z.object({ text: z.string() }),
      onJob(ctx) { ctx.complete("done"); },
      credit: { min: "$0.10", max: "$5.00" },
      auth: secp256k1Auth(),
    }), {
      env: {}, store: new MemoryKVStore(), jobStore: jobs, db: pool, dvmId, fxFetcher: stubFx,
      creditLedger: routeLedger, mpp, hostingTempoSessionStore: sessions,
      ...(options.reporting && { platformUrl: "https://platform.example.com", platformToken: "local-token" }),
      ...(hosted && { hostingControl: { secret: SECRET, scope } }),
    });

    /** `payloadDescriptor: null` sends a close credential without a descriptor. */
    const drain = async (signer: PrivateKeyAccount, payloadDescriptor: unknown = descriptor) => {
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
        payload: { action: "close", channelId,
          ...(payloadDescriptor !== null && { descriptor: payloadDescriptor }),
          cumulativeAmount: SPENT.toString(), signature } }));
      const response = await server.app.request("/v1/credit", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: credential },
        body: JSON.stringify(request),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const obligations = async () => (await pool.query<{ state: string; tx_hash: string | null }>(
      `SELECT state, tx_hash FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1
       ORDER BY created_at_ms, id`,
      [channelId]
    )).rows;
    /** Age every obligation of this channel past the receipt-wait bound. */
    const ageObligations = () => pool.query(
      `UPDATE sdk_hosted_settlement_report_obligations
          SET updated_at_ms=updated_at_ms - 600000, created_at_ms=created_at_ms - 600000
        WHERE channel_id=$1`, [channelId]
    );
    /** Close searches started: each one first asks for the chain head. */
    const searches = () => rpc.requests.filter(({ method }) => method === "eth_blockNumber").length;
    return { server, mpp: { ...mpp, sweepTempoSessions: manualSweep }, creditId, channelId, dvmId, scope, drain, broadcasts, obligations,
      ageObligations, searches, settlements, logs, chain, operator, rpc, descriptor, readChannelClose, runtimeConfig, chainOps };
  }

  /** The real payout and revenue reporters over this pool, posting to a stubbed platform. */
  function payoutReporting(dvmId: string, scope: string) {
    const sentPayouts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.dvmId === dvmId && typeof body.payoutId === "string") sentPayouts.push(body);
      return new Response(null, { status: 200 });
    }));
    const reporterObligations = new HostedSettlementReportObligations(pool, dvmId, scope);
    reporterObligations.configureTempo({ network: `eip155:${CHAIN_ID}`, escrow: ESCROW,
      payee: PAYEE, token: TOKEN });
    const transport = new RevenueReporter(pool, "https://platform.invalid", "local-token",
      reporterObligations);
    const reporter = new PayoutReporter({ dvmId, db: pool, transport,
      hostedObligations: reporterObligations, snapshotIntervalMs: 50 });
    return {
      sentPayouts,
      payoutIds: () => [...new Set(sentPayouts.map((payout) => String(payout.payoutId)))].sort(),
      start: async () => {
        await transport.init();
        await reporter.init();
        reporter.start();
      },
      stop: () => {
        reporter.stop();
        vi.unstubAllGlobals();
      },
    };
  }

  /** Stand in for finality on the channel's submitted obligation, as the reporter's own tests do. */
  const observeFinal = (channelId: string) => pool.query(
    `UPDATE sdk_hosted_settlement_report_obligations
        SET block_hash=$2,block_number=10,delta_native=$3,state='observed'
      WHERE channel_id=$1 AND tx_hash IS NOT NULL`, [channelId, `0x${"bc".repeat(32)}`, SPENT.toString()]
  );

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

  it.each([
    ["no descriptor", null],
    ["malformed descriptor", { payee: "invalid" }],
    ["another channel's descriptor", { salt: `0x${"55".repeat(32)}` }],
    ["conflicting stored descriptor", "stored-conflict"],
  ])("refuses a close credential with %s before reserving and requires the timed exit",
    async (_name, override) => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const { server, creditId, drain, broadcasts, obligations, descriptor, channelId, chain, logs } =
        await hostedCredit(payer);
      const warn = vi.spyOn(loggers.tempo, "warn");
      try {
        if (override === "stored-conflict") {
          await sessions.put(channelId, { ...await sessions.get(channelId) as Record<string, unknown>,
            descriptor: { ...descriptor, salt: `0x${"44".repeat(32)}` } });
        }
        const refused = await drain(payer, typeof override === "string"
          ? descriptor : override && { ...descriptor, ...override });
        expect(refused.status).toBe(terminalCloseContract.status);
        expect(refused.body).toMatchObject({ ...terminalCloseContract.body, drain_id: "d1", channel_id: channelId });
        expect(broadcasts).toEqual([]);
        expect(await obligations()).toEqual([]);
        expect(await ledger.getDrain({ creditId, drainId: "d1" }))
          .toMatchObject({ status: "exit_required" });

        expect((await drain(payer)).status).toBe(409);
        expect(await obligations()).toEqual([]);
        expect(broadcasts).toEqual([]);
        expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
        expect(warn).toHaveBeenCalledWith("tempo_session_close_descriptor_refused",
          expect.objectContaining({ channel_id: channelId,
            amount_at_stake_native: "100000", amount_at_stake_micro: 100_000 }));
        expect(await sessions.getClose(channelId)).toMatchObject({ drainId: "d1" });
        chain.deposit = 0n;
        logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
        expect((await drain(payer)).status).toBe(200);
        expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent" });
        expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
        expect(broadcasts).toEqual([]);
      } finally {
        warn.mockRestore();
        await server.shutdown();
      }
    });

  it("reports the payout of a close that landed after its receipt wait timed out, once", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, dvmId, scope, drain, obligations, searches } =
      await hostedCredit(payer, { modes: ["lands-then-receipt-times-out"] });
    const reporting = payoutReporting(dvmId, scope);
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
      expect(searches()).toBe(1);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);

      await observeFinal(channelId);
      await reporting.start();
      await vi.waitFor(async () => {
        expect((await obligations())[0]?.state).toBe("delivered");
      }, { timeout: 4_000 });
      // Further reconcile ticks find nothing left to report.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(reporting.payoutIds()).toEqual([`tempo:${TX_HASH}`]);
      for (const payout of reporting.sentPayouts) {
        expect(payout).toMatchObject({ rail: "tempo", kind: "close", nativeAmount: Number(SPENT) });
      }
    } finally {
      reporting.stop();
      await server.shutdown();
    }
  });

  it("warns when recovery finds no close transaction for the reserved obligation", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, drain, obligations } = await hostedCredit(payer,
      { modes: ["lands-then-receipt-times-out"], closeLogged: false });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
      expect((await sessions.getClose(channelId))?.reference).toBe(`channel:${channelId}`);
      expect(await obligations()).toEqual([{ state: "unmatched", tx_hash: null }]);
      expect(warn).toHaveBeenCalledWith("tempo_session_close_recovery_unmatched",
        expect.objectContaining({ channel_id: channelId, drain_id: "d1" }));
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  describe("a close that failed before it reached the chain", () => {
    it("is retried once its reservation outlives the receipt wait", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const { server, creditId, channelId, drain, broadcasts, obligations, ageObligations } =
        await hostedCredit(payer, { modes: ["fails-before-submit", "lands"] });
      const warn = vi.spyOn(loggers.tempo, "warn");
      try {
        expect((await drain(payer)).status).toBe(402);
        expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
        // Inside the receipt wait the reservation still holds.
        expect((await drain(payer)).status).toBe(402);
        expect(broadcasts).toHaveLength(1);

        await ageObligations();
        const retried = await drain(payer);
        expect(retried.status).toBe(200);
        expect(broadcasts).toHaveLength(2);
        expect(await obligations()).toEqual([
          { state: "no_report", tx_hash: null },
          { state: "reserved", tx_hash: TX_HASH },
        ]);
        expect(await ledger.getDrain({ creditId, drainId: "d1" }))
          .toMatchObject({ status: "sent" });
        expect(warn).toHaveBeenCalledWith("tempo_session_close_reservation_released",
          expect.objectContaining({ channel_id: channelId, drain_id: "d1", attempt: 2 }));
      } finally {
        warn.mockRestore();
        await server.shutdown();
      }
    });

    it("still reports a released attempt's close that lands late, once", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const { server, creditId, channelId, dvmId, scope, drain, broadcasts, obligations,
        ageObligations } = await hostedCredit(payer,
        { modes: ["submits-then-times-out", "earlier-close-lands"] });
      const reporting = payoutReporting(dvmId, scope);
      try {
        expect((await drain(payer)).status).toBe(402);
        await ageObligations();
        // The retry retires the first reservation and reserves its successor;
        // the first attempt's close then lands and this one is refused.
        expect((await drain(payer)).status).toBe(200);
        expect(broadcasts).toHaveLength(2);
        expect(await obligations()).toEqual([
          { state: "no_report", tx_hash: null },
          { state: "reserved", tx_hash: TX_HASH },
        ]);
        // The refund came from the chain; the ledger balance was not restored.
        expect(await ledger.getDrain({ creditId, drainId: "d1" }))
          .toMatchObject({ status: "sent" });

        await observeFinal(channelId);
        await reporting.start();
        await vi.waitFor(async () => {
          expect((await obligations())[1]?.state).toBe("delivered");
        }, { timeout: 4_000 });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(reporting.payoutIds()).toEqual([`tempo:${TX_HASH}`]);
        for (const payout of reporting.sentPayouts) {
          expect(payout).toMatchObject({ kind: "close", nativeAmount: Number(SPENT) });
        }
      } finally {
        reporting.stop();
        await server.shutdown();
      }
    });

    it("is refused for the timed exit after three retired attempts", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const { server, creditId, channelId, drain, broadcasts, obligations, ageObligations } =
        await hostedCredit(payer, { modes: ["fails-before-submit"] });
      const warn = vi.spyOn(loggers.tempo, "warn");
      try {
        expect((await drain(payer)).status).toBe(402);
        for (let retry = 0; retry < 3; retry += 1) {
          await ageObligations();
          expect((await drain(payer)).status).toBe(402);
        }
        await ageObligations();
        await pool.query(`CREATE FUNCTION reject_terminal_drain() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.status='exit_required' THEN RAISE EXCEPTION 'terminal drain write unavailable'; END IF;
          RETURN NEW; END $$;
          CREATE TRIGGER reject_terminal_drain BEFORE UPDATE ON credit_drains
          FOR EACH ROW EXECUTE FUNCTION reject_terminal_drain()`);
        try {
          expect((await drain(payer)).status).toBe(402);
          expect((await obligations()).at(-1)).toEqual({ state: "reserved", tx_hash: null });
          expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending" });
        } finally {
          await pool.query("DROP TRIGGER reject_terminal_drain ON credit_drains; DROP FUNCTION reject_terminal_drain()");
        }
        const refused = await drain(payer);
        expect(refused.status).toBe(terminalCloseContract.status);
        expect(refused.body).toMatchObject({ ...terminalCloseContract.body, drain_id: "d1", channel_id: channelId });
        expect(broadcasts).toHaveLength(4);
        expect((await obligations()).map(({ state }) => state))
          .toEqual(["no_report", "no_report", "no_report", "exhausted"]);
        expect(warn).toHaveBeenCalledWith("tempo_session_close_attempts_exhausted",
          expect.objectContaining({ channel_id: channelId, drain_id: "d1", attempt: 4,
            amount_at_stake_native: SPENT.toString() }));
        expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required" });
        expect((await drain(payer)).status).toBe(409);
        expect(broadcasts).toHaveLength(4);
      } finally {
        warn.mockRestore();
        await server.shutdown();
      }
    });
  });

  it.each(["search", "receipt"])("reports an exhausted attempt that lands late through %s exactly once", async (landing) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, dvmId, scope, drain, obligations, ageObligations,
      chain, logs, operator } = await hostedCredit(payer, { modes: ["fails-before-submit"] });
    const reporting = payoutReporting(dvmId, scope);
    const reports = new HostedSettlementReportObligations(pool, dvmId, scope);
    try {
      expect((await drain(payer)).status).toBe(402);
      for (let retry = 0; retry < 3; retry += 1) {
        await ageObligations();
        expect((await drain(payer)).status).toBe(402);
      }
      await ageObligations();
      expect((await drain(payer)).status).toBe(409);
      expect((await obligations()).at(-1)).toEqual({ state: "exhausted", tx_hash: null });
      const retired = (await pool.query<{ id: string }>(
        "SELECT id FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1 AND state='no_report' LIMIT 1", [channelId])).rows[0];
      expect(await retryHostedTempoCloseReport({ db: pool, dvmId, scope, obligationId: retired.id })).toBe(false);
      chain.deposit = 0n;
      chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      if (landing === "receipt") {
        const ids = (await pool.query<{ id: string }>(
          "SELECT id FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1 ORDER BY created_at_ms,id", [channelId])).rows;
        // An old receipt follows the retired reservations to the exhausted one.
        await reports.recordSubmitted(ids[0].id, TX_HASH);
        await reports.recordSubmitted(ids.at(-1)!.id, TX_HASH);
      } else {
        await mpp.sweepTempoSessions!();
      }
      expect((await drain(payer)).status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent" });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
      await observeFinal(channelId);
      await reporting.start();
      await vi.waitFor(async () => expect((await obligations()).at(-1)?.state).toBe("delivered"), { timeout: 4_000 });
      await mpp.sweepTempoSessions!();
      expect(reporting.payoutIds()).toEqual([`tempo:${TX_HASH}`]);
      for (const payout of reporting.sentPayouts) {
        expect(payout).toMatchObject({ kind: "close", nativeAmount: Number(SPENT) });
      }
    } finally {
      reporting.stop();
      await server.shutdown();
    }
  });

  describe("a close the payer's timed exit overtook", () => {
    it.each([
      ["leaves only its close request in the log", false],
      ["also logs ChannelClosed from its withdraw", true],
    ])("resolves to no report when the exit %s", async (_name, withdrawLogsClose) => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const { server, channelId, drain, obligations, chain, logs } =
        await hostedCredit(payer, { modes: ["fails-before-submit"] });
      const warn = vi.spyOn(loggers.tempo, "warn");
      try {
        expect((await drain(payer)).status).toBe(402);
        expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
        // The payer requests close and, after the grace period, withdraws.
        chain.deposit = 0n;
        logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: `0x${"7d".repeat(32)}`,
          from: payer.address });
        if (withdrawLogsClose) {
          logs.push({ event: "ChannelClosed", block: HEAD - 10n, txHash: EXIT_TX_HASH,
            from: payer.address });
        }
        await drain(payer);
        expect(await obligations()).toEqual([{ state: "no_report", tx_hash: null }]);
        expect(warn).toHaveBeenCalledWith("tempo_session_close_exit_resolved",
          expect.objectContaining({ channel_id: channelId, drain_id: "d1" }));
      } finally {
        warn.mockRestore();
        await server.shutdown();
      }
    });
  });

  it("resumes a close search that exceeded its per-poll budget where it stopped", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    // Every block is younger than the reservation, so only the budget stops a pass.
    const { server, creditId, drain, obligations, rpc } = await hostedCredit(payer, {
      modes: ["lands-then-receipt-times-out"], head: 3_000_000n, recentFrom: 0n,
      closeBlock: 100_000n,
    });
    try {
      const first = await drain(payer);
      expect(first.status).toBe(402);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
      const firstPass = rpc.requests.length;

      expect((await drain(payer)).status).toBe(200);
      const secondPassLogs = rpc.requests.slice(firstPass)
        .filter(({ method }) => method === "eth_getLogs")
        .map(({ params }) => BigInt((params[0] as { toBlock: Hex }).toBlock));
      // It continued below the first pass rather than starting again from the head.
      expect(secondPassLogs[0]).toBe(500_000n);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
    } finally {
      await server.shutdown();
    }
  });

  it("fires a self-hosted settlement callback once for a close recovered after its receipt wait", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, drain, settlements, obligations } =
      await hostedCredit(payer, { modes: ["lands-then-receipt-times-out"], hosted: false });
    try {
      expect((await drain(payer)).status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
      expect((await sessions.getClose(channelId))?.reference).toBe(TX_HASH);
      expect(await drain(payer)).toMatchObject({ status: 200 });
      expect(settlements).toEqual([{ txHash: TX_HASH, channelId, trigger: "close",
        amount: SPENT, delta: SPENT }]);
      expect(await obligations()).toEqual([]);
    } finally {
      await server.shutdown();
    }
  });

  it("reports a released attempt's close that lands while its successor is mid-broadcast, once", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstDone!: Promise<{ status: number }>;
    // The first attempt is still inside mppx past the stale bound (RPC retries
    // ahead of its broadcast). Its close lands, and completes, while the retry
    // that retired its reservation is broadcasting under the successor.
    const ctx = await hostedCredit(payer, {
      beforeBroadcast: async (call) => {
        if (call === 1) {
          await firstGate;
          return "lands";
        }
        releaseFirst();
        await firstDone;
        return "refused-finalized";
      },
    });
    const { server, creditId, channelId, dvmId, scope, drain, broadcasts, obligations,
      ageObligations } = ctx;
    const reporting = payoutReporting(dvmId, scope);
    try {
      firstDone = drain(payer);
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1));
      await ageObligations();
      expect((await drain(payer)).status).toBe(200);
      expect((await firstDone).status).toBe(200);
      expect(await obligations()).toEqual([
        { state: "no_report", tx_hash: null },
        { state: "reserved", tx_hash: TX_HASH },
      ]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });

      await observeFinal(channelId);
      await reporting.start();
      await vi.waitFor(async () => {
        expect((await obligations())[1]?.state).toBe("delivered");
      }, { timeout: 4_000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(reporting.payoutIds()).toEqual([`tempo:${TX_HASH}`]);
      for (const payout of reporting.sentPayouts) {
        expect(payout).toMatchObject({ kind: "close", nativeAmount: Number(SPENT) });
      }
    } finally {
      reporting.stop();
      await server.shutdown();
    }
  });

  it("counts a close sent by the channel's payee as this DVM's close", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, drain, obligations } = await hostedCredit(payer, {
      modes: ["lands-then-receipt-times-out"], closeSender: PAYEE as Hex,
    });
    try {
      expect((await drain(payer)).status).toBe(200);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
    } finally {
      await server.shutdown();
    }
  });

  it("resolves a released drain's close obligation once the payer's timed exit finalizes", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, drain, obligations, chain, logs } =
      await hostedCredit(payer, { modes: ["fails-before-submit"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(402);
      // The payer requests close; its caller replays the saved close credential
      // during the grace period, and the drain is released.
      chain.closeRequestedAt = 1_700_000_000;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: `0x${"7d".repeat(32)}`,
        from: payer.address });
      expect((await drain(payer)).status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "released" });
      // A close of ours could still land during grace, so the obligation stays.
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);

      // The withdraw finalizes the channel. No drain poll reaches recovery now;
      // the session sweep does.
      chain.deposit = 0n;
      chain.closeRequestedAt = 0;
      await mpp.sweepTempoSessions!();
      expect(await obligations()).toEqual([{ state: "no_report", tx_hash: null }]);
      expect(warn).toHaveBeenCalledWith("tempo_session_close_exit_resolved",
        expect.objectContaining({ channel_id: channelId, drain_id: "d1" }));
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  describe("a self-hosted settlement callback", () => {
    it("fires once from mppx's own callback for a close that returned", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const { server, channelId, drain, settlements } =
        await hostedCredit(payer, { hosted: false });
      try {
        expect((await drain(payer)).status).toBe(200);
        expect(await drain(payer)).toMatchObject({ status: 200 });
        expect(settlements).toEqual([{ txHash: TX_HASH, channelId, trigger: "close",
          amount: SPENT, delta: SPENT }]);
        expect((await sessions.getClose(channelId))?.reference).toBe(TX_HASH);
      } finally {
        await server.shutdown();
      }
    });

    it("fires once when a concurrent poll recovers the close during the receipt wait", async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const ctx = await hostedCredit(payer, {
        hosted: false,
        beforeBroadcast: async (call) => {
          if (call === 1) {
            await firstGate;
            return "lands";
          }
          return "refused-finalized";
        },
      });
      const { server, channelId, drain, broadcasts, settlements, chain, logs, operator } = ctx;
      try {
        const first = drain(payer);
        await vi.waitFor(() => expect(broadcasts).toHaveLength(1));
        // The close lands while the first request still waits for its receipt.
        chain.deposit = 0n;
        chain.settled = SPENT;
        logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH,
          from: operator.address });
        expect((await drain(payer)).status).toBe(200);
        releaseFirst();
        expect((await first).status).toBe(200);
        expect(settlements).toEqual([{ txHash: TX_HASH, channelId, trigger: "close",
          amount: SPENT, delta: SPENT }]);
      } finally {
        await server.shutdown();
      }
    });
  });

  describe("a released drain's close obligation after the payer's timed exit", () => {
    /** Fail the first close, then release the drain on a poll during the payer's grace period. */
    async function releasedDuringGrace(options: Parameters<typeof hostedCredit>[1] & {
      requestBlock: bigint;
    }) {
      const payer = privateKeyToAccount(generatePrivateKey());
      const ctx = await hostedCredit(payer, { ...options, modes: ["fails-before-submit"] });
      expect((await ctx.drain(payer)).status).toBe(402);
      ctx.chain.closeRequestedAt = 1_700_000_000;
      ctx.logs.push({ event: "CloseRequested", block: options.requestBlock,
        txHash: `0x${"7d".repeat(32)}`, from: payer.address });
      expect((await ctx.drain(payer)).status).toBe(200);
      expect(await ledger.getDrain({ creditId: ctx.creditId, drainId: "d1" }))
        .toMatchObject({ status: "released" });
      expect(await ctx.obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
      // The withdraw finalizes the channel.
      ctx.chain.deposit = 0n;
      ctx.chain.closeRequestedAt = 0;
      return ctx;
    }

    it("resumes a search past its per-pass budget from the obligation's own cursor", async () => {
      // Every block is younger than the reservation, so only the budget stops a pass.
      const { server, mpp, obligations, rpc } = await releasedDuringGrace({
        head: 3_000_000n, recentFrom: 0n, requestBlock: 100_000n,
      });
      try {
        await mpp.sweepTempoSessions!();
        expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
        const firstPass = rpc.requests.length;

        await mpp.sweepTempoSessions!();
        const secondPassLogs = rpc.requests.slice(firstPass)
          .filter(({ method }) => method === "eth_getLogs")
          .map(({ params }) => BigInt((params[0] as { toBlock: Hex }).toBlock));
        // Releasing the drain deleted its close intent; the search still
        // continued below the first pass rather than starting from the head.
        expect(secondPassLogs[0]).toBe(500_000n);
        expect(await obligations()).toEqual([{ state: "no_report", tx_hash: null }]);
      } finally {
        await server.shutdown();
      }
    });

    it("is resolved by the hosting closure check without waiting for traffic", async () => {
      const { server, dvmId, scope, obligations } =
        await releasedDuringGrace({ requestBlock: HEAD - 900n });
      try {
        const command = { version: 3 as const, action: "certificate" as const, dvmId, scope,
          generation: 1, operationId: `operation_${randomUUID().replaceAll("-", "")}`,
          timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}` };
        const response = await server.app.request("/_hosting/closure-certificate", {
          method: "POST",
          headers: { "Content-Type": "application/json",
            "X-DVM-Hosting-Signature": signHostingClosure(SECRET, command) },
          body: JSON.stringify(command),
        });
        // Not closed yet, so no certificate; the obligation resolved before that answer.
        expect(response.status).toBe(409);
        expect(await obligations()).toEqual([{ state: "no_report", tx_hash: null }]);
      } finally {
        await server.shutdown();
      }
    });
  });

  it("terminalizes an unmatched released obligation after one search and stops polling", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    // Every block is younger than the reservation and no log matches (pruned or
    // lagging), so only block 0 ends a search.
    const { server, mpp, dvmId, scope, channelId, drain, obligations, chain, rpc, logs, operator } = await hostedCredit(payer,
      { modes: ["fails-before-submit"], recentFrom: 0n });
    const warn = vi.spyOn(loggers.tempo, "warn");
    const reporting = payoutReporting(dvmId, scope);
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.closeRequestedAt = 1_700_000_000;
      expect((await drain(payer)).status).toBe(200);
      chain.deposit = 0n;
      chain.closeRequestedAt = 0;
      const perPass: number[] = [];
      for (let pass = 0; pass < 3; pass += 1) {
        const before = rpc.requests.length;
        await mpp.sweepTempoSessions!();
        perPass.push(rpc.requests.length - before);
      }
      // Block zero definitively ends the search; later sweeps do no work.
      expect(perPass[0]).toBeGreaterThan(600);
      expect(perPass.slice(1)).toEqual([0, 0]);
      expect(await obligations()).toEqual([{ state: "unmatched", tx_hash: null }]);
      expect(warn).toHaveBeenCalledWith("tempo_session_close_recovery_unmatched",
        expect.objectContaining({ channel_id: channelId, amount_at_stake_native: SPENT.toString() }));
      const row = (await pool.query<{ id: string }>(
        "SELECT id FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1", [channelId])).rows[0];
      expect(await pool.query(
        "SELECT id FROM sdk_hosted_settlement_report_obligations WHERE id=$1 AND (" + HOSTED_SETTLEMENT_UNRESOLVED_SQL + ")", [row.id]))
        .toMatchObject({ rowCount: 1 });
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      expect(await retryHostedTempoCloseReport({ db: pool, dvmId, scope: "other", obligationId: row.id })).toBe(false);
      expect(await retryHostedTempoCloseReport({ db: pool, dvmId, scope, obligationId: row.id })).toBe(true);
      expect(await retryHostedTempoCloseReport({ db: pool, dvmId, scope, obligationId: row.id })).toBe(false);
      await mpp.sweepTempoSessions!();
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      await observeFinal(channelId);
      await reporting.start();
      await vi.waitFor(async () => expect((await obligations())[0]?.state).toBe("delivered"), { timeout: 4_000 });
      expect(reporting.payoutIds()).toEqual([`tempo:${TX_HASH}`]);
    } finally {
      reporting.stop();
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("writes a late landing past a successor retired while it waited for the row lock", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, dvmId, scope, channelId, drain, obligations, ageObligations } =
      await hostedCredit(payer, { modes: ["fails-before-submit"] });
    const reports = new HostedSettlementReportObligations(pool, dvmId, scope);
    reports.configureTempo({ network: `eip155:${CHAIN_ID}`, escrow: ESCROW, payee: PAYEE,
      token: TOKEN });
    const releasing = await pool.connect();
    try {
      expect((await drain(payer)).status).toBe(402);
      await ageObligations();
      expect((await drain(payer)).status).toBe(402);
      const ids = async () => (await pool.query<{ id: string }>(
        `SELECT id FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1
         ORDER BY created_at_ms, id`, [channelId])).rows.map(({ id }) => id);
      const [retired, successor] = await ids();

      // A second stale release holds the successor's row lock, as
      // releaseStaleTempoClose does, while the first attempt's close lands.
      await releasing.query("BEGIN");
      await releasing.query(
        "SELECT id FROM sdk_hosted_settlement_report_obligations WHERE id=$1 FOR UPDATE", [successor]
      );
      const landing = reports.recordSubmitted(retired, TX_HASH);
      await vi.waitFor(async () => {
        const waiting = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type='Lock'
              AND query LIKE '%sdk_hosted_settlement_report_obligations%FOR UPDATE%' AND pid <> $1`,
          [(await releasing.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid]
        );
        expect(Number(waiting.rows[0].n)).toBeGreaterThan(0);
      });
      // The release retires the successor and reserves the drain's next attempt.
      await releasing.query(
        "UPDATE sdk_hosted_settlement_report_obligations SET state='no_report' WHERE id=$1", [successor]
      );
      await releasing.query(
        `INSERT INTO sdk_hosted_settlement_report_obligations
           (id,source_key,dvm_id,scope,instance_id,boot_epoch,rail,operation,network,contract,
            channel_id,original,state)
         SELECT $2,source_key || ':next',dvm_id,scope,instance_id,boot_epoch,rail,operation,
                network,contract,channel_id,original,'reserved'
           FROM sdk_hosted_settlement_report_obligations WHERE id=$1`,
        [successor, randomUUID()]
      );
      await releasing.query("COMMIT");
      await landing;

      expect(await obligations()).toEqual([
        { state: "no_report", tx_hash: null },
        { state: "no_report", tx_hash: null },
        { state: "reserved", tx_hash: TX_HASH },
      ]);
    } finally {
      await releasing.query("ROLLBACK").catch(() => undefined);
      releasing.release();
      await server.shutdown();
    }
  });

  it.each(["descriptor", "exhausted"])("returns the timed-exit 409 for a custom ledger without terminal persistence: %s", async (refusal) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, drain, broadcasts, ageObligations } = await hostedCredit(payer,
      { withoutExitCapability: true, modes: ["fails-before-submit"] });
    try {
      if (refusal === "exhausted") {
        expect((await drain(payer)).status).toBe(402);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await ageObligations();
          expect((await drain(payer)).status).toBe(402);
        }
        await ageObligations();
      }
      const response = await drain(payer, refusal === "descriptor" ? null : undefined);
      expect(response).toMatchObject({ status: terminalCloseContract.nonPersisted.status,
        body: terminalCloseContract.nonPersisted.body });
      expect((await drain(payer, refusal === "descriptor" ? null : undefined)).status).toBe(409);
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
      expect(broadcasts).toHaveLength(refusal === "exhausted" ? 4 : 0);
    } finally {
      await server.shutdown();
    }
  });

  it.each([[false, "descriptor"], [true, "descriptor"], [false, "exhausted"], [true, "exhausted"]] as const)(
    "the sweep completes a timed-exit drain without another poll, unbacked=%s, refusal=%s", async (unbacked, refusal) => {
    const retryLoop = vi.spyOn(RevenueReporter.prototype, "startRetryLoop").mockImplementation(() => {});
    const payoutLoop = vi.spyOn(PayoutReporter.prototype, "start").mockImplementation(() => {});
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs, broadcasts, ageObligations } =
      await hostedCredit(payer, { reporting: true, modes: [refusal === "exhausted" ? "fails-before-submit" : "lands"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      if (refusal === "exhausted") {
        expect((await drain(payer)).status).toBe(402);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await ageObligations();
          expect((await drain(payer)).status).toBe(402);
        }
        await ageObligations();
        expect((await drain(payer)).status).toBe(409);
      } else {
        expect((await drain(payer, null)).status).toBe(409);
      }
      chain.deposit = 0n;
      chain.settled = unbacked ? 0n : SPENT;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      if (unbacked && refusal === "descriptor") {
        await pool.query(`CREATE FUNCTION reject_sweep_drain_report() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.kind='drain' THEN RAISE EXCEPTION 'drain report unavailable'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER reject_sweep_drain_report BEFORE INSERT ON pending_dvm_reports
          FOR EACH ROW EXECUTE FUNCTION reject_sweep_drain_report()`);
        try {
          await mpp.sweepTempoSessions!();
          expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required" });
          expect((await pool.query("SELECT id FROM pending_dvm_reports WHERE kind='drain' AND payload->>'creditId'=$1", [creditId])).rows)
            .toEqual([]);
        } finally {
          await pool.query("DROP TRIGGER reject_sweep_drain_report ON pending_dvm_reports; DROP FUNCTION reject_sweep_drain_report()");
        }
      }
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent",
        sentRef: { terminal_outcome: unbacked ? "payer_exit_unbacked" : "payer_exit",
          credit_unbacked: unbacked, settled_amount: unbacked ? "200000" : "150000" } });
      if (unbacked) expect((await drain(payer)).body).toMatchObject({ drain: terminalCloseContract.unbackedFinalizedDrain });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0, status: unbacked ? "unbacked" : "active" });
      expect(warn).toHaveBeenCalledWith(unbacked ? "tempo_session_drain_unbacked_resolved" : "tempo_session_drain_finalized",
        expect.objectContaining({ channel_id: channelId, amount_at_stake_native: "100000",
          builder_loss_native: unbacked ? "50000" : "0" }));
      const reports = async () => (await pool.query(
        "SELECT payload FROM pending_dvm_reports WHERE kind='drain' AND payload->>'creditId'=$1", [creditId])).rows;
      expect(await reports()).toEqual([{ payload: expect.objectContaining({ status: "sent", amountMicro: 100_000 }) }]);
      await mpp.sweepTempoSessions!();
      expect(await reports()).toHaveLength(1);
      expect((await drain(payer)).status).toBe(200);
      expect(broadcasts).toHaveLength(refusal === "exhausted" ? 4 : 0);
    } finally {
      warn.mockRestore();
      await server.shutdown();
      retryLoop.mockRestore();
      payoutLoop.mockRestore();
    }
  });

  it("reports a self-hosted late close once when the sweep completes a terminal refusal", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, drain, chain, logs, operator, settlements, readChannelClose } =
      await hostedCredit(payer, { hosted: false, modes: ["submits-then-times-out"] });
    try {
      expect((await drain(payer)).status).toBe(402);
      await ledger.requireTempoDrainExit({ creditId, drainId: "d1" });
      chain.deposit = 0n;
      chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      readChannelClose.mockResolvedValueOnce({ settledToPayee: SPENT, refundedToPayer: DEPOSIT - SPENT })
        .mockRejectedValueOnce(new Error("receipt RPC unavailable"));
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent" });
      expect(settlements).toEqual([expect.objectContaining({ txHash: TX_HASH, amount: SPENT, delta: SPENT, trigger: "close" })]);
      await mpp.sweepTempoSessions!();
      expect(settlements).toHaveLength(1);
      expect(readChannelClose).toHaveBeenCalledTimes(1);
    } finally {
      await server.shutdown();
    }
  });

  it.each(["missing history", "short refund", "missing collateral"])("keeps a timed-exit drain open with %s and emits its amount", async (missing) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs } = await hostedCredit(payer);
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer, null)).status).toBe(409);
      if (missing !== "missing history") {
        if (missing === "missing collateral") {
          await sessions.put(channelId, { ...await sessions.get(channelId) as Record<string, unknown>, finalized: true, deposit: 0n });
        } else {
          chain.settled = 150_001n;
        }
        logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      }
      chain.deposit = 0n;
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required" });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0, status: missing === "short refund" ? "active" : "unbacked" });
      expect(warn).toHaveBeenCalledWith("tempo_session_drain_refund_unproven",
        expect.objectContaining({ channel_id: channelId, amount_at_stake_native: "100000" }));
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("reports each unproven refund reason once across replicas without classifying RPC failures as proof", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, drain, chain, logs, runtimeConfig, chainOps } = await hostedCredit(payer);
    const warn = vi.spyOn(loggers.tempo, "warn");
    const reasons = () => warn.mock.calls.filter(([event, fields]) =>
      event === "tempo_session_drain_refund_unproven" && fields?.credit_id === creditId)
      .map(([, fields]) => fields?.reason);
    try {
      expect((await drain(payer, null)).status).toBe(409);
      chain.deposit = 0n;
      chain.settled = 150_001n;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      chain.rpcFailure = true;
      await mpp.reconcileTempoSessionCloses!();
      expect(reasons()).toEqual([]);
      expect(warn).toHaveBeenCalledWith("tempo_session_close_reconcile_failed",
        expect.objectContaining({ channel_id: channelId, drain_id: "d1", error: "RPC unavailable" }));
      chain.rpcFailure = false;
      await pool.query(`CREATE FUNCTION reject_warning_claim() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.channel_key=TG_ARGV[0] AND NEW.state_json::jsonb ? 'drainRefundWarnings'
          THEN RAISE EXCEPTION 'warning claim unavailable'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_warning_claim BEFORE UPDATE ON mpp_tempo_channels
        FOR EACH ROW EXECUTE FUNCTION reject_warning_claim('${channelId}')`);
      try {
        await mpp.reconcileTempoSessionCloses!();
        expect(reasons()).toEqual(["refund_short"]);
        expect(warn).toHaveBeenCalledWith("tempo_session_close_reconcile_failed",
          expect.objectContaining({ channel_id: channelId, drain_id: "d1", error: "warning claim unavailable" }));
      } finally {
        await pool.query("DROP TRIGGER reject_warning_claim ON mpp_tempo_channels; DROP FUNCTION reject_warning_claim()");
      }
      warn.mockClear();
      await mpp.reconcileTempoSessionCloses!();
      expect(reasons()).toEqual(["refund_short"]);
      await mpp.reconcileTempoSessionCloses!();
      expect(reasons()).toEqual(["refund_short"]);
      const replica = _testing.attachTempoSessionRuntime({} as MppxServer, runtimeConfig, chainOps);
      replica.useTempoCreditLedger!(ledger, async () => false);
      await replica.reconcileTempoSessionCloses!();
      expect(reasons()).toEqual(["refund_short"]);
      const stored = await sessions.get(channelId) as Record<string, unknown>;
      await sessions.put(channelId, { ...stored, depositBeforeFinalization: undefined });
      await replica.reconcileTempoSessionCloses!();
      expect(reasons()).toEqual(["refund_short", "collateral_missing"]);
      await mpp.reconcileTempoSessionCloses!();
      expect(reasons()).toEqual(["refund_short", "collateral_missing"]);
      await sessions.put(channelId, { ...await sessions.get(channelId) as Record<string, unknown>,
        depositBeforeFinalization: DEPOSIT });
      await mpp.reconcileTempoSessionCloses!();
      expect(reasons()).toEqual(["refund_short", "collateral_missing"]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required" });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("stops a paused search at the reservation time bound before reading an older payer request", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, channelId, drain, obligations, logs, rpc } = await hostedCredit(payer, {
      modes: ["lands-then-receipt-times-out"], closeLogged: false,
      head: 3_000_000n, recentFrom: 500_001n,
    });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      logs.push({ event: "CloseRequested", block: 496_000n, txHash: EXIT_TX_HASH, from: payer.address });
      expect((await drain(payer)).status).toBe(402);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
      expect((await pool.query(
        "SELECT close_search_before FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1", [channelId])).rows)
        .toEqual([{ close_search_before: "500000" }]);
      const before = rpc.requests.length;
      expect((await drain(payer)).status).toBe(200);
      expect(rpc.requests.slice(before).filter(({ method }) => method === "eth_getLogs")).toEqual([]);
      expect(warn).not.toHaveBeenCalledWith("tempo_session_close_exit_resolved", expect.anything());
      expect(await obligations()).toEqual([{ state: "unmatched", tx_hash: null }]);
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("never reads below the reservation's time bound when a search resumes", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    // The node misses our ChannelClosed on the first search. History holds an
    // older close request, from before the reservation, that the payer cancelled.
    const { server, mpp, drain, obligations, logs, operator, rpc } = await hostedCredit(payer,
      { modes: ["lands-then-receipt-times-out"], closeLogged: false });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      logs.push({ event: "CloseRequested", block: HEAD - 40_000n, txHash: `0x${"7c".repeat(32)}`,
        from: payer.address });
      expect((await drain(payer)).status).toBe(200);
      expect(await obligations()).toEqual([{ state: "unmatched", tx_hash: null }]);
      // The node catches up; the obligation stays unmatched for an operator.
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      const before = rpc.requests.length;
      for (let pass = 0; pass < 6; pass += 1) await mpp.sweepTempoSessions!();
      expect(await obligations()).toEqual([{ state: "unmatched", tx_hash: null }]);
      expect(rpc.requests.slice(before).filter(({ method }) => method === "eth_getLogs")).toEqual([]);
      expect(warn).not.toHaveBeenCalledWith("tempo_session_close_exit_resolved", expect.anything());
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("does not count a cancelled close request as the payer's exit", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, channelId, drain, obligations, chain, logs } =
      await hostedCredit(payer, { modes: ["fails-before-submit"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(402);
      // The channel finalized, but the node serves only a request the payer
      // then cancelled, not what finalized it.
      chain.deposit = 0n;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: `0x${"7d".repeat(32)}`,
        from: payer.address });
      logs.push({ event: "CloseRequestCancelled", block: HEAD - 800n,
        txHash: `0x${"7b".repeat(32)}`, from: payer.address });
      await drain(payer);
      expect(await obligations()).toEqual([{ state: "unmatched", tx_hash: null }]);
      expect(warn).toHaveBeenCalledWith("tempo_session_close_recovery_unmatched",
        expect.objectContaining({ channel_id: channelId, drain_id: "d1" }));
      expect(warn).not.toHaveBeenCalledWith("tempo_session_close_exit_resolved", expect.anything());
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("logs a self-hosted recovered close that finds no transaction", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, channelId, drain, settlements } = await hostedCredit(payer,
      { modes: ["lands-then-receipt-times-out"], closeLogged: false, hosted: false });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(200);
      expect(settlements).toEqual([]);
      expect(warn).toHaveBeenCalledWith("tempo_session_close_recovery_unmatched",
        expect.objectContaining({ channel_id: channelId, drain_id: "d1" }));
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("does not read a close request whose grace period has not ended as the payer's exit", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    // The payer's request landed while our close was in flight; our close then
    // landed, and the node misses its ChannelClosed when the drain recovers it.
    const { server, mpp, creditId, drain, obligations, logs, operator } = await hostedCredit(payer,
      { modes: ["lands-then-receipt-times-out"], closeLogged: false });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      logs.push({ event: "CloseRequested", block: HEAD - 10n, txHash: `0x${"7d".repeat(32)}`,
        from: payer.address, closeGraceEnd: BigInt(Math.floor(Date.now() / 1000) + 86_400) });
      expect((await drain(payer)).status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "sent" });
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
      expect(warn).not.toHaveBeenCalledWith("tempo_session_close_exit_resolved", expect.anything());

      // The node catches up, and the next sweep finds our close from the head.
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      await mpp.sweepTempoSessions!();
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("finds our close again after an operator reopens a wrongly resolved exit", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, dvmId, scope, channelId, drain, obligations, chain, logs, operator } =
      await hostedCredit(payer, { modes: ["fails-before-submit"] });
    try {
      expect((await drain(payer)).status).toBe(402);
      // A node that missed our ChannelClosed shows only the payer's past-grace
      // request, so the obligation resolves as an exit.
      chain.deposit = 0n;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: `0x${"7d".repeat(32)}`,
        from: payer.address });
      await drain(payer);
      expect(await obligations()).toEqual([{ state: "no_report", tx_hash: null }]);
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      await mpp.sweepTempoSessions!();
      expect(await obligations()).toEqual([{ state: "no_report", tx_hash: null }]);

      // The documented repair, once the node serves the escrow logs fully.
      const row = (await pool.query<{ id: string }>(
        "SELECT id FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1", [channelId])).rows[0];
      expect(await retryHostedTempoCloseReport({ db: pool, dvmId, scope, obligationId: row.id })).toBe(true);
      await mpp.sweepTempoSessions!();
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
    } finally {
      await server.shutdown();
    }
  });
});
