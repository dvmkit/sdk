import { afterEach, describe, expect, it, vi } from "vitest";

import { MintHealthTracker } from "../mint-health-tracker";

const VALID_INFO = {
  pubkey: "02abc",
  version: "Nutshell/0.20.0",
  nuts: {
    "1": {},
    "4": { methods: [{ method: "bolt11", unit: "sat" }] },
    "5": { methods: [{ method: "bolt11", unit: "sat" }] },
    "7": { supported: true },
    "9": { supported: true },
    "10": { supported: true },
    "11": { supported: true },
    "20": { supported: true }
  }
};

const MINT_A = "https://test-mint-a.example.com";
const MINT_B = "https://test-mint-b.example.com";

/** Preserve three probe attempts while removing backoff delays from tick assertions. */
const NO_BACKOFF = { backoffMs: [0] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function buildFetch(behavior: Record<string, () => Promise<Response>>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === "string" ? input : String(input);
    for (const [prefix, handler] of Object.entries(behavior)) {
      if (url.startsWith(prefix)) return handler();
    }
    return new Response("not stubbed", { status: 599 });
  }) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("MintHealthTracker", () => {
  it("uses supplied environment defaults instead of ambient mint-health settings", async () => {
    vi.stubEnv("DVMKIT_MINT_HEALTH_TICK_MS", "10000");
    vi.stubEnv("DVMKIT_MINT_FAILURES_TO_SICK", "3");
    const fetchImpl = buildFetch({
      [MINT_A]: async () => new Response("nope", { status: 503 })
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A],
      env: {
        DVMKIT_MINT_HEALTH_TICK_MS: "1000",
        DVMKIT_MINT_FAILURES_TO_SICK: "1"
      },
      fetchImpl,
      probe: NO_BACKOFF
    });
    vi.useFakeTimers();
    try {
      tracker.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(tracker.isHealthy(MINT_A)).toBe(false);
      expect(tracker.snapshot()[MINT_A].consecutiveFailures).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      // The failed probe's two zero-delay retry timers must also complete.
      await vi.advanceTimersByTimeAsync(2);
      expect(tracker.snapshot()[MINT_A].consecutiveFailures).toBe(2);
    } finally {
      tracker.stop();
      vi.useRealTimers();
    }
  });

  it("keeps explicit mint-health options ahead of supplied environment defaults", async () => {
    const fetchImpl = buildFetch({
      [MINT_A]: async () => new Response("nope", { status: 503 })
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A],
      env: { DVMKIT_MINT_FAILURES_TO_SICK: "1" },
      consecutiveFailuresToSick: 2,
      fetchImpl,
      probe: NO_BACKOFF
    });
    await tracker.runOnce();
    expect(tracker.isHealthy(MINT_A)).toBe(true);
    await tracker.runOnce();
    expect(tracker.isHealthy(MINT_A)).toBe(false);
  });

  it("starts healthy and stays healthy on a clean probe", async () => {
    const fetchImpl = buildFetch({
      [MINT_A]: async () => jsonResponse(VALID_INFO)
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A],
      fetchImpl,
      probe: NO_BACKOFF,
      consecutiveFailuresToSick: 3
    });
    expect(tracker.initialProbeComplete()).toBe(false);
    await tracker.runOnce();
    expect(tracker.initialProbeComplete()).toBe(true);
    await tracker.runOnce();
    expect(tracker.initialProbeComplete()).toBe(true);
    expect(tracker.isHealthy(MINT_A)).toBe(true);
    expect(tracker.healthyMints()).toEqual([MINT_A]);
    expect(tracker.snapshot()[MINT_A]).toMatchObject({
      sick: false,
      consecutiveFailures: 0,
      version: "Nutshell/0.20.0"
    });
  });

  it("flips sick once consecutive failures cross the threshold and emits one transition log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchImpl = buildFetch({
      [MINT_A]: async () => new Response("nope", { status: 503 })
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A],
      fetchImpl,
      probe: NO_BACKOFF,
      consecutiveFailuresToSick: 3
    });
    await tracker.runOnce();
    await tracker.runOnce();
    expect(tracker.isHealthy(MINT_A)).toBe(true);
    expect(tracker.snapshot()[MINT_A]).toMatchObject({
      sick: false,
      consecutiveFailures: 2
    });
    await tracker.runOnce();
    expect(tracker.isHealthy(MINT_A)).toBe(false);
    expect(tracker.healthyMints()).toEqual([]);

    const sickLines = log.mock.calls
      .flat()
      .map(String)
      .filter((c) => c.includes("cashu_mint_runtime_sick"));
    expect(sickLines).toHaveLength(1);
    expect(sickLines[0]).not.toContain(MINT_A);

    await tracker.runOnce();
    const sickLinesAfter = log.mock.calls
      .flat()
      .map(String)
      .filter((c) => c.includes("cashu_mint_runtime_sick"));
    expect(sickLinesAfter).toHaveLength(1);
  });

  it("recovers on a single success after sick and emits a recovery log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let healthy = false;
    const fetchImpl = buildFetch({
      [MINT_A]: async () => (healthy ? jsonResponse(VALID_INFO) : new Response("nope", { status: 503 }))
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A],
      fetchImpl,
      probe: NO_BACKOFF,
      consecutiveFailuresToSick: 2
    });
    await tracker.runOnce();
    await tracker.runOnce();
    expect(tracker.isHealthy(MINT_A)).toBe(false);

    healthy = true;
    await tracker.runOnce();

    expect(tracker.isHealthy(MINT_A)).toBe(true);
    expect(tracker.snapshot()[MINT_A]).toMatchObject({
      sick: false,
      consecutiveFailures: 0
    });
    const recoveryLines = log.mock.calls
      .flat()
      .map(String)
      .filter((c) => c.includes("cashu_mint_runtime_recovered"));
    expect(recoveryLines).toHaveLength(1);
    expect(recoveryLines.join("\n")).not.toContain(MINT_A);
  });

  it("tracks mints independently — one sick, one healthy", async () => {
    const fetchImpl = buildFetch({
      [MINT_A]: async () => new Response("nope", { status: 503 }),
      [MINT_B]: async () => jsonResponse(VALID_INFO)
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A, MINT_B],
      fetchImpl,
      probe: NO_BACKOFF,
      consecutiveFailuresToSick: 2
    });
    await tracker.runOnce();
    await tracker.runOnce();
    expect(tracker.isHealthy(MINT_A)).toBe(false);
    expect(tracker.isHealthy(MINT_B)).toBe(true);
    expect(tracker.healthyMints()).toEqual([MINT_B]);
  });

  it("treats unknown mints as healthy (defensive default)", async () => {
    const tracker = new MintHealthTracker({ mints: [MINT_A] });
    expect(tracker.isHealthy("https://other.example.com")).toBe(true);
  });

  it("matches isHealthy across trailing-slash and case drift on the lookup URL", async () => {
    // Configured URL has no trailing slash; the token's `meta.mint` might carry
    // one (or differ in host case) — the tracker must still hit the same row.
    const configured = "https://test-mint-a.example.com";
    const fetchImpl = buildFetch({
      [configured]: async () => new Response("nope", { status: 503 })
    });
    const tracker = new MintHealthTracker({
      mints: [configured],
      fetchImpl,
      probe: NO_BACKOFF,
      consecutiveFailuresToSick: 2
    });
    await tracker.runOnce();
    await tracker.runOnce();
    expect(tracker.isHealthy(configured)).toBe(false);
    expect(tracker.isHealthy(`${configured}/`)).toBe(false);
    expect(tracker.isHealthy("https://TEST-MINT-A.example.com")).toBe(false);
  });

  it("flips a reachable-but-NUT-incompatible mint sick on the first probe", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const infoMissingNut11 = {
      ...VALID_INFO,
      nuts: { ...VALID_INFO.nuts, "11": { supported: false } }
    };
    const fetchImpl = buildFetch({
      [MINT_A]: async () => jsonResponse(infoMissingNut11)
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A],
      fetchImpl,
      probe: NO_BACKOFF,
      consecutiveFailuresToSick: 3
    });
    await tracker.runOnce();
    expect(tracker.isHealthy(MINT_A)).toBe(false);
    expect(tracker.healthyMints()).toEqual([]);
    expect(tracker.snapshot()[MINT_A]).toMatchObject({
      sick: true,
      nutIncompatible: true,
      errorCode: "nut_support_missing"
    });
    const nutLines = log.mock.calls
      .flat()
      .map(String)
      .filter((c) => c.includes("cashu_mint_nut_incompatible"));
    expect(nutLines).toHaveLength(1);
    expect(nutLines[0]).not.toContain(MINT_A);
  });

  it("misses NUT-4 bolt11/sat method → NUT-incompatible even though the NUT dict entry exists", async () => {
    const infoNoBolt11 = {
      ...VALID_INFO,
      nuts: {
        ...VALID_INFO.nuts,
        "4": { methods: [{ method: "bolt12", unit: "sat" }] }
      }
    };
    const fetchImpl = buildFetch({
      [MINT_A]: async () => jsonResponse(infoNoBolt11)
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A],
      fetchImpl,
      probe: NO_BACKOFF
    });
    await tracker.runOnce();
    expect(tracker.isHealthy(MINT_A)).toBe(false);
    expect(tracker.snapshot()[MINT_A]).toMatchObject({ nutIncompatible: true });
  });

  it("emits a one-shot cashu_mint_boot_health summary after the first probe, warning when all unhealthy", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchImpl = buildFetch({
      [MINT_A]: async () => new Response("nope", { status: 503 })
    });
    const tracker = new MintHealthTracker({
      mints: [MINT_A],
      fetchImpl,
      probe: NO_BACKOFF
    });
    await tracker.runOnce();
    await tracker.runOnce();

    const bootLines = log.mock.calls
      .flat()
      .map(String)
      .filter((c) => c.includes("cashu_mint_boot_health"));
    expect(bootLines).toHaveLength(1);
    const parsed = JSON.parse(bootLines[0]) as Record<string, unknown>;
    expect(parsed.level).toBe("warn");
    expect(parsed).toEqual({ event: "cashu_mint_boot_health", level: "warn" });
  });

  it("respects the tick interval and runs an immediate probe on start()", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        buildFetch({
          [MINT_A]: async () => jsonResponse(VALID_INFO)
        })
      );
      const tracker = new MintHealthTracker({
        mints: [MINT_A],
        fetchImpl,
        tickIntervalMs: 10_000,
        consecutiveFailuresToSick: 3
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      tracker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(tracker.snapshot()[MINT_A]).toMatchObject({ sick: false });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      tracker.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
