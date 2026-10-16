import { get as httpGet } from "node:http";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { servedApps } from "../../test-support/served-app";
import { configureDVM } from "../configure";
import type { FxFetcher } from "../pricing/index";
import { createDVMServer } from "../server/app";
import { CLIENT_COMPATIBILITY_HEADERS } from "../server/client-compatibility";
import { expectJobIdentity, expectNoJobIdentity } from "../server/__tests__/__helpers__/job-identity";
import { MemoryKVStore } from "../store";
import type { PaymentMethod } from "../types";

/** Deterministic fx stub — $100,000/BTC. Lets `priceMsats = fiatToSatsCeil(amount, 100_000) * 1000` work out cleanly across tests. */
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/**
 * The same stub carrying a second currency, for the cases where the
 * DVM prices in EUR. Kept separate rather than widening {@link stubFx}: the
 * USD-only set is itself an assertion in the unsupported-currency paths.
 */
const multiCurrencyFx: FxFetcher = {
  fetch: () =>
    Promise.resolve({ rates: { usd: 100_000, eur: 90_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd", "eur"],
};

/** POST JSON to a URL. */
function postJson(url: string, body: string, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tokenHeader(token) },
    body,
  });
}

/**
 * header object for the anonymous-flow per-job token. Spread into
 * `headers` on every test fetch against `/v1/job/:id/*` for a job the test
 * just submitted under default (anonymous) auth.
 */
function tokenHeader(token: string | undefined): Record<string, string> {
  return token ? { "X-Job-Token": token } : {};
}

/**
 * a promise the test resolves by hand. Cases whose precondition is an
 * *ordering* — "the DELETE lands while the handler is still running" — gate on
 * one of these instead of budgeting milliseconds and hoping the budget holds
 * under full-suite fork contention.
 */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("SDK server app", () => {
  const servers = servedApps();
  let baseUrl: string;

  async function startApp(
    descriptor: ReturnType<typeof configureDVM<any, any>>,
    opts: {
      devMode?: boolean;
      paymentMethods?: PaymentMethod[];
      fxFetcher?: FxFetcher;
      env?: Record<string, string>;
    } = {}
  ): Promise<void> {
    const { app } = await createDVMServer(descriptor, {
      env: { API_KEY: "test-key", ...opts.env },
      store: new MemoryKVStore(),
      devMode: opts.devMode,
      paymentMethods: opts.paymentMethods,
      fxFetcher: opts.fxFetcher ?? stubFx,
    });

    baseUrl = await servers.serve(app);
  }

  it("GET /health returns ok without auth", async () => {
    await startApp(
      configureDVM({
        name: "T",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get(CLIENT_COMPATIBILITY_HEADERS.protocolVersion)).toBe("1");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("healthHandler option overrides /health (status + body)", async () => {
    const { app } = await createDVMServer(
      configureDVM({
        name: "T",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      {
        env: {},
        store: new MemoryKVStore(),
        healthHandler: (c) => c.json({ ok: true, custom: true }, 503),
      }
    );
    const url = await servers.serve(app);
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: true, custom: true });
  });

  it("advertises cashu.canonical_id from canonicalDvmId when accumulator mode is on", async () => {
    const { app } = await createDVMServer(
      configureDVM({
        name: "T",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      {
        env: {},
        store: new MemoryKVStore(),
        mints: ["https://mint.example"],
        cashuMode: "p2pk-accumulator",
        lockPubkey: "02" + "ab".repeat(32),
        canonicalDvmId: "dvm-uuid-7",
      }
    );
    const url = await servers.serve(app);
    const res = await fetch(`${url}/v1/info`);
    const body = (await res.json()) as {
      cashu?: { lock_pubkeys: string[]; canonical_id: string | null };
    };
    expect(body.cashu?.canonical_id).toBe("dvm-uuid-7");
    expect(body.cashu?.lock_pubkeys).toEqual(["02" + "ab".repeat(32)]);
  });

  it("falls back to dvmId for canonical_id when canonicalDvmId is unset", async () => {
    const { app } = await createDVMServer(
      configureDVM({
        name: "T",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      {
        env: {},
        store: new MemoryKVStore(),
        mints: ["https://mint.example"],
        cashuMode: "p2pk-accumulator",
        lockPubkey: "02" + "ab".repeat(32),
        dvmId: "dvm-uuid-from-platform",
      }
    );
    const url = await servers.serve(app);
    const res = await fetch(`${url}/v1/info`);
    const body = (await res.json()) as { cashu?: { canonical_id: string | null } };
    expect(body.cashu?.canonical_id).toBe("dvm-uuid-from-platform");
  });

  it("falls back to the full configured list when every mint is sick", async () => {
    const { MintHealthTracker } = await import("../server/mint-health-tracker");
    const tracker = new MintHealthTracker({
      mints: ["https://mint-a.example", "https://mint-b.example"],
      fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
      consecutiveFailuresToSick: 1,
      // Zero backoff: a failing probe otherwise sleeps 700ms of real time.
      probe: { backoffMs: [0] },
    });
    await tracker.runOnce();

    const { app } = await createDVMServer(
      configureDVM({
        name: "T",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      {
        env: {},
        store: new MemoryKVStore(),
        mints: ["https://mint-a.example", "https://mint-b.example"],
        mintHealthTracker: tracker,
      }
    );
    const url = await servers.serve(app);
    const res = await fetch(`${url}/v1/info`);
    const body = (await res.json()) as { mints?: string[] };
    expect(body.mints).toEqual(["https://mint-a.example", "https://mint-b.example"]);
  });

  it("excludes NUT-incompatible mints from the all-sick fallback, keeps transiently-sick ones", async () => {
    const { MintHealthTracker } = await import("../server/mint-health-tracker");
    // mint-a is reachable but missing NUT-11 → permanently unsettleable.
    // mint-b is a transient 503. Nothing is healthy, so `advertisedMints()`
    // falls back — but the NUT-incompatible mint must never be re-advertised
    // by the fallback, while the flapping one stays published.
    const tracker = new MintHealthTracker({
      mints: ["https://mint-a.example", "https://mint-b.example"],
      fetchImpl: (async (input: unknown) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.startsWith("https://mint-a.example")) {
          return new Response(
            JSON.stringify({
              pubkey: "02abc",
              version: "Nutshell/0.20.0",
              nuts: {
                "4": { methods: [{ method: "bolt11", unit: "sat" }] },
                "5": { methods: [{ method: "bolt11", unit: "sat" }] },
                "7": { supported: true },
                "9": { supported: true },
                "10": { supported: true },
                "20": { supported: true },
                // NUT-11 (P2PK) absent → NUT-incompatible.
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("nope", { status: 503 });
      }) as typeof fetch,
      consecutiveFailuresToSick: 1,
      // Zero backoff: a failing probe otherwise sleeps 700ms of real time.
      probe: { backoffMs: [0] },
    });
    await tracker.runOnce();

    const { app } = await createDVMServer(
      configureDVM({
        name: "T",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      {
        env: {},
        store: new MemoryKVStore(),
        mints: ["https://mint-a.example", "https://mint-b.example"],
        mintHealthTracker: tracker,
      }
    );
    const url = await servers.serve(app);
    const res = await fetch(`${url}/v1/info`);
    const body = (await res.json()) as { mints?: string[] };
    expect(body.mints).toEqual(["https://mint-b.example"]);
  });

  it("filters sick/NUT-incompatible mints out of the /v1/info cashu block too", async () => {
    const { MintHealthTracker } = await import("../server/mint-health-tracker");
    const tracker = new MintHealthTracker({
      mints: ["https://mint-a.example", "https://mint-b.example"],
      fetchImpl: (async (input: unknown) => {
        const url = typeof input === "string" ? input : String(input);
        if (url.startsWith("https://mint-a.example")) {
          return new Response("nope", { status: 503 });
        }
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }) as typeof fetch,
      consecutiveFailuresToSick: 1,
      // Zero backoff: a failing probe otherwise sleeps 700ms of real time.
      probe: { backoffMs: [0] },
    });
    await tracker.runOnce();

    const { app } = await createDVMServer(
      configureDVM({
        name: "T",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      {
        env: {},
        store: new MemoryKVStore(),
        mints: ["https://mint-a.example", "https://mint-b.example"],
        cashuMode: "p2pk-accumulator",
        lockPubkey: "02" + "ab".repeat(32),
        mintHealthTracker: tracker,
      }
    );
    const url = await servers.serve(app);
    const res = await fetch(`${url}/v1/info`);
    const body = (await res.json()) as { mints?: string[]; cashu?: { mints: string[] } };
    // Both the top-level list and the P2PK block drop the sick mint.
    expect(body.mints).toEqual(["https://mint-b.example"]);
    expect(body.cashu?.mints).toEqual(["https://mint-b.example"]);
  });

  it("GET /v1/info returns descriptor metadata", async () => {
    await startApp(
      configureDVM({
        name: "Echo",
        capability: "test",
        description: "Echoes input",
        tag: "test",
        onJob(ctx) {
          ctx.complete(ctx.input as string);
        },
      })
    );
    const res = await fetch(`${baseUrl}/v1/info`);
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.name).toBe("Echo");
    expect(info.description).toBe("Echoes input");
    expect(info.tags).toEqual(["test"]);
  });

  it("summary-only job reports payload_in=summary, has_artifacts=false", async () => {
    await startApp(
      configureDVM({
        name: "SummaryOnly",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete(ctx.input as string);
        },
      })
    );

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "hello" })
    );
    const { job_id, job_token } = await res.json();
    expect(job_id).toBeDefined();
    expect([200, 202]).toContain(res.status);
    const status = await (
      await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) })
    ).json();
    expect(status.status).toBe("completed");
    expect(status.summary).toBe("hello");
    expect(status.has_artifacts).toBe(false);
    expect(status.artifact_count).toBeUndefined();
    expect(status.payload_in).toBe("summary");
  });

  it("states the job identity in the head of an inline completion larger than 64 KiB without changing its body", async () => {
    // Routers read the identity from the head precisely so they never buffer a
    // body this size; the field must not depend on the body being small.
    const summary = "0123456789abcdef".repeat(5 * 1024);
    await startApp(
      configureDVM({
        name: "Large",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete(summary);
        },
      })
    );

    const res = await postJson(`${baseUrl}/v1/job`, JSON.stringify({ capability: "test", input: "" }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024);
    const body = JSON.parse(text) as { job_id: string; status: string; summary: string };
    expect(body.status).toBe("completed");
    expect(body.summary).toBe(summary);
    expectJobIdentity(res, body);
  });

  it("single-artifact job reports artifact_count=1, payload_in=messages", async () => {
    await startApp(
      configureDVM({
        name: "OneArtifact",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.text("Working...");
          ctx.artifact({ data: "# Output", mime_type: "text/markdown" });
          ctx.complete("scraped example");
        },
      })
    );

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id, job_token } = await res.json();
    const status = await (
      await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) })
    ).json();
    expect(status.summary).toBe("scraped example");
    expect(status.has_artifacts).toBe(true);
    expect(status.artifact_count).toBe(1);
    expect(status.payload_in).toBe("messages");
    const { messages } = await (await fetch(`${baseUrl}/v1/job/${job_id}/messages`, {
      headers: tokenHeader(job_token),
    })).json();
    expect(messages.map((message: { type: string }) => message.type)).toEqual(["text", "artifact", "complete"]);
  });

  it("ignores query text after a fragment when reading authenticated job messages over HTTP", async () => {
    const finished = gate();
    await startApp(
      configureDVM({
        name: "QueryBoundary",
        capability: "test",
        onJob(ctx) {
          ctx.text("first");
          ctx.complete("done");
          finished.resolve();
        },
      })
    );
    const submitted = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    expect(submitted.status).toBe(200);
    const { job_id, job_token } = await submitted.json();
    await finished.promise;
    const url = new URL(baseUrl);

    for (const [suffix, expectedTypes] of [
      ["?after=1", ["complete"]],
      ["#ignored?after=99", ["text", "complete"]],
      ["?after=1#ignored&after=99", ["complete"]],
    ] as const) {
      // Fetch normalizes fragments away; a literal request target must reach the Node adapter.
      const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        httpGet({
          hostname: url.hostname,
          port: url.port,
          path: `/v1/job/${job_id}/messages${suffix}`,
          headers: tokenHeader(job_token),
        }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode, body }));
          res.on("error", reject);
        }).on("error", reject);
      });
      expect(response.status).toBe(200);
      const { messages } = JSON.parse(response.body) as { messages: { type: string }[] };
      expect(messages.map((message) => message.type)).toEqual(expectedTypes);
    }
  });

  it("multi-artifact + progress job reports artifact_count and payload_in=messages", async () => {
    await startApp(
      configureDVM({
        name: "MultiArtifact",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.progress(25, "phase-a");
          ctx.artifact({ data: "a", mime_type: "text/plain" });
          ctx.artifact({ data: "b", mime_type: "text/plain" });
          ctx.complete("two artifacts");
        },
      })
    );

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id, job_token } = await res.json();
    const status = await (
      await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) })
    ).json();
    expect(status.has_artifacts).toBe(true);
    expect(status.artifact_count).toBe(2);
    expect(status.payload_in).toBe("messages");
  });

  it("hint fields survive the store-backed fallback path", async () => {
    // Submit a job, evict it from activeJobs by hand, then refetch via
    // GET /v1/job/:id — that goes through the store-backed branch of
    // handleGetJob and must still compute has_artifacts from record.messages.
    const { app, jobManager } = await createDVMServer(
      configureDVM({
        name: "Persist",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.artifact({ data: "out", mime_type: "text/plain" });
          ctx.complete("done");
        },
      }),
      { env: {}, store: new MemoryKVStore() }
    );
    const url = await servers.serve(app);

    const res = await postJson(`${url}/v1/job`, JSON.stringify({ capability: "test", input: "" }));
    const { job_id, job_token } = await res.json();

    // Give the handler a tick to run + persist the terminal state.
    await new Promise((r) => {
      setTimeout(r, 30);
    });

    jobManager.activeJobs.delete(job_id);

    const status = await (
      await fetch(`${url}/v1/job/${job_id}`, {
        headers: tokenHeader(job_token),
      })
    ).json();
    expect(status.status).toBe("completed");
    expect(status.summary).toBe("done");
    expect(status.has_artifacts).toBe(true);
    expect(status.payload_in).toBe("messages");
  });

  it("GET /messages immediately after POST 202 resolves cleanly when X-Job-Token is presented", async () => {
    // Hold the handler on a gate so the immediate SSE read tests an in-flight job,
    // independently of timer or suite speed.
    const release = gate();
    const finished = gate();
    await startApp(
      configureDVM({
        name: "Slow",
        capability: "test",
        tag: "test",
        async onJob(ctx) {
          // Held non-terminal so the GET exercises the in-process branch of
          // `handleGetMessages` against a running job.
          await release.promise;
          ctx.complete("done");
          finished.resolve();
        },
      })
    );

    const postRes = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    expect(postRes.status).toBe(202);
    const { job_id, job_token } = await postRes.json();
    expect(typeof job_token).toBe("string");

    // No delay between the POST returning and the immediate GET — the GET
    // can arrive in the same event-loop turn as the 202 body parse.
    const okRes = await fetch(`${baseUrl}/v1/job/${job_id}/messages?after=0`, {
      headers: tokenHeader(job_token),
    });
    expect(okRes.status).toBe(200);
    await okRes.body?.cancel();

    const noTokenRes = await fetch(`${baseUrl}/v1/job/${job_id}/messages?after=0`);
    expect(noTokenRes.status).toBe(401);
    expect((await noTokenRes.json()).error).toBe("job_credential_required");

    // Let the handler finish before `afterEach` closes the server out from
    // under it.
    release.resolve();
    await finished.promise;
  });

  it("returns SSE for store-flushed jobs when Accept: text/event-stream", async () => {
    const { app, jobManager } = await createDVMServer(
      configureDVM({
        name: "FastJob",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.artifact({ data: "scraped content", mime_type: "text/plain" });
          ctx.complete("done");
        },
      }),
      { env: {}, store: new MemoryKVStore() }
    );
    const url = await servers.serve(app);

    const res = await postJson(`${url}/v1/job`, JSON.stringify({ capability: "test", input: "" }));
    const { job_id, job_token } = await res.json();

    // Wait for the handler to persist, then evict from activeJobs to simulate
    // the race where the CLI arrives after the job is already flushed.
    await new Promise((r) => {
      setTimeout(r, 30);
    });
    jobManager.activeJobs.delete(job_id);

    const sseRes = await fetch(`${url}/v1/job/${job_id}/messages?after=0`, {
      headers: { Accept: "text/event-stream", ...tokenHeader(job_token) },
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    const body = await sseRes.text();
    const events = body
      .split("\n\n")
      .filter((block) => block.includes("data:"))
      .map((block) => {
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        return JSON.parse((dataLine ?? "").slice("data:".length).trim());
      });
    expect(events.length).toBeGreaterThanOrEqual(2);
    const types = events.map((e: { type: string }) => e.type);
    expect(types).toContain("artifact");
    expect(types).toContain("complete");
  });

  it("provides env to the handler", async () => {
    await startApp(
      configureDVM({
        name: "Env",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete(ctx.env.API_KEY);
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    const status = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await status.json()).summary).toBe("test-key");
  });

  it("clones descriptor state for each handler job", async () => {
    await startApp(
      configureDVM({
        name: "Stateful",
        capability: "test",
        tag: "test",
        state: { count: 0 },
        onJob(ctx) {
          ctx.state.count++;
          ctx.complete(String(ctx.state.count));
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    for (let i = 0; i < 2; i++) {
      const res = await postJson(`${baseUrl}/v1/job`, body);
      const { job_id, job_token } = await res.json();
      const status = await fetch(`${baseUrl}/v1/job/${job_id}`, {
        headers: tokenHeader(job_token),
      });
      expect((await status.json()).summary).toBe("1");
    }
  });

  it("step caches results within a job", async () => {
    let callCount = 0;
    await startApp(
      configureDVM({
        name: "Step",
        capability: "test",
        tag: "test",
        async onJob(ctx) {
          const a = await ctx.step("compute", async () => {
            callCount++;
            return 42;
          });
          const b = await ctx.step("compute", async () => {
            callCount++;
            return 99;
          });
          ctx.complete(`${String(a)}-${String(b)}`);
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    const status = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await status.json()).summary).toBe("42-42");
    expect(callCount).toBe(1);
  });

  it("prompt suspends and resumes on response", async () => {
    await startApp(
      configureDVM({
        name: "Prompt",
        capability: "test",
        tag: "test",
        async onJob(ctx) {
          const resp = await ctx.prompt("q1", "What?", { options: ["A", "B"] });
          ctx.complete(resp.text);
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const jobRes = await postJson(`${baseUrl}/v1/job`, body);
    const submitted = await jobRes.json();
    const { job_id, job_token } = submitted;
    expect(jobRes.status).toBe(202);
    expect(submitted.status).toBe("awaiting-input");
    expectJobIdentity(jobRes, submitted);

    // Job should be awaiting input
    const statusRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await statusRes.json()).status).toBe("awaiting-input");
    // The field belongs to the submit and recovery responses, not to status reads.
    expectNoJobIdentity(statusRes);

    // Send response
    const msgBody = JSON.stringify({ type: "response", content: { prompt_id: "q1", text: "A" } });
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);

    // Wait for handler to resume
    await new Promise((r) => {
      setTimeout(r, 50);
    });

    const finalRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    const final = await finalRes.json();
    expect(final.status).toBe("completed");
    expect(final.summary).toBe("A");
  });

  it("validates structured input against schema", async () => {
    await startApp(
      configureDVM({
        name: "Structured",
        capability: "test",
        tag: "test",
        input: z.object({ url: z.string(), format: z.enum(["md", "txt"]).default("md") }),
        onJob(ctx) {
          ctx.complete(`${ctx.input.url} (${ctx.input.format})`);
        },
      })
    );

    const body = JSON.stringify({
      capability: "test",
      input: JSON.stringify({ url: "https://x.com" }),
    });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    const status = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await status.json()).summary).toBe("https://x.com (md)");
  });

  it("rejects invalid structured input with 400", async () => {
    await startApp(
      configureDVM({
        name: "Strict",
        capability: "test",
        tag: "test",
        input: z.object({ url: z.string() }),
        onJob(ctx) {
          ctx.complete(ctx.input.url);
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "not json" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
  });

  it("accepts body.data for structured input (preferred path)", async () => {
    await startApp(
      configureDVM({
        name: "Structured",
        capability: "test",
        tag: "test",
        input: z.object({ url: z.string(), format: z.enum(["md", "txt"]).default("md") }),
        onJob(ctx) {
          ctx.complete(`${ctx.input.url} (${ctx.input.format})`);
        },
      })
    );

    const body = JSON.stringify({
      capability: "test",
      data: { url: "https://example.com", format: "txt" },
    });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    const status = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await status.json()).summary).toBe("https://example.com (txt)");
  });

  it("missing both body.data and body.input returns invalid_input with hint", async () => {
    await startApp(
      configureDVM({
        name: "NeedsInput",
        capability: "test",
        tag: "test",
        input: z.object({ url: z.string() }),
        onJob(ctx) {
          ctx.complete(ctx.input.url);
        },
      })
    );

    const res = await postJson(`${baseUrl}/v1/job`, JSON.stringify({ capability: "test" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
    expect(body.hint).toMatch(/\/v1\/info/);
    expect(body.hint).toMatch(/body\.data/);
  });

  it("rejects body.data that fails schema validation with 400", async () => {
    await startApp(
      configureDVM({
        name: "Strict",
        capability: "test",
        tag: "test",
        input: z.object({ url: z.string() }),
        onJob(ctx) {
          ctx.complete(ctx.input.url);
        },
      })
    );

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", data: { url: 42 } })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
    expect(body.hint).toMatch(/\/v1\/info/);
  });

  it("uses DVMKIT_PUBLIC_URL in input and quote-schema hints", async () => {
    const publicOrigin = "https://dvmkit--strict.example.com";
    await startApp(
      configureDVM({
        name: "StrictPublicUrl",
        capability: "test",
        tag: "test",
        input: z.object({ url: z.string().optional(), words: z.unknown().optional() }),
        onQuote: {
          schema: z.object({ words: z.number() }),
          async handler() {
            return {
              upfront: { amount: 0.01, currency: "usd" },
              description: "Strict public URL quote",
            };
          },
        },
        onJob(ctx) {
          ctx.complete(ctx.input.url ?? "ok");
        },
      }),
      { env: { DVMKIT_PUBLIC_URL: `${publicOrigin}/ignored/path/` } }
    );

    const invalidInput = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", data: { url: 42 } })
    );
    expect(invalidInput.status).toBe(400);
    expect(((await invalidInput.json()) as { hint: string }).hint).toContain(
      `${publicOrigin}/v1/info`
    );

    const invalidQuote = await postJson(
      `${baseUrl}/v1/quote`,
      JSON.stringify({ capability: "test", data: { words: "many" } })
    );
    expect(invalidQuote.status).toBe(400);
    const quoteBody = (await invalidQuote.json()) as { error: string; hint: string };
    expect(quoteBody.error).toBe("invalid_quote_data");
    expect(quoteBody.hint).toContain(`${publicOrigin}/v1/info`);
  });

  it("falls back to the request origin when DVMKIT_PUBLIC_URL is malformed", async () => {
    await startApp(
      configureDVM({
        name: "MalformedPublicUrl",
        capability: "test",
        tag: "test",
        input: z.object({ url: z.string() }),
        onJob(ctx) {
          ctx.complete(ctx.input.url);
        },
      }),
      { env: { DVMKIT_PUBLIC_URL: "not a URL" } }
    );

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", data: { url: 42 } })
    );
    const body = (await res.json()) as { hint: string };
    expect(body.hint).toContain(`${baseUrl}/v1/info`);
    expect(body.hint).not.toContain("not a URL");
  });

  it("oversized string input returns a chunking hint (narrate scenario)", async () => {
    await startApp(
      configureDVM({
        name: "BigInput",
        capability: "test",
        tag: "test",
        input: z.object({ text: z.string().max(50_000) }),
        onJob(ctx) {
          ctx.complete(ctx.input.text);
        },
      })
    );

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", data: { text: "a".repeat(50_001) } })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
    expect(body.hint).toMatch(/exceeds the 50000-character limit/i);
    expect(body.hint).toMatch(/split into smaller chunks/i);
    // No raw Zod issues array — message must be a human-readable line.
    expect(typeof body.message).toBe("string");
    expect(body.message.startsWith("[")).toBe(false);
    expect(() => JSON.parse(body.message)).toThrow();
  });

  it("empty required string returns a non-empty hint", async () => {
    await startApp(
      configureDVM({
        name: "RequiredString",
        capability: "test",
        tag: "test",
        input: z.object({ text: z.string().min(1) }),
        onJob(ctx) {
          ctx.complete(ctx.input.text);
        },
      })
    );

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", data: { text: "" } })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_input");
    expect(body.hint).toMatch(/provide non-empty text/i);
    expect(body.message.startsWith("[")).toBe(false);
  });

  it("dispatches to onResponse handler (event-driven)", async () => {
    let responseText = "";
    await startApp(
      configureDVM({
        name: "EventDriven",
        capability: "test",
        tag: "test",
        state: { saved: "" },
        onJob(ctx) {
          ctx.state.saved = ctx.input as string;
          ctx.sendMessage("prompt", { id: "q1", text: "Hello?" });
        },
        onResponse(ctx, content) {
          responseText = content.text;
          ctx.complete(`got: ${content.text}`);
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "test" });
    const jobRes = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await jobRes.json();

    const msgBody = JSON.stringify({
      type: "response",
      content: { prompt_id: "q1", text: "world" },
    });
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);

    await new Promise((r) => {
      setTimeout(r, 50);
    });

    expect(responseText).toBe("world");
    const status = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await status.json()).status).toBe("completed");
  });

  it("handles multiple concurrent jobs independently", async () => {
    await startApp(
      configureDVM({
        name: "Multi",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete(`echo:${ctx.input as string}`);
        },
      })
    );

    const [res1, res2] = await Promise.all([
      postJson(`${baseUrl}/v1/job`, JSON.stringify({ capability: "test", input: "a" })),
      postJson(`${baseUrl}/v1/job`, JSON.stringify({ capability: "test", input: "b" })),
    ]);

    const { job_id: id1, job_token: t1 } = await res1.json();
    const { job_id: id2, job_token: t2 } = await res2.json();
    expect(id1).not.toBe(id2);

    const [s1, s2] = await Promise.all([
      fetch(`${baseUrl}/v1/job/${id1}`, { headers: tokenHeader(t1) }).then((r) => r.json()),
      fetch(`${baseUrl}/v1/job/${id2}`, { headers: tokenHeader(t2) }).then((r) => r.json()),
    ]);
    expect(s1.summary).toBe("echo:a");
    expect(s2.summary).toBe("echo:b");
  });

  it("calls onQuote handler with data", async () => {
    await startApp(
      configureDVM({
        name: "Quoter",
        capability: "test",
        tag: "test",
        price: "$0.001",
        onQuote: {
          schema: z.object({ words: z.number() }),
          async handler(ctx) {
            const words = (ctx.data as { words: number }).words;
            return {
              upfront: { amount: words * 0.001, currency: "usd" },
              description: `${String(words)} words`,
              shape: "fixed",
            };
          },
        },
        onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", data: { words: 500 } });
    const res = await postJson(`${baseUrl}/v1/quote`, body);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.upfront).toEqual({ amount: 0.5, amount_micro: 500_000, currency: "usd" });
    expect(data.description).toBe("500 words");
    expect(data.shape).toBe("fixed");
    expect(data.quote_id).toBeUndefined();
    expect(data.price_msats).toBeUndefined();
  });

  it("surfaces per-rail refundable flags on the dynamic-priced quote", async () => {
    await startApp(
      configureDVM({
        name: "Quoter",
        capability: "test",
        tag: "test",
        price: "$0.001",
        onQuote: {
          schema: z.object({ words: z.number() }),
          async handler() {
            return { upfront: { amount: 0.5, currency: "usd" }, description: "x", shape: "fixed" };
          },
        },
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      { paymentMethods: ["cashu", "x402", "tempo"] }
    );

    const body = JSON.stringify({ capability: "test", data: { words: 500 } });
    const res = await postJson(`${baseUrl}/v1/quote`, body);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.payment).toEqual({
      methods: ["cashu", "x402", "tempo"],
      refundable: { cashu: false, x402: false, tempo: false },
    });
  });

  it("surfaces per-rail refundable flags on the static-priced quote", async () => {
    await startApp(
      configureDVM({
        name: "StaticQuoter",
        capability: "test",
        tag: "test",
        price: "$0.001",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      { paymentMethods: ["cashu"] }
    );

    const res = await postJson(`${baseUrl}/v1/quote`, JSON.stringify({ capability: "test" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    // pins the accumulator fail-closed advertisement — Cashu refund on
    // failure is a no-op on the P2PK-accumulator rail, so it must advertise false.
    expect(data.payment).toEqual({ methods: ["cashu"], refundable: { cashu: false } });
  });

  it("rejects invalid quote data", async () => {
    await startApp(
      configureDVM({
        name: "StrictQuoter",
        capability: "test",
        tag: "test",
        onQuote: {
          schema: z.object({ words: z.number() }),
          async handler(ctx) {
            const words = (ctx.data as { words: number }).words;
            return {
              upfront: { amount: words * 0.001, currency: "usd" },
              description: `${String(words)} words`,
            };
          },
        },
        onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", data: { words: "not a number" } });
    const res = await postJson(`${baseUrl}/v1/quote`, body);
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error).toBe("invalid_quote_data");
    // humanised envelope (message + hint), no raw Zod `details` field.
    expect(typeof payload.message).toBe("string");
    expect(payload.message.startsWith("[")).toBe(false);
    expect(typeof payload.hint).toBe("string");
    expect(payload).not.toHaveProperty("details");
  });

  it("surfaces structured quote handler errors as 400 with display+hint", async () => {
    class StructuredErr extends Error {
      readonly code = "source_unreachable";
      readonly display = "Source URL returned 404";
      readonly hint = "verify the source is reachable and 2xx for HEAD";
    }
    await startApp(
      configureDVM({
        name: "ErroringQuoter",
        capability: "test",
        tag: "test",
        onQuote: {
          schema: z.object({ url: z.string() }),
          async handler() {
            throw new StructuredErr("source_unreachable: HEAD 404");
          },
        },
        onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );

    const body = JSON.stringify({
      capability: "test",
      data: { url: "https://example.com/missing.mp3" },
    });
    const res = await postJson(`${baseUrl}/v1/quote`, body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; display: string; hint: string } };
    expect(json.error.code).toBe("source_unreachable");
    expect(json.error.display).toBe("Source URL returned 404");
    expect(json.error.hint).toBe("verify the source is reachable and 2xx for HEAD");
  });

  it("surfaces structured errors via err.cause too", async () => {
    class StructuredCause extends Error {
      readonly code = "duration_exceeds_cap";
      readonly display = "Audio is 5h, cap is 4h";
      readonly hint = "split the input into chunks under MAX_INPUT_SECONDS";
    }
    await startApp(
      configureDVM({
        name: "WrappingQuoter",
        capability: "test",
        tag: "test",
        onQuote: {
          schema: z.object({ url: z.string() }),
          async handler() {
            throw new Error("wrapped", { cause: new StructuredCause("inner") });
          },
        },
        onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );

    const body = JSON.stringify({
      capability: "test",
      data: { url: "https://example.com/long.mp3" },
    });
    const res = await postJson(`${baseUrl}/v1/quote`, body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; display: string; hint: string } };
    expect(json.error.code).toBe("duration_exceeds_cap");
    expect(json.error.display).toBe("Audio is 5h, cap is 4h");
  });

  it("falls back to 500 for unstructured quote handler errors", async () => {
    await startApp(
      configureDVM({
        name: "PlainErrorQuoter",
        capability: "test",
        tag: "test",
        onQuote: {
          schema: z.object({ x: z.number() }),
          async handler() {
            throw new Error("kaboom");
          },
        },
        onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", data: { x: 1 } });
    const res = await postJson(`${baseUrl}/v1/quote`, body);
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("internal");
    expect(json.error.message).toBe("kaboom");
  });

  //
  // `fiatToSatsCeil` rounds any positive amount up to at least 1 sat, so a
  // quote below one micro-unit produces a real charge with no fiat amount the
  // ledger can draw. Refusing it here is what makes "every paid job carries a
  // denomination" total — the invariant `resolveLedgerContext` now throws on
  // rather than silently skipping the ledger. These pin the boundary in both
  // directions so a future weakening lands as a red test, not a 500 (or worse,
  // an unrecorded payment) on a money path.

  /** A DVM whose quote is whatever the test hands it. */
  function quoterReturning(amount: number) {
    return configureDVM({
      name: "MicroQuoter",
      capability: "test",
      tag: "test",
      input: z.object({ n: z.number() }),
      onQuote: {
        schema: z.object({ n: z.number() }),
        async handler() {
          return { upfront: { amount, currency: "usd" }, description: "micro" };
        },
      },
      onJob(ctx) {
        ctx.complete("should-not-run");
      },
    });
  }

  it("rejects a quote whose upfront is positive but below one micro-unit", async () => {
    await startApp(quoterReturning(0.0000004));

    const res = await postJson(
      `${baseUrl}/v1/quote`,
      JSON.stringify({ capability: "test", data: { n: 1 } })
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_quote_result");
    expect(json.error.message).toMatch(/below one micro-unit of usd/);
  });

  it("refuses the sub-micro quote at /v1/job instead of gating an undenominated price", async () => {
    await startApp(quoterReturning(0.0000004));

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: JSON.stringify({ n: 1 }) })
    );
    // Not a 402: the job never reaches the payment gate, so no caller can pay
    // a price the ledger would fail to record.
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("quote_failed");
    expect(json.message).toMatch(/below one micro-unit of usd/);
  });

  it("rejects an upfront too large to denominate in micro-units", async () => {
    await startApp(quoterReturning(1e12));

    const res = await postJson(
      `${baseUrl}/v1/quote`,
      JSON.stringify({ capability: "test", data: { n: 1 } })
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_quote_result");
    expect(json.error.message).toMatch(/too large to denominate/);
  });

  it("still accepts a zero upfront — the quote-free, charge-mid-job pattern", async () => {
    await startApp(quoterReturning(0));

    const res = await postJson(
      `${baseUrl}/v1/quote`,
      JSON.stringify({ capability: "test", data: { n: 1 } })
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { upfront: { amount: number; currency: string } };
    expect(data.upfront).toEqual({ amount: 0, currency: "usd" });
  });

  //
  // The credit ledger denominates per DVM: `POST /v1/credit` has no quote to
  // read a currency off, so it funds in the DVM's declared one. A quote priced
  // elsewhere would mint job credits at a denomination those top-ups never
  // reach — the caller's money would sit in a balance no job can draw. Refused
  // on both quote surfaces rather than converted; a builder's two declarations
  // disagreeing is a config error, not an exchange-rate problem.

  /** A DVM declaring `currency` while its handler quotes `quotedCurrency`. */
  function currencyQuoter(declared: string | undefined, quotedCurrency: string) {
    return configureDVM({
      name: "CurrencyQuoter",
      capability: "test",
      tag: "test",
      ...(declared ? { currency: declared } : {}),
      input: z.object({ n: z.number() }),
      onQuote: {
        schema: z.object({ n: z.number() }),
        async handler() {
          return { upfront: { amount: 0.5, currency: quotedCurrency }, description: "q" };
        },
      },
      onJob(ctx) {
        ctx.complete("should-not-run");
      },
    });
  }

  it("refuses a quote denominated outside the DVM's declared currency", async () => {
    await startApp(currencyQuoter("eur", "usd"), { fxFetcher: multiCurrencyFx });

    const res = await postJson(
      `${baseUrl}/v1/quote`,
      JSON.stringify({ capability: "test", data: { n: 1 } })
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("quote_currency_mismatch");
    expect(json.error.message).toMatch(/priced in usd but this DVM declares currency: "eur"/);
  });

  it("catches the mismatch on an undeclared (USD-defaulting) DVM too", async () => {
    // The legacy silent case: no `currency` on the config, a handler
    // quoting EUR, and `/v1/credit` funding USD behind it.
    await startApp(currencyQuoter(undefined, "eur"), { fxFetcher: multiCurrencyFx });

    const res = await postJson(
      `${baseUrl}/v1/quote`,
      JSON.stringify({ capability: "test", data: { n: 1 } })
    );
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("quote_currency_mismatch");
  });

  it("refuses the mismatch at /v1/job before the payment gate, not as a 402", async () => {
    await startApp(currencyQuoter("eur", "usd"), { fxFetcher: multiCurrencyFx });

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: JSON.stringify({ n: 1 }) })
    );
    // Not a 402 and not a 4xx: no price a caller could pay would make this
    // job's draw land in a denomination the DVM's own top-ups reach.
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("quote_currency_mismatch");
    expect(json.message).toMatch(/this DVM declares currency: "eur"/);
  });

  it("prices a non-USD DVM normally when the two agree", async () => {
    await startApp(currencyQuoter("eur", "eur"), { fxFetcher: multiCurrencyFx });

    const quote = await postJson(
      `${baseUrl}/v1/quote`,
      JSON.stringify({ capability: "test", data: { n: 1 } })
    );
    expect(quote.status).toBe(200);
    const quoted = (await quote.json()) as { upfront: { amount: number; currency: string } };
    expect(quoted.upfront).toEqual({ amount: 0.5, amount_micro: 500_000, currency: "eur" });

    // €0.50 at €90k/BTC → 556 sats (ceil) → 556_000 msats.
    const job = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: JSON.stringify({ n: 1 }) })
    );
    expect(job.status).toBe(402);
    const gated = (await job.json()) as { error: string; required_msats: number };
    expect(gated.error).toBe("payment_required");
    expect(gated.required_msats).toBe(556_000);
  });

  it("refuses at boot when the fx fetcher quotes no rate for the declared currency", async () => {
    // `configureDVM` validates the code's shape and stops — it has no fetcher
    // to consult. Unchecked, a typo'd or unbundled code boots clean and then
    // drops the credit block from every quote and answers every paid job with
    // a caller-blaming 400, for a defect only the builder can fix.
    await expect(
      createDVMServer(currencyQuoter("chf", "chf"), {
        env: { API_KEY: "test-key" },
        store: new MemoryKVStore(),
        fxFetcher: multiCurrencyFx,
      })
    ).rejects.toThrow(/prices in "chf".*only quotes \[usd, eur\]/);
  });

  it("answers a rate the source stopped carrying as a retryable 503, not a 400", async () => {
    // The boot preflight above passes — the fetcher advertises `eur` — and then
    // a body arrives without it. That is the rate source narrowing for a minute,
    // and it must reach the caller's agent on the same retryable envelope as any
    // other rate failure: a 400 `invalid_quote_result` tells them this DVM's own
    // quote is malformed and not to retry, over something no caller can fix and
    // that fixes itself.
    const narrowedFx: FxFetcher = {
      fetch: () =>
        Promise.resolve({
          rates: { usd: 100_000 },
          as_of: "2026-05-13T00:00:00Z",
          unavailable: ["eur"],
        }),
      supportedCurrencies: () => ["usd", "eur"],
    };
    await startApp(currencyQuoter("eur", "eur"), { fxFetcher: narrowedFx });

    // `/v1/quote` states the fiat price and never converts, so it is unaffected
    // the rate is only read where sats are derived.
    const job = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: JSON.stringify({ n: 1 }) })
    );
    expect(job.status).toBe(503);
    expect((await job.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "fx_rate_unavailable" },
    });
  });

  it("defaults to USD for a descriptor forced past the runtime boundary", async () => {
    // The CLI loader normalizes descriptor sketches through `configureDVM`, but
    // the server remains a public JavaScript boundary. Deleting the resolved
    // field reproduces a caller forcing an incomplete value past the type and
    // pins the retained defence-in-depth default. (Spread first because
    // `configureDVM` freezes what it returns.)
    const descriptor = { ...currencyQuoter(undefined, "usd") };
    delete (descriptor as { currency?: string }).currency;

    await startApp(descriptor, { fxFetcher: multiCurrencyFx });

    const res = await postJson(
      `${baseUrl}/v1/quote`,
      JSON.stringify({ capability: "test", data: { n: 1 } })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { upfront: { amount: number; currency: string } };
    expect(json.upfront).toEqual({ amount: 0.5, amount_micro: 500_000, currency: "usd" });
  });

  it("dynamic-priced DVM rejects /v1/job with no payment headers", async () => {
    let onJobRan = false;
    let quoteInvocations = 0;
    let receivedQuoteData: unknown;
    await startApp(
      configureDVM({
        name: "DynamicPriced",
        capability: "test",
        tag: "test",
        input: z.object({ size: z.number() }),
        onQuote: {
          schema: z.object({ size: z.number() }),
          async handler(ctx) {
            quoteInvocations++;
            receivedQuoteData = ctx.data;
            // $0.001 × size; at the stub rate ($100k/BTC) → size × 1000 msats
            const size = (ctx.data as { size: number }).size;
            return {
              upfront: { amount: size * 0.001, currency: "usd" },
              description: `${String(size)} units`,
            };
          },
        },
        onJob(ctx) {
          onJobRan = true;
          ctx.complete("should-not-run");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: JSON.stringify({ size: 50 }) });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toBe("payment_required");
    // 0.05 USD at $100k/BTC = 50 sats = 50_000 msats
    expect(json.required_msats).toBe(50_000);
    expect(onJobRan).toBe(false);
    expect(quoteInvocations).toBe(1);
    expect(receivedQuoteData).toEqual({ size: 50 });
  });

  it("dynamic-priced DVM surfaces quote_failed when onQuote.handler throws", async () => {
    await startApp(
      configureDVM({
        name: "ThrowingQuoter",
        capability: "test",
        tag: "test",
        input: z.object({ size: z.number() }),
        onQuote: {
          schema: z.object({ size: z.number() }),
          async handler() {
            throw new Error("audio host unreachable");
          },
        },
        onJob(ctx) {
          ctx.complete("should-not-run");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: JSON.stringify({ size: 1 }) });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("quote_failed");
    expect(json.message).toContain("audio host unreachable");
  });

  it("suppresses onCancel's own emits — the job is terminal before the hook runs", async () => {
    let cancelled = false;
    // The machine adopting a cancel another machine committed *cannot* let the
    // hook emit: the durable log is closed and its `job_messages` rows are
    // already swept. The local path is held to the same rule, so a builder who
    // emits from `onCancel` doesn't see it work in dev and silently vanish on a
    // multi-machine deploy. `ctx.complete()` here is the resurrection
    // bug arriving through the hook rather than through the handler.
    await startApp(
      configureDVM({
        name: "CancelHookEmits",
        capability: "test",
        tag: "test",
        async onJob(ctx) {
          await ctx.prompt("q1", "Wait...");
          ctx.complete("done");
        },
        onCancel(ctx) {
          ctx.text("released the lock");
          ctx.complete("resurrect");
          cancelled = true;
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();

    await fetch(`${baseUrl}/v1/job/${job_id}`, {
      method: "DELETE",
      headers: tokenHeader(job_token),
    });
    await vi.waitFor(() => expect(cancelled).toBe(true));

    const after = await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) });
    expect((await after.json()).status).toBe("cancelled");

    const msgs = await fetch(`${baseUrl}/v1/job/${job_id}/messages`, {
      headers: tokenHeader(job_token),
    });
    const { messages } = (await msgs.json()) as { messages: { type: string }[] };
    expect(messages.some((m) => m.type === "cancel")).toBe(true);
    expect(messages.some((m) => m.type === "text" || m.type === "complete")).toBe(false);
  });

  it("stays cancelled when a slow handler finishes after the DELETE", async () => {
    // Gates ensure DELETE commits before the still-running handler finishes.
    let sawAbort = false;
    const entered = gate();
    const release = gate();
    const finished = gate();
    await startApp(
      configureDVM({
        name: "SlowCancel",
        capability: "test",
        tag: "test",
        async onJob(ctx) {
          entered.resolve();
          await release.promise;
          sawAbort = ctx.signal.aborted;
          // A handler that ignores `ctx.signal` used to resurrect the job here.
          ctx.artifact({ data: "late", mime_type: "text/plain" });
          ctx.complete("resurrect");
          finished.resolve();
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();

    // The handler is provably running, so the DELETE takes the local
    // `activeJobs` branch against a non-terminal job.
    await entered.promise;
    const del = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      method: "DELETE",
      headers: tokenHeader(job_token),
    });
    expect(await del.json()).toMatchObject({ status: "cancelled" });

    // The DELETE response means the cancel is fully committed (the route awaits
    // `dispatchMessage`, which aborts the signal, goes terminal, and persists).
    // Only now does the handler get to run its tail — the late-write window.
    release.resolve();
    await finished.promise;
    expect(sawAbort).toBe(true);

    const after = await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) });
    const status = await after.json();
    expect(status.status).toBe("cancelled");
    expect(status.summary).toBeUndefined();

    // The message log is the layer the backstop can't repair, and so
    // the one that pins the context guard specifically: `adoptDurableTerminal`
    // re-reads `status`/`summary` from the durable row, but a resurrecting
    // handler's `artifact`/`complete` are already in `job.messages` by then.
    // Without this, reverting the guard alone leaves the case green.
    const msgs = await fetch(`${baseUrl}/v1/job/${job_id}/messages`, {
      headers: tokenHeader(job_token),
    });
    const { messages } = (await msgs.json()) as { messages: { type: string }[] };
    expect(messages.some((m) => m.type === "cancel")).toBe(true);
    expect(messages.some((m) => m.type === "artifact" || m.type === "complete")).toBe(false);
  });

  it("dispatches to onPayment handler", async () => {
    let paymentReceived = false;
    await startApp(
      configureDVM({
        name: "PayHandler",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.sendMessage("payment-request", { amount_msats: 1000, reason: "fee" });
        },
        onPayment(_ctx, content) {
          paymentReceived = true;
          _ctx.complete(`paid ${String(content.amount_msats)}`);
        },
      }),
      { devMode: true } // dev mode auto-credits payments so the test can focus on dispatch
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const jobRes = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await jobRes.json();

    const msgBody = JSON.stringify({
      type: "payment",
      content: { cashu_token: "fake-token", amount_msats: 1000 },
    });
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);

    await new Promise((r) => {
      setTimeout(r, 50);
    });
    expect(paymentReceived).toBe(true);
  });

  it("dispatches unknown message types to onMessage", async () => {
    let caughtType = "";
    await startApp(
      configureDVM({
        name: "CatchAll",
        capability: "test",
        tag: "test",
        async onJob(ctx) {
          await ctx.prompt("q1", "Wait...");
          ctx.complete("done");
        },
        onMessage(_ctx, msg) {
          caughtType = msg.type;
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const jobRes = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await jobRes.json();

    const msgBody = JSON.stringify({ type: "approval", content: { comment: "ok" } });
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);

    await new Promise((r) => {
      setTimeout(r, 50);
    });
    expect(caughtType).toBe("approval");
  });

  it("rejects DELETE on completed jobs with 409", async () => {
    await startApp(
      configureDVM({
        name: "Done",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("finished");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();

    const delRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      method: "DELETE",
      headers: tokenHeader(job_token),
    });
    expect(delRes.status).toBe(409);
  });

  it("rejects response message without prompt_id", async () => {
    await startApp(
      configureDVM({
        name: "Prompt",
        capability: "test",
        tag: "test",
        async onJob(ctx) {
          await ctx.prompt("q1", "Wait...");
          ctx.complete("done");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();

    const msgBody = JSON.stringify({ type: "response", content: { text: "answer" } });
    const msgRes = await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);
    expect(msgRes.status).toBe(400);
    expect((await msgRes.json()).error).toBe("invalid_message");
  });

  it("streams messages via SSE until yield", async () => {
    await startApp(
      configureDVM({
        name: "Streamer",
        capability: "test",
        tag: "test",
        async onJob(ctx) {
          ctx.text("step 1");
          ctx.text("step 2");
          const resp = await ctx.prompt("q1", "Pick one", { options: ["A", "B"] });
          ctx.complete(resp.text);
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const jobRes = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await jobRes.json();

    // Connect SSE
    const sseUrl = `${baseUrl}/v1/job/${job_id}/messages`;
    const sseRes = await fetch(sseUrl, {
      headers: { Accept: "text/event-stream", ...tokenHeader(job_token) },
    });
    expect(sseRes.status).toBe(200);

    const text = await sseRes.text();
    const events = text
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("event:"))
      .map((chunk) => {
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        return dataLine ? (JSON.parse(dataLine.slice(5)) as { type: string }) : null;
      })
      .filter(Boolean);

    const types = events.map((e) => e?.type);
    expect(types).toContain("text");
    expect(types).toContain("prompt");
    // SSE should close after the prompt (a yield message)
    expect(types[types.length - 1]).toBe("prompt");
  });

  it("anonymous create issues a job_token; wrong-token reads return 404, credential-less reads 401", async () => {
    await startApp(
      configureDVM({
        name: "Owned",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.text("secret transcript");
          ctx.complete("done");
        },
      })
    );

    // Caller A submits and captures the token.
    const submit = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id, job_token } = await submit.json();
    expect(typeof job_token).toBe("string");
    expect(job_token.length).toBe(64); // 32 bytes hex

    // Caller B (no token at all) is locked out of every /v1/job/:id/*
    // endpoint — 401 with actionable copy, not the opaque 404. The
    // answer doesn't depend on the job existing (asserted below), so this
    // costs the anti-oracle property nothing.
    const noTokenStatus = await fetch(`${baseUrl}/v1/job/${job_id}`);
    expect(noTokenStatus.status).toBe(401);
    const noTokenBody = await noTokenStatus.json();
    expect(noTokenBody.error).toBe("job_credential_required");
    expect(noTokenBody.hint).toContain("X-Job-Token");
    expect(noTokenBody.hint).toContain("by a caller that never stored it");
    expect(noTokenBody.hint).toContain("If your caller never sends X-Job-Token");
    expect(noTokenBody.hint).toContain("--endpoint <url>");
    expect(noTokenBody.hint).toContain("--job-token <hex>");
    expect(noTokenBody.hint).toContain("DVM_JOB_ENDPOINT");
    expect(noTokenBody.hint).toContain("DVM_JOB_TOKEN");
    expect(noTokenBody.hint).toContain("npm i -g @dvmkit/dvm-cli@latest");
    expect(noTokenBody.hint).not.toContain("client");
    expect(typeof noTokenBody.display).toBe("string");
    // The SDK's auth middleware pins `requesterId` to anonymous, so a Bearer
    // header is not a job credential here — it must not be offered as an
    // alternative, and a client that sends one still gets the 401.
    expect(noTokenBody.message).not.toContain("Bearer");
    expect(noTokenBody.hint).not.toContain("Bearer");
    const bearerOnly = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: { Authorization: "Bearer some-caller-token" },
    });
    expect(bearerOnly.status).toBe(401);
    expect(await bearerOnly.json()).toEqual(noTokenBody);
    const noTokenMsgs = await fetch(`${baseUrl}/v1/job/${job_id}/messages`);
    expect(noTokenMsgs.status).toBe(401);
    const noTokenMsgsBody = await noTokenMsgs.json();
    expect(noTokenMsgsBody.error).toBe("job_credential_required");
    const noTokenPost = await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({ type: "text", content: { text: "hi" } })
    );
    expect(noTokenPost.status).toBe(401);
    const noTokenPostBody = await noTokenPost.json();
    expect(noTokenPostBody).toEqual(noTokenBody);
    const noTokenDel = await fetch(`${baseUrl}/v1/job/${job_id}`, { method: "DELETE" });
    expect(noTokenDel.status).toBe(401);
    expect(noTokenMsgsBody).toEqual(noTokenBody);
    expect(await noTokenDel.json()).toEqual(noTokenBody);

    // The 401 is decided before any lookup, so a job id that was never issued
    // answers identically — no existence oracle for a credential-less prober.
    const unknownJob = await fetch(`${baseUrl}/v1/job/does-not-exist`);
    expect(unknownJob.status).toBe(401);
    expect(await unknownJob.json()).toEqual(noTokenBody);

    // Wrong token is also locked out — proves the gate hashes and compares,
    // not just checks presence.
    const wrongTokenMsgs = await fetch(`${baseUrl}/v1/job/${job_id}/messages`, {
      headers: tokenHeader("0".repeat(64)),
    });
    expect(wrongTokenMsgs.status).toBe(404);
    expect(await wrongTokenMsgs.json()).toEqual({ error: "Job not found" });
    // …and it stays indistinguishable from a job id that doesn't exist.
    const wrongTokenUnknown = await fetch(`${baseUrl}/v1/job/does-not-exist/messages`, {
      headers: tokenHeader("0".repeat(64)),
    });
    expect(wrongTokenUnknown.status).toBe(404);

    // Owner with the right token sees the transcript and status.
    const ownerStatus = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect(ownerStatus.status).toBe(200);
    expect((await ownerStatus.json()).status).toBe("completed");
    const ownerMsgs = await fetch(`${baseUrl}/v1/job/${job_id}/messages`, {
      headers: tokenHeader(job_token),
    });
    expect(ownerMsgs.status).toBe(200);
    const { messages } = await ownerMsgs.json();
    expect(messages.find((m: { type: string }) => m.type === "text").content.text).toBe(
      "secret transcript"
    );
  });

  it("anonymous caller A's job_token cannot access anonymous caller B's job", async () => {
    await startApp(
      configureDVM({
        name: "Owned",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.text("secret transcript");
          ctx.complete("done");
        },
      })
    );

    // Two anonymous callers each submit a job and capture their own token.
    const submitA = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id: idA, job_token: tokenA } = await submitA.json();
    const submitB = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id: idB, job_token: tokenB } = await submitB.json();
    expect(typeof tokenA).toBe("string");
    expect(typeof tokenB).toBe("string");
    expect(tokenA).not.toBe(tokenB);

    // Caller A presents tokenA against B's endpoints — all 404.
    const aOnBStatus = await fetch(`${baseUrl}/v1/job/${idB}`, { headers: tokenHeader(tokenA) });
    expect(aOnBStatus.status).toBe(404);
    const aOnBMsgs = await fetch(`${baseUrl}/v1/job/${idB}/messages`, {
      headers: tokenHeader(tokenA),
    });
    expect(aOnBMsgs.status).toBe(404);
    const aOnBPost = await postJson(
      `${baseUrl}/v1/job/${idB}/messages`,
      JSON.stringify({ type: "text", content: { text: "hijack" } }),
      tokenA
    );
    expect(aOnBPost.status).toBe(404);
    const aOnBDel = await fetch(`${baseUrl}/v1/job/${idB}`, {
      method: "DELETE",
      headers: tokenHeader(tokenA),
    });
    expect(aOnBDel.status).toBe(404);

    // Sanity: each caller's own token still works.
    const ownA = await fetch(`${baseUrl}/v1/job/${idA}`, { headers: tokenHeader(tokenA) });
    expect(ownA.status).toBe(200);
    const ownB = await fetch(`${baseUrl}/v1/job/${idB}`, { headers: tokenHeader(tokenB) });
    expect(ownB.status).toBe(200);
  });
});
