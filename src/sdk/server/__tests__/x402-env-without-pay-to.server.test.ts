/*
 * A hosted platform turns x402 off by removing only DVMKIT_X402_PAY_TO and
 * keeps the stored batch-settlement settings, private keys included. Such a
 * server must start without an x402 rail rather than refuse to boot.
 */
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { createDVMHost } from "../host";
import { MemoryJobStore } from "../memory-job-store";

afterEach(() => { vi.restoreAllMocks(); });

describe("x402 environment without a payout address", () => {
  it("starts in production mode with the stored batch bundle, serving /v1/job and refusing the x402 route", async () => {
    const relayKey = generatePrivateKey();
    const authorizerKey = generatePrivateKey();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const origin = "https://dvm.example.com";
    const host = createDVMHost({
      port: 0,
      // An explicit job store stands in for Postgres; devMode stays off.
      jobStore: new MemoryJobStore(),
      fx: createFxFetcher(),
      env: {
        DVMKIT_PUBLIC_URL: origin,
        DVMKIT_X402_BATCH_SETTLEMENT: "true",
        DVMKIT_X402_RPC_URL: "https://rpc.example.invalid",
        DVMKIT_X402_SELF_RELAY_KEY: relayKey,
        DVMKIT_X402_RECEIVER_AUTHORIZER_KEY: authorizerKey,
      },
    });
    host.mount(configureDVM({
      name: "unset-pay-to",
      capabilities: {
        echo: {
          input: z.object({ text: z.string() }),
          onJob(ctx) { ctx.complete(`echo ${(ctx.input as { text: string }).text}`); },
        },
        fetch: {
          input: z.object({ url: z.string() }),
          channels: { job: false, x402: {} },
          price: "$0.01",
          maxRuntimeSeconds: 5,
          onJob(ctx) { ctx.complete("done"); },
        },
      },
    }));
    const server = await host.serve();
    try {
      const job = await fetch(`${server.url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "echo", data: { text: "hi" } }),
      });
      expect(job.status).toBeLessThan(300);
      expect(await job.json()).toMatchObject({ status: "completed", summary: "echo hi" });

      const route = await fetch(`${server.url}/v1/x402/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      expect(route.status).toBe(503);
      expect(route.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect(((await route.json()) as { error: string }).error).toBe("x402_not_offered");
    } finally {
      await server.close();
    }

    const lines = warn.mock.calls.map(([line]) => String(line));
    const ignored = lines
      .map((line) => { try { return JSON.parse(line) as { event?: string }; } catch { return {}; } })
      .filter((line) => line.event === "x402_env_ignored");
    expect(ignored).toEqual([{
      level: "warn",
      event: "x402_env_ignored",
      variables: [
        "DVMKIT_X402_BATCH_SETTLEMENT",
        "DVMKIT_X402_RPC_URL",
        "DVMKIT_X402_SELF_RELAY_KEY",
        "DVMKIT_X402_RECEIVER_AUTHORIZER_KEY",
      ],
    }]);
    const logged = [...lines, ...vi.mocked(console.log).mock.calls.map(([line]) => String(line))].join("\n");
    for (const key of [relayKey, authorizerKey]) {
      expect(logged.toLowerCase()).not.toContain(key.slice(2).toLowerCase());
    }
  });
});
