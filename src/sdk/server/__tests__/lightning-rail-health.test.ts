import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPlatformLightningRailHealth,
  LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS,
  LIGHTNING_RAIL_HEALTH_TIMEOUT_MS,
  PlatformLightningRailHealth,
} from "../lightning-rail-health";

describe("PlatformLightningRailHealth", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("removes the rail for zero active channels and restores it after the next healthy refresh", async () => {
    let nowMs = 1_000;
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ routable: false, observed_at_ms: nowMs }))
      .mockResolvedValueOnce(json({ routable: true, observed_at_ms: nowMs + 5 * 60 * 1000 }));
    const health = new PlatformLightningRailHealth({
      url: "http://platform.test/_internal/lightning-rail-health",
      token: "per-dvm-token",
      fetchFn,
      now: () => nowMs,
      refreshTtlMs: 5 * 60 * 1000,
    });

    await health.refresh();
    expect(health.available()).toBe(false);
    expect(fetchFn).toHaveBeenLastCalledWith(
      "http://platform.test/_internal/lightning-rail-health",
      expect.objectContaining({
        headers: { Authorization: "Bearer per-dvm-token", Accept: "application/json" },
      })
    );

    nowMs += 5 * 60 * 1000;
    await health.refresh();
    expect(health.available()).toBe(true);
  });

  it("fails open on an unavailable platform, then removes the rail at the three-hour ceiling", async () => {
    let nowMs = 1_000;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const health = new PlatformLightningRailHealth({
      url: "http://platform.test/_internal/lightning-rail-health",
      fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
      now: () => nowMs,
      retries: 0,
    });

    await health.refresh();
    expect(health.available()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lightning_rail_health_fallback"));

    nowMs += LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS;
    expect(health.available()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("lightning_rail_health_staleness_ceiling")
    );
  });

  it("abandons a hung platform pull at its timeout so the next refresh pulls again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchFn = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    let nowMs = 1_000;
    const health = new PlatformLightningRailHealth({
      url: "http://platform.test/_internal/lightning-rail-health",
      fetchFn,
      now: () => nowMs,
      retries: 0,
    });

    let settled = false;
    void health.refresh().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(LIGHTNING_RAIL_HEALTH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("lightning_rail_health_fallback"));

    nowMs += 1;
    void health.refresh();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not create a platform pull for self-hosted DVMs", () => {
    expect(createPlatformLightningRailHealth({})).toBeUndefined();
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
