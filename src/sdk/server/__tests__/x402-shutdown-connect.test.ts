import { EventEmitter } from "node:events";

import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import type { Pool, PoolClient, PoolConfig } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import { applyRetryToPool } from "../../../lib/pg-retry";
import { CreditLedger } from "../credit-ledger";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { createX402BatchSettlementServer } from "../x402-batch-settlement";
import { PostgresX402ChannelStorage } from "../x402-channel-store";
import { connectForX402ShutdownClaim, x402ShutdownClaimEnvironment, x402ShutdownClaimSignal } from "../x402-shutdown-claim";

vi.mock("pg", async (importOriginal) => {
  const original = await importOriginal<typeof import("pg")>();
  return { ...original, default: { ...original.default, Pool: class extends original.default.Pool {
    constructor(options: PoolConfig) {
      super({ ...options, Client: PendingTransport as unknown as PoolConfig["Client"] });
      settlementPools.push(this);
    }
  } } };
});

const NETWORK = "eip155:84532";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const receiver = privateKeyToAccount(`0x${"22".repeat(32)}`);
const config = {
  payer: `0x${"11".repeat(20)}` as const, payerAuthorizer: `0x${"11".repeat(20)}` as const,
  receiver: receiver.address, receiverAuthorizer: receiver.address, token: TOKEN as `0x${string}`,
  withdrawDelay: 86_400, salt: `0x${"33".repeat(32)}` as const,
};
const row = {
  channel_id: computeChannelId(config, NETWORK).toLowerCase(), channel_config: config,
  charged_cumulative_amount: "100", signed_max_claimable: "100", signature: `0x${"44".repeat(65)}`,
  balance: "1000", total_claimed: "0", withdraw_requested_at: 0, refund_nonce: 0,
  onchain_synced_at: null, last_request_timestamp: 0,
};
let transports: PendingTransport[] = [];
let settlementPools: Pool[] = [];
let started = (_transport: PendingTransport) => {};

// Only the wire is simulated: pg owns the connecting-client registry, queue, timers and end().
class PendingTransport extends EventEmitter {
  _queryable = true;
  _ending = false;
  private finishHandshake?: () => void;
  private failHandshake?: (error: Error) => void;
  readonly connection = { stream: { destroy: vi.fn(() => this.fail(new Error("connection closed"))) } };

  constructor() {
    super();
    transports.push(this);
  }

  connect(callback: (error?: Error) => void): void {
    new Promise<void>((resolve, reject) => {
      this.finishHandshake = resolve;
      this.failHandshake = reject;
    }).then(() => callback(), (error: Error) => callback(error));
    started(this);
  }

  finish(): void { this.finishHandshake?.(); }
  fail(error: Error): void { this.failHandshake?.(error); }
  isConnected(): boolean { return false; }

  query(input: string | { text: string }): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = typeof input === "string" ? input : input.text;
    if (sql.includes("FROM credits c")) return new Promise(() => undefined);
    return Promise.resolve({
      rows: sql.includes("FROM x402_batch_channels") ? [{ ...row }] : [{ locked: true }], rowCount: 1,
    });
  }

  end(callback?: () => void): void {
    this._ending = true;
    this.fail(new Error("connection ended"));
    Promise.resolve().then(() => callback?.());
  }
}

class ReadyTransport extends PendingTransport {
  override connect(callback: (error?: Error) => void): void {
    super.connect(callback);
    this.finish();
  }
}

async function realPool(Client = PendingTransport, options: PoolConfig & { onConnect?: () => Promise<void> } = {}) {
  const original = await vi.importActual<typeof import("pg")>("pg");
  return new original.default.Pool({
    connectionTimeoutMillis: 10_000, max: 2, ...options,
    Client: Client as unknown as PoolConfig["Client"],
  });
}

async function serverFixture(boundary: "host" | "settlement" | "connect hook" | "parallel lookup") {
  transports = [];
  settlementPools = [];
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  started = (transport) => {
    if ((boundary === "host" || boundary === "settlement") && !(transport instanceof ReadyTransport)) enter();
  };
  let finishHook!: () => void;
  const hook = new Promise<void>((resolve) => { finishHook = resolve; });
  const pool = await realPool(boundary === "host" ? PendingTransport : ReadyTransport,
    boundary === "connect hook" ? { onConnect: () => { enter(); return hook; } } : {});
  const obligations = new HostedSettlementReportObligations(pool, "example-dvm", "example-scope");
  obligations.configureX402({ network: NETWORK, receiver: receiver.address, token: TOKEN });
  const facilitator: FacilitatorClient = {
    getSupported: vi.fn(async (): Promise<SupportedResponse> => ({
      kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }], extensions: [], signers: {},
    })),
    verify: vi.fn(), settle: vi.fn(),
  };
  const ledger = new CreditLedger(pool);
  const server = await x402ShutdownClaimEnvironment.run({ DVMKIT_X402_SHUTDOWN_CLAIM_MS: "25" }, () => createX402BatchSettlementServer({
    network: NETWORK, payTo: receiver.address, channelStorage: new PostgresX402ChannelStorage(pool),
    config: { facilitatorClient: facilitator, receiverAuthorizerSigner: receiver, autoSettlement: false },
    earnedNative: boundary === "parallel lookup"
      ? () => Promise.all([ledger.earnedNativeForX402Channel(row.channel_id), Promise.reject(new Error("lookup failed"))]).then(([earned]) => earned)
      : async () => 100,
    ...(boundary === "settlement" ? { hostedObligations: obligations } : {}),
  }));
  return { pool, server, entered, facilitator, finishHook };
}

describe("shutdown claim connection establishment", () => {
  it.each(["host", "settlement", "connect hook"] as const)("closes the real pool while a %s connection is still pending", async (boundary) => {
    const f = await serverFixture(boundary);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    let stopped = false;
    const stop = f.server.stop().then(() => { stopped = true; });
    let end: Promise<void> | undefined;
    try {
      await f.entered;
      const connecting = boundary === "settlement" ? settlementPools[0] : f.pool;
      expect(connecting.totalCount).toBe(1);
      expect(connecting.idleCount).toBe(0);
      let closed = false;
      end = f.pool.end().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(25);
      expect(stopped).toBe(true);
      expect(closed).toBe(true);
      expect(connecting.totalCount).toBe(0);
      expect(f.facilitator.settle).not.toHaveBeenCalled();
    } finally {
      f.finishHook();
      for (const transport of transports) transport.finish();
      await vi.advanceTimersByTimeAsync(25);
      await stop;
      await (end ?? f.pool.end());
      vi.useRealTimers();
    }
  });

  it("cancels abandoned database work when the claim finishes before its deadline", async () => {
    const f = await serverFixture("parallel lookup");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      await f.server.stop();
      let closed = false;
      const end = f.pool.end().then(() => { closed = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(true);
      await end;
    } finally {
      for (const transport of transports) transport.connection.stream.destroy();
      if (!f.pool.ending) await f.pool.end();
      vi.useRealTimers();
    }
  });

  it("does not start a queued handshake after cancellation", async () => {
    transports = [];
    started = () => {};
    const pool = await realPool(ReadyTransport, { max: 1 });
    const held = await pool.connect();
    const controller = new AbortController();
    const pending = x402ShutdownClaimSignal.run(controller.signal, () => connectForX402ShutdownClaim(pool));
    const rejected = expect(pending).rejects.toThrow("deadline");
    expect(pool.waitingCount).toBe(1);
    controller.abort(new Error("deadline"));
    await rejected;
    held.release(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      expect(transports).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("keeps an unrelated queued connection alive when the scoped handshake fails", async () => {
    transports = [];
    started = () => {};
    const pool = await realPool(PendingTransport, { max: 1 });
    const controller = new AbortController();
    const pending = x402ShutdownClaimSignal.run(controller.signal, () => connectForX402ShutdownClaim(pool));
    const rejected = expect(pending).rejects.toThrow("deadline");
    const unrelated = pool.connect();
    controller.abort(new Error("deadline"));
    await rejected;
    transports[0].fail(new Error("wire closed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(transports).toHaveLength(2);
    expect(transports[1].connection.stream.destroy).not.toHaveBeenCalled();
    transports[1].finish();
    const client = await unrelated;
    client.release();
    await pool.end();
  });

  it("preserves callback checkouts and does not cancel a reused connection", async () => {
    transports = [];
    started = () => {};
    const pool = await realPool(ReadyTransport, { max: 1 });
    const controller = new AbortController();
    applyRetryToPool(pool);
    const client = await x402ShutdownClaimSignal.run(controller.signal, () => connectForX402ShutdownClaim(pool));
    client.release();
    const unrelated = await new Promise<PoolClient>((resolve, reject) => {
      pool.connect((error, checkedOut) => {
        if (error) reject(error);
        else if (checkedOut) resolve(checkedOut);
        else reject(new Error("missing checked-out client"));
      });
    });
    controller.abort(new Error("deadline"));
    expect(transports[0].connection.stream.destroy).not.toHaveBeenCalled();
    unrelated.release();
    await pool.end();
  });
});
