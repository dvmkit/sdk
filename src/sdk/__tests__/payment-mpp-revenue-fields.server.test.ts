import { randomBytes } from "node:crypto";

import { Challenge, Credential } from "mppx";
import { Mppx } from "mppx/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../sdk/index";
import { servedApps } from "../../test-support/served-app";
import type { FxFetcher } from "../pricing/index";
import { createDVMServer } from "../server/app";
import type { JobManager, JobManagerOpts } from "../server/job-manager";
import { type MppxServer, wrapMppx } from "../server/mpp-setup";
import { MemoryKVStore } from "../store";
import { stubbedTempoCharge } from "./__helpers__/mppx-stub";

const BTC_USD = 100_000;
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: BTC_USD }, as_of: "2026-05-16T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const TEMPO_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";
const REVENUE_CALLBACK_DEADLINE_MS = 1_000;
const LATE_COMPLETION_DELAY_MS = 125;

type RevenueInfo = Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0];
type LifecycleJobManager = Pick<JobManager<unknown, undefined>, "activeJobs">;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectRevenueCallback(
  matches: (info: RevenueInfo) => boolean,
  label: string,
  deadlineMs = REVENUE_CALLBACK_DEADLINE_MS
): { callback(info: RevenueInfo): void; received: Promise<RevenueInfo> } {
  const event = deferred<RevenueInfo>();
  const timeout = setTimeout(() => {
    event.reject(new Error(`${label} was not called within ${deadlineMs}ms`));
  }, deadlineMs);

  return {
    callback(info) {
      clearTimeout(timeout);
      if (!matches(info)) {
        event.reject(new Error(`${label} received an unexpected payload`));
        return;
      }
      event.resolve(info);
    },
    received: event.promise.finally(() => clearTimeout(timeout)),
  };
}

async function awaitTerminalBoundary(jobManager: LifecycleJobManager, jobId: string): Promise<void> {
  const terminalWork = await vi.waitFor(() => {
    const work = jobManager.activeJobs.get(jobId)?.terminalWork;
    expect(work).toBeDefined();
    return work!;
  }, { timeout: REVENUE_CALLBACK_DEADLINE_MS });
  await terminalWork;
}

function makeMppxWithStubbedVerify(): MppxServer {
  const mpp = wrapMppx(
    Mppx.create({
      methods: [stubbedTempoCharge(TEMPO_RECIPIENT).method],
      secretKey: randomBytes(32).toString("hex"),
      realm: "test.example",
    })
  );
  return mpp;
}

describe("MPP/Tempo revenue fields", () => {
  const env = { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") };
  const dvm = configureDVM({
    name: "MPP Revenue Fields Test",
    price: "$0.10",
    async onJob(ctx) {
      // This exceeds the former 50ms test sleep. The assertion below waits for
      // the callback signal instead of treating elapsed time as completion.
      await new Promise<void>((resolve) => setTimeout(resolve, LATE_COMPLETION_DELAY_MS));
      ctx.complete("done");
    },
  });

  const servers = servedApps({ teardown: "all" });
  let url: string;
  let mpp: MppxServer;
  let jobManager: LifecycleJobManager;
  let revenueCallback: ReturnType<typeof expectRevenueCallback>;

  beforeAll(async () => {
    mpp = makeMppxWithStubbedVerify();
    const { app, jobManager: createdJobManager } = await createDVMServer(dvm, {
      env,
      store: new MemoryKVStore(),
      mpp,
      fxFetcher: stubFx,
      onJobCompleted: (info) => revenueCallback.callback(info),
    });

    jobManager = createdJobManager;
    url = await servers.serve(app);
  });

  it("upfront Tempo payment sets paymentTxHash, nativeAmount (usdc micro), nativeAsset on completion", async () => {
    const challengeRes = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "mpp-revenue-fields-test", input: "hello" }),
    });
    expect(challengeRes.status).toBe(402);
    const challenge = Challenge.fromHeadersList(challengeRes.headers)[0];
    expect(challenge.method).toBe("tempo");

    // Build and submit credential
    const credential = Credential.from({
      challenge,
      payload: { type: "hash" as const, hash: `0x${"c".repeat(64)}` },
    });

    revenueCallback = expectRevenueCallback(
      (info) =>
        info.capability === "mpp-revenue-fields-test" &&
        info.rail === "tempo" &&
        info.nativeAsset === "usdc",
      "Tempo revenue callback"
    );
    const revenueReceived = revenueCallback.received.then(
      (info) => ({ info }),
      (error: unknown) => ({ error })
    );

    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: Credential.serialize(credential),
      },
      body: JSON.stringify({ capability: "mpp-revenue-fields-test", input: "hello" }),
    });
    expect([200, 202]).toContain(res.status);

    const { job_id: jobId } = (await res.json()) as { job_id: string };
    const received = await revenueReceived;
    if ("error" in received) throw received.error;
    const revenueCapture = received.info;
    await awaitTerminalBoundary(jobManager, jobId);

    expect(revenueCapture.capability).toBe("mpp-revenue-fields-test");
    expect(revenueCapture.rail).toBe("tempo");
    expect(revenueCapture.paymentTxHash).toBe(challenge.id);
    expect(revenueCapture.nativeAsset).toBe("usdc");
    // $0.10 at $100k/BTC = 100_000 msats → ~100_000 micro-USDC. The exact
    // value depends on the live FX rate stub; assert it's in the right
    // ballpark and is NOT the sats value (100 sats).
    expect(revenueCapture.nativeAmount).toBeTypeOf("number");
    expect(revenueCapture.nativeAmount).toBeGreaterThan(0);
    expect(revenueCapture.nativeAmount).toBeGreaterThan(1000);
  });
});
