/**
 * The piece-accounting contract every built-in job store keeps, run against the memory store
 * offline and the Postgres store under the database suite.
 */
import { describe, expect, it } from "vitest";

import type { JobRecord, StreamableJobStore } from "../../job-store";

const NOW = 1_900_000_000_000;

export function pieceStoreContract(name: string, open: () => Promise<StreamableJobStore>): void {
  describe(`${name}: piece accounting in the store`, () => {
    let counter = 0;
    async function runningJob(store: StreamableJobStore): Promise<string> {
      const id = `pieces-${name.replaceAll(" ", "-")}-${++counter}-${Math.random().toString(16).slice(2)}`;
      const record: JobRecord = {
        id, tags: [], capability: "test", input: "", params: {}, requesterId: "requester",
        status: "processing", messages: [], seq: 0, paidMsats: 0, receivedProofs: [], stepCache: [], state: {},
        createdAt: NOW, lastActivityAt: NOW, creditId: "c1", drawId: "d1",
        pieces: [{ amountMicro: 100_000, paidSeq: 0, state: "running" }],
      };
      await store.save(record);
      return id;
    }
    const ask = (store: StreamableJobStore, id: string, opts: { finishedChargeMicro?: number } = {}) =>
      store.appendOutgoing(id, { from: "provider", type: "payment-request", timestamp: 1,
        content: { amount_msats: 200_000, reason: "piece 2", expires_at_ms: Date.now() + 60_000 } },
      { awaitingInput: true, pendingPaymentDelta: 200_000, ...opts });
    async function payAsk(store: StreamableJobStore, id: string): Promise<number> {
      const seq = await store.recordInbound(id, { from: "requester", type: "payment", timestamp: 1, content: { cashu_token: "t" } });
      await store.verifyAndCredit(id, seq, { paidMsatsDelta: 200_000, clearPending: true, piece: { amountMicro: 200_000, drawId: "d1" } });
      return seq;
    }

    it("ends a job at a decline only while an ask or prompt is open, releasing the running piece", async () => {
      const store = await open();
      if (!store.declineJob) throw new Error("the built-in stores implement declineJob");
      const id = await runningJob(store);
      expect(await store.declineJob(id, "no thanks")).toBe("no_open_ask");

      await ask(store, id);
      const paidSeq = await payAsk(store, id);
      // The ask is paid, so nothing is open for the caller to decline.
      expect(await store.declineJob(id, "no thanks")).toBe("no_open_ask");
      expect((await store.get(id))?.status).not.toBe("cancelled");

      await store.appendOutgoing(id, { from: "provider", type: "prompt", timestamp: 1,
        content: { id: "more", text: "Keep going?", expires_at_ms: Date.now() + 60_000 } }, { awaitingInput: true });
      expect(await store.declineJob(id, "no thanks")).toBe("declined");
      const declined = (await store.get(id))!;
      expect(declined).toMatchObject({ status: "cancelled", endedBy: "caller", summary: "no thanks" });
      expect(declined.pieces).toEqual([
        { amountMicro: 100_000, paidSeq: 0, state: "finished" },
        { amountMicro: 200_000, paidSeq, state: "released" },
      ]);
      expect(declined.settlement).toEqual({ chargedMicro: 100_000, stoppedPiece: false });

      expect(await store.declineJob(id, "no thanks")).toBe("not_active");
      expect((await store.get(id))!.settlement).toEqual(declined.settlement);
    });

    it("never lowers a piece below zero or to a fraction, whoever calls the store", async () => {
      for (const finishedChargeMicro of [-1, 0.5, Number.NaN]) {
        const store = await open();
        const id = await runningJob(store);
        await ask(store, id, { finishedChargeMicro });
        expect((await store.get(id))!.pieces).toEqual([{ amountMicro: 100_000, paidSeq: 0, state: "finished" }]);
        const terminal = await runningJob(store);
        const record = (await store.get(terminal))!;
        await store.save({ ...record, status: "completed", pieceEnding: { kind: "finish", paidSeq: 0, chargeMicro: finishedChargeMicro } });
        expect((await store.get(terminal))!.settlement).toEqual({ chargedMicro: 100_000, stoppedPiece: false });
      }
    });
  });
}
