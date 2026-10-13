import { beforeEach, describe, expect, it, vi } from "vitest";

import { toLockPubkey } from "../../lib/cashu/lock-pubkey";
import type * as cashuVerifyModule from "../../lib/cashu/verify";
import * as cashuVerify from "../../lib/cashu/verify";
import { acceptAccumulatorPayment } from "../server/wallet-accumulator-receive";

vi.mock("../../lib/cashu/verify", async (importOriginal) => {
  // Stub only `verifyCashuToken`; the tracker needs the real `normaliseMintUrl`.
  const actual = await importOriginal<typeof cashuVerifyModule>();
  return {
    ...actual,
    verifyCashuToken: vi.fn(),
  };
});
vi.mock("../server/wallet-accumulator-receive", () => ({
  acceptAccumulatorPayment: vi.fn(),
}));

const { verifyUpfrontPayment } = await import("../server/payment");
const { MintHealthTracker } = await import("../server/mint-health-tracker");

const mockVerifyCashuToken = vi.mocked(cashuVerify.verifyCashuToken);
const mockAccept = vi.mocked(acceptAccumulatorPayment);

const SICK_MINT = "https://sick.example.com";
const HEALTHY_MINT = "https://healthy.example.com";

const VALID_INFO = {
  pubkey: "02abc",
  version: "Nutshell/0.20.0",
  nuts: {
    "4": { methods: [{ method: "bolt11", unit: "sat" }] },
    "5": { methods: [{ method: "bolt11", unit: "sat" }] },
    "7": { supported: true },
    "9": { supported: true },
    "10": { supported: true },
    "11": { supported: true },
    "20": { supported: true },
  },
};

function trackerWithSick(): InstanceType<typeof MintHealthTracker> {
  const tracker = new MintHealthTracker({
    mints: [SICK_MINT, HEALTHY_MINT],
    consecutiveFailuresToSick: 1,
    fetchImpl: (async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.startsWith(SICK_MINT)) {
        return new Response("nope", { status: 503 });
      }
      return new Response(JSON.stringify(VALID_INFO), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch,
  });
  return tracker;
}

describe("verifyUpfrontPayment — runtime mint-health gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds paid calls at mint_health_pending 503 before the first probe lands", async () => {
    // Fresh tracker, no `runOnce()` — initialProbeComplete() is false.
    const tracker = trackerWithSick();
    expect(tracker.initialProbeComplete()).toBe(false);

    const result = await verifyUpfrontPayment({
      cashuToken: "cashuB...",
      requestId: "req-uuid-pending",
      cashuMode: "p2pk-accumulator",
      accumulatorDb: {} as never,
      dvmId: "dvm-1",
      lockPubkeys: [toLockPubkey("02" + "ab".repeat(32))],
      mints: [SICK_MINT, HEALTHY_MINT],
      mintHealthTracker: tracker,
    });

    expect(result.error?.status).toBe(503);
    expect(result.error?.body.error).toBe("mint_health_pending");
    expect(result.error?.body.mints).toEqual([SICK_MINT, HEALTHY_MINT]);
    // relayable display + retry signal ride along.
    expect(typeof result.error?.body.display).toBe("string");
    expect(result.error?.body.retryable).toBe(true);
    // Gate fires before the token is even decoded or the DB is touched.
    expect(mockVerifyCashuToken).not.toHaveBeenCalled();
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("rejects with cashu_mint_sick 503 when the token's mint is sick", async () => {
    const tracker = trackerWithSick();
    await tracker.runOnce();

    mockVerifyCashuToken.mockReturnValue({
      mint: SICK_MINT,
      totalMsats: 1_000_000,
      unit: "sat",
    });

    const result = await verifyUpfrontPayment({
      cashuToken: "cashuB...",
      requestId: "req-uuid-1",
      cashuMode: "p2pk-accumulator",
      accumulatorDb: {} as never,
      dvmId: "dvm-1",
      lockPubkeys: [toLockPubkey("02" + "ab".repeat(32))],
      mints: [SICK_MINT, HEALTHY_MINT],
      mintHealthTracker: tracker,
    });

    expect(result.error?.status).toBe(503);
    expect(result.error?.body.error).toBe("cashu_mint_sick");
    expect(result.error?.body.mints).toEqual([HEALTHY_MINT]);
    // the dynamic hint (healthy-mint list) is preserved as an
    // override while display/retryable come from the code's copy.
    expect(result.error?.body.hint).toContain(HEALTHY_MINT);
    expect(typeof result.error?.body.display).toBe("string");
    expect(result.error?.body.retryable).toBe(true);
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("passes through to acceptAccumulatorPayment when the token's mint is healthy", async () => {
    const tracker = trackerWithSick();
    await tracker.runOnce();

    mockVerifyCashuToken.mockReturnValue({
      mint: HEALTHY_MINT,
      totalMsats: 1_000_000,
      unit: "sat",
    });
    mockAccept.mockResolvedValueOnce({
      kind: "accumulated",
      paidMsats: 1_000_000,
      grossMsats: 1_000_000,
      inputFeeMsats: 0,
      netMsats: 1_000_000,
      mintUrl: HEALTHY_MINT,
    });

    const result = await verifyUpfrontPayment({
      cashuToken: "cashuB...",
      requestId: "req-uuid-2",
      cashuMode: "p2pk-accumulator",
      accumulatorDb: {} as never,
      dvmId: "dvm-1",
      lockPubkeys: [toLockPubkey("02" + "ab".repeat(32))],
      mints: [SICK_MINT, HEALTHY_MINT],
      mintHealthTracker: tracker,
    });

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(1_000_000);
    expect(mockAccept).toHaveBeenCalledOnce();
  });

  it("falls through to acceptAccumulatorPayment when the token cannot be decoded", async () => {
    const tracker = trackerWithSick();
    await tracker.runOnce();

    mockVerifyCashuToken.mockImplementation(() => {
      throw new Error("decode failed");
    });
    mockAccept.mockResolvedValueOnce({
      kind: "rejected",
      code: "invalid_token",
      message: "decode failed",
    });

    const result = await verifyUpfrontPayment({
      cashuToken: "garbage",
      requestId: "req-uuid-3",
      cashuMode: "p2pk-accumulator",
      accumulatorDb: {} as never,
      dvmId: "dvm-1",
      lockPubkeys: [toLockPubkey("02" + "ab".repeat(32))],
      mints: [SICK_MINT, HEALTHY_MINT],
      mintHealthTracker: tracker,
    });

    // The canonical rejection wins — the sick-mint gate must not mask invalid_token.
    expect(result.error?.body.error).toBe("invalid_token");
    // even the dynamic accumulator-rejection codes carry the fields.
    expect(typeof result.error?.body.display).toBe("string");
    expect(result.error?.body.retryable).toBe(false);
    expect(mockAccept).toHaveBeenCalledOnce();
  });
});
