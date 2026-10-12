/**
 * The direction of failure is the point. `lightning-rail-health.ts` fails
 * **open** — an outage there costs a sale, so the rail stays advertised. This
 * one fails **closed**: accepting a session channel nobody is watching is how
 * a caller takes service for free. `tempo/charge` must survive either way.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createPlatformTempoObserverHealth,
  PlatformTempoObserverHealth,
  TEMPO_OBSERVER_HEALTH_MAX_CURSOR_AGE_MS,
  TEMPO_OBSERVER_HEALTH_MAX_STALENESS_MS,
} from "../tempo-observer-health";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function health(args: { body?: unknown; status?: number; reject?: boolean; now?: () => number }) {
  const fetchFn = vi.fn(() =>
    args.reject
      ? Promise.reject(new Error("unreachable"))
      : Promise.resolve(jsonResponse(args.body ?? {}, args.status ?? 200))
  ) as unknown as typeof fetch;
  return {
    fetchFn,
    instance: new PlatformTempoObserverHealth({
      url: "https://platform.test/_internal/tempo-observer-health",
      token: "dvm-token",
      fetchFn,
      ...(args.now ? { now: args.now } : {}),
    }),
  };
}

describe("PlatformTempoObserverHealth", () => {

  it("treats a platform watching no escrows yet as healthy", async () => {
    // The observer derives its watch set from channel registrations, so before
    // the first channel there is nothing to watch — and its cold-start lookback
    // covers the blocks between opening a channel and the first scan. Calling
    // this stale would mean no DVM could ever open its first session.
    const now = 10_000_000;
    const { instance } = health({
      body: { observing: 0, oldest_cursor_advanced_at_ms: null, observed_at_ms: now },
      now: () => now,
    });

    await instance.refresh();

    expect(instance.available()).toBe(true);
  });

  it("withholds sessions when the observer's cursor has gone stale", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const now = 10_000_000;
    const { instance } = health({
      body: {
        observing: 1,
        oldest_cursor_advanced_at_ms: now - TEMPO_OBSERVER_HEALTH_MAX_CURSOR_AGE_MS - 1,
        observed_at_ms: now,
      },
      now: () => now,
    });

    await instance.refresh();

    expect(instance.available()).toBe(false);
    vi.restoreAllMocks();
  });

  it("tolerates a brief platform outage, then withholds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let clock = 10_000_000;
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ observing: 1, oldest_cursor_advanced_at_ms: clock, observed_at_ms: clock })
      )
    ) as unknown as typeof fetch;
    const instance = new PlatformTempoObserverHealth({
      url: "https://platform.test/_internal/tempo-observer-health",
      fetchFn,
      now: () => clock,
    });
    await instance.refresh();
    expect(instance.available()).toBe(true);

    // The platform goes away. A single failed poll must not drop the offer…
    (fetchFn as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.reject(new Error("unreachable"))
    );
    clock += 60_001;
    await instance.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(instance.available()).toBe(true);

    // …but past the ceiling we can no longer tell a blip from a dead observer.
    clock += TEMPO_OBSERVER_HEALTH_MAX_STALENESS_MS;
    expect(instance.available()).toBe(false);
    vi.restoreAllMocks();
  });

  it("ignores a non-200 and a malformed body rather than trusting them", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notOk = health({ status: 503, body: {} });
    await notOk.instance.refresh();
    expect(notOk.instance.available()).toBe(false);

    const malformed = health({ body: { observed_at_ms: "soon" } });
    await malformed.instance.refresh();
    expect(malformed.instance.available()).toBe(false);
    vi.restoreAllMocks();
  });

  it("presents the DVM's own bearer token", async () => {
    const { instance, fetchFn } = health({
      body: { observing: 0, oldest_cursor_advanced_at_ms: null, observed_at_ms: Date.now() },
    });

    await instance.refresh();

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers.Authorization).toBe("Bearer dvm-token");
  });

  it("logs the withholding once, not on every menu render", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { instance } = health({});

    expect(instance.available()).toBe(false);
    expect(instance.available()).toBe(false);
    expect(instance.available()).toBe(false);

    expect(
      warn.mock.calls.filter(([l]) => String(l).includes("tempo_session_withheld"))
    ).toHaveLength(1);
    warn.mockRestore();
  });
});

describe("ensureFresh", () => {
  it("waits out one probe on a cold start, so the first menu is not answered from nothing", async () => {
    // The gate is fail-closed and `available()` is synchronous, so without this
    // the first request after a boot — which on a scale-to-zero DVM is the
    // request that decides the funding path — would withhold sessions purely
    // because the probe had not returned yet.
    const now = 10_000_000;
    const { instance } = health({
      body: { observing: 1, oldest_cursor_advanced_at_ms: now - 1_000, observed_at_ms: now },
      now: () => now,
    });

    await instance.ensureFresh();

    expect(instance.available()).toBe(true);
  });

  it("waits again once the cached observation has aged past the ceiling", async () => {
    // A resume from a long suspend is the same shape as a cold start: the cache
    // is there but too old to be authoritative.
    let clock = 10_000_000;
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ observing: 1, oldest_cursor_advanced_at_ms: clock, observed_at_ms: clock })
      )
    ) as unknown as typeof fetch;
    const calls = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const instance = new PlatformTempoObserverHealth({
      url: "https://platform.test/_internal/tempo-observer-health",
      fetchFn,
      now: () => clock,
    });
    await instance.ensureFresh();
    expect(calls.mock.calls).toHaveLength(1);

    clock += TEMPO_OBSERVER_HEALTH_MAX_STALENESS_MS;
    await instance.ensureFresh();

    expect(calls.mock.calls).toHaveLength(2);
    expect(instance.available()).toBe(true);
  });

  it("costs nothing on the hot path while an observation is usable", async () => {
    let clock = 10_000_000;
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ observing: 1, oldest_cursor_advanced_at_ms: clock, observed_at_ms: clock })
      )
    ) as unknown as typeof fetch;
    const calls = fetchFn as unknown as ReturnType<typeof vi.fn>;
    const instance = new PlatformTempoObserverHealth({
      url: "https://platform.test/_internal/tempo-observer-health",
      fetchFn,
      now: () => clock,
    });
    await instance.ensureFresh();

    clock += 1_000;
    await instance.ensureFresh();
    await instance.ensureFresh();

    expect(calls.mock.calls).toHaveLength(1);
  });

  it("still withholds when the platform is unreachable on a cold start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { instance } = health({ reject: true });

    await instance.ensureFresh();

    expect(instance.available()).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("declareSessionCapability", () => {
  /** The probe URL of the nth fetch this instance made. */
  function probedUrl(fetchFn: typeof fetch, index = 0): string {
    return String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[index][0]);
  }

  it("reports capability while the gate is withholding availability", async () => {
    // The whole point, and the failure if it were ever otherwise: a
    // fail-closed blip must not de-stamp the DVM out of the payee fallback,
    // where it is the only thing standing between a caller and a free
    // withdrawal on that DVM's first channel.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { instance, fetchFn } = health({ reject: true });
    instance.declareSessionCapability(() => true);

    await instance.refresh();

    expect(instance.available()).toBe(false);
    expect(probedUrl(fetchFn)).toContain("tempo_session=1");
    vi.restoreAllMocks();
  });

  it("sends no signal at all when no mount has declared one", async () => {
    // A container on an older SDK build. Silence is not a retraction — the
    // platform must leave the deploy probe's stamp exactly where it is.
    const { instance, fetchFn } = health({});

    await instance.refresh();

    expect(probedUrl(fetchFn)).toBe("https://platform.test/_internal/tempo-observer-health");
  });

  /**
   * A client whose probes stay open until released, so a declaration can land
   * mid-probe — which is the ordinary boot ordering, not an edge case.
   */
  function stalled() {
    const pending: (() => void)[] = [];
    let open = false;
    const body = () =>
      jsonResponse({
        observing: 0,
        oldest_cursor_advanced_at_ms: null,
        observed_at_ms: 10_000_000,
      });
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          if (open) resolve(body());
          else pending.push(() => resolve(body()));
        })
    ) as unknown as typeof fetch;
    return {
      fetchFn,
      /** Open the gate for every probe, in flight and future. */
      release: () => {
        open = true;
        for (const resolve of pending.splice(0)) resolve();
      },
      instance: new PlatformTempoObserverHealth({
        url: "https://platform.test/_internal/tempo-observer-health",
        fetchFn,
        now: () => 10_000_000,
      }),
    };
  }

  it("re-probes when a mount declares during the boot probe", async () => {
    // `host.ts` primes the client before any mount exists, so the probe already
    // in flight carries nothing. Handing it back would leave a DVM that just
    // restarted to pick up `DVMKIT_TEMPO_METHODS` unstamped until traffic
    // arrived — and polls are traffic-driven, so on a scale-to-zero DVM that
    // can be hours.
    const { instance, fetchFn, release } = stalled();
    const boot = instance.refresh();

    instance.declareSessionCapability(() => true);
    const declared = instance.refresh();
    release();
    await Promise.all([boot, declared]);

    expect(probedUrl(fetchFn, 0)).toBe("https://platform.test/_internal/tempo-observer-health");
    expect(probedUrl(fetchFn, 1)).toBe("https://platform.test/_internal/tempo-observer-health?tempo_session=1");
  });

  it("re-probes when a second mount declares during the first one's probe", async () => {
    // Otherwise mount 2 joins mount 1's probe, whose URL was built before mount
    // 2 existed — and `false, true` goes up as `tempo_session=0`.
    const { instance, fetchFn, release } = stalled();
    instance.declareSessionCapability(() => false);
    const first = instance.refresh();

    instance.declareSessionCapability(() => true);
    const second = instance.refresh();
    release();
    await Promise.all([first, second]);

    expect(probedUrl(fetchFn, 0)).toContain("tempo_session=0");
    expect(probedUrl(fetchFn, 1)).toContain("tempo_session=1");
  });

  it("still de-dupes concurrent probes once every mount has declared", async () => {
    const { instance, fetchFn, release } = stalled();
    instance.declareSessionCapability(() => true);

    const a = instance.refresh();
    const b = instance.refresh();
    release();
    await Promise.all([a, b]);

    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("stops counting a mount that withdrew its declaration", async () => {
    const { instance, fetchFn } = health({});
    instance.declareSessionCapability(() => false);
    const undeclare = instance.declareSessionCapability(() => true);

    undeclare();
    await instance.refresh();

    expect(probedUrl(fetchFn)).toContain("tempo_session=0");
  });

  it("re-reads the capability on every probe", async () => {
    const { instance, fetchFn } = health({});
    let capable = false;
    instance.declareSessionCapability(() => capable);

    await instance.refresh();
    capable = true;
    await instance.refresh();

    expect(probedUrl(fetchFn, 0)).toContain("tempo_session=0");
    expect(probedUrl(fetchFn, 1)).toContain("tempo_session=1");
  });
});

describe("createPlatformTempoObserverHealth", () => {
  it("is wired only for a platform-hosted DVM", () => {
    // A self-hosted builder operates their own observer and wake path, so
    // nothing withholds their session offers.
    expect(createPlatformTempoObserverHealth({})).toBeUndefined();
    expect(
      createPlatformTempoObserverHealth({ DVMKIT_PLATFORM_URL: "https://platform.test" })
    ).toBeInstanceOf(PlatformTempoObserverHealth);
  });
});
