import { describe, expect, it, vi } from "vitest";

import {
  amountBoundsVerdict,
  assertNutSupport,
  canMeltBolt11Sat,
  canMintBolt11Sat,
  canSwap,
  checkMintHealth,
  DEFAULT_REQUIRED_NUTS,
  evaluateNutSupport,
  meltAmountBounds,
  mintAmountBounds,
} from "../health";
import {
  HEALTHY_MINT_NUTS,
  MELT_ONLY_MINT_NUTS,
  mintInfoDocument,
} from "./__helpers__/mint-info-fixtures";

const VALID_INFO = {
  pubkey: "02abc",
  version: "Nutshell/0.20.0",
  nuts: {
    "1": {},
    "2": {},
    "4": { methods: [{ method: "bolt11", unit: "sat" }] },
    "5": { methods: [{ method: "bolt11", unit: "sat" }] },
    "7": {},
    "8": {},
    "9": {},
    "10": {},
    "11": {},
    "20": {},
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("checkMintHealth", () => {
  it("returns ok=true with parsed NUT capabilities on a healthy mint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(VALID_INFO));
    const result = await checkMintHealth("https://mint.example.com", { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.pubkey).toBe("02abc");
    expect(result.nutsRaw?.["4"]).toEqual({ methods: [{ method: "bolt11", unit: "sat" }] });
    expect(result.version).toBe("Nutshell/0.20.0");
    expect(result.supportedNuts).toEqual(["1", "2", "4", "5", "7", "8", "9", "10", "11", "20"]);
    expect(result.missingRequiredNuts).toEqual([]);
    expect(result.bolt11SatMintSupported).toBe(true);
    expect(result.bolt11SatMeltSupported).toBe(true);
    expect(result.nutCompliant).toBe(true);
    expect(result.error).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mint.example.com/v1/info",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("strips a trailing slash on the mint URL before requesting /v1/info", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : "");
      return jsonResponse(VALID_INFO);
    };
    await checkMintHealth("https://mint.example.com/", { fetchImpl });
    expect(calls[0]).toBe("https://mint.example.com/v1/info");
  });

  it("flags missing NUT-04 / NUT-05 even on an otherwise reachable mint", async () => {
    const partial = { ...VALID_INFO, nuts: { "1": {}, "2": {} } };
    const fetchImpl = vi.fn(async () => jsonResponse(partial));
    const result = await checkMintHealth("https://mint.example.com", { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.missingRequiredNuts).toEqual(["4", "5", "7", "9", "10", "11", "20"]);
    expect(result.bolt11SatMintSupported).toBe(false);
    expect(result.bolt11SatMeltSupported).toBe(false);
    expect(result.nutCompliant).toBe(false);
  });

  it("flags missing higher NUTs (7/9/10/11/20) even when NUT-4 + NUT-5 are present", async () => {
    const minimal = {
      ...VALID_INFO,
      nuts: {
        "4": { methods: [{ method: "bolt11", unit: "sat" }] },
        "5": { methods: [{ method: "bolt11", unit: "sat" }] },
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(minimal));
    const result = await checkMintHealth("https://mint.example.com", { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.missingRequiredNuts).toEqual(["7", "9", "10", "11", "20"]);
    expect(result.bolt11SatMintSupported).toBe(true);
    expect(result.bolt11SatMeltSupported).toBe(true);
    expect(result.nutCompliant).toBe(false);
  });

  it("reports missing_fields when /v1/info lacks pubkey or version", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ version: "Nutshell/0.20.0" }));
    const result = await checkMintHealth("https://mint.example.com", { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("missing_fields");
    expect(result.error?.message).toContain("pubkey");
  });

  it("treats non-2xx HTTP responses as http_error and exhausts retries", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const result = await checkMintHealth("https://mint.example.com", {
      fetchImpl,
      backoffMs: [0, 0, 0],
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("http_error");
    expect(result.error?.message).toBe("HTTP 503");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns timeout when the abort signal fires", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      // Wait until the signal aborts, then throw the error fetch would.
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("operation was aborted");
          err.name = "TimeoutError";
          reject(err);
        });
      });
      throw new Error("unreachable");
    };
    const result = await checkMintHealth("https://mint.example.com", {
      fetchImpl,
      timeoutMs: 10,
      retries: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("timeout");
  });

  it("recovers when an early attempt fails but a later attempt succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(VALID_INFO));
    const result = await checkMintHealth("https://mint.example.com", {
      fetchImpl,
      retries: 3,
      backoffMs: [0, 0, 0],
    });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns parse_error when /v1/info returns non-JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>not json</html>", { status: 200 }));
    const result = await checkMintHealth("https://mint.example.com", {
      fetchImpl,
      retries: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("parse_error");
  });

});

describe("assertNutSupport", () => {
  const ALL_NUTS: Record<string, unknown> = {
    ...Object.fromEntries(DEFAULT_REQUIRED_NUTS.map((n) => [String(n), { supported: true }])),
    "4": { methods: [{ method: "bolt11", unit: "sat" }] },
    "5": { methods: [{ method: "bolt11", unit: "sat" }] },
  };

  it("does not throw when all required NUTs are present", () => {
    expect(() => {
      assertNutSupport("https://mint.example.com", ALL_NUTS);
    }).not.toThrow();
  });

  it("does not throw when a NUT entry has no supported field (treated as present)", () => {
    const nuts = { ...ALL_NUTS, "7": {} };
    expect(() => {
      assertNutSupport("https://mint.example.com", nuts);
    }).not.toThrow();
  });

  it("throws when a required NUT is absent, naming the NUT and mint URL", () => {
    const { "11": _removed, ...nutsWithout11 } = ALL_NUTS;
    expect(() => {
      assertNutSupport("https://mint.example.com", nutsWithout11);
    }).toThrow(/11/);
    expect(() => {
      assertNutSupport("https://mint.example.com", nutsWithout11);
    }).toThrow(/https:\/\/mint\.example\.com/);
  });

  it("throws when a NUT has supported: false", () => {
    const nuts = { ...ALL_NUTS, "11": { supported: false } };
    expect(() => {
      assertNutSupport("https://mint.example.com", nuts);
    }).toThrow(/11/);
  });

  it("throws listing all missing NUTs when the nuts object is empty", () => {
    expect(() => {
      assertNutSupport("https://mint.example.com", {});
    }).toThrow(/4, 5, 7, 9, 10, 11, 20/);
  });

  it("throws when NUT-4 lacks bolt11/sat method", () => {
    const nuts = { ...ALL_NUTS, "4": { methods: [{ method: "ecash", unit: "sat" }] } };
    expect(() => {
      assertNutSupport("https://mint.example.com", nuts);
    }).toThrow(/bolt11.*NUT-4/);
  });

  it("throws when NUT-5 lacks bolt11/sat method", () => {
    const nuts = { ...ALL_NUTS, "5": { methods: [{ method: "ecash", unit: "sat" }] } };
    expect(() => {
      assertNutSupport("https://mint.example.com", nuts);
    }).toThrow(/bolt11.*NUT-5/);
  });

  it("accepts a custom requiredNuts list", () => {
    const nuts = {
      "4": { methods: [{ method: "bolt11", unit: "sat" }] },
      "5": { methods: [{ method: "bolt11", unit: "sat" }] },
    };
    expect(() => {
      assertNutSupport("https://mint.example.com", nuts, [4, 5]);
    }).not.toThrow();
    expect(() => {
      assertNutSupport("https://mint.example.com", nuts, [4, 5, 7]);
    }).toThrow(/7/);
  });
});

describe("evaluateNutSupport (non-throwing parity with assertNutSupport)", () => {
  const ALL_NUTS: Record<string, unknown> = {
    ...Object.fromEntries(DEFAULT_REQUIRED_NUTS.map((n) => [String(n), { supported: true }])),
    "4": { methods: [{ method: "bolt11", unit: "sat" }] },
    "5": { methods: [{ method: "bolt11", unit: "sat" }] },
  };

  it("ok=true with no missing sets when every required NUT is present", () => {
    const verdict = evaluateNutSupport(ALL_NUTS);
    expect(verdict.ok).toBe(true);
    expect(verdict.missingNuts).toBeUndefined();
    expect(verdict.missingBolt11).toBeUndefined();
  });

  it("reports missing dict NUTs (absent or supported:false)", () => {
    const { "11": _removed, ...without11 } = ALL_NUTS;
    expect(evaluateNutSupport(without11)).toMatchObject({ ok: false, missingNuts: [11] });
    expect(evaluateNutSupport({ ...ALL_NUTS, "11": { supported: false } })).toMatchObject({
      ok: false,
      missingNuts: [11],
    });
  });

  it("reports missing bolt11/sat on NUT-4 and NUT-5 separately", () => {
    expect(
      evaluateNutSupport({ ...ALL_NUTS, "4": { methods: [{ method: "ecash", unit: "sat" }] } })
    ).toMatchObject({ ok: false, missingBolt11: ["mint"] });
    expect(
      evaluateNutSupport({ ...ALL_NUTS, "5": { methods: [{ method: "ecash", unit: "sat" }] } })
    ).toMatchObject({ ok: false, missingBolt11: ["melt"] });
  });

});

describe("mint/melt capability flags", () => {
  const disabledInfo = (nut: "4" | "5") => ({
    ...VALID_INFO,
    nuts: {
      ...VALID_INFO.nuts,
      [nut]: { methods: [{ method: "bolt11", unit: "sat" }], disabled: true },
    },
  });

  it("reads an absent `disabled` key as enabled", () => {
    // VALID_INFO's NUT-4/NUT-5 carry no `disabled` field at all. Silence about
    // being switched off is not a claim of incapability — reading it as one
    // would rule out working mints.
    expect(canMintBolt11Sat(VALID_INFO.nuts)).toBe(true);
    expect(canMeltBolt11Sat(VALID_INFO.nuts)).toBe(true);
  });

  it("reads `disabled: false` as enabled", () => {
    const nuts = {
      ...VALID_INFO.nuts,
      "4": { methods: [{ method: "bolt11", unit: "sat" }], disabled: false },
    };
    expect(canMintBolt11Sat(nuts)).toBe(true);
  });

  it("reads `disabled: true` as incapable, per direction independently", () => {
    expect(canMintBolt11Sat(disabledInfo("4").nuts)).toBe(false);
    expect(canMeltBolt11Sat(disabledInfo("4").nuts)).toBe(true);
    expect(canMeltBolt11Sat(disabledInfo("5").nuts)).toBe(false);
  });

  it("treats a missing bolt11/sat method as incapable regardless of `disabled`", () => {
    expect(canMintBolt11Sat({ "4": { methods: [{ method: "bolt12", unit: "sat" }] } })).toBe(false);
    expect(canMintBolt11Sat({})).toBe(false);
  });

  it("surfaces both flags on a health probe", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(disabledInfo("4")));
    const result = await checkMintHealth("https://mint.example.com", { fetchImpl, retries: 1 });
    expect(result.ok).toBe(true);
    expect(result.mintingEnabled).toBe(false);
    expect(result.meltingEnabled).toBe(true);
  });

  it("keeps a melt-only mint loadable — `disabled` must never reach the boot-time NUT gate", () => {
    // `getWallet` calls `assertNutSupport`. Folding `disabled` into it would
    // throw for exactly the mint `dvm wallet cash-out` exists to drain, making
    // the balance unreachable. The two checks stay separate on purpose.
    expect(() => {
      assertNutSupport("https://mint.example.com", disabledInfo("4").nuts);
    }).not.toThrow();
    expect(evaluateNutSupport(disabledInfo("4").nuts).ok).toBe(true);
  });
});

describe("swap capability", () => {
  it("reads a healthy mint's silence about NUT-3 as swap-capable", () => {
    // Neither coinos nor lnvoltz advertises a "3" key. Swap is the baseline
    // mint operation — reading its absence as incapable would route every
    // payment around every working mint.
    expect(canSwap(HEALTHY_MINT_NUTS)).toBe(true);
    expect(canSwap({})).toBe(true);
  });

  it("reads the melt-only recovery posture as not swap-capable", () => {
    expect(canSwap(MELT_ONLY_MINT_NUTS)).toBe(false);
  });

  it("honours either spelling of switched-off, and `supported: true` as on", () => {
    expect(canSwap({ "3": { disabled: true } })).toBe(false);
    expect(canSwap({ "3": { supported: false } })).toBe(false);
    expect(canSwap({ "3": { supported: true } })).toBe(true);
    expect(canSwap({ "3": {} })).toBe(true);
  });

  it("surfaces swapEnabled on a health probe over the real-shaped fixtures", async () => {
    const healthy = await checkMintHealth("https://mint.example.com", {
      fetchImpl: vi.fn(async () => jsonResponse(mintInfoDocument(HEALTHY_MINT_NUTS))),
      retries: 1,
    });
    expect(healthy.ok).toBe(true);
    expect(healthy.swapEnabled).toBe(true);

    const meltOnly = await checkMintHealth("https://mint.example.com", {
      fetchImpl: vi.fn(async () => jsonResponse(mintInfoDocument(MELT_ONLY_MINT_NUTS))),
      retries: 1,
    });
    expect(meltOnly.ok).toBe(true);
    expect(meltOnly.swapEnabled).toBe(false);
    // Still melts — which is what keeps `dvm wallet cash-out` working there.
    expect(meltOnly.meltingEnabled).toBe(true);
    expect(meltOnly.mintingEnabled).toBe(false);
  });

  it("keeps a swap-disabled mint past the boot-time NUT gate", () => {
    expect(() => {
      assertNutSupport("https://mint.example.com", MELT_ONLY_MINT_NUTS);
    }).not.toThrow();
  });
});

describe("per-method amount bounds", () => {
  /** Shape both mints in the default rotation actually emit (verified against live `/v1/info`). */
  const boundedInfo = (
    nut: "4" | "5",
    bounds: Record<string, unknown>,
    other: Record<string, unknown> = {}
  ) => ({
    ...VALID_INFO,
    nuts: {
      ...VALID_INFO.nuts,
      [nut]: { methods: [{ method: "bolt11", unit: "sat", ...bounds }], ...other },
    },
  });

  it("reads min_amount / max_amount off the bolt11/sat entry, per direction", () => {
    const nuts = {
      ...VALID_INFO.nuts,
      "4": { methods: [{ method: "bolt11", unit: "sat", min_amount: 0, max_amount: 1_000_000 }] },
      "5": { methods: [{ method: "bolt11", unit: "sat", min_amount: 100, max_amount: 500_000 }] },
    };
    expect(mintAmountBounds(nuts)).toEqual({ minSats: 0, maxSats: 1_000_000 });
    expect(meltAmountBounds(nuts)).toEqual({ minSats: 100, maxSats: 500_000 });
  });

  it("reads an absent bound as unbounded, not as zero", () => {
    // mint.coinos.io advertises bolt11/sat with no amount fields at all. A mint
    // saying nothing must not be read as a mint refusing everything.
    expect(mintAmountBounds(VALID_INFO.nuts)).toEqual({ minSats: null, maxSats: null });
    expect(meltAmountBounds(VALID_INFO.nuts)).toEqual({ minSats: null, maxSats: null });
    expect(amountBoundsVerdict(50_000_000, mintAmountBounds(VALID_INFO.nuts))).toBe("ok");
  });

  it("ignores a bound it cannot read, rather than narrowing on a shape it doesn't recognise", () => {
    for (const bad of [{ max_amount: "nope" }, { max_amount: -1 }, { max_amount: "" }]) {
      expect(mintAmountBounds(boundedInfo("4", bad).nuts).maxSats).toBeNull();
    }
    expect(mintAmountBounds(boundedInfo("4", { max_amount: null }).nuts).maxSats).toBeNull();
  });

  it("accepts a bound sent as a numeric string or bigint", () => {
    // cashu-ts types these as `number | bigint | string`, so a large max sent as
    // a string is a real shape — reading it as absent would silently unbound it.
    expect(mintAmountBounds(boundedInfo("4", { max_amount: "1000000" }).nuts).maxSats).toBe(
      1_000_000
    );
    expect(mintAmountBounds(boundedInfo("4", { max_amount: 1_000_000n }).nuts).maxSats).toBe(
      1_000_000
    );
  });

  it("honours an explicit zero literally", () => {
    // `min_amount: 0` is what mint.lnvoltz.com emits — a no-op floor, not silence.
    expect(mintAmountBounds(boundedInfo("4", { min_amount: 0 }).nuts).minSats).toBe(0);
    expect(mintAmountBounds(boundedInfo("4", { max_amount: 0 }).nuts).maxSats).toBe(0);
  });

  it("has no bounds to report when the direction lacks a bolt11/sat method", () => {
    expect(mintAmountBounds({ "4": { methods: [{ method: "bolt12", unit: "sat" }] } })).toEqual({
      minSats: null,
      maxSats: null,
    });
  });

  describe("amountBoundsVerdict", () => {
    const bounds = { minSats: 100, maxSats: 1_000 };

    it("judges an amount against both ends, inclusive", () => {
      expect(amountBoundsVerdict(500, bounds)).toBe("ok");
      expect(amountBoundsVerdict(100, bounds)).toBe("ok");
      expect(amountBoundsVerdict(1_000, bounds)).toBe("ok");
      expect(amountBoundsVerdict(99, bounds)).toBe("below_min");
      expect(amountBoundsVerdict(1_001, bounds)).toBe("above_max");
    });

    it("passes anything when the bounds are absent or unknown", () => {
      expect(amountBoundsVerdict(1, undefined)).toBe("ok");
      expect(amountBoundsVerdict(50_000_000, { minSats: null, maxSats: null })).toBe("ok");
    });
  });

  it("surfaces both directions' bounds on a health probe", async () => {
    const info = {
      ...VALID_INFO,
      nuts: {
        ...VALID_INFO.nuts,
        "4": { methods: [{ method: "bolt11", unit: "sat", min_amount: 0, max_amount: 1_000_000 }] },
        "5": { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 1_000_000 }] },
      },
    };
    const fetchImpl = vi.fn(async () => jsonResponse(info));
    const result = await checkMintHealth("https://mint.example.com", { fetchImpl, retries: 1 });
    expect(result.ok).toBe(true);
    expect(result.mintAmountBounds).toEqual({ minSats: 0, maxSats: 1_000_000 });
    expect(result.meltAmountBounds).toEqual({ minSats: 1, maxSats: 1_000_000 });
  });

  it("keeps a narrowly-bounded mint loadable — bounds must never reach the boot-time NUT gate", () => {
    const narrow = boundedInfo("5", { min_amount: 1, max_amount: 10 }).nuts;
    expect(() => {
      assertNutSupport("https://mint.example.com", narrow);
    }).not.toThrow();
    expect(evaluateNutSupport(narrow).ok).toBe(true);
    expect(canMeltBolt11Sat(narrow)).toBe(true);
  });
});
