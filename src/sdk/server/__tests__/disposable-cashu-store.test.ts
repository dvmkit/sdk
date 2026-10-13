import { Amount, type Proof } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";
import { createDisposableCashuStore } from "../disposable-cashu-store";

const proof = (secret: string): Proof => ({ secret, C: "unused", id: "unused", amount: Amount.from(1) });
const funding = (creditId: string) => ({
  creditId, callerPubkey: "caller", currency: "usd", amountMicro: 10,
  expiryMs: Date.now() + 60000,
  basis: { rail: "cashu" as const, paidMsats: 1000, mint: "http://localhost:3338", fundingRef: creditId },
});

describe("disposable atomic Cashu accounting", () => {
  it("publishes proof ownership and fund/draw together and rejects concurrent reuse", async () => {
    const { ledger, accumulator } = createDisposableCashuStore();
    const pay = (id: string) => accumulator.commit(id, [proof("one")], async (staged) => {
      await staged.fund(funding(id));
      await staged.draw({ creditId: id, drawId: id, amountMicro: 10 });
    });
    const results = await Promise.allSettled([pay("a"), pay("b")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await ledger.getDraw({ creditId: "a", drawId: "a" }))?.status).toBe("pending");
    expect(await ledger.get("b")).toBeUndefined();
    await expect(accumulator.commit("a", [proof("two")], async () => {})).rejects.toThrow("replay");
  });

  it("rolls back partial funding and keeps an unrelated concurrent ledger mutation", async () => {
    const { ledger, accumulator } = createDisposableCashuStore();
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const failed = accumulator.commit("a", [proof("one")], async (staged) => {
      await staged.fund(funding("a"));
      entered();
      await barrier;
      throw new Error("accounting failure");
    });
    const rejection = expect(failed).rejects.toThrow("accounting failure");
    await inside;
    const unrelated = ledger.fund(funding("b"));
    release();
    await rejection;
    await unrelated;
    expect(await ledger.get("a")).toBeUndefined();
    expect((await ledger.get("b"))?.availableMicro).toBe(10);
    await accumulator.commit("a", [proof("one")], async (staged) => { await staged.fund(funding("a")); });
    expect((await ledger.get("a"))?.availableMicro).toBe(10);
  });
});
