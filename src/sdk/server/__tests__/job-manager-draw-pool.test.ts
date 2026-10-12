/**
 * `JobManager.resolveDrawPool` carries the credit's denomination on
 * every arm, including the two that carry no spendable fiat pool.
 *
 * The auto-credit gate can't spend that figure — that part is unchanged, and
 * covered in `context-upfront-pool-auto-credit.test.ts`. But `ctx.requestPayment`
 * has to *pin* each ask in the credit's currency for the mid-job draw cap to
 * bound anything, and an implicit N=1 credit — the ordinary per-job payment —
 * takes the `rail` arm. Erasing the currency there is what left the cap
 * unenforceable on essentially every job of a DVM pricing in anything but USD.
 *
 * `resolveDrawPool` is private and has exactly one caller, so these reach it
 * through a typed probe rather than staging a whole job lifecycle.
 */
import { describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import type { DrawPool } from "../context";
import { implicitCreditId } from "../funding";
import type { ServerJob } from "../job";
import { JobManager } from "../job-manager";
import { MemoryCreditLedger } from "../memory-credit-ledger";

const CALLER = "aa".repeat(32);

function jobStub(creditId?: string, drawId?: string): ServerJob {
  return { id: "job-1", creditId, drawId } as ServerJob;
}

function pooler(ledger?: MemoryCreditLedger): (job: ServerJob) => Promise<DrawPool> {
  const descriptor = configureDVM({
    name: "draw-pool-test",
    capability: "test",
    tag: "test",
    idleTimeout: 120,
    onJob: () => undefined,
  });
  const jm = new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    devMode: true,
    fxFetcher: {
      fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date(0).toISOString() }),
      supportedCurrencies: () => ["usd"],
    },
    creditLedger: ledger,
    orphanDrawSweepIntervalMs: 0,
    staleJobTimeoutMs: 0,
    processingWatchdogMs: 0,
    heartbeatIntervalMs: 0,
  });
  const probe = jm as unknown as { resolveDrawPool: (job: ServerJob) => Promise<DrawPool> };
  return (job) => probe.resolveDrawPool(job);
}

/** A credit + draw in `currency`, at the id `creditId` names. */
async function seeded(creditId: string, drawId: string, currency: string) {
  const ledger = new MemoryCreditLedger();
  await ledger.fund({
    creditId,
    callerPubkey: CALLER,
    currency,
    amountMicro: 100_000,
    expiryMs: Date.now() + 3_600_000,
    basis: { rail: "x402", paidMsats: 100_000, nativeAmount: 100_000, nativeAsset: "usdc" },
  });
  await ledger.draw({ creditId, drawId, amountMicro: 100_000, jobId: "job-1" });
  return ledger;
}

describe("JobManager.resolveDrawPool — the credit's denomination", () => {
  it("carries the credit's currency on an implicit N=1 job", async () => {
    const drawId = "pay-1";
    const creditId = implicitCreditId("x402", drawId);
    const pool = await pooler(await seeded(creditId, drawId, "eur"))(jobStub(creditId, drawId));

    expect(pool).toEqual({ basis: "rail", creditCurrency: "eur" });
  });

  it("carries it on a credit funded with no rail basis, which allocates no msats", async () => {
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "eur",
      amountMicro: 100_000,
      expiryMs: Date.now() + 3_600_000,
      basis: { rail: "cashu", paidMsats: 0 },
    });
    await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 100_000, jobId: "job-1" });

    expect(await pooler(ledger)(jobStub("c1", "d1"))).toEqual({
      basis: "rail",
      creditCurrency: "eur",
    });
  });

  it("still answers with the fiat pool on an explicit fund-and-draw", async () => {
    const ledger = await seeded("c1", "d1", "eur");
    expect(await pooler(ledger)(jobStub("c1", "d1"))).toEqual({
      basis: "draw",
      amountMicro: 100_000,
      currency: "eur",
    });
  });

  it("carries no currency for a job bound to no credit — the free-then-paid shape", async () => {
    // The one answer that means "seed the ask denomination from the DVM's own
    // declaration", because the credit this job's first payment opens does not
    // exist yet and will be denominated in exactly that.
    expect(await pooler(new MemoryCreditLedger())(jobStub())).toEqual({ basis: "rail" });
  });
});
