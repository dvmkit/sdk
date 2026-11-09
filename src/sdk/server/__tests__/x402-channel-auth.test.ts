/* x402 callers are unsigned: no field of an x402 job's input may become `ctx.auth`. */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";

const CALLER_CHOSEN = "ff".repeat(32);

function manager() {
  const descriptor = configureDVM({
    name: "x402-auth-test",
    auth: secp256k1Auth({ allowUnsignedPaid: true }),
    x402: { network: "eip155:84532", payTo: "0x1111111111111111111111111111111111111111" },
    capabilities: {
      fetch: {
        input: z.looseObject({ url: z.string() }),
        price: "$0.01",
        maxRuntimeSeconds: 9,
        onJob(ctx) {
          ctx.complete("ok");
        },
      },
      "fetch-x402": {
        name: "fetch",
        channels: { job: false, x402: {} },
        // Unknown keys survive parsing, so a body's `pubkey` reaches the parsed input.
        input: z.looseObject({ url: z.string() }),
        price: "$0.01",
        maxRuntimeSeconds: 9,
        onJob(ctx) {
          ctx.complete("ok");
        },
      },
    },
  });
  return new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    devMode: true,
    staleJobTimeoutMs: 0,
    fxFetcher: createFxFetcher(),
  });
}

describe("ctx.auth on the x402 channel", () => {
  const input = JSON.stringify({ url: "https://example.com", pubkey: CALLER_CHOSEN });

  it("is never taken from a parsed x402 input, at admission or on reactivation", () => {
    const jm = manager();
    try {
      const job = jm.createJob({ input }, "anonymous", { paidMsats: 0, receivedProofs: [] }, undefined, "fetch", undefined, {
        channel: "x402",
      });
      const parsed = jm.parseInput({ input }, "fetch", true, "x402");
      expect(parsed).toMatchObject({ pubkey: CALLER_CHOSEN });
      expect(jm.buildAndAttachContext(job, parsed).auth).toBeUndefined();

      const { sdkCtx } = jm.reactivateJob({
        id: "job-reactivated",
        tags: [],
        capability: "fetch",
        channel: "x402",
        input,
        params: {},
        requesterId: "anonymous",
        status: "processing",
        messages: [],
        seq: 0,
        paidMsats: 0,
        receivedProofs: [],
        stepCache: [],
        state: {},
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      expect(sdkCtx.auth).toBeUndefined();
    } finally {
      jm.shutdown();
    }
  });

  it("is still taken from a dvmkit-protocol input on the same DVM", () => {
    const jm = manager();
    try {
      const job = jm.createJob({ input }, "anonymous", { paidMsats: 0, receivedProofs: [] }, undefined, "fetch");
      const ctx = jm.buildAndAttachContext(job, jm.parseInput({ input }, "fetch"));
      expect(ctx.auth?.pubkey).toBe(CALLER_CHOSEN);
    } finally {
      jm.shutdown();
    }
  });
});
