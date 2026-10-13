import { describe, expect, it, vi } from "vitest";

import { toLockPubkey } from "../../lib/cashu/lock-pubkey";
import { acceptAccumulatorPayment } from "../server/wallet-accumulator-receive";

vi.mock("../server/wallet-accumulator-receive", () => ({
  acceptAccumulatorPayment: vi.fn(),
}));

const { processIncomingPayment } = await import("../server/payment");
const mockAccept = vi.mocked(acceptAccumulatorPayment);

import type { ServerJob } from "../server/job";
import { StepCache } from "../step-cache";

const MINT = "https://mint.example.com";
const LOCK_PUBKEY = toLockPubkey("02" + "ab".repeat(32));

function makeJob(overrides?: Partial<ServerJob>): ServerJob {
  return {
    id: "job-1",
    tags: [],
    capability: "test",
    input: "test",
    params: {},
    requesterId: "user-1",
    status: "awaiting-input",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    pendingPaymentMsats: 7_000,
    listeners: new Set(),
    abort: new AbortController(),
    stepCache: new StepCache(),
    state: {},
    pendingPrompts: new Map(),
    pendingPayment: null,
    replayHighSeq: null,
    replayProviderSkip: 0,
    replayPaymentIndex: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

describe("processIncomingPayment — cashu_p2pk mid-job", () => {
  it("credits the job and tags cashu_flow when accumulator accepts", async () => {
    mockAccept.mockResolvedValueOnce({
      kind: "accumulated",
      paidMsats: 7_000,
      grossMsats: 7_000,
      inputFeeMsats: 0,
      netMsats: 7_000,
      mintUrl: MINT,
    });

    const job = makeJob();
    const result = await processIncomingPayment(
      job,
      {
        type: "payment",
        content: {
          cashu_token: "cashuB-locked",
          cashu_request_id: "req-mid-uuid",
          mint: MINT,
          amount_msats: 7_000,
        },
      },
      {
        mints: [MINT],
        cashuMode: "p2pk-accumulator",
        accumulatorDb: {} as never,
        dvmId: "dvm-1",
        lockPubkeys: [LOCK_PUBKEY],
      }
    );

    expect(result).toBeNull();
    expect(job.paidMsats).toBe(7_000);
    expect(job.paymentRail).toBe("cashu");
    expect(job.paymentMint).toBe(MINT);
    expect(job.paymentTxHash).toBe("req-mid-uuid");
    expect(job.cashuFlow).toBe("p2pk_accumulator");
    expect(job.status).toBe("processing");
    expect(job.pendingPaymentMsats).toBeUndefined();

    expect(mockAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        cashuToken: "cashuB-locked",
        requestId: "req-mid-uuid",
        mints: [MINT],
        dvmId: "dvm-1",
        lockPubkeys: [LOCK_PUBKEY],
      })
    );
  });

  it("surfaces accumulator rejection as a 402 with the receive code", async () => {
    mockAccept.mockResolvedValueOnce({
      kind: "rejected",
      code: "wrong_lock_pubkey",
      message: "not locked to DVM pubkey",
    });

    const job = makeJob();
    const result = await processIncomingPayment(
      job,
      {
        type: "payment",
        content: {
          cashu_token: "cashuB-locked",
          cashu_request_id: "req-mid-uuid",
          mint: MINT,
        },
      },
      {
        mints: [MINT],
        cashuMode: "p2pk-accumulator",
        accumulatorDb: {} as never,
        dvmId: "dvm-1",
        lockPubkeys: [LOCK_PUBKEY],
      }
    );

    expect(result?.status).toBe(402);
    expect(result?.body.error).toBe("wrong_lock_pubkey");
    expect(job.paidMsats).toBe(0);
    expect(job.paymentRail).toBeUndefined();
  });

  it("still rejects with cashu_not_p2pk_locked when accumulator opts are absent", async () => {
    const job = makeJob();
    const result = await processIncomingPayment(
      job,
      {
        type: "payment",
        content: {
          cashu_token: "cashuB-locked",
          cashu_request_id: "req-mid-uuid",
        },
      },
      { mints: [MINT] }
    );

    expect(result?.status).toBe(402);
    expect(result?.body.error).toBe("cashu_not_p2pk_locked");
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("rejects with cashu_unavailable when accumulator wired but mints missing", async () => {
    const job = makeJob();
    const result = await processIncomingPayment(
      job,
      {
        type: "payment",
        content: { cashu_token: "cashuB-locked", cashu_request_id: "req-mid-uuid" },
      },
      {
        cashuMode: "p2pk-accumulator",
        accumulatorDb: {} as never,
        dvmId: "dvm-1",
        lockPubkeys: [LOCK_PUBKEY],
      }
    );

    expect(result?.status).toBe(402);
    expect(result?.body.error).toBe("cashu_unavailable");
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("forwards missing cashu_request_id to the accumulator (it rejects with missing_request_id)", async () => {
    mockAccept.mockResolvedValueOnce({
      kind: "rejected",
      code: "missing_request_id",
      message: "X-Cashu-Request-Id header required for the agent-wallet path.",
    });

    const job = makeJob();
    const result = await processIncomingPayment(
      job,
      { type: "payment", content: { cashu_token: "cashuB-locked" } },
      {
        mints: [MINT],
        cashuMode: "p2pk-accumulator",
        accumulatorDb: {} as never,
        dvmId: "dvm-1",
        lockPubkeys: [LOCK_PUBKEY],
      }
    );

    expect(result?.body.error).toBe("missing_request_id");
    expect(mockAccept).toHaveBeenCalledWith(expect.objectContaining({ requestId: undefined }));
  });
});
