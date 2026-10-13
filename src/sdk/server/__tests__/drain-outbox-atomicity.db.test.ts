import { schnorr } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { commitTerminalDrain } from "../credit-drain-report";
import { CreditLedger } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { MemoryJobStore } from "../memory-job-store";
import { RevenueReporter } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { fundCredit } from "./__helpers__/credit-fixtures";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const DVM_ID = "dvm-drain-drain";
const DVM_SCHEMA = `dvm_drain_drain_${process.pid}`;
const PRIVKEY = new Uint8Array(32).fill(21);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const REFUND_PUBKEY = `02${"cd".repeat(32)}`;
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-30T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

interface PendingDrainRow {
  payload: {
    dvmId: string;
    creditId: string;
    callerPubkey: string;
    drainId: string;
    method: string;
    amountMicro: number;
    creditCurrency: string;
    status: string;
  };
}

describe.skipIf(!RUN)("— transactional drain outbox", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let ledger: CreditLedger;
  let reporter: RevenueReporter;

  beforeAll(async () => {
    // Own schema, same reason as the deposit-outbox suite: the platform test
    // harness owns the platform's differently-shaped `public.pending_revenue_reports`.
    adminPool = new pg.Pool({ connectionString: DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${DVM_SCHEMA}`);
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${DVM_SCHEMA}`,
    });
    ledger = new CreditLedger(pool);
    reporter = new RevenueReporter(pool, "https://platform.invalid", "token");
    await Promise.all([ledger.init(), reporter.init()]);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM pending_dvm_reports");
    await pool.query("DELETE FROM credit_drains");
    await pool.query("DELETE FROM credit_draws");
    await pool.query("DELETE FROM credit_fundings");
    await pool.query("DELETE FROM credits");
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${DVM_SCHEMA} CASCADE`);
    await adminPool.end();
  });

  async function pendingDrains(): Promise<PendingDrainRow[]> {
    const { rows } = await pool.query<PendingDrainRow>(
      `SELECT payload FROM pending_dvm_reports WHERE kind = 'drain' ORDER BY created_at`
    );
    return rows;
  }

  function wiring(enqueue = reporter.enqueueCreditDrain.bind(reporter)) {
    return { db: pool, dvmId: DVM_ID, enqueueCreditDrain: enqueue };
  }

  async function openDrain(args: {
    creditId: string;
    drainId: string;
    method: "cashu" | "x402";
    amountMicro: number;
  }): Promise<void> {
    await fundCredit(ledger, {
      creditId: args.creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: args.amountMicro,
      expiryMs: FUTURE_MS,
    });
    await ledger.requestDrain({
      creditId: args.creditId,
      drainId: args.drainId,
      callerPubkey: CALLER,
      method: args.method,
      payout:
        args.method === "cashu"
          ? { refund_pubkey: REFUND_PUBKEY }
          : { address: `0x${"ab".repeat(20)}` },
    });
  }

  it("reports a send-back once, however many times the transition is retried", async () => {
    await openDrain({
      creditId: "c-sent",
      drainId: "d1",
      method: "x402",
      amountMicro: 400_000,
    });

    const sent = await commitTerminalDrain(wiring(), (tx) =>
      ledger.markDrainSent({
        creditId: "c-sent",
        drainId: "d1",
        sentRef: { tx_hash: "0xaa11" },
        tx,
      })
    );
    expect(sent.drain.status).toBe("sent");
    expect(sent.replayed).toBe(false);

    const retry = await commitTerminalDrain(wiring(), (tx) =>
      ledger.markDrainSent({ creditId: "c-sent", drainId: "d1", sentRef: {}, tx })
    );
    expect(retry.replayed).toBe(true);

    expect(await pendingDrains()).toEqual([
      {
        payload: expect.objectContaining({
          dvmId: DVM_ID,
          creditId: "c-sent",
          callerPubkey: CALLER,
          drainId: "d1",
          method: "x402",
          amountMicro: 400_000,
          creditCurrency: "usd",
          status: "sent",
        }),
      },
    ]);
  });

  it("rolls the transition back when the outbox write fails", async () => {
    await openDrain({
      creditId: "c-rollback",
      drainId: "d1",
      method: "x402",
      amountMicro: 300_000,
    });

    await expect(
      commitTerminalDrain(
        wiring(() => Promise.reject(new Error("outbox down"))),
        (tx) => ledger.markDrainSent({ creditId: "c-rollback", drainId: "d1", sentRef: {}, tx })
      )
    ).rejects.toThrow("outbox down");

    const drain = await ledger.getDrain({ creditId: "c-rollback", drainId: "d1" });
    expect(drain?.status).toBe("pending");
    expect(await pendingDrains()).toHaveLength(0);
  });

  it("surfaces a ledger refusal unchanged", async () => {
    await openDrain({
      creditId: "c-refuse",
      drainId: "d1",
      method: "cashu",
      amountMicro: 100_000,
    });

    await expect(
      commitTerminalDrain(wiring(), (tx) =>
        ledger.markDrainSent({ creditId: "c-refuse", drainId: "d1", sentRef: {}, tx })
      )
    ).rejects.toMatchObject({ code: "invalid_drain_state" });
    expect(await pendingDrains()).toHaveLength(0);
  });

  it("reports the cashu pickup through the hosted /v1/credit route", async () => {
    const descriptor = configureDVM({
      name: "dvm-drain-drain",
      capability: "test",
      input: signedSchema,
      price: "$0.10",
      credit: { min: "$0.10", max: "$5.00" },
      auth: secp256k1Auth(),
      onJob(ctx) {
        ctx.complete("ok");
      },
    });
    const built = await createDVMServer(descriptor, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "token",
        DVMKIT_PLATFORM_URL: "https://platform.invalid",
      },
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      db: pool,
      dvmId: DVM_ID,
      fxFetcher: stubFx,
      creditLedger: ledger,
    });

    try {
      expect(built.revenueReporterActive).toBe(true);
      await fundCredit(ledger, {
        creditId: "c-route",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 250_000,
        expiryMs: FUTURE_MS,
      });

      const drainCall = (drain: Record<string, unknown>) =>
        built.app.request("/v1/credit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            creditSigner.signRequest(PRIVKEY, { op: "drain", credit_id: "c-route", drain })
          ),
        });

      const requested = await drainCall({
        drain_id: "d1",
        method: "cashu",
        payout: { refund_pubkey: REFUND_PUBKEY },
      });
      expect(requested.status).toBe(200);
      expect(await pendingDrains()).toHaveLength(0);

      await ledger.parkDrain({ creditId: "c-route", drainId: "d1", token: "cashuBparked" });
      expect(await pendingDrains()).toHaveLength(0);

      const pickup = await drainCall({ drain_id: "d1" });
      expect(pickup.status).toBe(200);
      expect(((await pickup.json()) as { drain: { status: string } }).drain.status).toBe(
        "picked_up"
      );

      expect((await drainCall({ drain_id: "d1" })).status).toBe(200);

      expect(await pendingDrains()).toEqual([
        {
          payload: expect.objectContaining({
            dvmId: DVM_ID,
            creditId: "c-route",
            callerPubkey: CALLER,
            drainId: "d1",
            method: "cashu",
            amountMicro: 250_000,
            creditCurrency: "usd",
            status: "picked_up",
          }),
        },
      ]);
    } finally {
      await built.shutdown();
    }
  });
});
