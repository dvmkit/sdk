import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertRevenueReporterReady,
  type ReporterBannerOpts,
  type RevenueBootCheckOpts,
  revenueReporterBannerState,
} from "../app";

const PLATFORM_HOSTED: RevenueBootCheckOpts = {
  failFast: false,
  platformToken: "tok",
  platformUrl: "http://platform.invalid",
  dvmId: "dvm-123",
  hasPgPool: true,
};

const SELF_HOSTED: RevenueBootCheckOpts = {
  failFast: false,
  platformToken: undefined,
  platformUrl: undefined,
  dvmId: undefined,
  hasPgPool: false,
};

describe("assertRevenueReporterReady", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("silent when DVMKIT_PLATFORM_URL is unset (self-hosted, fully empty)", () => {
    expect(() => {
      assertRevenueReporterReady(SELF_HOSTED);
    }).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("silent when DVMKIT_PLATFORM_URL is unset but other pieces leak in", () => {
    // A self-hosted DVM with an unrelated DATABASE_URL and a stray
    // DVMKIT_PLATFORM_TOKEN should not trigger reporter validation —
    // platform URL is the sole signal.
    expect(() => {
      assertRevenueReporterReady({
        ...SELF_HOSTED,
        platformToken: "stray",
        dvmId: "stray-dvm",
        hasPgPool: true,
      });
    }).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("silent when fully wired (platform-hosted)", () => {
    expect(() => {
      assertRevenueReporterReady(PLATFORM_HOSTED);
    }).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("throws when DVMKIT_PLATFORM_TOKEN is missing (failFast=false)", () => {
    expect(() => {
      assertRevenueReporterReady({ ...PLATFORM_HOSTED, platformToken: undefined });
    }).toThrow(/Platform-hosted DVM.*DVMKIT_PLATFORM_TOKEN/);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("throws when DVMKIT_DVM_ID is missing (failFast=false)", () => {
    expect(() => {
      assertRevenueReporterReady({ ...PLATFORM_HOSTED, dvmId: undefined });
    }).toThrow(/DVMKIT_DVM_ID/);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("throws when database is missing (failFast=false)", () => {
    expect(() => {
      assertRevenueReporterReady({ ...PLATFORM_HOSTED, hasPgPool: false });
    }).toThrow(/database/);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("error message names every missing piece when several are absent", () => {
    expect(() => {
      assertRevenueReporterReady({
        ...PLATFORM_HOSTED,
        platformToken: undefined,
        dvmId: undefined,
        hasPgPool: false,
      });
    }).toThrow(/DVMKIT_PLATFORM_TOKEN.*DVMKIT_DVM_ID.*database/);
  });

  describe("devMode exemption", () => {
    const partials: [string, Partial<RevenueBootCheckOpts>][] = [
      ["platform token missing", { platformToken: undefined }],
      ["dvm id missing", { dvmId: undefined }],
      ["database missing", { hasPgPool: false }],
      ["nothing but the URL set", { platformToken: undefined, dvmId: undefined, hasPgPool: false }],
    ];

    for (const [label, partial] of partials) {
      it(`silent under devMode with ${label}`, () => {
        expect(() => {
          assertRevenueReporterReady({ ...PLATFORM_HOSTED, devMode: true, ...partial });
        }).not.toThrow();
        expect(errorSpy).not.toHaveBeenCalled();
      });
    }
  });
});

describe("revenueReporterBannerState", () => {
  // Dev mode exempts partial wiring from boot refusal, so the banner must
  // independently refuse to claim that an incomplete reporter is active.
  const WIRED: ReporterBannerOpts = {
    platformUrl: "http://platform.invalid",
    hasPlatformToken: true,
    hasDvmId: true,
    databaseConnected: true,
    devMode: false,
  };

  it("(self-hosted) when no platform URL, whatever else is set", () => {
    expect(revenueReporterBannerState({ ...WIRED, platformUrl: undefined })).toBe("(self-hosted)");
  });

  it("active when every piece the reporter needs is wired", () => {
    expect(revenueReporterBannerState(WIRED)).toBe("active");
    expect(revenueReporterBannerState({ ...WIRED, devMode: true })).toBe("active");
  });

  const missing: [string, Partial<ReporterBannerOpts>][] = [
    ["platform token", { hasPlatformToken: false }],
    ["dvm id", { hasDvmId: false }],
    ["database", { databaseConnected: false }],
  ];

  for (const [label, partial] of missing) {
    it(`never claims active without ${label} (devMode boot)`, () => {
      expect(revenueReporterBannerState({ ...WIRED, devMode: true, ...partial })).toBe(
        "(dev — not reporting)"
      );
    });

    it(`misconfigured without ${label} outside devMode`, () => {
      expect(revenueReporterBannerState({ ...WIRED, ...partial })).toBe("misconfigured");
    });
  }
});
