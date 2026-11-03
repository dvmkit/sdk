/**
 * The payment-intent contract every job store with arrival support must keep,
 * run against the memory store offline and the Postgres store under the
 * database suite. Time is faked through `Date` only, so a real Postgres pool
 * keeps working underneath.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ASK_EXPIRY_GRACE_MS } from "../../ask-expiry";
import type { JobRecord, StreamableJobStore } from "../../job-store";
import {
  PAYMENT_INTENT_LEASE_MS,
  PaymentIntentOpenError,
  type PaymentArrivalStore,
} from "../../payment-arrival";

type IntentStore = StreamableJobStore & PaymentArrivalStore;

const NOW = 1_900_000_000_000;
const ASK_MSATS = 16_000;

export function paymentIntentContract(name: string, open: () => Promise<IntentStore>): void {
  describe(`${name}: payment arrivals hold the job open while they verify`, () => {
    afterEach(() => { vi.useRealTimers(); });

    let counter = 0;
    async function awaitingJob(store: IntentStore, expiresAtMs = NOW + 60_000): Promise<string> {
      const id = `intent-${name}-${++counter}-${Math.random().toString(16).slice(2)}`;
      const record: JobRecord = {
        id, tags: [], capability: "test", input: "", params: {}, requesterId: "requester",
        status: "processing", messages: [], seq: 0, paidMsats: 0, receivedProofs: [],
        stepCache: [], state: {}, createdAt: NOW, lastActivityAt: NOW,
      };
      await store.save(record);
      await store.appendOutgoing(id, { from: "provider", type: "payment-request", timestamp: Math.floor(NOW / 1000),
        content: { amount_msats: ASK_MSATS, reason: "next step", expires_at_ms: expiresAtMs } },
      { awaitingInput: true, pendingPaymentDelta: ASK_MSATS });
      return id;
    }

    async function arrive(store: IntentStore, id: string, arrivedAtMs = NOW) {
      return store.recordPaymentArrival(id, { from: "requester", type: "payment", timestamp: Math.floor(arrivedAtMs / 1000),
        content: { cashu_token: "token" } }, { arrivedAtMs, leaseMs: PAYMENT_INTENT_LEASE_MS });
    }

    it("refuses every terminal write while the intent is open, and states when to retry", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const store = await open();
      const id = await awaitingJob(store);
      const { seq, disposition } = await arrive(store, id);
      expect(disposition).toEqual({ disposition: "ask" });
      const held = { name: "PaymentIntentOpenError", retryAtMs: NOW + PAYMENT_INTENT_LEASE_MS };

      await expect(store.cancelJob(id, "caller stopped")).rejects.toMatchObject(held);
      vi.setSystemTime(NOW + 60_000 + ASK_EXPIRY_GRACE_MS);
      await expect(store.cancelStaleJob(id, Number.MAX_SAFE_INTEGER, "Job timed out (idle)", "cancelled"))
        .rejects.toMatchObject(held);
      await expect(store.failJob!(id, "worker died")).rejects.toMatchObject(held);
      const record = (await store.get(id))!;
      await expect(store.save({ ...record, status: "completed", summary: "done" })).rejects.toBeInstanceOf(PaymentIntentOpenError);
      expect((await store.get(id))?.status).toBe("awaiting-input");
      expect(await store.openPaymentIntentUntil(id, Date.now())).toBe(NOW + PAYMENT_INTENT_LEASE_MS);

      // Tx C resolves it, and the job can end.
      await store.verifyAndCredit(id, seq, null);
      expect(await store.openPaymentIntentUntil(id, Date.now())).toBeUndefined();
      expect(await store.cancelJob(id, "caller stopped")).toBe(true);
    });

    it("lets a refusal release the job", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const store = await open();
      const id = await awaitingJob(store);
      const { seq } = await arrive(store, id);
      await store.markInboundFailed(id, seq, "payment_invalid");
      expect(await store.cancelJob(id, "caller stopped")).toBe(true);
    });

    it("bounds an intent whose verifier died by its lease", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const store = await open();
      const id = await awaitingJob(store);
      await arrive(store, id);
      vi.setSystemTime(NOW + PAYMENT_INTENT_LEASE_MS - 1);
      await expect(store.cancelJob(id, "caller stopped")).rejects.toBeInstanceOf(PaymentIntentOpenError);
      vi.setSystemTime(NOW + PAYMENT_INTENT_LEASE_MS);
      expect(await store.openPaymentIntentUntil(id, Date.now())).toBeUndefined();
      expect(await store.cancelJob(id, "caller stopped")).toBe(true);
    });

    it.each([
      [ASK_EXPIRY_GRACE_MS - 1, { disposition: "ask" }],
      [ASK_EXPIRY_GRACE_MS, { disposition: "balance", reason: "ask_expired" }],
    ])("decides an arrival %i ms past the ask's deadline from the arrival time", async (pastMs, expected) => {
      const store = await open();
      const id = await awaitingJob(store, NOW);
      expect((await arrive(store, id, NOW + pastMs)).disposition).toEqual(expected);
    });

    it("records an arrival on an ended job, or with no ask open, as balance", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: NOW });
      const store = await open();
      const ended = await awaitingJob(store);
      expect(await store.cancelJob(ended, "caller stopped")).toBe(true);
      const late = await arrive(store, ended);
      expect(late.disposition).toEqual({ disposition: "balance", reason: "job_ended" });
      // The ended job keeps the arrival until its outcome is recorded, and takes no payment or binding from it.
      const outcome = await store.verifyAndCredit(ended, late.seq,
        { paidMsatsDelta: ASK_MSATS, clearPending: true, creditId: "late-credit", drawId: "late-draw" });
      expect(outcome).toMatchObject({ creditRefused: "job_ended", alreadyVerified: false });
      const endedRow = await store.get(ended);
      expect([endedRow?.paidMsats, endedRow?.creditId, endedRow?.drawId]).toEqual([0, undefined, undefined]);
      // Recorded, but kept out of history and replay: it paid no ask.
      expect(await store.getVerifiedInbound(ended, late.seq)).toMatchObject({ alreadyVerified: true });
      expect((await store.getMessages(ended, 0, { includeHeld: true })).some((message) => message.seq === late.seq)).toBe(false);

      // A live job's balance landing is kept out of history the same way.
      const live = await awaitingJob(store);
      const landed = await arrive(store, live, NOW + 60_000 + ASK_EXPIRY_GRACE_MS);
      expect(landed.disposition).toEqual({ disposition: "balance", reason: "ask_expired" });
      await store.verifyAndCredit(live, landed.seq, null, { landedAsBalance: true });
      expect((await store.getMessages(live, 0, { includeHeld: true })).map((message) => message.type)).toEqual(["payment-request"]);
      expect((await store.get(live))?.pendingPaymentMsats).toBe(ASK_MSATS);

      const paid = await awaitingJob(store);
      const first = await arrive(store, paid);
      await store.verifyAndCredit(paid, first.seq, { paidMsatsDelta: ASK_MSATS, clearPending: true });
      expect((await arrive(store, paid)).disposition).toEqual({ disposition: "balance", reason: "no_open_ask" });
    });
  });
}
