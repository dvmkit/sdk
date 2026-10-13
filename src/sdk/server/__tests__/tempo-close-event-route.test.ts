/**
 * `POST /_internal/tempo-close-event`, the route the platform's
 * close observer wakes a suspended DVM through.
 *
 * Replaces the token-gated `/_internal/tempo-session-watch` sweep endpoint.
 * The route is deliberately unauthenticated — the body is an event locator and
 * the DVM verifies it against its own chain read — so what these cases pin is
 * the mount gate and the status contract the observer's retry loop reads.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";
import type { MppxServer, TempoChannelSettlementOutcome } from "../mpp-setup";
import { TEMPO_CLOSE_REQUESTED_TOPIC } from "../tempo-close-event";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"]
};

const CHANNEL_ID = `0x${"11".repeat(32)}`;
const ESCROW = `0x${"22".repeat(20)}`;
const TX_HASH = `0x${"33".repeat(32)}`;
const CHAIN_ID = 42431;

/** Minimal mppx handle carrying just the three seams the route mounts on. */
function closeEventMpp(
  overrides: {
    outcome?: TempoChannelSettlementOutcome;
    binding?: { chainId: number; escrowContract: string } | null;
    omit?: "settle" | "binding" | "receipt";
  } = {}
) {
  const settle = vi.fn(() =>
    Promise.resolve(
      overrides.outcome ?? {
        outcome: "settled" as const,
        channelId: CHANNEL_ID,
        settledAmount: 60n
      }
    )
  );
  const getTempoSessionBinding = vi.fn(() =>
    Promise.resolve(overrides.binding === undefined ? { chainId: CHAIN_ID, escrowContract: ESCROW } : overrides.binding)
  );
  const getTempoReceipt = vi.fn(() =>
    Promise.resolve({
      logs: [
        {
          address: ESCROW,
          topics: [TEMPO_CLOSE_REQUESTED_TOPIC, CHANNEL_ID, `0x${"44".repeat(20)}`, `0x${"55".repeat(20)}`],
          logIndex: 0
        }
      ]
    })
  );
  return {
    realm: "tempo-close-event.test",
    methods: [],
    challenge: {},
    settle,
    handle: {
      realm: "tempo-close-event.test",
      methods: [],
      challenge: {},
      ...(overrides.omit === "settle" ? {} : { settleTempoSessionChannel: settle }),
      ...(overrides.omit === "binding" ? {} : { getTempoSessionBinding }),
      ...(overrides.omit === "receipt" ? {} : { getTempoReceipt })
    } as unknown as MppxServer
  };
}

async function startDvm(mpp?: MppxServer) {
  const dvm = configureDVM({
    name: "tempo-close-event-test",
    capability: "do",
    input: z.object({ text: z.string() }),
    price: "$0.01",
    onJob(ctx) {
      ctx.complete("done");
    }
  });
  return createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    ...(mpp ? { mpp } : {})
  });
}

function deliver(
  app: Awaited<ReturnType<typeof startDvm>>["app"],
  body: unknown = { chain_id: CHAIN_ID, tx_hash: TX_HASH, log_index: 0 }
) {
  return app.request("/_internal/tempo-close-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /_internal/tempo-close-event", () => {
  it("settles a verified close and acknowledges the event", async () => {
    const mpp = closeEventMpp();
    const { app } = await startDvm(mpp.handle);

    const res = await deliver(app);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      outcome: "settled",
      channel_id: CHANNEL_ID,
      settled_amount: "60"
    });
    expect(mpp.settle).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it("refuses a malformed locator with 400 and settles nothing", async () => {
    const mpp = closeEventMpp();
    const { app } = await startDvm(mpp.handle);

    const res = await deliver(app, { chain_id: CHAIN_ID });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "malformed_locator" });
    expect(mpp.settle).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const mpp = closeEventMpp();
    const { app } = await startDvm(mpp.handle);

    const res = await app.request("/_internal/tempo-close-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json"
    });

    expect(res.status).toBe(400);
    expect(mpp.settle).not.toHaveBeenCalled();
  });

  it("answers 409 for a channel this DVM does not hold, so the observer stops retrying", async () => {
    const mpp = closeEventMpp({ binding: null });
    const { app } = await startDvm(mpp.handle);

    const res = await deliver(app);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "unknown_channel" });
    expect(mpp.settle).not.toHaveBeenCalled();
  });

  it("answers 409, never 200, when the channel finalized before protection", async () => {
    const mpp = closeEventMpp({
      outcome: {
        outcome: "finalized_before_protection",
        channelId: CHANNEL_ID,
        owed: 40n,
        settledOnChain: 20n
      }
    });
    const { app } = await startDvm(mpp.handle);

    const res = await deliver(app);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      outcome: "finalized_before_protection",
      owed: "40"
    });
  });

  it("answers 503 on a retryable failure so the event stays pending", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mpp = closeEventMpp({
      outcome: {
        outcome: "retryable_failure",
        channelId: CHANNEL_ID,
        error: "rpc down"
      }
    });
    const { app } = await startDvm(mpp.handle);

    expect((await deliver(app)).status).toBe(503);
    expect(info.mock.calls.map(([line]) => String(line)).join("\n")).not.toContain("rpc down");
    info.mockRestore();
  });

  it("does not mount without the settlement, binding and receipt seams", async () => {
    const noMpp = await startDvm();
    expect((await deliver(noMpp.app)).status).toBe(404);

    for (const omit of ["settle", "binding", "receipt"] as const) {
      const partial = await startDvm(closeEventMpp({ omit }).handle);
      expect((await deliver(partial.app)).status).toBe(404);
    }
  });
});
