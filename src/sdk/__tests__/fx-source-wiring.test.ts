import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../configure";
import { createDVMServer } from "../server/app";
import { MemoryKVStore } from "../store";

/** The env value "platform" selects an FX source; it is not a fetchable URL. */
describe('SDK fx-source wiring — DVMKIT_FX_SOURCE="platform"', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('resolves to the authenticated platform fx endpoint instead of fetch("platform")', async () => {
    const fetchCalls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = vi.fn(
      (input: unknown, init?: { headers?: Record<string, string | undefined> }) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        const headers = init?.headers ?? {};
        fetchCalls.push({ url, auth: headers.Authorization ?? headers.authorization ?? null });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              // All DEFAULT_FX_CURRENCIES — the platform fetcher validates each.
              rates: { usd: 100_000, eur: 92_000, gbp: 79_000, jpy: 15_000_000 },
              as_of: "2026-05-30T00:00:00Z",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          )
        );
      }
    ) as unknown as typeof fetch;

    const { app } = await createDVMServer(
      configureDVM({
        name: "FxProbe",
        capability: "synth",
        tag: "test",
        input: z.object({ text: z.string() }),
        onQuote: {
          schema: z.object({ text: z.string() }),
          handler() {
            return Promise.resolve({
              upfront: { amount: 0.01, currency: "usd" as const },
              description: "probe",
              shape: "fixed" as const,
            });
          },
        },
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      {
        // DVMKIT_FX_SOURCE="platform" requires DVMKIT_PLATFORM_URL/TOKEN; setting
        // PLATFORM_URL also trips the reporter-wiring gate, so supply the minimal
        // token/dvmId/db stubs (db is never dereferenced on this path) and an
        // onJobCompleted no-op to skip RevenueReporter construction.
        env: {
          DVMKIT_FX_SOURCE: "platform",
          DVMKIT_PLATFORM_URL: "http://platform.test",
          DVMKIT_PLATFORM_TOKEN: "tok-123",
          DVMKIT_DVM_ID: "test-dvm",
        },
        store: new MemoryKVStore(),
        db: {} as unknown as Pool,
        dvmId: "test-dvm",
        platformToken: "tok-123",
        onJobCompleted: () => {},
        // NB: no `fxFetcher` — this exercises the env-derived wiring under test.
      }
    );

    const res = await app.fetch(
      new Request("http://local/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "synth", data: { text: "hi" } }),
      })
    );

    // Pre-fix the only fx attempt was `fetch("platform")` → 503 fx_rate_unavailable.
    expect(res.status).not.toBe(503);
    const fxCall = fetchCalls.find((c) => c.url.includes("/_internal/fx"));
    expect(fxCall?.url).toBe("http://platform.test/_internal/fx");
    expect(fxCall?.auth).toBe("Bearer tok-123");
    // The buggy path would have fetched the bare "platform" string.
    expect(fetchCalls.some((c) => c.url === "platform")).toBe(false);
  });
});
