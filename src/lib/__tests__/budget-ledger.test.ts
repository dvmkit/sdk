import { describe, expect, it } from "vitest";

import { windowEnd, windowStart } from "../budget-core";

describe("windowStart", () => {
  it("anchors daily, weekly, and monthly windows in UTC, including Sunday and Monday", () => {
    for (const [window, instant, expected] of [
      ["daily", "2026-04-17T13:45:00Z", "2026-04-17T00:00:00.000Z"],
      ["weekly", "2026-04-17T13:45:00Z", "2026-04-13T00:00:00.000Z"],
      ["weekly", "2026-04-13T13:45:00Z", "2026-04-13T00:00:00.000Z"],
      ["weekly", "2026-04-19T13:45:00Z", "2026-04-13T00:00:00.000Z"],
      ["monthly", "2026-04-17T13:45:00Z", "2026-04-01T00:00:00.000Z"],
    ] as const) {
      expect(windowStart(window, new Date(instant)).toISOString(), `${window}: ${instant}`).toBe(expected);
    }
  });

  });

describe("windowEnd", () => {
  it("daily window is 24 hours after start", () => {
    const now = new Date("2026-04-17T13:45:00Z");
    expect(windowEnd("daily", now).toISOString()).toBe("2026-04-18T00:00:00.000Z");
  });

  it("monthly window is the start of the next month UTC", () => {
    const now = new Date("2026-04-17T13:45:00Z");
    expect(windowEnd("monthly", now).toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});
