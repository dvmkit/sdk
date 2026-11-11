import { EventEmitter } from "node:events";

import type { FacilitatorClient } from "@x402/core/server";
import type { SettleResponse, SupportedResponse } from "@x402/core/types";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import type { Channel } from "@x402/evm/batch-settlement/server";
import type { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { CreditLedger } from "../credit-ledger";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { PayoutReporter, type PayoutTransport } from "../payout-reporter";
import { createX402BatchSettlementServer } from "../x402-batch-settlement";
import { PostgresX402ChannelStorage } from "../x402-channel-store";
import { x402ShutdownClaimEnvironment } from "../x402-shutdown-claim";

const connection = vi.hoisted(() => ({ settlementPool: undefined as unknown }));
vi.mock("pg", () => ({ default: { Pool: class {
  constructor() { return connection.settlementPool as object; }
} } }));

interface Result { rows: Record<string, unknown>[]; rowCount: number }
const empty = (): Result => ({ rows: [], rowCount: 1 });

// Model pg's checkout/return boundary: end waits for clients, and destroying one rejects its active query.
class DatabasePool extends EventEmitter {
  readonly options = {};
  readonly clients = new Set<DatabaseClient>();
  private closing = false;
  private finishClose?: () => void;

  constructor(readonly respond: (sql: string, args: unknown[]) => Result | Promise<Result>) { super(); }

  async connect(): Promise<DatabaseClient> {
    if (this.closing) throw new Error("pool is closing");
    const client = new DatabaseClient(this);
    this.clients.add(client);
    return client;
  }

  async query(sql: string, args: unknown[] = []): Promise<Result> {
    const client = await this.connect();
    try { return await client.query(sql, args); }
    finally { client.release(); }
  }

  async end(): Promise<void> {
    this.closing = true;
    if (this.clients.size) await new Promise<void>((resolve) => { this.finishClose = resolve; });
  }

  returned(client: DatabaseClient): void {
    this.clients.delete(client);
    if (!this.clients.size) this.finishClose?.();
  }
}

class DatabaseClient extends EventEmitter {
  private released = false;
  private readonly pending = new Set<(error: Error) => void>();

  constructor(private readonly pool: DatabasePool) { super(); }

  query(input: string | { text: string }, args: unknown[] = []): Promise<Result> {
    if (this.released) return Promise.reject(new Error("client is released"));
    return new Promise<Result>((resolve, reject) => {
      this.pending.add(reject);
      Promise.resolve().then(() => this.pool.respond(typeof input === "string" ? input : input.text, args))
        .then(resolve, reject);
    }).finally(() => { this.pending.clear(); });
  }

  release(destroy?: boolean | Error): void {
    if (this.released) throw new Error("client released twice");
    this.released = true;
    if (destroy) for (const reject of this.pending) reject(new Error("client destroyed"));
    this.pool.returned(this);
  }
}

const NETWORK = "eip155:84532";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HASH = `0x${"aa".repeat(32)}`;
const reservation = { id: "11111111-1111-4111-8111-111111111111", replayed: false };
const phases = [
  "hosted reservation", "hosted submission record", "earned credit read",
  "payout batch read", "payout batch write", "hosted submitted claim lookup", "connection probe",
] as const;
type Phase = typeof phases[number] | "late reservation" | "snapshot";

async function fixture(phase: Phase) {
  const receiver = privateKeyToAccount(`0x${"22".repeat(32)}`);
  const config: Channel["channelConfig"] = {
    payer: `0x${"11".repeat(20)}`, payerAuthorizer: `0x${"11".repeat(20)}`,
    receiver: receiver.address, receiverAuthorizer: receiver.address, token: TOKEN,
    withdrawDelay: 86_400, salt: `0x${"33".repeat(32)}`,
  };
  const channelId = computeChannelId(config, NETWORK).toLowerCase();
  const row = {
    channel_id: channelId, channel_config: config, charged_cumulative_amount: "100",
    signed_max_claimable: "100", signature: `0x${"44".repeat(65)}`, balance: "1000",
    total_claimed: "0", withdraw_requested_at: 0, refund_nonce: 0,
    onchain_synced_at: null, last_request_timestamp: 0,
  };
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  let unblock!: (result: Result) => void;
  const delayed = new Promise<Result>((resolve) => { unblock = resolve; });
  const hosted = phase.startsWith("hosted") || phase === "connection probe" || phase === "late reservation";
  const payout = phase.startsWith("payout") || phase === "hosted submitted claim lookup" || phase === "snapshot";
  const respond = (sql: string, args: unknown[]): Result | Promise<Result> => {
    const blocks =
      phase === "hosted reservation" && sql.includes("SELECT channel_config,charged_cumulative_amount") ||
      phase === "hosted submission record" && sql.includes("sdk_hosted_settlement_report_obligations WHERE id=") ||
      phase === "earned credit read" && sql.includes("FROM credits c") ||
      phase === "payout batch read" && sql.includes("SELECT * FROM payout_x402_batches") ||
      phase === "payout batch write" && sql.includes("INSERT INTO payout_x402_batches") ||
      phase === "hosted submitted claim lookup" && sql.includes("SELECT id,original FROM sdk_hosted_settlement_report_obligations") ||
      phase === "connection probe" && sql === "SELECT 1";
    if (blocks) { entered(); return delayed; }
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (sql.includes("SELECT * FROM x402_batch_channels")) return { rows: [{ ...row }], rowCount: 1 };
    if (sql.includes("INSERT INTO x402_batch_channels (")) row.total_claimed = String(args[6]);
    if (sql.includes("FROM credits c")) return { rows: [{ earned: "100" }], rowCount: 1 };
    if (hosted && sql.includes("SELECT * FROM payout_x402_batches")) return { rows: [{
      scope: args[0], batch_id: "22222222-2222-4222-8222-222222222222", claimed_native: "0",
      voucher_count: 0, claims: 0, opened_at: "0", attempts: 0, first_failed_at: null,
      last_error: null, next_retry_at: null, obligation_ids: [],
    }], rowCount: 1 };
    return empty();
  };
  const pool = new DatabasePool(respond);
  const terminal = new DatabasePool(respond);
  connection.settlementPool = terminal;
  const store = new PostgresX402ChannelStorage(pool as unknown as Pool);
  const obligations = new HostedSettlementReportObligations(pool as unknown as Pool, "example-dvm", "example-scope");
  obligations.configureX402({ network: NETWORK, receiver: receiver.address, token: TOKEN });
  if (phase === "hosted submission record" || phase === "hosted submitted claim lookup") {
    vi.spyOn(obligations, "reserveX402").mockResolvedValue(reservation);
  }
  if (phase === "hosted submitted claim lookup") vi.spyOn(obligations, "recordSubmitted").mockResolvedValue();
  let finishReservation!: () => void;
  if (phase === "late reservation") {
    vi.spyOn(obligations, "reserveX402").mockImplementation(() => new Promise((resolve) => {
      finishReservation = () => resolve(reservation);
      entered();
    }));
    vi.spyOn(obligations, "recordSubmitted").mockResolvedValue();
  }
  const facilitator: FacilitatorClient = {
    getSupported: vi.fn(async (): Promise<SupportedResponse> => ({ kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }], extensions: [], signers: {} })),
    verify: vi.fn(),
    settle: vi.fn(async (): Promise<SettleResponse> => ({ success: true, transaction: HASH, network: NETWORK })),
  };
  const transport: PayoutTransport = {
    enqueuePayout: vi.fn(), reportPayout: vi.fn(), reportPayoutPending: vi.fn(), drainPending: vi.fn(),
  };
  const reporter = new PayoutReporter({
    dvmId: "example-dvm", db: pool as unknown as Pool, transport,
    ...(hosted ? { hostedObligations: obligations } : {}),
  });
  const ledger = new CreditLedger(pool as unknown as Pool);
  const server = await x402ShutdownClaimEnvironment.run({ DVMKIT_X402_SHUTDOWN_CLAIM_MS: "25" }, () => createX402BatchSettlementServer({
    network: NETWORK, payTo: receiver.address, channelStorage: store,
    earnedNative: (id) => ledger.earnedNativeForX402Channel(id),
    config: { facilitatorClient: facilitator, receiverAuthorizerSigner: receiver, autoSettlement: false },
    ...(hosted ? { hostedObligations: obligations } : {}),
    ...(payout ? { payout: reporter.x402Observer() } : {}),
  }));
  return { server, pool, terminal, blocked, unblock, facilitator, transport, channelId,
    finishReservation: () => finishReservation(), recordSubmitted: obligations.recordSubmitted };
}

describe("shutdown claim database deadline", () => {
  it.each(phases)("finishes stop and pool closure while %s stays blocked", async (phase) => {
    const f = await fixture(phase);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    let stopped = false;
    const stop = f.server.stop().then(() => { stopped = true; });
    try {
      await f.blocked;
      await vi.advanceTimersByTimeAsync(25);
      expect(stopped).toBe(true);
      let closed = false;
      const close = Promise.all([f.pool.end(), f.terminal.end()]).then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(true);
      await close;
      expect(f.pool.clients.size).toBe(0);
      expect(f.terminal.clients.size).toBe(0);
    } finally {
      f.unblock(empty());
      await vi.advanceTimersByTimeAsync(0);
      await stop;
      await Promise.all([f.pool.end(), f.terminal.end()]);
      vi.useRealTimers();
    }
  });

  it("does not submit when a hosted reservation completes after the deadline", async () => {
    const f = await fixture("late reservation");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const stopped = f.server.stop();
      await f.blocked;
      await vi.advanceTimersByTimeAsync(25);
      await stopped;
      expect(f.pool.clients.size).toBe(0);
      f.finishReservation();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.facilitator.settle).not.toHaveBeenCalled();
      expect(f.recordSubmitted).not.toHaveBeenCalled();
    } finally {
      await Promise.all([f.pool.end(), f.terminal.end()]);
      vi.useRealTimers();
    }
  });

  it("does not start a background payout snapshot during the final claim", async () => {
    const f = await fixture("snapshot");
    await f.server.stop();
    expect((await f.server.getChannel(f.channelId))?.totalClaimed).toBe("100");
    await Promise.all([f.pool.end(), f.terminal.end()]);
    expect(f.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(f.transport.reportPayoutPending).not.toHaveBeenCalled();
  });
});
