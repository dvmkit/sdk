import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  fundedMicroFor,
  fundingCommitment,
  implicitCreditId,
  pinAskFiat,
  priceFiatMicro,
  resolvePriceFiat,
  x402SettledShare,
} from "../funding";

describe("resolvePriceFiat", () => {
  it("parses a static '$X.XX' price exactly", () => {
    const fiat = resolvePriceFiat({ price: "$0.10", priceMsats: 100_000 });
    expect(fiat).toEqual({ currency: "usd", amountMicro: 100_000 });
  });

  it("prefers the dynamic quote's fiat envelope over everything", () => {
    const fiat = resolvePriceFiat({
      price: undefined,
      priceMsats: 42_000,
      dynamicUpfront: { amount: 0.25, currency: "USD" },
    });
    expect(fiat).toEqual({ currency: "usd", amountMicro: 250_000 });
  });

  it("denominates every paid job — no fx, so no rate outage can skip the ledger", () => {



    expect(resolvePriceFiat({ price: "$0.001", priceMsats: 1000 })).toEqual({
      currency: "usd",
      amountMicro: 1000,
    });
  });

  it("throws on a malformed static price rather than silently skipping the ledger", () => {
    expect(() => resolvePriceFiat({ price: "10000", priceMsats: 10_000 })).toThrow(
      /not a USD price literal/
    );
  });

  it("returns undefined for free jobs", () => {
    expect(resolvePriceFiat({ price: undefined, priceMsats: undefined })).toBeUndefined();
    expect(resolvePriceFiat({ price: "$0.10", priceMsats: 0 })).toBeUndefined();
  });
});

describe("priceFiatMicro", () => {
  it("states independent micro-unit vectors for static and dynamic prices", () => {
    for (const [args, expected] of [
      [{ price: "$0.10" }, { currency: "usd", amountMicro: 100_000 }],
      [{ price: "$0.0001" }, { currency: "usd", amountMicro: 100 }],
      [{ dynamicUpfront: { amount: 0.003174, currency: "usd" } }, { currency: "usd", amountMicro: 3174 }],
      [{ dynamicUpfront: { amount: 0.25, currency: "EUR" } }, { currency: "eur", amountMicro: 250_000 }],
    ] as const) {
      expect(priceFiatMicro(args)).toEqual(expected);
    }
  });

  it("has no priceMsats gate — an advertisement has no msat figure in hand", () => {
    expect(priceFiatMicro({ price: "$0.10" })).toEqual({ currency: "usd", amountMicro: 100_000 });
    expect(priceFiatMicro({})).toBeUndefined();
  });

  it("refuses a sub-micro or unsafe amount, exactly as the ledger pin does", () => {
    expect(
      priceFiatMicro({ dynamicUpfront: { amount: 0.0000004, currency: "usd" } })
    ).toBeUndefined();
    expect(priceFiatMicro({ dynamicUpfront: { amount: 0, currency: "usd" } })).toBeUndefined();
    expect(priceFiatMicro({ dynamicUpfront: { amount: 1e12, currency: "usd" } })).toBeUndefined();
  });
});

describe("pinAskFiat", () => {
  const fx = { rates: { usd: 100_000, eur: 80_000 }, as_of: "2026-07-31T00:00:00Z" };

  it("takes a fiat-form ask verbatim when it already speaks the target currency", () => {


    expect(
      pinAskFiat({ msats: 50_000, currency: "usd", fx, exact: { amount: 0.05, currency: "usd" } })
    ).toEqual({ currency: "usd", amountMicro: 50_000 });
  });

  it("converts an ask that names another currency, on the snapshot that sized it", () => {


    expect(
      pinAskFiat({ msats: 50_000, currency: "usd", fx, exact: { amount: 0.04, currency: "eur" } })
    ).toEqual({ currency: "usd", amountMicro: 50_000 });
  });

  it("converts a bare-msats ask into the target currency", () => {
    expect(pinAskFiat({ msats: 50_000, currency: "eur", fx })).toEqual({
      currency: "eur",
      amountMicro: 40_000,
    });
  });

  it("floors a sub-micro ask at one micro rather than refusing to denominate it", () => {


    expect(
      pinAskFiat({
        msats: 1000,
        currency: "usd",
        fx,
        exact: { amount: 0.0000004, currency: "usd" },
      })
    ).toEqual({ currency: "usd", amountMicro: 1 });
  });

  it("leaves resolvePriceFiat's sub-micro refusal alone", () => {


    expect(
      resolvePriceFiat({
        price: undefined,
        priceMsats: 1000,
        dynamicUpfront: { amount: 0.0000004, currency: "usd" },
      })
    ).toBeUndefined();
  });
});

describe("fundedMicroFor", () => {
  const priceFiat = { currency: "usd", amountMicro: 100_000 };

  it("is exactly the quoted price at exact payment — zero drift", () => {
    expect(fundedMicroFor(priceFiat, 100_000, 100_000)).toBe(100_000);
  });

  it("pro-rates overpay at the quote-pinned ratio (full paid amount funds)", () => {
    expect(fundedMicroFor(priceFiat, 150_000, 100_000)).toBe(150_000);
    expect(fundedMicroFor(priceFiat, 200_000, 100_000)).toBe(200_000);
  });

  it("pro-rates short pay the same way", () => {
    expect(fundedMicroFor(priceFiat, 50_000, 100_000)).toBe(50_000);
  });
});

describe("x402SettledShare", () => {
  const PRICE_MICRO = 3_174;
  const REQUIRED_MSATS = 3_258;
  /** `msatsToUsdc(3258, 97432)` — the 402's own ceil'd advertisement. */
  const ADVERTISED = 3_175;

  it("returns the quoted figure untouched at exactly the advertised amount", () => {


    expect(x402SettledShare(PRICE_MICRO, ADVERTISED, ADVERTISED)).toBe(PRICE_MICRO);
    expect(x402SettledShare(REQUIRED_MSATS, ADVERTISED, ADVERTISED)).toBe(REQUIRED_MSATS);
  });

  it("pro-rates a genuine overpayment at the advertised ratio", () => {
    expect(x402SettledShare(PRICE_MICRO, ADVERTISED, ADVERTISED * 2)).toBe(PRICE_MICRO * 2);

    expect(x402SettledShare(PRICE_MICRO, ADVERTISED, ADVERTISED + 1)).toBe(
      3175
    );
  });

  it("pro-rates a short payment the same way", () => {
    expect(x402SettledShare(PRICE_MICRO, ADVERTISED, Math.floor(ADVERTISED / 2))).toBe(
      1587
    );
  });

  it("falls back to the quoted figure rather than dividing by zero", () => {
    expect(x402SettledShare(PRICE_MICRO, 0, 5_000)).toBe(PRICE_MICRO);
    expect(x402SettledShare(PRICE_MICRO, -1, 5_000)).toBe(PRICE_MICRO);
  });
});

describe("fundingCommitment", () => {
  it("is the SHA-256 hex over the verbatim artifact string", () => {
    const artifact = "cashuAeyJtaW50IjoiaHR0cHM6Ly9taW50In0";
    expect(fundingCommitment(artifact)).toBe(
      createHash("sha256").update(artifact, "utf8").digest("hex")
    );
  });
});

describe("implicitCreditId", () => {
  it("namespaces by rail so caller-chosen ids can't collide", () => {
    expect(implicitCreditId("cashu", "req-1")).toBe("imp:cashu:req-1");
    expect(implicitCreditId("x402", "0xabc")).toBe("imp:x402:0xabc");
  });
});
