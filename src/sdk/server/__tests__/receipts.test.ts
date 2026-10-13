import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { generateIdentity, signAttestation } from "../../../lib/builder-identity";
import { attestationEnv, signDeployAttestation } from "../../../test-support/deploy-attestation";
import { computeResultHash, verifyReceipt } from "../../../lib/receipt";
import { deriveReceiptKeypair } from "../../../lib/receipt-key";
import type { ReceiptTrustAnchor } from "../../../lib/receipt-verify";
import { verifyJobReceipt } from "../../../lib/receipt-verify";
import type { V1InfoResponse } from "../../../lib/transport/types";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import { createDVMServer } from "../app";
import type { JobRecord, JobStatus, JobStore } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";
import { ReceiptIssuer } from "../receipt-issuer";

const BUILDER_SECRET = "33".repeat(32);
const DVM_ID = "dvm-receipt-test";
const RECEIPT = deriveReceiptKeypair(BUILDER_SECRET, DVM_ID);
const ISSUER = new ReceiptIssuer({ secret: RECEIPT.secret, dvm: "receipt-test", dvmId: DVM_ID });

/**
 * A `JobStore` with no receipt extension — what a builder gets by passing a
 * custom `jobStore` to `createDVMHost`. Delegation keeps the job lifecycle
 * working; the point is that `claimReceiptSeq` / `saveReceipt` are absent.
 */
class PlainJobStore implements JobStore {
  private readonly inner = new MemoryJobStore();

  get(id: string): Promise<JobRecord | undefined> {
    return this.inner.get(id);
  }
  findJobByPaymentTxHash(txHash: string): Promise<JobRecord | undefined> {
    return this.inner.findJobByPaymentTxHash(txHash);
  }
  save(record: JobRecord): Promise<void> {
    return this.inner.save(record);
  }
  delete(id: string): Promise<void> {
    return this.inner.delete(id);
  }
}

/**
 * The job token a seeded row is owned by. Live rows always carry one,
 * and refuses a credential-less read before the lookup, so a seeded
 * row's reader has to present it like any other caller.
 */
const SEED_JOB_TOKEN = "seed-job-token";
const SEED_JOB_TOKEN_HASH = createHash("sha256").update(SEED_JOB_TOKEN).digest("hex");

/** A minimal persisted job, owned by the devMode requester the routes see. */
function seedRecord(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  const now = Date.now();
  return {
    id,
    tags: [],
    capability: "count",
    input: "",
    params: {},
    requesterId: "dev-anonymous",
    requesterTokenHash: SEED_JOB_TOKEN_HASH,
    status: "completed" as JobStatus,
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    stepCache: [],
    state: {},
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-21T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

type Handler = (ctx: SDKJobContext<unknown, { text: string }>) => Promise<void> | void;

async function buildServer(
  onJob: Handler,
  opts: { receiptKey?: string; jobStore?: JobStore } = {}
) {
  const descriptor = configureDVM({
    name: "receipt-test",
    capability: "count",
    tag: "test",
    idleTimeout: 120,
    input: z.object({ text: z.string() }),
    onJob,
  });
  const jobStore = opts.jobStore ?? new MemoryJobStore();
  const { app } = await createDVMServer(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore,
    devMode: true,
    fxFetcher: stubFx,
    dvmId: DVM_ID,
    receiptKey: "receiptKey" in opts ? opts.receiptKey : RECEIPT.secret,
  });
  return { app, jobStore };
}

interface JobBody {
  job_id: string;
  job_token?: string;
  status?: string;
  receipt?: Record<string, unknown>;
}

async function submit(app: { request: typeof fetch }, text = "one two three"): Promise<JobBody> {
  const res = await app.request("/v1/job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "count", data: { text } }),
  } as RequestInit);
  return (await res.json()) as JobBody;
}

async function poll(
  app: { request: typeof fetch },
  jobId: string,
  token: string | undefined
): Promise<JobBody> {
  const res = await app.request(`/v1/job/${jobId}`, {
    headers: token ? { "X-Job-Token": token } : {},
  } as RequestInit);
  return (await res.json()) as JobBody;
}

const completes: Handler = (ctx) => {
  ctx.complete("counted 3 words");
};

describe("signed receipts", () => {
  it("puts a verifying receipt on the synchronous 200", async () => {
    const { app } = await buildServer(completes);
    const body = await submit(app as never);
    expect(body.status).toBe("completed");
    expect(body.receipt).toBeDefined();
    const receipt = body.receipt as never;
    expect(verifyReceipt(receipt)).toBe(true);
    expect(body.receipt).toMatchObject({
      v: 1,
      job_id: body.job_id,
      dvm: "receipt-test",
      capability: "count",
      outcome: "completed",
      reason: null,
      dvm_id: DVM_ID,
      receipt_pubkey: RECEIPT.pubkey,
      result_hash: "c7bbe5f76e8f5937aa6a4a6345131b0fcf03712a2f7ccae40586d17ef0076f45",
      paid: {
        msats: 0, rail: null, native_amount: null, native_asset: null, tx_hash: null, mint: null,
      },
    });
    const firstPoll = await poll(app as never, body.job_id, body.job_token);
    const secondPoll = await poll(app as never, body.job_id, body.job_token);
    expect(JSON.stringify(firstPoll.receipt)).toBe(JSON.stringify(body.receipt));
    expect(JSON.stringify(secondPoll.receipt)).toBe(JSON.stringify(body.receipt));
    const secondJob = await submit(app as never);
    expect((secondJob.receipt as { seq: number }).seq).toBeGreaterThan(
      (body.receipt as { seq: number }).seq
    );
    const info = await (app as never as { request: typeof fetch }).request("/v1/info");
    expect(((await info.json()) as V1InfoResponse).receipts).toBe(true);
  });

  it("attests a failed job, carrying its reason", async () => {
    const { app } = await buildServer((ctx) => {
      ctx.fail("provider_unavailable");
    });
    const submitted = await submit(app as never);
    const body = await poll(app as never, submitted.job_id, submitted.job_token);
    expect(body.status).toBe("failed");
    expect(verifyReceipt(body.receipt as never)).toBe(true);
    expect(body.receipt).toMatchObject({ outcome: "failed", reason: "provider_unavailable" });
  });

  it("attests a job the handler threw out of", async () => {
    const { app } = await buildServer(() => {
      throw new Error("kaboom");
    });
    const submitted = await submit(app as never);
    const body = await poll(app as never, submitted.job_id, submitted.job_token);
    expect(body.status).toBe("failed");
    expect(body.receipt).toMatchObject({ outcome: "failed", reason: "kaboom" });
  });

  it("attests a cancelled job", async () => {
    // Park the handler so the job is still live when the DELETE lands.
    let release: (() => void) | undefined;
    const { app } = await buildServer(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const submitted = await submit(app as never);
    await (app as never as { request: typeof fetch }).request(`/v1/job/${submitted.job_id}`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...(submitted.job_token ? { "X-Job-Token": submitted.job_token } : {}),
      },
      body: JSON.stringify({ reason: "changed my mind" }),
    } as RequestInit);
    release?.();
    const body = await poll(app as never, submitted.job_id, submitted.job_token);
    expect(body.status).toBe("cancelled");
    expect(verifyReceipt(body.receipt as never)).toBe(true);
    expect(body.receipt).toMatchObject({ outcome: "cancelled", reason: "changed my mind" });
  });

  it("binds the result — the hash changes with the delivered payload", async () => {
    const { app: appA } = await buildServer((ctx) => {
      ctx.complete("alpha");
    });
    const { app: appB } = await buildServer((ctx) => {
      ctx.complete("beta");
    });
    const a = (await submit(appA as never)).receipt as { result_hash: string };
    const b = (await submit(appB as never)).receipt as { result_hash: string };
    expect(a.result_hash).toBe("c80aa24d2a2e18237f84d8bfe9999030e7de17e5899eff9fdc6d8576a5599333");
    expect(b.result_hash).toBe("ae9003a19073e6acf4c27020cadfd26abe827d1ffe13b0ba2c9a5ef549325f95");
  });

  it("without a receipt key: no receipt, no flag, jobs unaffected", async () => {
    const { app } = await buildServer(completes, { receiptKey: undefined });
    const body = await submit(app as never);
    expect(body.status).toBe("completed");
    expect(body.receipt).toBeUndefined();

    const res = await (app as never as { request: typeof fetch }).request("/v1/info");
    const info = (await res.json()) as V1InfoResponse;
    expect(info.receipts).toBeUndefined();
  });

  it("keeps the receipt through a later snapshot save", async () => {
    // The snapshot path must not own the receipt column: a save carrying a
    // pre-receipt view of the job would otherwise wipe the evidence.
    const jobStore = new MemoryJobStore();
    const { app } = await buildServer(completes, { jobStore });
    const submitted = await submit(app as never);
    const record = await jobStore.get(submitted.job_id);
    expect(record?.receipt).toBeDefined();
    await jobStore.save({ ...record, receipt: undefined } as JobRecord);
    expect((await jobStore.get(submitted.job_id))?.receipt).toEqual(record?.receipt);
  });

  it("withholds the /v1/info flag when the store can't issue receipts", async () => {
    // `jobStore` is a public host option, so a builder can wire a store that
    // satisfies `JobStore` but not `ReceiptIssuingStore`. Advertising receipts
    // there would promise something no job ever delivers.
    const { app } = await buildServer(completes, { jobStore: new PlainJobStore() });
    const body = await submit(app as never);
    expect(body.status).toBe("completed");
    expect(body.receipt).toBeUndefined();

    const res = await (app as never as { request: typeof fetch }).request("/v1/info");
    const info = (await res.json()) as V1InfoResponse;
    expect(info.receipts).toBeUndefined();
  });
});

describe("result_hash covers what was delivered, not why it ended", () => {
  // Every durable terminal writes `summary = COALESCE(summary, reason)` in the
  // same transaction as the status, so on a reaped or cross-machine-cancelled
  // row the job's summary *is* the terminal reason. Hashing it as delivered
  // output would invert the empty-handed/partial-output signal and break
  // recomputation for any verifier following the documented recipe.
  const artifact = { name: "out.json", mime_type: "application/json", data: '{"n":6}' };

  it("is null on a reaped job whose summary is the terminal reason", () => {
    const receipt = ISSUER.issue(
      seedRecord("job-reaped", { status: "failed", summary: "worker_died_mid_job" }),
      1
    );
    expect(receipt.result_hash).toBeNull();
    expect(receipt.reason).toBe("worker_died_mid_job");
    expect(verifyReceipt(receipt)).toBe(true);
  });

  it("still binds artifacts a failed job did deliver", () => {
    const receipt = ISSUER.issue(
      seedRecord("job-partial", {
        status: "failed",
        summary: "worker_died_mid_job",
        messages: [{ seq: 1, type: "artifact", content: artifact }] as JobRecord["messages"],
      }),
      1
    );
    // The verifier recomputes from the message stream alone, with no summary.
    expect(receipt.result_hash).toBe(computeResultHash(undefined, [artifact]));
  });
});

describe("receipt/status coherence on the read paths", () => {
  it("withholds a receipt from a response whose status isn't terminal", async () => {
    // An inconsistent stored row must not expose a terminal receipt while
    // the response still reports processing.
    const jobStore = new MemoryJobStore();
    const { app } = await buildServer(completes, { jobStore });
    await jobStore.save(seedRecord("job-window", { status: "processing" }));
    await jobStore.saveReceipt(
      "job-window",
      ISSUER.issue(seedRecord("job-window", { status: "failed", summary: "boom" }), 99)
    );

    const body = await poll(app as never, "job-window", SEED_JOB_TOKEN);
    expect(body.status).toBe("processing");
    expect(body.receipt).toBeUndefined();
  });

  it("repairs a terminal job that lost its receipt, reusing the claimed sequence", async () => {
    // The crash window: `claimReceiptSeq` commits the number, the process dies
    // before `saveReceipt` writes the bytes. Left alone that number is stranded
    // forever and reads as a suppression gap — so the read path re-issues, and
    // the idempotent claim means it takes the number already spent on this job.
    const jobStore = new MemoryJobStore();
    const { app } = await buildServer(completes, { jobStore });
    await jobStore.save(seedRecord("job-crashed", { status: "failed", summary: "boom" }));
    const claimed = await jobStore.claimReceiptSeq("job-crashed");

    const body = await poll(app as never, "job-crashed", SEED_JOB_TOKEN);
    expect(body.receipt).toBeDefined();
    const receipt = body.receipt as never;
    expect(verifyReceipt(receipt)).toBe(true);
    expect(body.receipt).toMatchObject({ outcome: "failed", seq: claimed });
    // And it's persisted, so the next read is served the same bytes.
    expect((await jobStore.get("job-crashed"))?.receipt).toEqual(body.receipt);
  });
});

/**
 * the whole trust chain, against a server booted exactly the way
 * `dvmctl serve --dvm <handle>` boots one — `attestationEnv()` verbatim, no
 * hand-assembled builder block.
 *
 * This is the L0 twin of `npm run money-loop`'s assertion. `verified` is only
 * reachable when all three links hold, so it is the single expectation that
 * catches a regression in any of them: the SDK dropping the builder block, the
 * attested slug drifting from the signing key, or the env shape changing under
 * the CLI that writes it.
 */
describe("the receipt → attestation chain, end to end", () => {
  const builder = generateIdentity();
  const attestation = signDeployAttestation({
    builderSecret: builder.secret,
    builderPubkey: builder.pubkey,
    dvmId: "dvm-attested",
    // Deliberately not the descriptor name: a receipt is stamped with the
    // *attested* slug, since a receipt claiming a name the attestation doesn't
    // bind would be unverifiable.
    slug: "attested-dvm",
    capabilities: ["count"],
    withReceiptKey: true,
  });

  async function buildAttestedServer() {
    const descriptor = configureDVM({
      name: "receipt-test",
      capability: "count",
      tag: "test",
      idleTimeout: 120,
      input: z.object({ text: z.string() }),
      onJob: completes,
    });
    const { app } = await createDVMServer(descriptor, {
      env: attestationEnv(attestation),
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      devMode: true,
      fxFetcher: stubFx,
      receiptKey: attestation.receiptSecret,
    });
    return app;
  }

  it("serves the attested key on /v1/info and signs receipts under it", async () => {
    const app = await buildAttestedServer();
    const info = (await (
      await (app as never as { request: typeof fetch }).request("/v1/info")
    ).json()) as V1InfoResponse;

    expect(info.receipts).toBe(true);
    expect(info.builder?.pubkey).toBe(builder.pubkey);
    expect(info.builder?.attestation.receipt_pubkey).toBe(attestation.payload.receipt_pubkey);

    const body = await submit(app as never);
    expect(body.receipt).toMatchObject({
      dvm_id: "dvm-attested",
      dvm: "attested-dvm",
      receipt_pubkey: attestation.payload.receipt_pubkey,
    });
    const verdict = verifyJobReceipt({
      receipt: body.receipt as never,
      builder: info.builder as ReceiptTrustAnchor,
      expectedJobId: body.job_id,
      delivered: { summary: "counted 3 words", artifactContents: [] },
    });

    expect(verdict.status).toBe("verified");
    expect(verdict.checks).toEqual({
      job_id: "ok",
      signature: true,
      attestation: "ok",
      result_hash: "ok",
    });
  });

  it("reports key_mismatch when the served block attests a key the DVM doesn't hold", async () => {
    // The failure the `--local` path refused to create by attesting nothing:
    // a builder block whose `receipt_pubkey` names someone else's key makes
    // every receipt `invalid`, not merely unattested.
    const app = await buildAttestedServer();
    const info = (await (
      await (app as never as { request: typeof fetch }).request("/v1/info")
    ).json()) as V1InfoResponse;
    const body = await submit(app as never);

    const other = signDeployAttestation({
      builderSecret: builder.secret,
      builderPubkey: builder.pubkey,
      dvmId: "dvm-some-other",
      slug: "some-other-dvm",
      capabilities: ["count"],
      withReceiptKey: true,
    });
    const otherPayload = { ...other.payload, dvm_id: "dvm-attested" };
    const verdict = verifyJobReceipt({
      receipt: body.receipt as never,
      builder: {
        ...(info.builder as ReceiptTrustAnchor),
        attestation: otherPayload as unknown as Record<string, unknown>,
        signature: signAttestation(otherPayload, builder.secret),
      },
    });

    expect(verdict.status).toBe("invalid");
    expect(verdict.reason).toBe("receipt_key_mismatch");
  });
});
