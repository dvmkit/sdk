import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPlatformLightningRailHealth,
  LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS,
  PlatformLightningRailHealth,
} from "../lightning-rail-health";

describe("PlatformLightningRailHealth", () => {
  afterEach(() => {
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
