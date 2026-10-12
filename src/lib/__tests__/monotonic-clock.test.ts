import { afterEach, describe, expect, it, vi } from "vitest";

import { createMonotonicClock } from "../monotonic-clock";

afterEach(() => {
  vi.useRealTimers();
});

describe("createMonotonicClock", () => {
  it("holds its reading forward across a backwards wall-clock step", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const nowMs = createMonotonicClock();
    expect(nowMs()).toBe(t0);

    vi.setSystemTime(t0 - 60_000);
    // `setSystemTime` leaves the monotonic baseline alone, so the projection
    // stays at the anchor while the wall reads a minute earlier.
    expect(nowMs()).toBe(t0);
    expect(Date.now()).toBe(t0 - 60_000);
  });

  it("re-anchors immediately on a legitimate forward jump", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const nowMs = createMonotonicClock();

    vi.setSystemTime(t0 + 5_000);
    expect(nowMs()).toBe(t0 + 5_000);
    // The forward jump is adopted, so a later backwards step is measured
    // against it rather than against construction.
    vi.setSystemTime(t0 + 1_000);
    expect(nowMs()).toBe(t0 + 5_000);
  });

  it("returns whole milliseconds, so an untroubled clock reads as zero skew", () => {
    const nowMs = createMonotonicClock();
    const reading = nowMs();
    expect(Number.isInteger(reading)).toBe(true);
    expect(Math.max(0, reading - Date.now())).toBe(0);
  });

  it("gives each clock its own anchor", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const born = createMonotonicClock();

    vi.setSystemTime(t0 - 60_000);
    // A clock created after the step has no way to know one happened, and
    // simply trusts the wall it was born with.
    const late = createMonotonicClock();
    expect(born()).toBe(t0);
    expect(late()).toBe(t0 - 60_000);
  });
});
