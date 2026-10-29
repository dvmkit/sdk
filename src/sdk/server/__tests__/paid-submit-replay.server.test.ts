import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { MintHealthTracker } from "../mint-health-tracker";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { acceptAccumulatorPayment } from "../wallet-accumulator-receive";
import { expectJobIdentity, expectNoJobIdentity } from "./__helpers__/job-identity";

vi.mock("../wallet-accumulator-receive", () => ({
  acceptAccumulatorPayment: vi.fn(),
}));

const { createDVMServer } = await import("../app");
const mockAccept = vi.mocked(acceptAccumulatorPayment);

/**
 * a retried paid submit gets the original job back.
 *
 * The client-side abort in a timed-out paid submit doesn't stop the DVM: it
 * takes the payment, creates the job, and runs it. Only the response — which
 * carried `job_id` and `job_token` — is lost. Replaying is safe (the
 * accumulator's UNIQUE constraint no-ops the duplicate) and now also useful:
 * the DVM re-issues the original job's response instead of a bare 409.
 *
 * The gate is proof-of-origin, not possession of the (already-spent) bearer
 * token: the replay must reproduce the request it paid for, and on a signed
 * DVM come from the same caller.
 */

const MINT = "https://mint.example";
const LOCK_PUBKEY = "02" + "ab".repeat(32);
const REQUEST_ID = "req-1260-uuid";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const PRIVKEY = new Uint8Array(32).fill(7);
const OTHER_PRIVKEY = new Uint8Array(32).fill(9);

/**
 * First accept succeeds; every later accept collides on the UNIQUE constraint
 * and reports the proofs bound to the first accept's request id.
 */
function acceptOnceThenReplay(): void {
  mockAccept.mockImplementation(() => {
    const call = mockAccept.mock.calls.length;
    const firstRequestId = mockAccept.mock.calls[0]?.[0].requestId ?? "";
    const requestId = mockAccept.mock.calls[call - 1]?.[0].requestId;
    return Promise.resolve(
      call === 1
        ? {
            kind: "accumulated" as const,
            grossMsats: 1_000_000,
            inputFeeMsats: 0,
            mintUrl: MINT,
            netMsats: 1_000_000,
            paidMsats: 1_000_000,
            requestId: firstRequestId,
          }
        : {
            kind: "rejected" as const,
            code: "replay_rejected" as const,
            message: "Proofs or request id already accepted at this DVM.",
            acceptedRequestId: firstRequestId,
            requestId,
          }
    );
  });
}

/**
 * The tracker holds paid calls at 503 until its first probe lands,
 * so drive one probe with a stubbed fetch rather than reaching the network.
 */
async function settledTracker(): Promise<MintHealthTracker> {
  const tracker = new MintHealthTracker({
    mints: [MINT],
    fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
  });
  await tracker.runOnce();
  return tracker;
}

/** Released in `afterEach` so a `slow` handler doesn't outlive its test. */
let releaseSlowHandler: () => void = () => {};

const servers = servedApps();

async function startServer(opts: { signed: boolean; handlerCalls?: { n: number } }): Promise<{
  url: string;
}> {
  const inputSchema = opts.signed ? signedSchema : z.object({ action: z.string() });
  const dvm = configureDVM({
    name: "paid-submit-replay",
    capabilities: {
      do: {
        input: inputSchema,
        price: "$0.10",
        onJob(ctx) {
          if (opts.handlerCalls) opts.handlerCalls.n++;
          ctx.complete("ok");
        },
      },
      slow: {
        input: inputSchema,
        price: "$0.10",
        async onJob(ctx) {
          if (opts.handlerCalls) opts.handlerCalls.n++;
          await new Promise<void>((resolve) => {
            releaseSlowHandler = resolve;
          });
          ctx.complete("ok");
        },
      },
    },
    ...(opts.signed ? { auth: secp256k1Auth() } : {}),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    fxFetcher: stubFx,
    mints: [MINT],
    cashuMode: "p2pk-accumulator",
    lockPubkey: LOCK_PUBKEY,
    dvmId: "dvm-paid-replay",
    // The accept path is mocked, so the pool is never queried;
    // `lockPubkeyStateForRead` falls back to the env-seeded lock pubkey.
    db: {} as never,
    mintHealthTracker: await settledTracker(),
  });
  return { url: await servers.serve(app) };
}

function submit(url: string, body: unknown, requestId = REQUEST_ID): Promise<Response> {
  return fetch(`${url}/v1/job`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": "cashuBreplay",
      "X-Cashu-Request-Id": requestId,
    },
    body: JSON.stringify(body),
  });
}

interface SubmitBody {
  job_id?: string;
  job_token?: string;
  status?: string;
  summary?: string;
  error?: string;
}

describe("replayed paid submit returns the original job", () => {
  beforeEach(() => {
    mockAccept.mockReset();
    acceptOnceThenReplay();
  });

  afterEach(() => {
    releaseSlowHandler();
  });

  it("re-issues the original job_id and job_token when the replayed body matches", async () => {
    const calls = { n: 0 };
    const started = await startServer({ signed: false, handlerCalls: calls });
    const body = { capability: "do", data: { action: "publish" } };

    const first = await submit(started.url, body);
    const original = (await first.json()) as SubmitBody;
    expect(first.status).toBe(200);
    expect(original.job_id).toBeTruthy();
    expect(original.job_token).toBeTruthy();
    expectJobIdentity(first, original);

    const replay = await submit(started.url, body);
    const recovered = (await replay.json()) as SubmitBody;

    // Same job, same token, and the completion fields the lost response carried.
    expect(replay.status).toBe(200);
    expectJobIdentity(replay, recovered);
    expect(recovered.job_id).toBe(original.job_id);
    expect(recovered.job_token).toBe(original.job_token);
    expect(recovered.status).toBe("completed");
    expect(recovered.summary).toBe("ok");
    // No second job, no second run — the payment bought exactly one execution.
    expect(calls.n).toBe(1);
  });

  it("recovers a still-processing job with the same 202 the first submit returned", async () => {
    const started = await startServer({ signed: false });
    const body = { capability: "slow", data: { action: "publish" } };

    const first = await submit(started.url, body);
    const original = (await first.json()) as SubmitBody;
    expect(first.status).toBe(202);
    expect(original.status).toBeUndefined();
    expectJobIdentity(first, original);

    const replay = await submit(started.url, body);
    const recovered = (await replay.json()) as SubmitBody;
    expect(replay.status).toBe(202);
    expectJobIdentity(replay, recovered);
    expect(recovered.job_id).toBe(original.job_id);
    expect(recovered.job_token).toBe(original.job_token);
    expect(recovered.status).toBeUndefined();
  });

  it("refuses a replay whose body doesn't match the paid-for request", async () => {
    const started = await startServer({ signed: false });

    const first = await submit(started.url, { capability: "do", data: { action: "publish" } });
    expect(first.status).toBe(200);

    // Same spent token, same request id — a different job. This is the thief:
    // possession of the bearer token buys nothing.
    const replay = await submit(started.url, { capability: "do", data: { action: "exfiltrate" } });
    const body = (await replay.json()) as SubmitBody;
    expect(replay.status).toBe(409);
    expect(body.error).toBe("replay_rejected");
    expect(body.job_id).toBeUndefined();
    expectNoJobIdentity(replay);
    expect(body.job_token).toBeUndefined();
  });

  it("refuses a replay whose proofs were accepted under a different request id than the header names", async () => {
    const started = await startServer({ signed: false });
    const body = { capability: "do", data: { action: "publish" } };
    const first = await submit(started.url, body);
    expect(first.status).toBe(200);
    mockAccept.mockReset();
    mockAccept.mockResolvedValue({
      kind: "rejected",
      code: "replay_rejected",
      message: "Proofs or request id already accepted at this DVM.",
      acceptedRequestId: "req-other-uuid",
    });

    // The header and body name the paid job, but the proofs are bound elsewhere.
    const replay = await submit(started.url, body);
    const refused = (await replay.json()) as SubmitBody;
    expect(replay.status).toBe(409);
    expect(refused.error).toBe("replay_rejected");
    expect(refused.job_token).toBeUndefined();
    expectNoJobIdentity(replay);
  });

  it("keeps the 409 when the request id paid for no job here", async () => {
    const started = await startServer({ signed: false });
    mockAccept.mockReset();
    mockAccept.mockResolvedValue({
      kind: "rejected",
      code: "replay_rejected",
      message: "Proofs or request id already accepted at this DVM.",
    });

    const res = await submit(started.url, { capability: "do", data: { action: "publish" } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as SubmitBody).error).toBe("replay_rejected");
  });

  describe("on a descriptor-auth DVM", () => {
    const signer = createSignedRequestVerifier(signedSchema);

    it("recovers the job across a re-signed envelope from the same caller", async () => {
      const calls = { n: 0 };
      const started = await startServer({ signed: true, handlerCalls: calls });

      const first = await submit(started.url, {
        capability: "do",
        data: signer.signRequest(PRIVKEY, { action: "publish" }),
      });
      const original = (await first.json()) as SubmitBody;
      expect(first.status).toBe(200);

      // The resume sweep re-signs on every attempt — the DVM rejects a
      // stale timestamp before it ever looks at the payment. Fresh nonce, fresh
      // timestamp, fresh signature; same caller, same request.
      const replay = await submit(started.url, {
        capability: "do",
        data: signer.signRequest(PRIVKEY, { action: "publish" }),
      });
      const recovered = (await replay.json()) as SubmitBody;

      expect(replay.status).toBe(200);
      expect(recovered.job_id).toBe(original.job_id);
      expect(recovered.job_token).toBe(original.job_token);
      // The recovery returns before `recordReplay`, so the fresh envelope's
      // nonce is never burned and the caller never sees a 401.
      expect(recovered.error).toBeUndefined();
      expect(calls.n).toBe(1);
    });

    it("refuses a replay signed by a different caller", async () => {
      const started = await startServer({ signed: true });

      const first = await submit(started.url, {
        capability: "do",
        data: signer.signRequest(PRIVKEY, { action: "publish" }),
      });
      expect(first.status).toBe(200);

      // Same request, validly signed — by someone else. The body fingerprints
      // the same, so the pubkey is the only thing standing between a thief with
      // a lifted token and the original caller's job.
      const replay = await submit(started.url, {
        capability: "do",
        data: signer.signRequest(OTHER_PRIVKEY, { action: "publish" }),
      });
      const body = (await replay.json()) as SubmitBody;
      expect(replay.status).toBe(409);
      expect(body.error).toBe("replay_rejected");
      expect(body.job_token).toBeUndefined();
    });
  });
});
