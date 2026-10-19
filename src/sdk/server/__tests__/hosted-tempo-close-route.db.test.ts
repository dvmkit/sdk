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
import { readFileSync } from "node:fs";

import terminalCloseContract from "../../../../protocol-fixtures/tempo-close-terminal.json";
import drainDecisionContract from "../../../../protocol-fixtures/tempo-drain-decisions.json";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Credential, Errors as MppxErrors } from "mppx";
import { Session as TempoSession } from "mppx/tempo";
import pg from "pg";
import {
  type Client, createPublicClient, custom, defineChain, encodeAbiParameters, encodeEventTopics,
  type Hex, toHex, WaitForTransactionReceiptTimeoutError,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import { loggers } from "../../../observability/loggers";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { Hono } from "hono";
import { buildAdminChallenge } from "../admin-cashu";
import { installAdminCreditRoutes } from "../admin-credit";
import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import { toLockPubkey } from "../lock-pubkey-store";
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
  const searchGate = { wait: undefined as (() => Promise<void>) | undefined };
  const timing = { latencyMs: 0, headTimestamp: undefined as bigint | undefined, blockTimestamp: undefined as bigint | undefined };
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
        await searchGate.wait?.();
        return toHex(args.head);
      case "eth_getLogs": {
        if (timing.latencyMs) await new Promise((resolve) => setTimeout(resolve, timing.latencyMs));
        const filter = params[0] as { topics: Hex[]; fromBlock: Hex; toBlock: Hex };
        return args.logs.filter((log) => topicOf(log.event) === filter.topics[0] &&
          log.block >= BigInt(filter.fromBlock) && log.block <= BigInt(filter.toBlock)).map(rpcLog);
      }
      case "eth_getBlockByNumber": {
        if (timing.latencyMs) await new Promise((resolve) => setTimeout(resolve, timing.latencyMs));
        const number = params[0] === "latest" ? args.head : BigInt(params[0] as Hex);
        return { number: toHex(number), hash: `0x${"b2".repeat(32)}`,
          parentHash: `0x${"b3".repeat(32)}`, transactions: [], logsBloom: null, nonce: null,
          timestamp: toHex(params[0] === "latest" && timing.headTimestamp !== undefined
            ? timing.headTimestamp : number >= args.recentFrom ? timing.blockTimestamp ?? BigInt(Math.floor(Date.now() / 1000)) : 0) };
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
  return { client, requests, searchGate, timing };
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
    consumedNative?: bigint;
    highestVoucherAmount?: bigint;
    lossEvidenceCapability?: { version: 1 | undefined };
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
    findChannelClose?: NonNullable<Parameters<typeof _testing.attachTempoSessionRuntime>[2]>["findChannelClose"];
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
      operator: operator.address, highestVoucherAmount: options.highestVoucherAmount ?? SPENT, settledOnChain: 0n,
      spent: options.consumedNative ?? SPENT, units: 0, deposit: DEPOSIT, closeRequestedAt: 0n, finalized: false,
    });
    await ledger.fund({
      creditId, callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
      expiryMs: Date.now() + 86_400_000,
      basis: { rail: "tempo", paidMsats: 0, nativeAmount: 100_000, nativeAsset: "usdc",
        tempoSession: { channelId, cumulativeAmount: (options.highestVoucherAmount ?? SPENT).toString() } },
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
    const readChannelClose = vi.fn((_client: Client, _channelId: Hex, _txHash: Hex) => Promise.resolve({ settledToPayee: SPENT,
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
      ...(options.findChannelClose && { findChannelClose: options.findChannelClose }),
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
    const routeLedger = options.withoutExitCapability || options.lossEvidenceCapability ? new Proxy(ledger, {
      get(target, key) {
        if (key === "requireTempoDrainExit" && options.withoutExitCapability) return undefined;
        if (key === "tempoCreditLossEvidenceVersion" && options.lossEvidenceCapability) return options.lossEvidenceCapability.version;
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
    const drain = async (signer: PrivateKeyAccount, payloadDescriptor: unknown = descriptor, drainId = "d1") => {
      const request = creditSigner.signRequest(PRIVKEY, {
        op: "drain", credit_id: creditId, drain: { drain_id: drainId, method: "tempo" },
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

  function decisionAdmin(dvmId: string, scope: string) {
    const secret = new Uint8Array(32).fill(17);
    const lock = toLockPubkey(`02${Buffer.from(schnorr.getPublicKey(secret)).toString("hex")}`);
    const reports = new HostedSettlementReportObligations(pool, dvmId, scope);
    const app = new Hono();
    installAdminCreditRoutes(app, { db: pool, dvmId, ledger, fxFetcher: stubFx,
      getLockPubkeyState: () => Promise.resolve({ current: lock, retired: [] }),
      nonceStore: new MemoryConsumedCredentialStore(), accumulatorWired: false, receiptIssuer: undefined,
      creditTtlMs: () => 86_400_000, creditCurrency: () => "usd", hostedSettlementReports: { store: reports },
      tempoDrainRail: () => Promise.resolve({ getTempoSessionCloseIntent: () => Promise.resolve(null) }) });
    return async (path: string, body?: unknown) => {
      const method = body === undefined ? "GET" : "POST";
      const nonceHex = randomUUID().replaceAll("-", "");
      const unixSeconds = Math.floor(Date.now() / 1000);
      const digest = buildAdminChallenge({ method, path: path.split("?")[0], dvmId, nonceHex, unixSeconds });
      return app.request(path, { method, headers: { Authorization: `P2PK ${nonceHex}.${unixSeconds}.${Buffer.from(schnorr.sign(digest, secret)).toString("hex")}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
  }

  async function listedDrain(admin: ReturnType<typeof decisionAdmin>, creditId: string): Promise<{ close_reports: unknown[] }> {
    let after: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await (await admin(`/admin/credit/tempo-drains?min_age_ms=0&evidence=false&limit=50${after ? `&after=${after}` : ""}`)).json() as {
        drains: { credit_id: string; close_reports: unknown[] }[]; next_after?: string;
      };
      const found = page.drains.find(row => row.credit_id === creditId);
      if (found) return found;
      after = page.next_after;
      if (after && seen.has(after)) throw new Error("The drain cursor did not advance");
      if (after) seen.add(after);
    } while (after);
    throw new Error("The held drain was absent from the admin listing");
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
      expect((await drain(payer)).status).toBe(409);
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "pending", sentRef: null });
      expect((await sessions.getClose(channelId))?.reference).toBeNull();
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

  it.each(["poll only", "poll joins sweep"])("pauses a slow caller search within its response budget: %s", async (mode) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, drain, chain, logs, operator, rpc, obligations } = await hostedCredit(payer, {
      modes: ["submits-then-times-out"], head: 3_000_000n, recentFrom: 0n,
    });
    let started!: () => void;
    const searching = new Promise<void>((resolve) => { started = resolve; });
    let sweep: Promise<void> | undefined;
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n;
      chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: 100_000n, txHash: TX_HASH, from: operator.address });
      rpc.timing.latencyMs = 35;
      if (mode === "poll joins sweep") {
        rpc.searchGate.wait = async () => { started(); };
        sweep = mpp.reconcileTempoSessionCloses!();
        await searching;
      }
      const before = performance.now();
      const result = await drain(payer);
      const elapsed = performance.now() - before;
      expect(result).toMatchObject({ status: 402, body: { retryable: true } });
      expect(elapsed).toBeLessThan(12_000);
      const cursor = (await pool.query<{ close_search_before: string | null }>(
        "SELECT close_search_before FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1", [channelId]
      )).rows[0].close_search_before;
      expect(cursor).not.toBeNull();
      expect(BigInt(cursor!)).toBeGreaterThan(100_000n);
      expect(BigInt(cursor!)).toBeLessThan(3_000_000n);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", sentRef: null });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
    } finally {
      rpc.timing.latencyMs = 0;
      await Promise.allSettled([sweep]);
      await server.shutdown();
    }
  }, 45_000);

  it("resumes a slow background close search without discarding its cursor", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, drain, chain, logs, operator, obligations, rpc } = await hostedCredit(payer, {
      modes: ["submits-then-times-out"], head: 3_000_000n, recentFrom: 0n,
      closeBlock: 100_000n,
    });
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n;
      chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: 100_000n, txHash: TX_HASH, from: operator.address });
      rpc.timing.latencyMs = 35;
      const cursors: Array<string | null> = [];
      for (let pass = 0; pass < 2; pass += 1) {
        await mpp.reconcileTempoSessionCloses!();
        cursors.push((await pool.query<{ close_search_before: string | null }>(
          "SELECT close_search_before FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1", [channelId]
        )).rows[0].close_search_before);
      }
      expect(cursors[0]).not.toBeNull();
      expect(BigInt(cursors[0]!)).toBeGreaterThan(100_000n);
      expect(BigInt(cursors[0]!)).toBeLessThan(3_000_000n);
      expect((await drain(payer)).status).toBe(200);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent",
        sentRef: { tx_hash: TX_HASH, settled_amount: "150000" } });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
    } finally {
      rpc.timing.latencyMs = 0;
      await server.shutdown();
    }
  }, 120_000);

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
    const { server, mpp, dvmId, scope, channelId, creditId, drain, obligations, chain, rpc, logs, operator, runtimeConfig, chainOps } = await hostedCredit(payer,
      { modes: ["fails-before-submit"], recentFrom: 0n });
    const warn = vi.spyOn(loggers.tempo, "warn");
    const reporting = payoutReporting(dvmId, scope);
    const restartPool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}`, max: 1, connectionTimeoutMillis: 1000 });
    let other: Awaited<ReturnType<typeof hostedCredit>> | undefined;
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
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, deposit: 0n, creditLossPending: true });
      expect(await ledger.get(creditId)).toMatchObject({ status: "active", balanceMicro: 100_000 });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "released", provenRefundNative: null, refundPaymentProven: false });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      await expect(ledger.draw({ creditId, drawId: "unmatched-no-spend", amountMicro: 1 })).rejects.toMatchObject({ code: "tempo_channel_closing" });

      // A restart reads unrelated saved channels while the terminal hosted search stays stopped.
      other = await hostedCredit(privateKeyToAccount(generatePrivateKey()));
      const restartedStore = new PostgresTempoSessionStore(restartPool);
      const restartedLedger = new CreditLedger(restartPool, restartedStore);
      const restartedObligations = new HostedSettlementReportObligations(restartPool, dvmId, scope);
      const readStates = vi.fn(chainOps.getChannelStatesBatch);
      const restarted = _testing.attachTempoSessionRuntime({} as MppxServer,
        { ...runtimeConfig, store: restartedStore, hostedObligations: restartedObligations },
        { ...chainOps, getChannelStatesBatch: readStates });
      restarted.useTempoCreditLedger!(restartedLedger);
      const beforeRestart = rpc.requests.length;
      await expect(restarted.sweepTempoSessions!()).resolves.toMatchObject({ inFlight: 1 });
      const readChannels = readStates.mock.calls.flatMap(([, ids]) => ids);
      expect(readChannels).not.toContain(channelId);
      expect(readChannels).toContain(other.channelId);
      expect(rpc.requests).toHaveLength(beforeRestart);
      // Another entrance cannot bypass the terminal history owner.
      expect(await restarted.settleTempoSessionChannel!(channelId)).toMatchObject({ outcome: "retryable_failure" });
      expect(rpc.requests).toHaveLength(beforeRestart);
      expect(await restartedStore.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true });
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      expect(await retryHostedTempoCloseReport({ db: pool, dvmId, scope: "other", obligationId: row.id })).toBe(false);
      expect(await retryHostedTempoCloseReport({ db: pool, dvmId, scope, obligationId: row.id })).toBe(true);
      expect(await retryHostedTempoCloseReport({ db: pool, dvmId, scope, obligationId: row.id })).toBe(false);
      await restarted.sweepTempoSessions!();
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      await observeFinal(channelId);
      await reporting.start();
      await vi.waitFor(async () => expect((await obligations())[0]?.state).toBe("delivered"), { timeout: 4_000 });
      expect(reporting.payoutIds()).toEqual([`tempo:${TX_HASH}`]);
    } finally {
      reporting.stop();
      warn.mockRestore();
      await restartPool.end();
      await other?.server.shutdown();
      await server.shutdown();
    }
  });

  it.each([false, true])("recovers another channel while its hosted history owner defers, lookup failure=%s", async failLookup => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const own = await hostedCredit(payer, { modes: ["fails-before-submit"] });
    const otherPayer = privateKeyToAccount(generatePrivateKey());
    const other = await hostedCredit(otherPayer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n });
    const owner = own.runtimeConfig.hostedObligations!;
    const findPending = owner.findPendingTempo.bind(owner);
    const lookup = vi.spyOn(owner, "findPendingTempo");
    try {
      expect((await own.drain(payer)).status).toBe(402);
      own.chain.closeRequestedAt = 1_700_000_000;
      expect((await own.drain(payer)).status).toBe(200);
      own.chain.deposit = 0n; own.chain.closeRequestedAt = 0;
      await own.mpp.sweepTempoSessions!();
      expect(await own.obligations()).toEqual([{ state: "unmatched", tx_hash: null }]);
      expect((await other.drain(otherPayer)).status).toBe(402);
      other.chain.deposit = 0n; other.chain.settled = SPENT;
      if (failLookup) lookup.mockImplementation((channelId, operation) => channelId === own.channelId
        ? Promise.reject(new Error("hosted owner lookup unavailable")) : findPending(channelId, operation));
      const keys = [own.channelId, other.channelId];
      const onlyChannels = new Proxy(sessions, { get(target, key) {
        if (key === "listActive") return () => Promise.all(keys.map(async channelId => ({
          key: channelId, state: await target.get(channelId) as Record<string, unknown>, updatedAt: 1,
        })));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const readStates = vi.fn((_client: Client, ids: Hex[]) => Promise.resolve(ids.map(id =>
        id === other.channelId ? { deposit: 0n, settled: SPENT, closeRequestedAt: 0 }
          : { deposit: 0n, settled: 0n, closeRequestedAt: 0 })));
      const search = vi.fn((_client: Client, channelId: Hex) => {
        if (channelId !== other.channelId) throw new Error("terminal channel history was searched");
        return Promise.resolve({ outcome: "closed" as const, txHash: TX_HASH, sender: other.operator.address });
      });
      const runtime = _testing.attachTempoSessionRuntime({} as MppxServer,
        { ...own.runtimeConfig, store: onlyChannels }, { ...other.chainOps, getChannelStatesBatch: readStates, findChannelClose: search });
      runtime.useTempoCreditLedger!(ledger);
      for (let pass = 0; pass < 2; pass += 1) {
        await expect(runtime.sweepTempoSessions!()).resolves.toEqual({ scanned: 2, closeRequested: 0, settled: 0, inFlight: 1 });
        expect(readStates.mock.calls.at(-1)?.[1]).toEqual([other.channelId]);
        expect(await sessions.get(own.channelId)).toMatchObject({ finalized: true, creditLossPending: true });
        expect(await ledger.getDrain({ creditId: own.creditId, drainId: "d1" })).toMatchObject({ status: "released", provenRefundNative: null, refundPaymentProven: false });
        expect(await sessions.get(other.channelId)).toMatchObject({ finalized: true, creditLossPending: false });
        expect(await ledger.getDrain({ creditId: other.creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: "150000", refundPaymentProven: true });
        expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=ANY($1)", [[own.creditId, other.creditId]])).rows).toEqual([]);
      }
      expect(search.mock.calls.every(([, channelId]) => channelId === other.channelId)).toBe(true);
      await expect(ledger.draw({ creditId: own.creditId, drawId: "deferred-no-spend", amountMicro: 1 })).rejects.toMatchObject({ code: "tempo_channel_closing" });
    } finally { lookup.mockRestore(); await other.server.shutdown(); await own.server.shutdown(); }
  });

  it("uses a known close receipt and retained proof across a hosted unmatched capability retry", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const capability = { version: undefined as 1 | undefined };
    const { server, mpp, channelId, creditId, drain, chain, obligations, readChannelClose, rpc, runtimeConfig } = await hostedCredit(payer,
      { modes: ["fails-before-submit"], highestVoucherAmount: 150_000n, lossEvidenceCapability: capability });
    const owner = runtimeConfig.hostedObligations!;
    const findPending = owner.findPendingTempo.bind(owner);
    const lookup = vi.spyOn(owner, "findPendingTempo");
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n; chain.settled = SPENT;
      await mpp.sweepTempoSessions!();
      expect(await obligations()).toEqual([{ state: "unmatched", tx_hash: null }]);
      await sessions.confirmClose(channelId, "d1", TX_HASH);
      lookup.mockClear();
      lookup.mockImplementation((id, operation) => id === channelId
        ? Promise.reject(new Error("history owner read must not block a known receipt")) : findPending(id, operation));
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 50_000n });
      const before = rpc.requests.length;
      await mpp.getTempoSessionDrainState!(channelId);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ provenRefundNative: "50000", refundPaymentProven: true });
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      capability.version = 1;
      for (let pass = 0; pass < 2; pass += 1) await mpp.sweepTempoSessions!();
      expect(rpc.requests).toHaveLength(before);
      expect(lookup.mock.calls.filter(([id]) => id === channelId)).toEqual([]);
      expect(readChannelClose).toHaveBeenCalledWith(expect.anything(), channelId, TX_HASH);
      expect((await pool.query("SELECT loss_native,settled_on_chain_native,refunded_to_payer_native FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows)
        .toEqual([{ loss_native: "50000", settled_on_chain_native: "50000", refunded_to_payer_native: "50000" }]);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: false });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: "50000", refundPaymentProven: true });
    } finally { lookup.mockRestore(); await server.shutdown(); }
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
          expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required", provenRefundNative: null, refundPaymentProven: true });
          expect((await pool.query("SELECT id FROM pending_dvm_reports WHERE kind='drain' AND payload->>'creditId'=$1", [creditId])).rows)
            .toEqual([]);
        } finally {
          await pool.query("DROP TRIGGER reject_sweep_drain_report ON pending_dvm_reports; DROP FUNCTION reject_sweep_drain_report()");
        }
      }
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent", provenRefundNative: null, refundPaymentProven: true,
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

  it.each(["poll recovery", "close sweep", "settlement sweep", "state read", "targeted settlement", "intent recovery"] as const)(
    "preserves refunded voucher headroom across %s", async (entry) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs, operator, readChannelClose } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object, highestVoucherAmount: 150_000n }, result: undefined }));
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n;
      chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      if (entry === "poll recovery") {
        readChannelClose.mockRejectedValue(new Error("receipt unavailable"));
        expect((await drain(payer)).status).toBe(402);
        expect(await ledger.get(creditId)).toMatchObject({ status: "active" });
        expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
        readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 150_000n });
      } else if (entry === "close sweep") {
        await ledger.requireTempoDrainExit({ creditId, drainId: "d1" });
        await mpp.reconcileTempoSessionCloses!();
      } else if (entry === "settlement sweep") {
        await ledger.requireTempoDrainExit({ creditId, drainId: "d1" });
        await mpp.sweepTempoSessions!();
      } else if (entry === "state read") {
        expect(await mpp.getTempoSessionDrainState!(channelId)).toMatchObject({ finalized: true, deposit: 0n });
      } else if (entry === "targeted settlement") {
        expect(await mpp.settleTempoSessionChannel!(channelId)).toMatchObject({ outcome: "already_safe" });
      } else {
        expect(await mpp.recoverTempoSessionClose!(channelId, "d1")).toBe(TX_HASH);
      }
      expect((await drain(payer)).status).toBe(200);
      expect(await ledger.get(creditId)).toMatchObject({ status: "active", balanceMicro: 0 });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent",
        sentRef: { terminal_outcome: "cooperative_close", credit_unbacked: false } });
      expect(warn.mock.calls.filter(([event, fields]) => event === "tempo_session_drain_unbacked_resolved" && fields?.credit_id === creditId)).toEqual([]);
      const completions = () => warn.mock.calls.filter(([event, fields]) => event === "tempo_session_drain_finalized" && fields?.credit_id === creditId);
      expect(completions()).toEqual([["tempo_session_drain_finalized", expect.objectContaining({ builder_loss_native: "0", refund_native: "150000" })]]);
      expect((await drain(payer)).status).toBe(200);
      await mpp.sweepTempoSessions!();
      expect(completions()).toHaveLength(1);
    } finally { warn.mockRestore(); await server.shutdown(); }
  });

  it.each(["receipt unavailable", "history incomplete", "positive payment only", "exact amount without close"] as const)(
    "defers permanent loss and retries a finalized ordinary sweep with %s", async (missing) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs, operator, readChannelClose } = await hostedCredit(payer);
    try {
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object, highestVoucherAmount: 150_000n }, result: undefined }));
      if (missing === "positive payment only" || missing === "exact amount without close") {
        expect((await drain(payer, null)).status).toBe(409);
        if (missing === "positive payment only") await ledger.recordTempoDrainPayment({ creditId, drainId: "d1" });
        else await ledger.recordTempoDrainRefund({ creditId, drainId: "d1", refundedNative: 150_000n });
      }
      chain.deposit = 0n;
      chain.settled = SPENT;
      if (missing === "receipt unavailable") {
        logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
        readChannelClose.mockRejectedValue(new Error("receipt unavailable"));
      }
      await mpp.sweepTempoSessions!();
      expect(await ledger.get(creditId)).toMatchObject({ status: "active" });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, deposit: 0n, creditLossPending: true });
      await expect(ledger.draw({ creditId, drawId: "cannot-spend-finalized", amountMicro: 1 })).rejects.toMatchObject({ code: "tempo_channel_closing" });
      expect((await sessions.listActive()).some(row => row.key === channelId)).toBe(true);
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 150_000n });
      if (missing !== "receipt unavailable") logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      await mpp.sweepTempoSessions!();
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: false });
      expect((await sessions.listActive()).some(row => row.key === channelId)).toBe(false);
      expect(await ledger.get(creditId)).toMatchObject({ status: "active" });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
    } finally { await server.shutdown(); }
  });

  it.each([0n, 100_000n])("persists only the residual cooperative loss with refund %s", async refundedToPayer => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs, operator, readChannelClose } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object, highestVoucherAmount: DEPOSIT }, result: undefined }));
      expect((await drain(payer)).status).toBe(402);
      await ledger.requireTempoDrainExit({ creditId, drainId: "d1" });
      chain.deposit = 0n;
      chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer });
      await mpp.sweepTempoSessions!();
      const residual = refundedToPayer === 0n ? "150000" : "50000";
      const loss = (await pool.query("SELECT settled_on_chain_native, refunded_to_payer_native, loss_native, loss_basis FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows;
      expect(loss).toEqual([{ settled_on_chain_native: "50000", refunded_to_payer_native: refundedToPayer.toString(), loss_native: residual, loss_basis: "cooperative_close" }]);
      expect(await ledger.get(creditId)).toMatchObject({ status: "unbacked", availableMicro: 0 });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject(refundedToPayer === 0n
        ? { status: "exit_required", sentRef: null, provenRefundNative: "0" }
        : { status: "sent", sentRef: { credit_unbacked: true, terminal_outcome: "cooperative_close_unbacked" } });
      if (refundedToPayer > 0n) expect(warn).toHaveBeenCalledWith("tempo_session_drain_unbacked_resolved",
        expect.objectContaining({ credit_id: creditId, builder_loss_native: "50000" }));
      // Later money cannot erase an independently established loss.
      await ledger.terminalizeTempoCredits({ channelId, settledOnChainNative: SPENT,
        highestVoucherNative: DEPOSIT, consumedNative: SPENT, refundedToPayerNative: DEPOSIT });
      await mpp.sweepTempoSessions!();
      expect((await pool.query("SELECT settled_on_chain_native, refunded_to_payer_native, loss_native, loss_basis FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual(loss);
      expect(await ledger.get(creditId)).toMatchObject({ status: "unbacked" });
    } finally { warn.mockRestore(); await server.shutdown(); }
  });

  it.each([
    { highest: 50_000n, settled: 0n, realConsumption: false },
    { highest: 150_000n, settled: 0n, realConsumption: true },
    { highest: 150_000n, settled: 50_000n, realConsumption: true },
  ])("classifies payer-exit earned loss rather than unused authority: $highest/$settled, settled draw=$realConsumption", async ({ highest, settled, realConsumption }) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs } = await hostedCredit(payer,
      { consumedNative: realConsumption ? 0n : SPENT });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      if (realConsumption) {
        await ledger.draw({ creditId, drawId: "earned", amountMicro: 50_000 });
        await ledger.settle({ creditId, drawId: "earned" });
        expect(await ledger.getDraw({ creditId, drawId: "earned" })).toMatchObject({ status: "settled", amountMicro: 50_000 });
        expect(await sessions.get(channelId)).toMatchObject({ spent: 50_000n });
      }
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object, highestVoucherAmount: highest }, result: undefined }));
      expect((await drain(payer, null)).status).toBe(409);
      chain.deposit = 0n;
      chain.settled = settled;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      await mpp.sweepTempoSessions!();
      const lost = settled === 0n;
      const losses = (await pool.query("SELECT highest_voucher_native, consumed_native, settled_on_chain_native, refunded_to_payer_native, loss_native, loss_basis FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows;
      expect(losses).toEqual(lost ? [{ highest_voucher_native: highest.toString(), consumed_native: "50000",
        settled_on_chain_native: "0", refunded_to_payer_native: null, loss_native: "50000", loss_basis: "payer_exit" }] : []);
      expect(await ledger.get(creditId)).toMatchObject({ status: lost ? "unbacked" : "active" });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent", provenRefundNative: null,
        sentRef: { terminal_outcome: lost ? "payer_exit_unbacked" : "payer_exit", credit_unbacked: lost } });
      expect(warn).toHaveBeenCalledWith(lost ? "tempo_session_drain_unbacked_resolved" : "tempo_session_drain_finalized",
        expect.objectContaining({ credit_id: creditId, builder_loss_native: lost ? "50000" : "0",
          refund_native: settled === 0n ? "200000" : "150000" }));
      await mpp.sweepTempoSessions!();
      expect((await pool.query("SELECT loss_native FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows)
        .toEqual(lost ? [{ loss_native: "50000" }] : []);
    } finally { warn.mockRestore(); await server.shutdown(); }
  });

  it.each(["cooperative partial", "cooperative zero", "payer exit"] as const)("defers a legacy custom positive %s loss until capability upgrade", async kind => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const capability = { version: undefined as 1 | undefined };
    const cooperative = kind !== "payer exit";
    const exactRefund = kind === "cooperative zero" ? 0n : 10_000n;
    const { server, mpp, channelId, creditId, dvmId, scope, drain, chain, logs, operator, readChannelClose } = await hostedCredit(payer,
      { highestVoucherAmount: cooperative ? 30_000n : 150_000n,
        consumedNative: cooperative ? 10_000n : 50_000n, lossEvidenceCapability: capability });
    const mutationBomb = vi.spyOn(ledger, "terminalizeTempoCredits").mockRejectedValue(new Error("legacy positive permanent mutation invoked"));
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer, null)).status).toBe(409);
      chain.deposit = 0n;
      chain.settled = cooperative ? 10_000n : 0n;
      logs.push(cooperative ? { event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address }
        : { event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      if (cooperative) readChannelClose.mockResolvedValue({ settledToPayee: 10_000n, refundedToPayer: exactRefund });
      const proofWrite = cooperative ? vi.spyOn(ledger, "recordTempoDrainRefund") : vi.spyOn(ledger, "recordTempoDrainPayment");
      proofWrite.mockRejectedValue(new Error("refund evidence unavailable"));
      await expect(mpp.sweepTempoSessions!()).resolves.toMatchObject({ inFlight: 1 });
      expect(warn).toHaveBeenCalledWith("tempo_drain_refund_evidence_write_failed", { amount_micro: 100_000 });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required", sentRef: null });
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true });
      await expect(ledger.draw({ creditId, drawId: "proof-failure-cannot-spend", amountMicro: 1 })).rejects.toMatchObject({ code: "tempo_channel_closing" });
      proofWrite.mockRestore();
      await mpp.sweepTempoSessions!();
      expect(mutationBomb).not.toHaveBeenCalled();
      expect(await ledger.get(creditId)).toMatchObject({ status: "active" });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required", sentRef: null,
        provenRefundNative: cooperative ? exactRefund.toString() : null, refundPaymentProven: kind !== "cooperative zero" });
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      expect(warn.mock.calls.filter(([event, fields]) => fields?.credit_id === creditId &&
        (event === "tempo_session_drain_finalized" || event === "tempo_session_drain_unbacked_resolved"))).toEqual([]);
      await expect(ledger.draw({ creditId, drawId: "legacy-cannot-spend", amountMicro: 1 })).rejects.toMatchObject({ code: "tempo_channel_closing" });
      if (kind !== "cooperative zero") {
        const refused = await decisionAdmin(dvmId, scope)("/admin/credit/release-tempo-drain", {
          credit_id: creditId, drain_id: "d1", reason: "No refund was paid" });
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ error: "tempo_drain_refund_paid" });
      }
      mutationBomb.mockRestore();
      capability.version = 1;
      await mpp.sweepTempoSessions!();
      const expected = [{ settled_on_chain_native: cooperative ? "10000" : "0", loss_native: cooperative ? (kind === "cooperative zero" ? "20000" : "10000") : "50000",
        refunded_to_payer_native: cooperative ? exactRefund.toString() : null, loss_basis: cooperative ? "cooperative_close" : "payer_exit" }];
      expect((await pool.query("SELECT settled_on_chain_native, loss_native, refunded_to_payer_native, loss_basis FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual(expected);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: false });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: cooperative ? "exit_required" : "sent" });
      await mpp.sweepTempoSessions!();
      expect((await pool.query("SELECT settled_on_chain_native, loss_native, refunded_to_payer_native, loss_basis FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual(expected);
      expect(warn.mock.calls.filter(([event, fields]) => event === "tempo_session_drain_unbacked_resolved" && fields?.credit_id === creditId))
        .toHaveLength(cooperative ? 0 : 1);
    } finally { mutationBomb.mockRestore(); warn.mockRestore(); await server.shutdown(); }
  });

  it.each([
    { name: "legacy cooperative partial", version: undefined, refund: 50_000n, exit: false, hosted: true },
    { name: "v1 cooperative partial", version: 1, refund: 50_000n, exit: false, hosted: true },
    { name: "v1 cooperative covering", version: 1, refund: 100_000n, exit: false, hosted: true },
    { name: "legacy payer exit", version: undefined, refund: 0n, exit: true, hosted: true },
    { name: "self-hosted cooperative covering", version: 1, refund: 100_000n, exit: false, hosted: false },
  ] as const)("retains pending channel-only payment proof before RELEASE: $name", async ({ version, refund, exit, hosted }) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const capability = { version: version as 1 | undefined };
    const { server, mpp, channelId, creditId, dvmId, scope, drain, chain, logs, operator, readChannelClose } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n,
        lossEvidenceCapability: capability, hosted });
    await new RevenueReporter(pool, "https://platform.example.com", "local-token").init();
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(402);
      const balance = (await pool.query("SELECT balance_micro, native_remaining, msats_remaining FROM credits WHERE credit_id=$1", [creditId])).rows;
      chain.deposit = 0n;
      chain.settled = exit ? 0n : SPENT;
      logs.push(exit ? { event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address }
        : { event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: refund });
      const expectedLoss = exit || refund === 50_000n ? "50000" : undefined;
      const lossRows = async () => (await pool.query(
        "SELECT loss_native, refunded_to_payer_native, loss_basis FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows;
      const expectedRows = expectedLoss ? [{ loss_native: expectedLoss,
        refunded_to_payer_native: exit ? null : refund.toString(), loss_basis: exit ? "payer_exit" : "cooperative_close" }] : [];
      const assertHeld = async () => {
        expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", sentRef: null,
          operatorDecision: null, provenRefundNative: exit ? null : refund.toString(), refundPaymentProven: true });
        expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0, availableMicro: 0 });
        expect((await ledger.listPendingDrains()).filter(row => row.creditId === creditId))
          .toEqual([expect.objectContaining({ drainId: "d1", amountMicro: 100_000, status: "pending" })]);
        const release = await decisionAdmin(dvmId, scope)("/admin/credit/release-tempo-drain", {
          credit_id: creditId, drain_id: "d1", reason: "No refund was paid" });
        expect(release.status).toBe(409);
        expect(await release.json()).toMatchObject({ error: "tempo_drain_refund_paid" });
        expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0, availableMicro: 0 });
        expect((await pool.query("SELECT balance_micro, native_remaining, msats_remaining FROM credits WHERE credit_id=$1", [creditId])).rows).toEqual(balance);
        expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", operatorDecision: null });
        expect((await pool.query("SELECT payload FROM pending_dvm_reports WHERE kind='drain' AND payload->>'creditId'=$1", [creditId])).rows).toEqual([]);
      };
      await mpp.sweepTempoSessions!();
      await assertHeld();
      expect(await lossRows()).toEqual(version === 1 ? expectedRows : []);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, deposit: 0n,
        creditLossPending: version !== 1 && expectedLoss !== undefined });
      if (version === undefined && !exit) readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 0n });
      await mpp.sweepTempoSessions!();
      await assertHeld();
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: refund });
      const second = await drain(payer, undefined, "d2");
      expect(second).toMatchObject({ status: 409, body: { error: version === 1 && expectedLoss ? "credit_unbacked" : "drain_conflict" } });
      expect(await ledger.getDrain({ creditId, drainId: "d2" })).toBeUndefined();
      if (version === undefined) {
        capability.version = 1;
        await mpp.sweepTempoSessions!();
        await assertHeld();
        expect(await lossRows()).toEqual(expectedRows);
        expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: false });
      }
      await mpp.sweepTempoSessions!();
      expect(await lossRows()).toEqual(expectedRows);
      expect(warn.mock.calls.filter(([event, fields]) => fields?.credit_id === creditId &&
        (event === "tempo_session_drain_finalized" || event === "tempo_session_drain_unbacked_resolved"))).toEqual([]);
    } finally { warn.mockRestore(); await server.shutdown(); }
  });

  it("retains a channel-only exact zero separately from unknown refund evidence", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const capability = { version: undefined as 1 | undefined };
    const { server, mpp, channelId, creditId, dvmId, scope, drain, chain, logs, operator, readChannelClose } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n, lossEvidenceCapability: capability });
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n; chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      readChannelClose.mockRejectedValue(new Error("receipt unavailable"));
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: null, refundPaymentProven: false });
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 0n });
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: "0", refundPaymentProven: false });
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      const released = await decisionAdmin(dvmId, scope)("/admin/credit/release-tempo-drain", {
        credit_id: creditId, drain_id: "d1", reason: "Verified close refunded zero" });
      expect(released.status).toBe(200);
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 100_000 });
    } finally { await server.shutdown(); }
  });

  it("keeps finalized gates and retries a failed channel-only proof write before permanent loss", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs, operator, readChannelClose } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n });
    const write = vi.spyOn(ledger, "recordTempoDrainRefund");
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n; chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 50_000n });
      write.mockRejectedValue(new Error("proof write unavailable"));
      await expect(mpp.sweepTempoSessions!()).resolves.toMatchObject({ inFlight: 1 });
      expect(warn).toHaveBeenCalledWith("tempo_drain_refund_evidence_write_failed", { amount_micro: 100_000 });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: null, refundPaymentProven: false });
      expect(await ledger.get(creditId)).toMatchObject({ status: "active", balanceMicro: 0 });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, deposit: 0n, creditLossPending: true });
      expect((await sessions.listActive()).some(row => row.key === channelId)).toBe(true);
      await expect(ledger.draw({ creditId, drawId: "write-failed-no-spend", amountMicro: 1 })).rejects.toMatchObject({ code: "tempo_channel_closing" });
      write.mockRestore();
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: "50000", refundPaymentProven: true });
      expect((await pool.query("SELECT loss_native FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([{ loss_native: "50000" }]);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: false });
    } finally { write.mockRestore(); warn.mockRestore(); await server.shutdown(); }
  });

  it.each(["channel-only", "finalized-drain"].flatMap(entry => ["cooperative", "payer exit"].map(kind => ({ entry, kind }))))(
    "protects concurrent RELEASE after positive observation commits: $entry/$kind", async ({ entry, kind }) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const exit = kind === "payer exit";
    const { server, mpp, channelId, creditId, dvmId, scope, drain, chain, logs, operator, readChannelClose, runtimeConfig } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n });
    const originalRefund = ledger.recordTempoDrainRefund.bind(ledger);
    const write = exit ? vi.spyOn(ledger, "recordTempoDrainPayment") : vi.spyOn(ledger, "recordTempoDrainRefund");
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let work: Promise<unknown> | undefined;
    let finishBody!: () => void;
    const bodyFinished = new Promise<void>(resolve => { finishBody = resolve; });
    let cleaningUp = false;
    // A framework timeout leaves the async body running; unblock and join it before the next case.
    onTestFinished(async () => {
      cleaningUp = true;
      release();
      entered();
      await bodyFinished;
    });
    try {
      expect((await drain(payer)).status).toBe(402);
      if (cleaningUp) return;
      chain.deposit = 0n; chain.settled = exit ? 0n : SPENT;
      logs.push(exit ? { event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address }
        : { event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 50_000n });
      if (entry === "finalized-drain") {
        await ledger.requireTempoDrainExit({ creditId, drainId: "d1" });
        if (exit) {
          const obligation = await runtimeConfig.hostedObligations!.pendingTempoClose(channelId, "d1");
          await runtimeConfig.hostedObligations!.resolveTempoCloseExit(obligation!.id);
        } else await sessions.confirmClose(channelId, "d1", TX_HASH);
      }
      write.mockImplementation(async () => { entered(); await blocked; throw new Error("paused proof writer failed"); });
      const run = () => entry === "channel-only" ? mpp.sweepTempoSessions!() : mpp.reconcileTempoSessionCloses!();
      work = run().then(() => "completed", error => error);
      await started;
      if (cleaningUp) return;
      const observation = { creditId, drainId: "d1" };
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, deposit: 0n, depositBeforeFinalization: DEPOSIT,
        creditLossPending: true, tempoDrainPaymentObservation: observation });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ provenRefundNative: null, refundPaymentProven: false });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      const admin = decisionAdmin(dvmId, scope);
      const releaseIntent = { credit_id: creditId, drain_id: "d1", reason: "No refund was paid" };
      const assertReleaseRefused = async () => {
        const refused = await admin("/admin/credit/release-tempo-drain", releaseIntent);
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ error: "tempo_drain_refund_paid" });
        expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
        expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ operatorDecision: null });
      };
      await assertReleaseRefused();
      const snapshot = await sessions.get(channelId) as Record<string, unknown>;
      await expect(sessions.put(channelId, { ...snapshot, tempoDrainPaymentObservation: undefined })).rejects.toThrow("cannot be erased or rebound");
      await expect(sessions.update(channelId, value => ({ op: "set", value: { ...value as object,
        tempoDrainPaymentObservation: { creditId, drainId: "other" } }, result: undefined }))).rejects.toThrow("cannot be erased or rebound");
      // Even a later trusted zero cannot erase the earlier positive observation.
      if (!exit) await originalRefund({ creditId, drainId: "d1", refundedNative: 0n });
      await assertReleaseRefused();
      release();
      const result = await work;
      expect(result).toBe("completed");
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true, tempoDrainPaymentObservation: observation });
      await assertReleaseRefused();
      if (cleaningUp) return;
      write.mockRestore();
      await run();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({
        provenRefundNative: exit ? null : "50000", refundPaymentProven: true });
      expect((await pool.query("SELECT loss_native FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([{ loss_native: "50000" }]);
      expect(await sessions.get(channelId)).toMatchObject({ creditLossPending: false, tempoDrainPaymentObservation: observation });
    } finally {
      release();
      try {
        try { await work; }
        finally {
          try { write.mockRestore(); }
          finally { await server.shutdown(); }
        }
      } finally { finishBody(); }
    }
  });

  it("makes no durable payment claim when the protective channel commit fails", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs, operator, readChannelClose } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n });
    const writer = vi.spyOn(ledger, "recordTempoDrainRefund");
    const dropTrigger = () => pool.query("DROP TRIGGER IF EXISTS reject_tempo_protection ON mpp_tempo_channels; DROP FUNCTION IF EXISTS reject_tempo_protection()");
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n; chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 100_000n });
      await pool.query(`CREATE FUNCTION reject_tempo_protection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.channel_key='${channelId}' AND NEW.state_json::jsonb ? 'tempoDrainPaymentObservation' THEN
          RAISE EXCEPTION 'protective commit failed'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER reject_tempo_protection BEFORE UPDATE ON mpp_tempo_channels FOR EACH ROW EXECUTE FUNCTION reject_tempo_protection()`);
      await expect(mpp.getTempoSessionDrainState!(channelId)).rejects.toThrow("protective commit failed");
      expect(writer).not.toHaveBeenCalled();
      expect(await sessions.get(channelId)).toMatchObject({ finalized: false, deposit: DEPOSIT });
      expect(await sessions.get(channelId)).not.toHaveProperty("tempoDrainPaymentObservation");
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: null, refundPaymentProven: false });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      await dropTrigger();
      await mpp.getTempoSessionDrainState!(channelId);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: false,
        tempoDrainPaymentObservation: { creditId, drainId: "d1" } });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ provenRefundNative: "100000", refundPaymentProven: true });
    } finally { await dropTrigger(); writer.mockRestore(); await server.shutdown(); }
  });

  it("permits manual BOOK and its replay after a matched positive payment observation", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, channelId, creditId, dvmId, scope, drain } = await hostedCredit(payer, { modes: ["submits-then-times-out"] });
    await new RevenueReporter(pool, "https://platform.example.com", "local-token").init();
    try {
      expect((await drain(payer)).status).toBe(402);
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object, finalized: true, deposit: 0n,
        creditLossPending: true, tempoDrainPaymentObservation: { creditId, drainId: "d1" } }, result: undefined }));
      const admin = decisionAdmin(dvmId, scope);
      const intent = { credit_id: creditId, drain_id: "d1", reason: "Operator verified full refund including off-path remainder" };
      const first = await admin("/admin/credit/book-tempo-drain", intent);
      expect(first.status).toBe(200);
      const decision = await first.json();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent", operatorDecision: { decision: "book_refunded" } });
      const replay = await admin("/admin/credit/book-tempo-drain", intent);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...decision, replayed: true });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
    } finally { await server.shutdown(); }
  });

  it.each(["unknown", "foreign credit", "foreign drain"] as const)("preserves manual RELEASE and immutable replay with %s pending observation", async kind => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, channelId, creditId, dvmId, scope, drain } = await hostedCredit(payer, { modes: ["submits-then-times-out"] });
    try {
      expect((await drain(payer)).status).toBe(402);
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object,
        finalized: true, deposit: 0n, creditLossPending: true,
        ...(kind !== "unknown" && { tempoDrainPaymentObservation: {
          creditId: kind === "foreign credit" ? "other-credit" : creditId,
          drainId: kind === "foreign drain" ? "other-drain" : "d1",
        } }),
      }, result: undefined }));
      const admin = decisionAdmin(dvmId, scope);
      const intent = { credit_id: creditId, drain_id: "d1", reason: "Operator verified no refund was paid" };
      const first = await admin("/admin/credit/release-tempo-drain", intent);
      expect(first.status).toBe(200);
      const decision = await first.json();
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 100_000 });
      if (kind === "unknown") await sessions.update(channelId, value => ({ op: "set", value: { ...value as object,
        tempoDrainPaymentObservation: { creditId, drainId: "d1" } }, result: undefined }));
      const replay = await admin("/admin/credit/release-tempo-drain", intent);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ...decision, replayed: true });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 100_000 });
    } finally { await server.shutdown(); }
  });

  it("bounds repeated full drain pages without losing finalized restrictions or skipping later retries", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs, operator, readChannelClose } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n });
    const reader = vi.spyOn(ledger, "listChannelDrains");
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(402);
      await sessions.confirmClose(channelId, "d1", TX_HASH);
      const own = (await ledger.getDrain({ creditId, drainId: "d1" }))!;
      const page = [own, ...Array.from({ length: 99 }, (_, i) => ({ ...own,
        channelId: `0x${"fe".repeat(32)}`, creditId: `other-${String(i).padStart(3, "0")}`, drainId: "other" }))];
      const reads = { proof: 0, final: 0 };
      // The third-page fuse makes the deliberately broken control finite.
      reader.mockImplementation(async args => {
        const phase = args.includeResolved ? "final" : "proof";
        reads[phase] += 1;
        return reads[phase] <= 2 ? page : [];
      });
      chain.deposit = 0n; chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 100_000n });
      expect(await mpp.sweepTempoSessions!()).toMatchObject({ inFlight: 2 });
      expect(reads).toEqual({ proof: 2, final: 2 });
      for (const includeResolved of [false, true]) {
        const calls = reader.mock.calls.filter(([args]) => Boolean(args.includeResolved) === includeResolved);
        expect(calls[0][0].createdBeforeMs).toBe(calls[1][0].createdBeforeMs);
      }
      expect(warn).toHaveBeenCalledWith("tempo_session_close_reconcile_failed", expect.objectContaining({ error: "Tempo drain pagination cursor did not advance" }));
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: null, refundPaymentProven: false });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      await expect(ledger.draw({ creditId, drawId: "pagination-no-spend", amountMicro: 1 })).rejects.toMatchObject({ code: "tempo_channel_closing" });
      reader.mockRestore();
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", provenRefundNative: "100000", refundPaymentProven: true });
      expect(await sessions.get(channelId)).toMatchObject({ creditLossPending: false });
      expect(await ledger.get(creditId)).toMatchObject({ status: "active", balanceMicro: 0 });
    } finally { reader.mockRestore(); warn.mockRestore(); await server.shutdown(); }
  });

  it.each([false, true])("checks channel and credit bindings before retaining channel-only proof, forged binding=%s", async forged => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const otherPayer = privateKeyToAccount(generatePrivateKey());
    const own = await hostedCredit(payer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n });
    const other = await hostedCredit(otherPayer, { modes: ["submits-then-times-out"] });
    const list = ledger.listChannelDrains.bind(ledger);
    const reader = vi.spyOn(ledger, "listChannelDrains");
    try {
      expect((await own.drain(payer)).status).toBe(402);
      expect((await other.drain(otherPayer)).status).toBe(402);
      own.chain.deposit = 0n; own.chain.settled = SPENT;
      own.logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: own.operator.address });
      own.readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 100_000n });
      reader.mockImplementation(async args => (await list(args)).map(row =>
        forged && row.creditId === other.creditId ? { ...row, channelId: own.channelId } : row));
      if (forged) await expect(own.mpp.getTempoSessionDrainState!(own.channelId)).rejects.toThrow("Tempo drain channel does not match its credit");
      else await own.mpp.getTempoSessionDrainState!(own.channelId);
      expect(await ledger.getDrain({ creditId: own.creditId, drainId: "d1" }))
        .toMatchObject({ provenRefundNative: forged ? null : "100000", refundPaymentProven: !forged });
      expect(await ledger.getDrain({ creditId: other.creditId, drainId: "d1" }))
        .toMatchObject({ status: "pending", provenRefundNative: null, refundPaymentProven: false });
      expect(await sessions.get(own.channelId)).toMatchObject({ finalized: true, creditLossPending: forged });
    } finally { reader.mockRestore(); await other.server.shutdown(); await own.server.shutdown(); }
  });

  it.each([false, true])("resumes channel-only loss search after a later channel reference confirmation, stale cursor=%s", async stale => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const capability = { version: undefined as 1 | undefined };
    const { server, mpp, channelId, creditId, drain, chain, logs, operator, readChannelClose, rpc } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"], highestVoucherAmount: 150_000n, lossEvidenceCapability: capability });
    const closeTime = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object,
        createdAt: new Date(closeTime - 3_600_000).toISOString() }, result: undefined }));
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n; chain.settled = SPENT;
      const closeBlock = HEAD - 10_000n;
      logs.push({ event: "ChannelClosed", block: closeBlock, txHash: TX_HASH, from: operator.address });
      rpc.timing.blockTimestamp = BigInt(Math.floor(closeTime / 1000));
      readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 50_000n });
      expect(await mpp.settleTempoSessionChannel!(channelId)).toMatchObject({ outcome: "retryable_failure" });
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true });
      // An earlier bounded pass may have missed logs the RPC now serves.
      const cursor = HEAD - (stale ? 15_000n : 5_000n);
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object,
        creditLossSearchBefore: cursor }, result: undefined }));
      clock.mockReturnValue(closeTime + 7 * 86_400_000);
      await sessions.confirmClose(channelId, "d1", `channel:${channelId}`);
      expect(await sessions.getCloseRecovery(channelId)).toMatchObject({ updatedAtMs: closeTime + 7 * 86_400_000 });
      capability.version = 1;
      rpc.requests.length = 0;
      if (stale) {
        expect(await mpp.settleTempoSessionChannel!(channelId)).toMatchObject({ outcome: "retryable_failure" });
        expect(await sessions.get(channelId)).not.toHaveProperty("creditLossSearchBefore");
        expect(await sessions.get(channelId)).toMatchObject({ creditLossPending: true });
        expect((await pool.query("SELECT loss_native FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      }
      expect(await mpp.settleTempoSessionChannel!(channelId)).toMatchObject({ outcome: "finalized_before_protection", owed: 50_000n, settledOnChain: SPENT });
      const firstWindow = rpc.requests.find(({ method }) => method === "eth_getLogs");
      expect(BigInt((firstWindow!.params[0] as { toBlock: Hex }).toBlock)).toBe(cursor);
      expect(rpc.requests.some(({ method, params }) => method === "eth_getLogs" &&
        BigInt((params[0] as { fromBlock: Hex }).fromBlock) <= closeBlock &&
        BigInt((params[0] as { toBlock: Hex }).toBlock) >= closeBlock)).toBe(true);
      expect((await pool.query("SELECT loss_native FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([{ loss_native: "50000" }]);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: false });
      await mpp.settleTempoSessionChannel!(channelId);
      expect((await pool.query("SELECT loss_native FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([{ loss_native: "50000" }]);
    } finally { clock.mockRestore(); await server.shutdown(); }
  });

  it.each([true, false])("reads zero-loss diagnostics without reacquiring a held one-client pool, advertised=%s", async advertised => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, channelId, chain, logs, operator, runtimeConfig, chainOps } = await hostedCredit(payer,
      { highestVoucherAmount: 150_000n });
    const narrowPool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}`, max: 1, connectionTimeoutMillis: 1000 });
    const narrowStore = new PostgresTempoSessionStore(narrowPool);
    const narrowLedger = new CreditLedger(narrowPool, narrowStore);
    const originalRead = narrowLedger.listTempoCreditLosses.bind(narrowLedger);
    const read = !advertised ? vi.spyOn(narrowLedger, "listTempoCreditLosses").mockImplementation(args => originalRead(args)) : undefined;
    const custom = new Proxy(narrowLedger, { get(target, key) {
      if (key === "tempoCreditLossEvidenceVersion" && !advertised) return undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    try {
      chain.deposit = 0n; chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      const runtime = _testing.attachTempoSessionRuntime({} as MppxServer, { ...runtimeConfig, store: narrowStore }, chainOps);
      runtime.useTempoCreditLedger!(custom);
      expect(await runtime.getTempoSessionDrainState!(channelId)).toMatchObject({ finalized: true, deposit: 0n });
      expect(await narrowStore.get(channelId)).toMatchObject({ creditLossPending: false });
      if (read) expect(read).toHaveBeenCalledWith({ channelId, limit: 1000 });
    } finally { read?.mockRestore(); await narrowPool.end(); await server.shutdown(); }
  });

  it("ignores foreign loss rows when a custom reader ignores the channel filter", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, drain, chain, logs, operator } = await hostedCredit(payer,
      { modes: ["submits-then-times-out"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    const read = vi.spyOn(ledger, "listTempoCreditLosses");
    try {
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object, highestVoucherAmount: 150_000n }, result: undefined }));
      expect((await drain(payer)).status).toBe(402);
      await ledger.requireTempoDrainExit({ creditId, drainId: "d1" });
      read.mockResolvedValue([{ creditId, channelId: `0x${"ff".repeat(32)}`, callerPubkey: CALLER,
        currency: "usd", formerBalanceMicro: 100_000, highestVoucherNative: 999n,
        settledOnChainNative: 0n, consumedServiceMicro: 0, consumedNative: 0n,
        refundedToPayerNative: null, lossNative: 999n, lossBasis: "caller_asserted", observedAt: 1 }]);
      chain.deposit = 0n;
      chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      await mpp.sweepTempoSessions!();
      expect(await ledger.get(creditId)).toMatchObject({ status: "active" });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent", sentRef: { credit_unbacked: false } });
      expect(warn).toHaveBeenCalledWith("tempo_session_drain_finalized", expect.objectContaining({ credit_id: creditId, builder_loss_native: "0" }));
    } finally { read.mockRestore(); warn.mockRestore(); await server.shutdown(); }
  });

  it("rechecks headroom under the channel lock before classifying a stale snapshot", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, chain } = await hostedCredit(payer);
    const original = sessions.withFinalizedCreditLoss.bind(sessions);
    const race = vi.spyOn(sessions, "withFinalizedCreditLoss").mockImplementationOnce(async (id, operation) => {
      await sessions.update(channelId, value => ({ op: "set", value: { ...value as object, highestVoucherAmount: 150_000n }, result: undefined }));
      return original(id, operation);
    });
    try {
      chain.deposit = 0n;
      chain.settled = SPENT;
      await mpp.getTempoSessionDrainState!(channelId);
      expect(await ledger.get(creditId)).toMatchObject({ status: "active" });
      expect((await pool.query("SELECT * FROM tempo_credit_losses WHERE credit_id=$1", [creditId])).rows).toEqual([]);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: true, creditLossPending: true });
    } finally { race.mockRestore(); await server.shutdown(); }
  });

  it("exports exact loss evidence without inventing historical refunds", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, channelId, creditId } = await hostedCredit(payer);
    const amount = 9_007_199_254_740_993n;
    const recipe = readFileSync(new URL("../../../../recipes/postgres/financial-export-v1.sql", import.meta.url), "utf8");
    const client = await pool.connect();
    const exportLoss = async () => {
      const begin = recipe.indexOf("BEGIN TRANSACTION");
      await client.query(recipe.slice(0, begin));
      const results = await client.query(recipe.slice(begin)) as unknown as import("pg").QueryResult[];
      return results.find(result => result.command === "SELECT")!.rows[0].jsonb_build_object.tempo_losses
        .find((row: { credit_id: string }) => row.credit_id === creditId);
    };
    try {
      await ledger.terminalizeTempoCredits({ channelId, settledOnChainNative: 1n,
        highestVoucherNative: amount * 2n + 1n, consumedNative: 1n, refundedToPayerNative: amount });
      expect(await exportLoss()).toMatchObject({ refunded_to_payer_native: "9007199254740993", loss_native: "9007199254740993", loss_basis: "cooperative_close" });
      await client.query("BEGIN");
      try {
        await client.query("ALTER TABLE tempo_credit_losses DROP COLUMN refunded_to_payer_native, DROP COLUMN loss_native, DROP COLUMN loss_basis");
        // Export the old schema in this transaction without committing its DDL.
        const begin = recipe.indexOf("BEGIN TRANSACTION");
        await client.query(recipe.slice(0, begin));
        const select = recipe.slice(begin).replace("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;", "").replace("ROLLBACK;", "");
        const old = (await client.query(select)).rows[0].jsonb_build_object.tempo_losses.find((row: { credit_id: string }) => row.credit_id === creditId);
        expect(old).toMatchObject({ credit_id: creditId, settled_on_chain_native: 1 });
        expect(old).not.toHaveProperty("refunded_to_payer_native");
        expect(old).not.toHaveProperty("loss_native");
        expect(old).not.toHaveProperty("loss_basis");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      await ledger.init();
      expect(await ledger.listTempoCreditLosses()).toEqual(expect.arrayContaining([expect.objectContaining({ creditId, refundedToPayerNative: null, lossNative: null, lossBasis: null })]));
      expect(await exportLoss()).toMatchObject({ refunded_to_payer_native: null, loss_native: null, loss_basis: null });
    } finally { client.release(); await server.shutdown(); }
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

  it.each(["missing history", "short refund", "missing collateral"].flatMap(missing =>
    ["book", "release"].map(decision => ({ missing, decision }))))("decides a held timed-exit drain after $missing: $decision", async ({ missing, decision }) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, dvmId, scope, drain, chain, logs, operator, readChannelClose } = await hostedCredit(payer);
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer, null)).status).toBe(409);
      if (missing !== "missing history") {
        if (missing === "missing collateral") {
          await sessions.put(channelId, { ...await sessions.get(channelId) as Record<string, unknown>, finalized: true, deposit: 0n });
        } else {
          chain.settled = SPENT;
          if (decision === "release") readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 0n });
          else chain.settled = 150_001n;
        }
        logs.push(missing === "short refund" && decision === "release"
          ? { event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address }
          : { event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      }
      chain.deposit = 0n;
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required" });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0, status: missing === "missing collateral" ? "unbacked" : "active" });
      expect(warn).toHaveBeenCalledWith("tempo_session_drain_refund_unproven",
        expect.objectContaining({ channel_id: channelId, amount_at_stake_native: "100000" }));
      const admin = decisionAdmin(dvmId, scope);
      const listed = await listedDrain(admin, creditId);
      expect(listed).toMatchObject({ held_reason:
        missing === "missing history" ? "close_evidence_missing" : missing === "short refund" ? "refund_short" : "collateral_missing" });
      if (missing === "short refund") {
        expect((await ledger.getDrain({ creditId, drainId: "d1" }))?.provenRefundNative).toBe(decision === "release" ? "0" : null);
        expect((await ledger.getDrain({ creditId, drainId: "d1" }))?.refundPaymentProven).toBe(decision === "book");
        expect(await listedDrain(admin, creditId)).toMatchObject(decision === "book"
          ? drainDecisionContract.refund_evidence.positive_lower_bound : drainDecisionContract.refund_evidence.exact_zero);
        if (decision === "book") {
          const refused = await admin("/admin/credit/release-tempo-drain", { credit_id: creditId, drain_id: "d1", reason: "No refund was paid" });
          expect(refused.status).toBe(409);
          expect(await refused.json()).toMatchObject({ error: "tempo_drain_refund_paid" });
        }
      }
      const response = await admin(`/admin/credit/${decision}-tempo-drain`, { credit_id: creditId, drain_id: "d1",
        reason: decision === "book" ? "The full amount was returned off-path" : "No refund was paid" });
      expect(response.status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: decision === "book" ? "sent" : "released",
        operatorDecision: { source: "operator", decision: decision === "book" ? "book_refunded" : "release" } });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: decision === "book" ? 0 : 100_000,
        status: missing === "missing collateral" ? "unbacked" : "active" });
      await expect(ledger.draw({ creditId, drawId: "after-held-decision", amountMicro: 1 }))
        .rejects.toMatchObject({ code: missing === "missing collateral" ? "credit_unbacked" : "tempo_channel_closing" });
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it.each([true, false])("refuses release after a submitted close receipt times out without a saved hash, hosted=%s", async hosted => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, dvmId, scope, drain, chain } = await hostedCredit(payer,
      { hosted, modes: ["submits-then-times-out"] });
    await new RevenueReporter(pool, "https://platform.example.com", "local-token").init();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await drain(payer)).status).toBe(402);
      expect(chain.pendingClose).toBe(true);
      expect((await pool.query("SELECT reference, settled_before_close FROM mpp_tempo_close_intents WHERE channel_id=$1", [channelId])).rows)
        .toEqual([{ reference: null, settled_before_close: "0" }]);
      expect(await sessions.get(channelId)).toMatchObject({ finalized: false, closeRequestedAt: 0n });
      const balance = (await pool.query("SELECT balance_micro, native_remaining, msats_remaining FROM credits WHERE credit_id=$1", [creditId])).rows;
      const obligations = (await pool.query("SELECT state, tx_hash FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1", [channelId])).rows;
      expect(obligations).toEqual(hosted ? [{ state: "reserved", tx_hash: null }] : []);
      const reports = (await pool.query("SELECT kind, payload FROM pending_dvm_reports")).rows;
      const response = await decisionAdmin(dvmId, scope)("/admin/credit/release-tempo-drain",
        { credit_id: creditId, drain_id: "d1", reason: "No refund was paid" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "tempo_drain_close_pending", message: expect.stringContaining("may still pay") });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "pending", operatorDecision: null });
      expect((await pool.query("SELECT balance_micro, native_remaining, msats_remaining FROM credits WHERE credit_id=$1", [creditId])).rows).toEqual(balance);
      expect((await pool.query("SELECT state, tx_hash FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1", [channelId])).rows).toEqual(obligations);
      expect((await pool.query("SELECT kind, payload FROM pending_dvm_reports")).rows).toEqual(reports);
      expect(warn.mock.calls.filter(call => JSON.stringify(call).includes("tempo_drain_released"))).toEqual([]);
      expect((await ledger.get(creditId))?.balanceMicro).toBe(0);
      await expect(ledger.draw({ creditId, drawId: "unsafe-spend", amountMicro: 500, nowMs: Date.now() })).rejects.toMatchObject({ code: "insufficient_credit" });
    } finally { warn.mockRestore(); await server.shutdown(); }
  });

  it.each([49_999n, 0n, -1n])("retains only positive-payment knowledge from a payer-exit lower bound of %s", async lowerBound => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, dvmId, scope, drain, chain, logs } = await hostedCredit(payer);
    const warning = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer, null)).status).toBe(409);
      chain.deposit = 0n; chain.settled = DEPOSIT - lowerBound;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      await mpp.sweepTempoSessions!();
      const args = { creditId, drainId: "d1" };
      expect(await ledger.getDrain(args)).toMatchObject({ status: "exit_required", holdReason: "refund_short",
        provenRefundNative: null, refundPaymentProven: lowerBound > 0n });
      expect(warning).toHaveBeenCalledWith("tempo_session_drain_refund_unproven", expect.objectContaining({ reason: "refund_short", channel_id: channelId }));
      expect(warning.mock.calls.some(call => call[0] === "tempo_drain_refund_evidence_write_failed")).toBe(false);
      const admin = decisionAdmin(dvmId, scope);
      const release = () => admin("/admin/credit/release-tempo-drain", { credit_id: creditId, drain_id: "d1", reason: "No refund was paid" });
      expect(await (await release()).json()).toMatchObject({ error: lowerBound > 0n ? "tempo_drain_refund_paid" : "tempo_drain_refund_unknown" });
      expect(await listedDrain(admin, creditId)).toMatchObject(lowerBound > 0n
        ? drainDecisionContract.refund_evidence.positive_lower_bound : drainDecisionContract.refund_evidence.unknown);
      if (lowerBound > 0n) {
        chain.rpcFailure = true;
        await mpp.sweepTempoSessions!();
        chain.rpcFailure = false; chain.settled = DEPOSIT;
        await mpp.sweepTempoSessions!();
        expect(await ledger.getDrain(args)).toMatchObject({ provenRefundNative: null, refundPaymentProven: true });
        await ledger.recordTempoDrainRefund({ ...args, refundedNative: 0n });
        expect(await ledger.getDrain(args)).toMatchObject({ provenRefundNative: "0", refundPaymentProven: true });
        expect(await (await release()).json()).toMatchObject({ error: "tempo_drain_refund_paid" });
      }
      expect((await ledger.get(creditId))?.balanceMicro).toBe(0);
    } finally { warning.mockRestore(); await server.shutdown(); }
  });

  it("retains monetary proof and the unproven alert when the held-reason label cannot be written", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, dvmId, scope, drain, chain, logs } = await hostedCredit(payer);
    const label = vi.spyOn(ledger, "recordTempoDrainHold").mockRejectedValue(new Error("label unavailable"));
    const warning = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer, null)).status).toBe(409);
      chain.deposit = 0n; chain.settled = 150_001n;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      await mpp.sweepTempoSessions!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required", provenRefundNative: null, refundPaymentProven: true });
      expect(warning).toHaveBeenCalledWith("tempo_drain_hold_reason_write_failed", { amount_micro: 100_000 });
      expect(warning).toHaveBeenCalledWith("tempo_session_drain_refund_unproven", expect.objectContaining({ reason: "refund_short", channel_id: channelId }));
      const response = await decisionAdmin(dvmId, scope)("/admin/credit/release-tempo-drain", { credit_id: creditId, drain_id: "d1", reason: "No refund was paid" });
      expect(response.status).toBe(409);
      expect((await ledger.get(creditId))?.balanceMicro).toBe(0);
    } finally { label.mockRestore(); warning.mockRestore(); await server.shutdown(); }
  });

  it.each(["book", "release"].flatMap(decision => [false, true].map(writtenOff => ({ decision, writtenOff }))))(
    "decides a held drain independently of its close report: $decision, writtenOff=$writtenOff", async ({ decision, writtenOff }) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, channelId, creditId, dvmId, scope, drain, chain, ageObligations } = await hostedCredit(payer,
      { modes: ["fails-before-submit"] });
    try {
      expect((await drain(payer)).status).toBe(402);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ageObligations();
        expect((await drain(payer)).status).toBe(402);
      }
      await ageObligations();
      expect((await drain(payer)).status).toBe(409);
      chain.deposit = 0n;
      await mpp.sweepTempoSessions!();
      const admin = decisionAdmin(dvmId, scope);
      const id = (await pool.query("SELECT id FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1 AND state='unmatched'", [channelId])).rows[0].id;
      if (writtenOff) expect((await admin("/admin/credit/write-off-tempo-close-report", { obligation_id: id, note: "History is irrecoverable" })).status).toBe(200);
      const before = (await pool.query("SELECT state, close_write_off_note FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id])).rows;
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required", sentRef: null });
      expect((await listedDrain(admin, creditId)).close_reports).toContainEqual({ obligation_id: id, status: writtenOff ? "no_report" : "unmatched", written_off: writtenOff });
      expect((await admin(`/admin/credit/${decision}-tempo-drain`, { credit_id: creditId, drain_id: "d1", reason: "Independently reviewed" })).status).toBe(200);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: decision === "book" ? "sent" : "released" });
      expect((await pool.query("SELECT state, close_write_off_note FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id])).rows).toEqual(before);
    } finally { await server.shutdown(); }
  });

  it.each(["missing history", "short refund", "missing collateral", "short receipt", "proven exit", "proven close"])(
    "caller polls require refund proof for a timed-exit drain: %s", async (evidence) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, channelId, creditId, drain, chain, logs, broadcasts, operator, readChannelClose } = await hostedCredit(payer);
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer, null)).status).toBe(409);
      chain.deposit = 0n;
      chain.settled = evidence === "short refund" ? 150_001n : SPENT;
      if (evidence === "short receipt" || evidence === "proven close") {
        logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
        if (evidence === "short receipt") readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 99_999n });
      } else if (evidence !== "missing history") {
        logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      }
      if (evidence === "missing collateral") {
        await sessions.put(channelId, { ...await sessions.get(channelId) as Record<string, unknown>,
          finalized: true, deposit: 0n });
      }
      const result = await drain(payer);
      const proven = evidence === "proven exit" || evidence === "proven close";
      expect(result.status).toBe(proven ? 200 : 409);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject(proven
        ? { status: "sent", sentRef: { terminal_outcome: evidence === "proven close" ? "cooperative_close" : "payer_exit",
          settled_amount: "150000" } }
        : { status: "exit_required", sentRef: null });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
      expect(broadcasts).toHaveLength(0);
      if (!proven) {
        expect(result.body).toMatchObject({ error: "settlement_pending", retryable: false });
        expect(String(result.body.display)).toContain("The DVM operator has been alerted.");
        expect(warn).toHaveBeenCalledWith("tempo_session_drain_refund_unproven", expect.objectContaining({
          channel_id: channelId, credit_id: creditId, drain_id: "d1", amount_at_stake_native: "100000",
          reason: evidence === "short refund" || evidence === "short receipt" ? "refund_short"
            : evidence === "missing collateral" ? "collateral_missing" : "close_evidence_missing",
        }));
      }
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it("shares one close search between a caller poll and the concurrent sweep", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, drain, chain, logs, operator, rpc, searches, obligations } =
      await hostedCredit(payer, { modes: ["submits-then-times-out"] });
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const searching = new Promise<void>((resolve) => { started = resolve; });
    const recoveryRead = vi.spyOn(sessions, "getCloseRecovery");
    let sweep: Promise<void> | undefined;
    let poll: ReturnType<typeof drain> | undefined;
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n;
      chain.settled = SPENT;
      logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      const before = searches();
      rpc.searchGate.wait = async () => { started(); await blocked; };
      sweep = mpp.reconcileTempoSessionCloses!();
      await searching;
      recoveryRead.mockClear();
      poll = drain(payer);
      await vi.waitFor(() => expect(recoveryRead).toHaveBeenCalledWith(channelId));
      // Flush the poll's continuation after its last store read; both paths
      // now await the blocked chain search, rather than a timer-based race.
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      const [result] = await Promise.all([poll, sweep]);
      expect(searches() - before).toBe(1);
      const closeTopic = encodeEventTopics({ abi: TempoSession.Precompile.escrowAbi, eventName: "ChannelClosed" })[0];
      expect(rpc.requests.filter(({ method, params }) => method === "eth_getLogs" &&
        (params[0] as { topics: Hex[] }).topics[0] === closeTopic)).toHaveLength(1);
      expect(result.status).toBe(200);
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: TX_HASH }]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent" });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
    } finally {
      release();
      await Promise.allSettled([poll, sweep]);
      recoveryRead.mockRestore();
      await server.shutdown();
    }
  });

  it.each(["stale pending", "pending"])("refuses a short payer-exit refund from a %s snapshot", async (snapshot) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, drain, chain, logs } = await hostedCredit(payer,
      { modes: ["submits-then-times-out"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    let read: ReturnType<typeof vi.spyOn> | undefined;
    try {
      expect((await drain(payer)).status).toBe(402);
      if (snapshot === "stale pending") {
        const getDrain = ledger.getDrain.bind(ledger);
        read = vi.spyOn(ledger, "getDrain").mockImplementationOnce(async (args) => {
          const pending = await getDrain(args);
          await ledger.requireTempoDrainExit(args);
          return pending;
        });
      }
      chain.deposit = 0n;
      chain.settled = 150_001n;
      logs.push({ event: "CloseRequested", block: HEAD - 900n, txHash: EXIT_TX_HASH, from: payer.address });
      const result = await drain(payer);
      expect(result).toMatchObject({ status: 409, body: { error: "settlement_pending", retryable: false } });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({
        status: snapshot === "stale pending" ? "exit_required" : "pending", sentRef: null,
      });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
      expect(warn).toHaveBeenCalledWith("tempo_session_drain_refund_unproven",
        expect.objectContaining({ channel_id: channelId, amount_at_stake_native: "100000", reason: "refund_short" }));
    } finally {
      read?.mockRestore();
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it.each(["late close", "terminal miss"])("the poll searches an exhausted close obligation: %s", async (landing) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, drain, chain, logs, operator, ageObligations, obligations } =
      await hostedCredit(payer, { modes: ["fails-before-submit"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    try {
      expect((await drain(payer)).status).toBe(402);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await ageObligations();
        expect((await drain(payer)).status).toBe(402);
      }
      await ageObligations();
      expect((await drain(payer)).status).toBe(409);
      chain.deposit = 0n;
      chain.settled = SPENT;
      if (landing === "late close") {
        logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      }
      const response = await drain(payer);
      expect(response.status).toBe(landing === "late close" ? 200 : 409);
      expect((await obligations()).at(-1)).toEqual(landing === "late close"
        ? { state: "reserved", tx_hash: TX_HASH } : { state: "unmatched", tx_hash: null });
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject(landing === "late close"
        ? { status: "sent", sentRef: { tx_hash: TX_HASH, settled_amount: "150000", terminal_outcome: "cooperative_close" } }
        : { status: "exit_required", sentRef: null });
      if (landing === "terminal miss") {
        expect(warn).toHaveBeenCalledWith("tempo_session_drain_refund_unproven",
          expect.objectContaining({ channel_id: channelId, reason: "close_history_unmatched", amount_at_stake_native: "100000" }));
      }
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it.each(["RPC", "receipt", "ledger", "paused search"])("keeps a finalized drain retryable after a transient %s failure", async (failure) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, drain, chain, logs, operator, readChannelClose } = await hostedCredit(payer,
      failure === "paused search" ? { head: 3_000_000n, recentFrom: 0n } : {});
    let write: ReturnType<typeof vi.spyOn> | undefined;
    try {
      expect((await drain(payer, null)).status).toBe(409);
      chain.deposit = 0n;
      chain.settled = SPENT;
      if (failure !== "paused search") {
        logs.push({ event: "ChannelClosed", block: HEAD - 3n, txHash: TX_HASH, from: operator.address });
      }
      if (failure === "RPC") chain.rpcFailure = true;
      if (failure === "receipt") readChannelClose.mockRejectedValueOnce(new Error("receipt unavailable"));
      if (failure === "ledger") write = vi.spyOn(ledger, "markDrainSent").mockRejectedValueOnce(new Error("ledger unavailable"));
      const response = await drain(payer);
      expect(response).toMatchObject({ status: 402, body: { retryable: true } });
      expect(String(response.body.hint)).toMatch(/retry/i);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required", sentRef: null });
    } finally {
      write?.mockRestore();
      await server.shutdown();
    }
  });

  it("does not share search results across independently configured runtimes", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const firstSearch = vi.fn(async () => { entered(); await blocked; return { outcome: "none" as const }; });
    const secondSearch = vi.fn(async () => ({ outcome: "none" as const }));
    const { server, mpp, drain, chain, runtimeConfig, chainOps } = await hostedCredit(payer,
      { modes: ["submits-then-times-out"], findChannelClose: firstSearch });
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n;
      chain.settled = SPENT;
      const replica = _testing.attachTempoSessionRuntime({} as MppxServer, runtimeConfig,
        { ...chainOps, findChannelClose: secondSearch });
      first = mpp.reconcileTempoSessionCloses!();
      await started;
      second = replica.reconcileTempoSessionCloses!();
      await vi.waitFor(() => expect(secondSearch).toHaveBeenCalledTimes(1));
    } finally {
      release();
      await Promise.allSettled([first, second]);
      await server.shutdown();
    }
  });

  it("keeps different self-hosted search time bounds independent", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const search = vi.fn(async () => { await blocked; return { outcome: "none" as const }; });
    const { server, mpp, channelId, drain, chain } = await hostedCredit(payer,
      { hosted: false, modes: ["submits-then-times-out"], findChannelClose: search });
    let first: ReturnType<NonNullable<MppxServer["recoverTempoSessionClose"]>> | undefined;
    let second: typeof first;
    const recovery = sessions.getCloseRecovery.bind(sessions);
    const bounds = vi.spyOn(sessions, "getCloseRecovery");
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n;
      chain.settled = SPENT;
      bounds.mockResolvedValueOnce({ ...(await recovery(channelId))!, updatedAtMs: Date.now() - 3_600_000 })
        .mockResolvedValueOnce({ ...(await recovery(channelId))!, updatedAtMs: Date.now() });
      first = mpp.recoverTempoSessionClose!(channelId, "d1");
      await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
      second = mpp.recoverTempoSessionClose!(channelId, "d1");
      await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    } finally {
      release();
      await Promise.allSettled([first, second]);
      bounds.mockRestore();
      await server.shutdown();
    }
  });

  it("retries a close search after a stalled search exceeds its deadline", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const search = vi.fn(async () => ({ outcome: "closed" as const, txHash: TX_HASH, sender: PAYEE as Hex }))
      .mockImplementationOnce(async () => { entered(); await blocked; return { outcome: "closed" as const, txHash: TX_HASH, sender: PAYEE as Hex }; });
    const { server, creditId, drain, chain } = await hostedCredit(payer,
      { modes: ["submits-then-times-out"], findChannelClose: search });
    let poll: ReturnType<typeof drain> | undefined;
    const results: Awaited<ReturnType<typeof drain>>[] = [];
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n;
      chain.settled = SPENT;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      poll = drain(payer);
      void poll.then((result) => { results.push(result); });
      await started;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(results).toEqual([]);
      await vi.advanceTimersByTimeAsync(30_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(results).toMatchObject([{ status: 402, body: { retryable: true } }]);
      vi.useRealTimers();
      expect((await drain(payer)).status).toBe(200);
      expect(search).toHaveBeenCalledTimes(2);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent" });
    } finally {
      release();
      vi.useRealTimers();
      await Promise.allSettled([poll]);
      await server.shutdown();
    }
  });

  it("retains saved search progress when a cursor write stalls beyond the backstop", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const cursor = 2_500_000n;
    let release!: () => void;
    let persisted!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const saved = new Promise<void>((resolve) => { persisted = resolve; });
    const findChannelClose = vi.fn<NonNullable<NonNullable<Parameters<typeof _testing.attachTempoSessionRuntime>[2]>["findChannelClose"]>>()
      .mockResolvedValueOnce({ outcome: "paused", resumeAt: cursor })
      .mockResolvedValue({ outcome: "closed", txHash: TX_HASH, sender: PAYEE as Hex });
    const { server, creditId, channelId, drain, chain, runtimeConfig } = await hostedCredit(payer,
      { modes: ["submits-then-times-out"], findChannelClose });
    const obligations = runtimeConfig.hostedObligations!;
    const record = obligations.recordTempoCloseSearch.bind(obligations);
    const write = vi.spyOn(obligations, "recordTempoCloseSearch");
    const results: Awaited<ReturnType<typeof drain>>[] = [];
    let poll: ReturnType<typeof drain> | undefined;
    const readCursor = async () => (await pool.query<{ close_search_before: string }>(
      "SELECT close_search_before FROM sdk_hosted_settlement_report_obligations WHERE channel_id=$1", [channelId]
    )).rows[0].close_search_before;
    try {
      expect((await drain(payer)).status).toBe(402);
      chain.deposit = 0n;
      chain.settled = SPENT;
      write.mockImplementationOnce(async (id, resumeAt) => {
        await record(id, resumeAt);
        persisted();
        await blocked;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      poll = drain(payer);
      void poll.then((result) => { results.push(result); });
      await saved;
      await vi.advanceTimersByTimeAsync(59_999);
      expect(results).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(results).toMatchObject([{ status: 402, body: { retryable: true } }]);
      vi.useRealTimers();
      expect(await readCursor()).toBe("2500000");
      expect((await drain(payer)).status).toBe(200);
      expect(findChannelClose.mock.calls[1][4]).toBe(cursor);
      expect(await readCursor()).toBe("2500000");
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "sent",
        sentRef: { tx_hash: TX_HASH, settled_amount: "150000" } });
    } finally {
      release();
      vi.useRealTimers();
      await Promise.allSettled([poll]);
      write.mockRestore();
      await server.shutdown();
    }
  });

  it.each(["intent poll", "intent sweep", "delivered poll", "delivered sweep", "short intent poll", "short delivered sweep"])(
    "uses the durable transaction receipt when logs are unavailable: %s", async (source) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, mpp, creditId, channelId, drain, chain, rpc, readChannelClose } = await hostedCredit(payer,
      { modes: ["submits-then-times-out"] });
    const warn = vi.spyOn(loggers.tempo, "warn");
    const short = source.startsWith("short");
    try {
      expect((await drain(payer)).status).toBe(402);
      await ledger.requireTempoDrainExit({ creditId, drainId: "d1" });
      if (source.includes("intent")) await sessions.confirmClose(channelId, "d1", TX_HASH);
      else await pool.query("UPDATE sdk_hosted_settlement_report_obligations SET state='delivered',tx_hash=$2 WHERE channel_id=$1",
        [channelId, TX_HASH]);
      chain.deposit = 0n;
      chain.settled = SPENT;
      rpc.searchGate.wait = () => Promise.reject(new Error("log history unavailable"));
      if (short) readChannelClose.mockResolvedValue({ settledToPayee: SPENT, refundedToPayer: 99_999n });
      if (source.endsWith("poll")) expect((await drain(payer)).status).toBe(short ? 409 : 200);
      else await mpp.reconcileTempoSessionCloses!();
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject(short
        ? { status: "exit_required", sentRef: null }
        : { status: "sent", sentRef: { tx_hash: TX_HASH, settled_amount: "150000" } });
      if (short) expect(warn).toHaveBeenCalledWith("tempo_session_drain_refund_unproven",
        expect.objectContaining({ channel_id: channelId, reason: "refund_short", amount_at_stake_native: "100000" }));
      expect(readChannelClose.mock.calls.filter(([, id]) => id === channelId)).toHaveLength(1);
      expect(rpc.requests.filter(({ method }) => method === "eth_getLogs")).toEqual([]);
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
    } finally {
      warn.mockRestore();
      await server.shutdown();
    }
  });

  it.each(["exit grace pending", "node behind the close block"])(
    "retries a transient miss without consuming the definitive refund alert: %s", async (transient) => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const { server, creditId, channelId, drain, chain, logs, rpc } = await hostedCredit(payer);
    const warn = vi.spyOn(loggers.tempo, "warn");
    const refundAlerts = () => warn.mock.calls.filter(([event, fields]) =>
      event === "tempo_session_drain_refund_unproven" && fields?.credit_id === creditId);
    try {
      expect((await drain(payer, null)).status).toBe(409);
      chain.deposit = 0n;
      chain.settled = SPENT;
      const now = BigInt(Math.floor(Date.now() / 1000));
      logs.push({ event: "CloseRequested", block: HEAD - 10n, txHash: EXIT_TX_HASH,
        from: payer.address, closeGraceEnd: transient === "exit grace pending" ? now + 86_400n : now - 30n });
      if (transient === "node behind the close block") {
        rpc.timing.headTimestamp = now - 60n;
        logs.push({ event: "ChannelClosed", block: HEAD + 1n, txHash: TX_HASH, from: payer.address });
      }
      const retry = await drain(payer);
      expect(retry).toMatchObject({ status: 402, body: { retryable: true } });
      expect(refundAlerts()).toEqual([]);
      expect((await sessions.get(channelId) as Record<string, unknown>).drainRefundWarnings).toBeUndefined();
      logs.length = 0;
      rpc.timing.headTimestamp = undefined;
      const definitive = await drain(payer);
      expect(definitive).toMatchObject({ status: 409, body: { error: "settlement_pending", retryable: false } });
      expect(definitive.body).toMatchObject({
        message: "The full Tempo refund could not be proven yet.",
        display: "Your funds remain held and have not been lost. The DVM operator has been alerted.",
      });
      expect(refundAlerts()).toEqual([["tempo_session_drain_refund_unproven", expect.objectContaining({
        channel_id: channelId, amount_at_stake_native: "100000", reason: "close_evidence_missing",
      })]]);
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toMatchObject({ status: "exit_required", sentRef: null });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
      expect((await drain(payer)).status).toBe(409);
      expect(refundAlerts()).toHaveLength(1);
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
      expect((await drain(payer)).status).toBe(409);
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
      expect((await drain(payer)).status).toBe(409);
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
      expect((await drain(payer)).status).toBe(409);
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
      expect(await drain(payer)).toMatchObject({ status: 402, body: { retryable: true } });
      expect(await ledger.getDrain({ creditId, drainId: "d1" }))
        .toMatchObject({ status: "pending", sentRef: null });
      expect(await obligations()).toEqual([{ state: "reserved", tx_hash: null }]);
      expect(warn).not.toHaveBeenCalledWith("tempo_session_close_exit_resolved", expect.anything());
      expect(warn).not.toHaveBeenCalledWith("tempo_session_drain_refund_unproven", expect.anything());

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
