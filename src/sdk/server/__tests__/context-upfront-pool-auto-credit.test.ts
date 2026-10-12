import { describe, expect, it, vi } from "vitest";

import type { FxFetcher } from "../../pricing/index";
import { StepCache } from "../../step-cache";
import { MemoryKVStore } from "../../store";
import type { BuildContextOpts } from "../context";
import { buildContext } from "../context";
import type { ServerJob } from "../job";
import type { JobCounters } from "../job-store";

function blankJob(paidMsats = 0): ServerJob {
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
    paidMsats,
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

/** Fixed-rate fx, so a fiat-form ask's msat value is exact and stated. */
function fxAt(usdPerBtc: number, eurPerBtc = 80_000): FxFetcher {
  return {
    fetch: () =>
      Promise.resolve({
        rates: { usd: usdPerBtc, eur: eurPerBtc },
        as_of: "2026-07-30T00:00:00Z",
      }),
    supportedCurrencies: () => ["usd", "eur"],
  };
}

/** `{ amount, currency }` in the fiat form `ctx.requestPayment` accepts. */
function usd(amount: number): { amount: number; currency: "usd" } {
  return { amount, currency: "usd" };
}

/**
 * The streamable-store half of `BuildContextOpts`: a NOTIFY
 * subscription plus the counter re-read the woken resolver gates on. `fire()`
 * is one `pg_notify` landing on this machine.
 */
function notifyHarness(counters: JobCounters): {
  opts: Pick<BuildContextOpts, "subscribeNotifications" | "getCounters" | "claimForProcessing">;
  claim: ReturnType<typeof vi.fn>;
  set: (next: Partial<JobCounters>) => void;
  fire: () => Promise<void>;
} {
  let current = counters;
  const listeners: (() => void)[] = [];
  const claim = vi.fn(() => Promise.resolve(true));
  return {
    opts: {
      subscribeNotifications: (cb) => {
        listeners.push(cb);
        return Promise.resolve(() => {
          listeners.splice(listeners.indexOf(cb), 1);
        });
      },
      getCounters: () => Promise.resolve(current),
      claimForProcessing: claim,
    },
    claim,
    set: (next) => {
      current = { ...current, ...next };
    },
    fire: async () => {
      for (const cb of [...listeners]) cb();
      await tick();
    },
  };
}

/** Let the resolver's microtask chain (fetch → subscribe → check) drain. */
async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Track whether a suspended `requestPayment` has resumed. `Promise.race` can't
 * answer this — the sentinel always wins the first microtask — so watch the
 * settlement directly.
 */
function watch<T>(p: Promise<T>): { settled: () => boolean; value: () => T | undefined } {
  let value: T | undefined;
  let done = false;
  void p.then(
    (v) => {
      value = v;
      done = true;
    },
    () => {
      done = true;
    }
  );
  return { settled: () => done, value: () => value };
}

describe("buildContext.requestPayment — upfront-pool auto-credit", () => {

  it("consumes the upfront pool before yielding for another payment", async () => {
    const job = blankJob(19_000); // upfront credited via verifyUpfrontPayment
    const ctx = buildContext(job, { store: new MemoryKVStore(), env: {} });

    const result = await ctx.requestPayment(7_000, "base");

    expect(result.amount_msats).toBe(7_000);
    // Status stays processing — no yield, no payment-request emitted.
    expect(job.status).toBe("processing");
    expect(job.messages.length).toBe(0);
    // paidMsats untouched — the auto-credit is bookkeeping, not a new receipt.
    expect(job.paidMsats).toBe(19_000);
    expect(job.pendingPaymentMsats).toBeUndefined();
    expect((await ctx.requestPayment(5_000, "size surcharge")).amount_msats).toBe(5_000);
    expect((await ctx.requestPayment(7_000, "extract")).amount_msats).toBe(7_000);
    expect(job.status).toBe("processing");
    expect(job.messages).toHaveLength(0);
    expect(job.paidMsats).toBe(19_000);

    void ctx.requestPayment(5_000, "another stage");
    await tick();
    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentMsats).toBe(5_000);
    expect(job.messages).toHaveLength(1);
    expect(job.messages[0].type).toBe("payment-request");
  });

  it("yields on first call when pool is empty", async () => {
    const job = blankJob(0);
    const ctx = buildContext(job, { store: new MemoryKVStore(), env: {} });

    void ctx.requestPayment(7_000, "base");
    await new Promise((r) => setTimeout(r, 0));

    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentMsats).toBe(7_000);
    expect(job.messages[0].type).toBe("payment-request");
  });

  it("resumes pool accounting after a yielded call is paid via dispatch", async () => {
    const job = blankJob(0);
    const ctx = buildContext(job, { store: new MemoryKVStore(), env: {} });

    // First call yields.
    const p1 = ctx.requestPayment(7_000, "base");
    await new Promise((r) => setTimeout(r, 0));
    expect(job.status).toBe("awaiting-input");

    // Simulate dispatchMessage paying the request: credit paidMsats, flip status
    // back to processing, resolve resolver. Mirrors job-manager dispatchMessage.
    job.paidMsats += 12_000; // agent overpaid (covers base + future surcharge)
    const resolver = job.pendingPayment;
    expect(resolver).not.toBeNull();
    job.status = "processing";
    job.pendingPayment = null;
    resolver?.resolve({ amount_msats: 7_000 });
    await p1;

    // Second call should auto-credit from the leftover pool (5_000 still available).
    const r2 = await ctx.requestPayment(5_000, "size surcharge");
    expect(r2.amount_msats).toBe(5_000);
    expect(job.status).toBe("processing");
  });

  it("rebuilt ctx (e.g. on reactivation) re-derives consumption deterministically", async () => {
    const job = blankJob(19_000);
    const ctx1 = buildContext(job, { store: new MemoryKVStore(), env: {} });
    await ctx1.requestPayment(7_000, "base");
    await ctx1.requestPayment(5_000, "surcharge");

    // Reactivation replaces the ctx; the new ctx must re-walk the same call
    // sequence and reach the same conclusion (no double-counting).
    const ctx2 = buildContext(job, { store: new MemoryKVStore(), env: {} });
    await ctx2.requestPayment(7_000, "base"); // pool: 19_000 - 7_000 = 12_000
    await ctx2.requestPayment(5_000, "surcharge"); // pool: 7_000
    const r = await ctx2.requestPayment(7_000, "extract"); // pool: 0

    expect(r.amount_msats).toBe(7_000);
    expect(job.status).toBe("processing");
    expect(job.messages.length).toBe(0);
  });
});

/**
 * under an explicit fund-and-draw the job's `paidMsats` is
 * `withDrawBasis`'s pro-rata slice of the credit's rail value — msats derived
 * from a *fiat* draw at the credit's pinned ratio — while the ask converts at
 * the rate live right now. The scenario below is one credit funded at $2.00 for
 * 4000 sats (BTC $50k, so 2 msats per usd-micro); a $1.00 job draws half of it,
 * which is 1_000_000 micro and 2_000_000 msats. Every case then moves the rate
 * and asks $0.60 + $0.40 + $0.50 against that draw.
 */
const DRAW_MICRO = 1_000_000;
const DRAW_MSATS = 2_000_000;

/** A mutable `drawPool` stub — the draw grows when a mid-job top-up lands. */
function poolStub(
  amountMicro: number,
  currency = "usd"
): { fn: NonNullable<BuildContextOpts["drawPool"]>; set: (micro: number) => void } {
  const state = { amountMicro, currency };
  return {
    fn: () => Promise.resolve({ basis: "draw" as const, ...state }),
    set: (micro) => {
      state.amountMicro = micro;
    },
  };
}

describe("buildContext.requestPayment — explicit draw pool is fiat", () => {
  it("auto-credits an ask the drifted msat pool refuses", async () => {
    // BTC halved to $25k since the deposit, so $0.60 is 2_400_000 msats —
    // more than the whole 2_000_000-msat slice, though the caller drew $1.00.
    const job = blankJob(DRAW_MSATS);
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(25_000),
      drawPool: poolStub(DRAW_MICRO).fn,
    });

    const result = await ctx.requestPayment(usd(0.6), "base");

    expect(result.amount_msats).toBe(2_400_000);
    expect(job.status).toBe("processing");
    expect(job.messages.length).toBe(0);
    expect(job.pendingPaymentMsats).toBeUndefined();
  });

  it("spends the fiat pool down exactly, then yields", async () => {
    const job = blankJob(DRAW_MSATS);
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(25_000),
      drawPool: poolStub(DRAW_MICRO).fn,
    });

    await ctx.requestPayment(usd(0.6), "base"); // $0.40 left
    await ctx.requestPayment(usd(0.4), "surcharge"); // $0.00 left
    void ctx.requestPayment(usd(0.5), "overage");
    await tick();

    expect(job.messages.length).toBe(1);
    expect(job.messages[0].type).toBe("payment-request");
    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentFiatMicro).toBe(500_000);
    expect(job.pendingPaymentFiatCurrency).toBe("usd");
  });

  it("does not resume the suspended handler on leftover msat headroom", async () => {
    // The resume gate is a second reading of the same predicate. Left in msats
    // it fires on the 1_000_000 msats the fiat gate never spent — before any
    // payment lands — and the handler does the overage for free.
    const job = blankJob(DRAW_MSATS);
    const notify = notifyHarness({ status: "awaiting-input", paidMsats: DRAW_MSATS });
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: poolStub(DRAW_MICRO).fn,
      ...notify.opts,
    });

    await ctx.requestPayment(usd(0.6), "base");
    await ctx.requestPayment(usd(0.4), "surcharge");
    const overage = watch(ctx.requestPayment(usd(0.5), "overage"));
    await tick();
    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentMsats).toBe(500_000);
    expect(job.messages[0].type).toBe("payment-request");
    await notify.fire();

    expect(overage.settled()).toBe(false);
    expect(notify.claim).not.toHaveBeenCalled();
    expect(job.status).toBe("awaiting-input");
  });

  it("resumes once the top-up lands, on a pool the msat counter has overshot", async () => {
    // The mirror failure: BTC fell, so the fiat gate auto-credited past the msat
    // slice and `creditedToHandlerMsats` (4_000_000) now exceeds `paidMsats`
    // (2_000_000). An msat resume gate can never fire again — a fully-paid job
    // would hang to the idle timeout.
    const job = blankJob(DRAW_MSATS);
    const pool = poolStub(DRAW_MICRO);
    const notify = notifyHarness({ status: "awaiting-input", paidMsats: DRAW_MSATS });
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(25_000),
      drawPool: pool.fn,
      ...notify.opts,
    });

    await ctx.requestPayment(usd(0.6), "base");
    await ctx.requestPayment(usd(0.4), "surcharge");
    const overage = watch(ctx.requestPayment(usd(0.5), "overage"));
    await tick();
    expect(overage.settled()).toBe(false);

    // The caller pays 2000 sats: `fund` + `growDraw` on the job's credit, then
    // Tx C credits the earmarked rail value and notifies this machine.
    pool.set(DRAW_MICRO + 500_000);
    notify.set({ paidMsats: DRAW_MSATS + 2_000_000, pendingPaymentMsats: undefined });
    await notify.fire();

    expect(overage.settled()).toBe(true);
    expect(overage.value()?.amount_msats).toBe(2_000_000);
    expect(notify.claim).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("processing");
  });

  it("resumes when the payment credited the job but skipped the ledger leg", async () => {
    // A cross-rail top-up, an fx outage, a draw already resolved: the mid-job
    // preflight refuses by skipping, so `paidMsats` grows and the draw does not.
    // No pool-based resume gate could see that; the rail-msat delta can.
    const job = blankJob(DRAW_MSATS);
    const notify = notifyHarness({ status: "awaiting-input", paidMsats: DRAW_MSATS });
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: poolStub(DRAW_MICRO).fn,
      ...notify.opts,
    });

    await ctx.requestPayment(usd(0.6), "base");
    await ctx.requestPayment(usd(0.4), "surcharge");
    const overage = watch(ctx.requestPayment(usd(0.5), "overage"));
    await tick();

    notify.set({ paidMsats: DRAW_MSATS + 500_000, pendingPaymentMsats: undefined });
    await notify.fire();

    expect(overage.settled()).toBe(true);
    expect(overage.value()?.amount_msats).toBe(500_000);
  });

  it("replays the whole ask sequence against the grown draw", async () => {
    // Reactivation rebuilds the context, so both counters reset and the handler
    // re-walks the same asks. The draw it re-walks against has grown by exactly
    // what the paid ask consumed, so the two cancel and every ask lands where it
    // did the first time — including the one that originally yielded.
    const job = blankJob(DRAW_MSATS + 2_000_000);
    job.messages = [
      {
        seq: 1,
        type: "payment",
        from: "requester",
        content: { amount_msats: 2_000_000 },
        timestamp: 0,
      },
    ] as ServerJob["messages"];
    job.seq = 1;
    job.replayHighSeq = 1;
    job.reactivationPaymentApplied = true;
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(25_000),
      drawPool: poolStub(DRAW_MICRO + 500_000).fn,
    });

    await ctx.requestPayment(usd(0.6), "base");
    await ctx.requestPayment(usd(0.4), "surcharge");
    const overage = await ctx.requestPayment(usd(0.5), "overage");

    expect(overage.amount_msats).toBe(2_000_000);
    expect(job.status).toBe("processing");
    // No new payment-request: the auto-credit branch never emits one, which is
    // what the `replayProviderSkip` seed counts on.
    expect(job.messages.length).toBe(1);
    expect(job.replayPaymentIndex).toBe(1);
  });

  it("replays a credited draw without comparing its rail slice to the live ask", async () => {
    const job = blankJob(500_000);
    job.messages = [
      {
        seq: 1,
        type: "payment",
        from: "requester",
        content: { amount_msats: 1_000_000 },
        timestamp: 0,
      },
    ] as ServerJob["messages"];
    job.seq = 1;
    job.replayHighSeq = 1;
    job.reactivationPaymentApplied = true;

    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: () => Promise.resolve({ basis: "draw", amountMicro: 500_000, currency: "usd" }),
    });

    await expect(ctx.requestPayment(1_000_000, "base")).resolves.toEqual({
      amount_msats: 1_000_000,
    });
    expect(job.status).toBe("processing");
    expect(job.replayPaymentIndex).toBe(1);
  });

  it("still rejects a replay when Tx C left the job awaiting input", async () => {
    const job = blankJob(500_000);
    job.status = "awaiting-input";
    job.messages = [
      {
        seq: 1,
        type: "payment",
        from: "requester",
        content: { amount_msats: 1_000_000 },
        timestamp: 0,
      },
    ] as ServerJob["messages"];
    job.seq = 1;
    job.replayHighSeq = 1;

    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: () => Promise.resolve({ basis: "draw", amountMicro: 500_000, currency: "usd" }),
    });

    await expect(ctx.requestPayment(1_000_000, "base")).rejects.toThrow(
      "[internal_error] payment replay reached without credit"
    );
  });

  it("does not let a cached prompt mask an unapplied replay payment", async () => {
    const job = blankJob(500_000);
    job.status = "awaiting-input";
    job.messages = [
      {
        seq: 1,
        type: "response",
        from: "requester",
        content: { prompt_id: "confirm", text: "yes" },
        timestamp: 0,
      },
      {
        seq: 2,
        type: "payment",
        from: "requester",
        content: { amount_msats: 1_000_000 },
        timestamp: 0,
      },
    ] as ServerJob["messages"];
    job.seq = 2;
    job.replayHighSeq = 2;

    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: () => Promise.resolve({ basis: "draw", amountMicro: 500_000, currency: "usd" }),
    });

    await expect(ctx.prompt("confirm", "Confirm")).resolves.toEqual({
      prompt_id: "confirm",
      text: "yes",
    });
    expect(job.status).toBe("processing");
    await expect(ctx.requestPayment(1_000_000, "base")).rejects.toThrow(
      "[internal_error] payment replay reached without credit"
    );
  });

  it("leaves implicit N=1 on the msat comparison", async () => {
    // Fund and draw are the same money in the same request, so `paidMsats` is
    // the rail's own traffic and no pool resolves. Identical numbers to the
    // first case — and here the ask must still yield.
    const job = blankJob(DRAW_MSATS);
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(25_000),
      drawPool: () => Promise.resolve({ basis: "rail" }),
    });

    void ctx.requestPayment(usd(0.6), "base");
    await tick();

    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentMsats).toBe(2_400_000);
    expect(job.messages[0].type).toBe("payment-request");
  });

  it("yields rather than spend an msat pool it knows is draw-derived", async () => {
    // The ledger is unreachable, so the pool can't be priced — but `creditId` /
    // `drawId` on the job say `paidMsats` is a slice of the credit's rail value
    // at a ratio pinned when that credit was funded. At $100k the msat gate
    // would cover this ask three times over and give the work away silently.
    const job = blankJob(DRAW_MSATS);
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: () => Promise.reject(new Error("ledger unreachable")),
    });

    void ctx.requestPayment(usd(0.6), "base");
    await tick();

    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentMsats).toBe(600_000);
    expect(job.messages[0].type).toBe("payment-request");
  });

  it("still pins an `unpriced` job's ask, so the top-up it yields for lands", async () => {
    // Declining to auto-credit is not declining to charge: the payment-request
    // this yields still has to reach the ledger as a `fund` + `growDraw`, which
    // is fiat-denominated. Refusing to price the POOL must not stop
    // us pricing the ASK.
    const job = blankJob(DRAW_MSATS);
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: () => Promise.resolve({ basis: "unpriced" }),
    });

    void ctx.requestPayment(usd(0.6), "base");
    await tick();

    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentFiatMicro).toBe(600_000);
    expect(job.pendingPaymentFiatCurrency).toBe("usd");
  });

  it("yields when the pool reads but the ask can't be denominated", async () => {
    // A bare-msats ask needs an fx hop to reach the pool's fiat unit. Numeric
    // asks remain valid when that conversion is unavailable. With no pinned figure there is nothing to
    // subtract from the pool, so auto-crediting would spend it without
    // depleting it — the next pinnable ask would read the pool undepleted.
    const downFx: FxFetcher = {
      fetch: () => Promise.reject(new Error("fx down")),
      supportedCurrencies: () => ["usd"],
    };
    const job = blankJob(DRAW_MSATS);
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: downFx,
      drawPool: poolStub(DRAW_MICRO).fn,
    });

    void ctx.requestPayment(600_000, "base");
    await tick();

    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentMsats).toBe(600_000);
    expect(job.pendingPaymentFiatMicro).toBeUndefined();
  });

  it("pins the ask in the credit's currency, not the ask's", async () => {
    // `resolveTopUpFiat` only takes the pin verbatim when it already speaks the
    // credit's currency; otherwise it re-converts at accept time and a rate move
    // between the ask and the payment leaks into the ledger.
    const job = blankJob(DRAW_MSATS);
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: poolStub(100_000, "eur").fn,
    });

    void ctx.requestPayment(usd(0.6), "base");
    await tick();

    expect(job.status).toBe("awaiting-input");
    // 600 sats at €80 000/BTC is €0.48 — the pool's unit, not the ask's.
    expect(job.pendingPaymentFiatCurrency).toBe("eur");
    expect(job.pendingPaymentFiatMicro).toBe(480_000);
  });

  it("keeps the ask denomination when the pool read flaps", async () => {
    // The pool answered `draw` for the first ask and stopped answering for the
    // second. Before the denomination was sticky, ask two fell to a different
    // currency — which poisoned the job's ask total to a permanent `-1`, and
    // mixed units into the very counter the gate subtracts from.
    const job = blankJob(DRAW_MSATS);
    let reads = 0;
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: () =>
        Promise.resolve(
          ++reads === 1
            ? { basis: "draw" as const, amountMicro: 0, currency: "eur" }
            : { basis: "unpriced" as const }
        ),
    });

    void ctx.requestPayment(usd(0.6), "base");
    await tick();
    job.pendingPayment = null;
    void ctx.requestPayment(usd(0.6), "surcharge");
    await tick();

    expect(job.pendingPaymentFiatCurrency).toBe("eur");
    expect(job.askedTopUpCurrency).toBe("eur");
    expect(job.askedTopUpMicro).toBe(960_000);
    expect(job.topUpCapUnenforcedReason).toBeUndefined();
  });

  it("yields when the pin and the pool disagree about the unit", async () => {
    // The job's denomination is sticky and no longer derived from this pool, so
    // the two can now disagree — the first ask's pool read flapped, or the
    // operator flipped `DVMConfig.currency` since. €10.00 of pool would cover a
    // $0.60 ask on the numbers alone, which is precisely the mixed-unit gate
    // exists to prevent, so the ask yields instead.
    const job = blankJob(DRAW_MSATS);
    job.askedTopUpMicro = 100_000;
    job.askedTopUpCurrency = "usd";
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fxAt(100_000),
      drawPool: poolStub(10_000_000, "eur").fn,
    });

    void ctx.requestPayment(usd(0.6), "base");
    await tick();

    expect(job.status).toBe("awaiting-input");
    expect(job.messages[0].type).toBe("payment-request");
    // Yielding is not refusing: the ask still pins, in the job's own currency,
    // so the top-up it yields for still reaches the ledger.
    expect(job.pendingPaymentFiatCurrency).toBe("usd");
    expect(job.pendingPaymentFiatMicro).toBe(600_000);
    expect(job.askedTopUpMicro).toBe(700_000);
  });
});
