import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../sdk/index";
import { serve } from "../server/serve";

const VALID_INFO = {
  pubkey: "02abc",
  version: "Nutshell/0.20.0",
  nuts: {
    "1": {},
    "2": {},
    "3": {},
    "4": { methods: [{ method: "bolt11", unit: "sat" }] },
    "5": { methods: [{ method: "bolt11", unit: "sat" }] },
    "7": { supported: true },
    "9": { supported: true },
    "10": { supported: true },
    "11": { supported: true },
    "13": { supported: true },
    "20": { supported: true },
    "23": { supported: true }
  }
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const dvm = configureDVM({
  name: "Startup Health Test",
  capability: "test",
  price: "$0.10",
  async onJob(ctx) {
    ctx.complete("done");
  }
});

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (closers.length) {
    const close = closers.pop();
    if (close) await close();
  }
  vi.unstubAllGlobals();
});

/**
 * Replace global fetch only for outbound mint probes. Keeps the test's own
 * `fetch(${handle.url}/v1/info)` calls flowing through real fetch so the
 * running DVM under test can answer normally.
 */
function stubMintFetch(behavior: (url: string) => Promise<Response>): void {
  const realFetch = fetch;
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    if (url.startsWith("http://127.0.0.1:3338")) return behavior(url);
    return realFetch(input as Parameters<typeof fetch>[0], init);
  });
}

describe("serve() rejects BUILDER_LOCK_PRIVKEY", () => {
  it("throws at boot when BUILDER_LOCK_PRIVKEY is set", async () => {
    // No fetch stub — the throw happens before any mint probe runs.
    await expect(
      serve(dvm, {
        port: 0,
        env: { BUILDER_LOCK_PRIVKEY: "deadbeef" },
        devMode: true
      })
    ).rejects.toThrow(/BUILDER_LOCK_PRIVKEY must not be set/);
  });
});

describe("serve() binds the port regardless of mint health", () => {
  it("starts when at least one mint passes /v1/info", async () => {
    stubMintFetch(async (url) => {
      if (url.endsWith("/good/v1/info")) return jsonResponse(VALID_INFO);
      return new Response("nope", { status: 503 });
    });

    const handle = await serve(dvm, {
      port: 0,
      env: {},
      mints: ["http://127.0.0.1:3338/good", "http://127.0.0.1:3338/bad"],
      devMode: true
    });
    closers.push(handle.close);

    const res = await fetch(`${handle.url}/v1/info`);
    expect(res.status).toBe(200);
  });

  it("still binds the port when every configured mint is unreachable", async () => {
    stubMintFetch(async () => new Response("nope", { status: 503 }));

    const handle = await serve(dvm, {
      port: 0,
      env: {},
      mints: ["http://127.0.0.1:3338/bad-1", "http://127.0.0.1:3338/bad-2"],
      devMode: true
    });
    closers.push(handle.close);

    const res = await fetch(`${handle.url}/v1/info`);
    expect(res.status).toBe(200);
  });

  it("still binds the port when a reachable mint is missing required NUTs", async () => {
    const infoMissingNut11 = {
      ...VALID_INFO,
      nuts: { ...VALID_INFO.nuts, "11": { supported: false } }
    };
    stubMintFetch(
      async () =>
        new Response(JSON.stringify(infoMissingNut11), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    );

    const handle = await serve(dvm, {
      port: 0,
      env: {},
      mints: ["http://127.0.0.1:3338/no-p2pk"],
      devMode: true
    });
    closers.push(handle.close);

    const res = await fetch(`${handle.url}/v1/info`);
    expect(res.status).toBe(200);
  });

  it("skips the check when no mints are configured (handles advertising honesty)", async () => {
    const mintProbes: string[] = [];
    stubMintFetch(async (url) => {
      mintProbes.push(url);
      return jsonResponse(VALID_INFO);
    });

    const handle = await serve(dvm, {
      port: 0,
      env: {},
      mints: [],
      devMode: true
    });
    closers.push(handle.close);

    const res = await fetch(`${handle.url}/v1/info`);
    expect(res.status).toBe(200);
    const info = (await res.json()) as Record<string, unknown>;
    // Empty mints array is truthy in app.ts, so `mints: []` is echoed back —
    // what matters here is that "cashu" isn't advertised and that
    // we never probed an external mint URL during startup.
    expect((info.payment as { methods?: string[] } | undefined)?.methods).toEqual([]);
    expect(mintProbes).toEqual([]);
  });
});

describe("serve() Cashu mode auto-default", () => {
  async function expectAccumulatorDefaultLogged(env: Record<string, string>): Promise<void> {
    const logCalls: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(" "));
    };

    try {
      // Accumulator setup will fail (no DB/recovery keys) and drop cashu, but
      // the auto-default log fires before that check.
      const handle = await serve(dvm, { port: 0, env, devMode: true });
      closers.push(handle.close);
    } finally {
      console.log = originalLog;
    }

    expect(logCalls).toContain('{"event":"diagnostic.message","level":"info"}');
    expect(logCalls.join("\n")).not.toContain("127.0.0.1:3338");
  }

  it("defaults to p2pk-accumulator and logs it when DVMKIT_CASHU_MINTS env var is set", async () => {
    await expectAccumulatorDefaultLogged({ DVMKIT_CASHU_MINTS: "http://127.0.0.1:3338" });
  });

  it("does not enable Cashu when DVMKIT_CASHU_MINTS is not set", async () => {
    const handle = await serve(dvm, {
      port: 0,
      env: {},
      devMode: true
    });
    closers.push(handle.close);

    const res = await fetch(`${handle.url}/v1/info`);
    const info = (await res.json()) as Record<string, unknown>;
    expect((info.payment as { methods?: string[] } | undefined)?.methods).toEqual([]);
  });
});
