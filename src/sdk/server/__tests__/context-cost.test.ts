import { describe, expect, it } from "vitest";

import { InvalidCurrencyError } from "../../pricing/index";
import { StepCache } from "../../step-cache";
import { MemoryKVStore } from "../../store";
import { buildContext } from "../context";
import { fromJobRecord, type ServerJob, toJobRecord } from "../job";

/**
 * Cost is a per-context cumulative assignment; replaying the same declarations must not add a
 * second copy to the job.
 */
function blankJob(): ServerJob {
  return {
    id: "job-1",
    tags: [],
    capability: "test",
    input: "",
    params: {},
    requesterId: "test",
    status: "processing",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    listeners: new Set(),
    abort: new AbortController(),
    stepCache: new StepCache(),
    state: {},
    pendingPrompts: new Map(),
    pendingPayment: null,
    replayHighSeq: null,
    replayProviderSkip: 0,
    replayPaymentIndex: 0,
    createdAt: 0,
    lastActivityAt: 0,
  };
}

const ctxFor = (job: ServerJob) => buildContext(job, { store: new MemoryKVStore(), env: {} });

describe("buildContext.cost — what the job cost the builder", () => {
  it("leaves the job unmarked when the handler declares nothing", () => {
    const job = blankJob();
    ctxFor(job);
    expect(job.costAmountMicro).toBeUndefined();
    expect(job.costCurrency).toBeUndefined();
    expect(job.costRevision).toBeUndefined();
  });

  it("records a sub-cent cost exactly, which is the whole reason for micro units", () => {
    const job = blankJob();
    ctxFor(job).cost({ amount: 0.0003, currency: "usd" });
    expect(job.costAmountMicro).toBe(300);
    expect(job.costCurrency).toBe("usd");
    expect(job.costRevision).toBe(1);
  });

  it("distinguishes a declared zero from no declaration at all", () => {
    const job = blankJob();
    ctxFor(job).cost({ amount: 0, currency: "usd" });
    // Both halves present: "this job genuinely cost me nothing" is a claim, and
    // the report carries it. Absent would have meant "unknown".
    expect(job.costAmountMicro).toBe(0);
    expect(job.costCurrency).toBe("usd");
    expect(job.costRevision).toBe(1);
  });

  it("adds up every declaration, so a handler can declare per vendor call", () => {
    const job = blankJob();
    const ctx = ctxFor(job);
    ctx.cost({ amount: 0.0004, currency: "usd" });
    ctx.cost({ amount: 0.0011, currency: "usd" });
    ctx.cost({ amount: 0.25, currency: "usd" });
    expect(job.costAmountMicro).toBe(251_500);
    expect(job.costRevision).toBe(3);
  });

  it("sums declarations finer than a millionth instead of flooring each to zero", () => {
    const job = blankJob();
    const ctx = ctxFor(job);
    // Rounding each 0.3-micro-unit declaration gives 0; rounding the
    // three-call total of 0.9 micro-units gives 1.
    for (let i = 0; i < 3; i++) ctx.cost({ amount: 0.0000003, currency: "usd" });
    expect(job.costAmountMicro).toBe(1);
    expect(job.costRevision).toBe(3);
  });

  it("rounds only the total, so a lone sub-millionth cost reports the rounded total", () => {
    const job = blankJob();
    ctxFor(job).cost({ amount: 0.0000003, currency: "usd" });
    // Honest: the job's whole cost really is under half a millionth, so zero is
    // what it rounds to. The currency is still pinned, so this reads as a
    // declared ~0 rather than as "unreported" — unlike the old per-call
    // rounding, nothing that should have accumulated has been thrown away.
    expect(job.costAmountMicro).toBe(0);
    expect(job.costCurrency).toBe("usd");
  });

  it("refuses a total beyond exact integer range without disturbing the running total", () => {
    const job = blankJob();
    const ctx = ctxFor(job);
    ctx.cost({ amount: 0.25, currency: "usd" });
    expect(() => ctx.cost({ amount: 1e10, currency: "usd" })).toThrow(RangeError);
    // The rejected declaration is not half-applied: validation runs against the
    // prospective total and the counter only moves once it passes.
    expect(job.costAmountMicro).toBe(250_000);
    expect(job.costRevision).toBe(1);
    ctx.cost({ amount: 0.25, currency: "usd" });
    expect(job.costAmountMicro).toBe(500_000);
    expect(job.costRevision).toBe(2);
  });

  it("reports nothing at all when a job names two currencies", () => {
    const job = blankJob();
    const ctx = ctxFor(job);
    ctx.cost({ amount: 0.5, currency: "usd" });
    ctx.cost({ amount: 0.4, currency: "eur" });
    // One number in two currencies is not a cost. Degrading to "unreported" is
    // honest and is a state the platform already shows; guessing is not.
    expect(job.costAmountMicro).toBeUndefined();
    expect(job.costCurrency).toBeUndefined();
    expect(job.costRevision).toBe(2);
  });

  it("stays unreported after the switch, including for a later good declaration", () => {
    const job = blankJob();
    const ctx = ctxFor(job);
    ctx.cost({ amount: 0.5, currency: "usd" });
    ctx.cost({ amount: 0.4, currency: "eur" });
    ctx.cost({ amount: 0.1, currency: "usd" });
    expect(job.costAmountMicro).toBeUndefined();
    expect(job.costRevision).toBe(3);
  });

  it("refuses a currency that is not ISO 4217 lowercase", () => {
    const ctx = ctxFor(blankJob());
    expect(() => ctx.cost({ amount: 1, currency: "USD" })).toThrow(InvalidCurrencyError);
  });

  it("refuses an amount that is not a finite, non-negative number", () => {
    const ctx = ctxFor(blankJob());
    expect(() => ctx.cost({ amount: -0.01, currency: "usd" })).toThrow(RangeError);
    expect(() => ctx.cost({ amount: Number.NaN, currency: "usd" })).toThrow(RangeError);
    expect(() => ctx.cost({ amount: Number.POSITIVE_INFINITY, currency: "usd" })).toThrow(
      RangeError
    );
  });

  it("is a no-op once the job is terminal, like every other context write", () => {
    const job = blankJob();
    const ctx = ctxFor(job);
    job.status = "cancelled";
    ctx.cost({ amount: 1, currency: "usd" });
    expect(job.costAmountMicro).toBeUndefined();
  });

  it("reports the cost once when a reactivation re-walks the same declarations", () => {
    const first = blankJob();
    const ctxA = ctxFor(first);
    ctxA.cost({ amount: 0.0004, currency: "usd" });
    ctxA.cost({ amount: 0.0006, currency: "usd" });
    expect(first.costAmountMicro).toBe(1_000);
    expect(first.costRevision).toBe(2);

    // The crash: the row is persisted, the process dies, the job is
    // reactivated and the handler runs again from the top.
    const restored = fromJobRecord(toJobRecord(first));
    expect(restored.costAmountMicro).toBe(1_000);

    const ctxB = ctxFor(restored);
    ctxB.cost({ amount: 0.0004, currency: "usd" });
    ctxB.cost({ amount: 0.0006, currency: "usd" });
    // Assigned from a per-context total, not summed onto the rehydrated one.
    expect(restored.costAmountMicro).toBe(1_000);
    expect(restored.costRevision).toBe(2);
  });

  it("replays a step body's cost exactly once when the body is served from cache", async () => {
    const first = blankJob();
    const ctxA = ctxFor(first);
    let stepCalls = 0;
    await ctxA.step("vendor", async () => {
      stepCalls++;
      ctxA.cost({ amount: 0.0004, currency: "usd" });
      return "transcript";
    });
    ctxA.cost({ amount: 0.0006, currency: "usd" });
    expect(first.costAmountMicro).toBe(1_000);
    expect(first.costRevision).toBe(2);
    expect(first.stepCache.getRecord("vendor").costs).toEqual([
      { amount: 0.0004, currency: "usd" },
    ]);

    const restored = fromJobRecord(toJobRecord(first));
    const ctxB = ctxFor(restored);
    await ctxB.step("vendor", async () => {
      stepCalls++;
      return "not reached";
    });
    ctxB.cost({ amount: 0.0006, currency: "usd" });

    expect(stepCalls).toBe(1);
    expect(restored.costAmountMicro).toBe(1_000);
    expect(restored.costRevision).toBe(2);
  });

  it("keeps fanned-out step cost records isolated from their siblings", async () => {
    // The shape builders actually write for a batch of vendor calls. Each
    // branch declares its own cost while sibling step bodies are still in
    // flight, and each cache record must carry only its own declaration.
    const job = blankJob();
    const ctx = ctxFor(job);
    await Promise.all(
      [1, 2, 3].map((n) =>
        ctx.step(`vendor-${n}`, async () => {
          await new Promise((r) => setTimeout(r, n));
          ctx.cost({ amount: n * 0.0001, currency: "usd" });
          return n;
        })
      )
    );
    expect(job.costAmountMicro).toBe(600);
    expect(job.costRevision).toBe(3);
    for (const n of [1, 2, 3]) {
      expect(job.stepCache.getRecord(`vendor-${n}`).costs).toEqual([
        { amount: n * 0.0001, currency: "usd" },
      ]);
    }
  });

  it("folds an inner cache hit into an outer miss for a later outer replay", async () => {
    const first = blankJob();
    const ctxA = ctxFor(first);
    await ctxA.step("inner", async () => {
      ctxA.cost({ amount: 0.0004, currency: "usd" });
      return "inner";
    });

    const second = fromJobRecord(toJobRecord(first));
    const ctxB = ctxFor(second);
    let outerCalls = 0;
    await ctxB.step("outer", async () => {
      outerCalls++;
      await ctxB.step("inner", () => Promise.reject(new Error("inner cache miss")));
      ctxB.cost({ amount: 0.0006, currency: "usd" });
      return "outer";
    });
    expect(second.costAmountMicro).toBe(1_000);
    expect(second.costRevision).toBe(2);
    expect(second.stepCache.getRecord("outer").costs).toEqual([
      { amount: 0.0004, currency: "usd" },
      { amount: 0.0006, currency: "usd" },
    ]);

    const third = fromJobRecord(toJobRecord(second));
    const ctxC = ctxFor(third);
    await ctxC.step("outer", () => Promise.reject(new Error("outer cache miss")));
    ctxC.cost({ amount: 0.001, currency: "usd" });
    expect(outerCalls).toBe(1);
    expect(third.costAmountMicro).toBe(2_000);
    expect(third.costRevision).toBe(3);
  });

  it("replays a step body's currency switch as poisoned", async () => {
    const first = blankJob();
    const ctxA = ctxFor(first);
    let stepCalls = 0;
    await ctxA.step("vendor", async () => {
      stepCalls++;
      ctxA.cost({ amount: 0.5, currency: "usd" });
      ctxA.cost({ amount: 0.4, currency: "eur" });
      return "done";
    });
    expect(first.costAmountMicro).toBeUndefined();
    expect(first.costCurrency).toBeUndefined();
    expect(first.costRevision).toBe(2);

    const restored = fromJobRecord(toJobRecord(first));
    const ctxB = ctxFor(restored);
    await ctxB.step("vendor", async () => {
      stepCalls++;
      return "not reached";
    });
    ctxB.cost({ amount: 0.1, currency: "usd" });

    expect(stepCalls).toBe(1);
    expect(restored.costAmountMicro).toBeUndefined();
    expect(restored.costCurrency).toBeUndefined();
    expect(restored.costRevision).toBe(3);
  });
});
