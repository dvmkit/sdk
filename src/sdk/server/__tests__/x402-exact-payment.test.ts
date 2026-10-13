import { beforeEach, describe, expect, it, vi } from "vitest";

import { usdcToMsats } from "../../../lib/currency";
import { encodePayment, X402_V1_VERSION } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { fiatToSatsCeil } from "../../pricing/index";
import { fundingCommitment, x402SettledShare } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");
const { verifyUpfrontPayment } = await import("../payment");

/** A rate and price whose fiat-to-msat-to-fiat round trip is lossy. */
const RATE = 97_432;
const PRICE_MICRO = 3_174;

/** What a real quote settles on: the price ceiled to a whole satoshi. */
function quoteMsats(priceMicro: number, rate: number): number {
  return fiatToSatsCeil(priceMicro / 1e6, rate) * 1000;
}

const PRICE_MSATS = quoteMsats(PRICE_MICRO, RATE); // 4000

/**
 * What the 402's `accepts[0].maxAmountRequired` states, in µUSDC: the quoted
 * price verbatim, because USDC is a six-decimal USD stablecoin.
 */
const ADVERTISED_USDC_MICRO = PRICE_MICRO;

/** What a conformant caller pays: exactly the advertised amount, doubled to overpay. */
const OVERPAID_USDC_MICRO = ADVERTISED_USDC_MICRO * 2;
const OVERPAID_MICRO = Math.round((PRICE_MICRO * OVERPAID_USDC_MICRO) / ADVERTISED_USDC_MICRO);

const DVM_ID = "dvm-exact-payment";
const CALLER = "aa".repeat(32);
const TX_HASH = "0xsettled";

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

/**
 * A real `X-PAYMENT` header for an authorization of `valueUsdcMicro`. The
 * pre-settle gate decodes this rather than asking the facilitator,
 * so a placeholder string would silently route every case in this suite past
 * the gate and into the post-settlement backstop.
 */
function header(valueUsdcMicro: number): string {
  return encodePayment({
    x402Version: X402_V1_VERSION,
    scheme: "exact",
    network: X402.network,
    payload: {
      signature: "0x" + "cd".repeat(32),
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: X402.payTo,
        value: String(valueUsdcMicro),
        validAfter: "0",
        validBefore: "99999999999",
        nonce: "0x" + "ef".repeat(32),
      },
    },
  });
}

/** The header the current `settle()` stubbed a receipt for — kept in step. */
let X402_HEADER = header(0);

function warmFetcher(rate = RATE): FxFetcher {
  return {
    fetch: vi.fn(() =>
      Promise.resolve({
        rates: { usd: rate } as FxRateSnapshot["rates"],
        as_of: new Date(0).toISOString(),
      })
    ),
    supportedCurrencies: () => ["usd"],
    lastKnown: vi.fn(() => null),
  };
}

interface Harness {
  ledger: MemoryCreditLedger;
  processedPayments: MemoryProcessedPaymentStore;
}

function harness(): Harness {
  return { ledger: new MemoryCreditLedger(), processedPayments: new MemoryProcessedPaymentStore() };
}

/**
 * The receipt `verifyX402Payment` really produces for a settled authorization
 * of `settledUsdcMicro` — `amountMsats` derived the same lossy way the verifier
 * derives it, so the drift under test is genuine rather than stubbed. The
 * header moves with it: the real verifier reads its rail-native amount off the
 * authorization, so a receipt stating one figure while the attached payload
 * carries another is a state the code under test can never see.
 */
function settle(settledUsdcMicro: number, rate = RATE): void {
  X402_HEADER = header(settledUsdcMicro);
  vi.mocked(verifyX402Payment).mockResolvedValue({
    verified: true,
    amountMsats: usdcToMsats(settledUsdcMicro / 1e6, rate),
    amountUsdcMicro: settledUsdcMicro,
    txHash: TX_HASH,
    settleResponseHeader: "hdr",
  });
}

function fundAndDraw(
  h: Harness,
  amountMicro: number,
  opts: { rate?: number; requiredMsats?: number; priceCurrency?: string } = {}
) {
  const rate = opts.rate ?? RATE;
  return verifyUpfrontPayment({
    x402Payment: X402_HEADER,
    x402Config: X402,
    requiredMsats: opts.requiredMsats ?? PRICE_MSATS,
    fxFetcher: warmFetcher(rate),
    creditLedger: h.ledger,
    processedPayments: h.processedPayments,
    priceFiat: { currency: opts.priceCurrency ?? "usd", amountMicro: PRICE_MICRO },
    callerPubkey: CALLER,
    dvmId: DVM_ID,
    jobId: "job-1",
    creditEnvelope: {
      creditId: "c1",
      drawId: "d1",
      fund: { amountMicro, commitment: fundingCommitment(X402_HEADER) },
    },
  });
}

/**
 * The `maxAmountRequired` this provider really advertises, read off its own 402
 * rather than recomputed here — the figure a conformant caller signs.
 */
async function advertised(
  rate: number,
  opts: { priceMicro?: number; priceCurrency?: string } = {}
): Promise<number> {
  const priceMicro = opts.priceMicro ?? PRICE_MICRO;
  const result = await verifyUpfrontPayment({
    x402Config: X402,
    requiredMsats: quoteMsats(priceMicro, rate),
    fxFetcher: warmFetcher(rate),
    priceFiat: { currency: opts.priceCurrency ?? "usd", amountMicro: priceMicro },
    callerPubkey: CALLER,
    dvmId: DVM_ID,
  });
  const requirements = result.error?.x402Requirements ?? [];
  expect(requirements).toHaveLength(1);
  return Number.parseInt(requirements[0].maxAmountRequired, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  settle(ADVERTISED_USDC_MICRO);
});

describe("provider advertisement", () => {

  it("advertises the price, not the satoshi quote's dollar value", async () => {
    // The BTC hop this replaced demanded 3,898 µUSDC for a 3,174 µUSDC job —
    // 23% over the advertised price, because 4 whole satoshis is 23% more than
    // the price is worth. Sub-cent jobs are where the sat-ceil bites hardest.
    expect(await advertised(RATE)).toBe(PRICE_MICRO);
  });
});

describe("an exact x402 payment", () => {

  it("funds and draws the quoted price, with no drift onto the ledger", async () => {
    const h = harness();
    const result = await fundAndDraw(h, PRICE_MICRO);
    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(PRICE_MSATS);

    const credit = await h.ledger.get("c1");
    // The gate and the commit have to agree: accepting `price_micro` and then
    // minting `price_micro + 1` would be the same bug one layer down.
    expect(credit?.balanceMicro).toBe(PRICE_MICRO);
    const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(draw?.amountMicro).toBe(PRICE_MICRO);
    // The millisatoshi frame is pinned to the quote by the same ratio, so the
    // credit's rail basis can't drift away from its fiat balance either.
    expect(draw?.railValue.drawMsats).toBe(PRICE_MSATS);
    expect(draw?.railValue.drawNative).toBe(ADVERTISED_USDC_MICRO);
  });
});

describe("the pre-settle gate", () => {
  // The derivation above stops this bug class from *arising* on a USD price.
  // This gate is what stops a caller-supplied funding amount from reintroducing
  // it on the USD path. The signed authorization's `value` is in hand before the
  // facilitator is called, so the valuation is predictable and a disagreement
  // refuses with nothing broadcast.

  it("refuses a wrong fund.amount_micro without calling the facilitator at all", async () => {
    const h = harness();
    const result = await fundAndDraw(h, PRICE_MICRO + 1);

    expect(result.error?.body.error).toBe("funding_commitment_mismatch");
    expect(result.error?.body.expected_micro).toBe(PRICE_MICRO);
    // The whole point: `/verify` and `/settle` live behind this mock, so a
    // refusal that never reached it is a refusal that moved no money.
    expect(vi.mocked(verifyX402Payment)).not.toHaveBeenCalled();
    expect(await h.ledger.get("c1")).toBeUndefined();
    const hint = result.error?.body.hint as string;
    expect(hint).toContain(String(PRICE_MICRO));
    expect(hint).toMatch(/nothing was settled/i);
    expect(hint).toMatch(/X-PAYMENT/);
  });

  it("falls through a header it cannot decode, leaving the backstop to refuse", async () => {
    const h = harness();
    X402_HEADER = "not-a-payload";

    const result = await fundAndDraw(h, PRICE_MICRO + 1);

    // A malformed credential is the verifier's to report, so the gate declines
    // to blame the caller's arithmetic for it — and the post-settlement gate
    // still catches the mismatch, which is why it stays in the code.
    expect(vi.mocked(verifyX402Payment)).toHaveBeenCalled();
    expect(result.error?.body.error).toBe("funding_commitment_mismatch");
    expect(await h.ledger.get("c1")).toBeUndefined();
  });

  it("leaves an authorization below the advertised figure to the facilitator", async () => {
    const h = harness();
    X402_HEADER = header(ADVERTISED_USDC_MICRO - 1);
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: false,
      amountMsats: 0,
      invalidReason: "insufficient_funds",
    });

    const result = await fundAndDraw(h, PRICE_MICRO);

    // Pro-rating a short authorization lands below `price_micro`, so without
    // the guard this gate fires first and blames the caller's arithmetic for a
    // payment that is simply too small — then hints a correction that cannot
    // work, since no `fund.amount_micro` makes an underfunded authorization
    // settle. `/verify` refuses it pre-settle anyway, so nothing is lost by
    // letting the only party that can say *why* say it.
    expect(vi.mocked(verifyX402Payment)).toHaveBeenCalled();
    expect(result.error?.body.error).toBe("payment_invalid");
    // Still a clean re-present: the 402 rides back out stating the figure to sign.
    expect(result.error?.x402Requirements?.[0]?.maxAmountRequired).toBe(
      String(ADVERTISED_USDC_MICRO)
    );
    expect(await h.ledger.get("c1")).toBeUndefined();
  });
});

describe("an fx refresh between the 402 and the submit", () => {
  // The rate FELL, which is the direction that loses money: the figure the
  // caller was advertised is the larger one, so the facilitator settles and the
  // provider then reads the authorization as an overpayment. Under the BTC hop
  // this pair advertised 10,725 µUSDC and recomputed 10,718 at submit, valuing
  // an exact payment at 10,007 against a caller who signed 10,000 — refused
  // post-settlement, with the money already gone.
  const PRICE = 10_000; // $0.01
  const RATE_AT_402 = 97_500;
  const RATE_AT_SUBMIT = 97_432;

  function fundAtSubmit(h: Harness, amountMicro: number) {
    return verifyUpfrontPayment({
      x402Payment: X402_HEADER,
      x402Config: X402,
      requiredMsats: quoteMsats(PRICE, RATE_AT_SUBMIT),
      fxFetcher: warmFetcher(RATE_AT_SUBMIT),
      creditLedger: h.ledger,
      processedPayments: h.processedPayments,
      priceFiat: { currency: "usd", amountMicro: PRICE },
      callerPubkey: CALLER,
      dvmId: DVM_ID,
      jobId: "job-1",
      creditEnvelope: {
        creditId: "c1",
        drawId: "d1",
        fund: { amountMicro, commitment: fundingCommitment(X402_HEADER) },
      },
    });
  }

  it("advertises the same figure on both sides of the refresh", async () => {
    expect(await advertised(RATE_AT_402, { priceMicro: PRICE })).toBe(
      await advertised(RATE_AT_SUBMIT, { priceMicro: PRICE })
    );
  });

  it("funds and draws a payment of exactly the pre-refresh advertised amount", async () => {
    const h = harness();
    const quoted = await advertised(RATE_AT_402, { priceMicro: PRICE });
    settle(quoted, RATE_AT_SUBMIT);

    const result = await fundAtSubmit(h, PRICE);

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(quoteMsats(PRICE, RATE_AT_SUBMIT));
    const credit = await h.ledger.get("c1");
    expect(credit?.balanceMicro).toBe(PRICE);
    const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(draw?.amountMicro).toBe(PRICE);
  });

  it("still refuses a genuinely wrong fund.amount_micro across the refresh", async () => {
    const h = harness();
    const quoted = await advertised(RATE_AT_402, { priceMicro: PRICE });
    settle(quoted, RATE_AT_SUBMIT);

    // 10,007 is precisely what the old recomputation demanded of this caller.
    // It is wrong now for the same reason it was wrong then, and the refusal
    // stays fail-closed.
    const result = await fundAtSubmit(h, 10_007);

    expect(result.error?.body.error).toBe("funding_commitment_mismatch");
    expect(result.error?.body.expected_micro).toBe(PRICE);
    expect(await h.ledger.get("c1")).toBeUndefined();
  });
});

describe("a price this rule cannot express", () => {
  it("does not advertise x402 for a non-USD job", async () => {
    const result = await verifyUpfrontPayment({
      x402Config: X402,
      requiredMsats: PRICE_MSATS,
      fxFetcher: warmFetcher(RATE),
      priceFiat: { currency: "eur", amountMicro: PRICE_MICRO },
      callerPubkey: CALLER,
      dvmId: DVM_ID,
    });

    expect(result.error?.body.error).toBe("payment_required");
    expect(result.error?.x402Requirements).toBeUndefined();
  });

  it("refuses a presented x402 payment before calling the facilitator", async () => {
    const h = harness();
    const result = await fundAndDraw(h, PRICE_MICRO, { priceCurrency: "eur" });

    expect(result.error?.body).toMatchObject({
      error: "x402_not_offered",
      retryable: false,
    });
    expect(vi.mocked(verifyX402Payment)).not.toHaveBeenCalled();
    expect(await h.ledger.get("c1")).toBeUndefined();
  });
});

describe("the advertisable set, swept", () => {
  // What the single regression case above cannot show: that the figure is
  // rate-INVARIANT rather than merely stable across one small move. The set of
  // figures this provider could advertise for a given USD price, over every
  // rate it could hold, is a single point — so a caller who signs any
  // advertisement lands, whatever the fx cache did and however long they sat
  // on the 402. That is the property; the cases below are its perimeter.
  //
  // Rates span two orders of magnitude, the multi-× pairs are the "sat between
  // the 402 and the submit" scenario at its most extreme, and the price range
  // runs from one micro-dollar (below a satoshi at every rate here, so the
  // sat-ceil bites hardest) to $5.
  const RATES = [10_000, 97_432, 1_000_000];
  const PRICES = [1, 3_174, 5_000_000];

  /** `usd[priceIndex][rateIndex]`, read off the provider's own 402 each time. */
  const usd: number[][] = [];

  beforeEach(async () => {
    if (usd.length > 0) return;
    for (const priceMicro of PRICES) {
      const usdRow: number[] = [];
      for (const rate of RATES) {
        usdRow.push(await advertised(rate, { priceMicro }));
      }
      usd.push(usdRow);
    }
  });

  it("advertises exactly the price at every rate in the sweep", () => {
    PRICES.forEach((priceMicro, p) => {
      RATES.forEach((rate, r) => {
        // The rate rides the assertion so a failure names the pair rather than
        // reporting "expected 3174, got 3898".
        expect({ priceMicro, rate, advertised: usd[p][r] }).toEqual({
          priceMicro,
          rate,
          advertised: priceMicro,
        });
      });
    });
  });

  it("values a payment of any pair's 402 figure at exactly the price", () => {
    // The submit side of every ordered rate pair, including the multi-×
    // moves — this is the arithmetic the fund gate and the ledger both run.
    PRICES.forEach((priceMicro, p) => {
      RATES.forEach((at402, i) => {
        RATES.forEach((atSubmit, j) => {
          expect({
            priceMicro,
            at402,
            atSubmit,
            funded: x402SettledShare(priceMicro, usd[p][j], usd[p][i]),
          }).toEqual({ priceMicro, at402, atSubmit, funded: priceMicro });
        });
      });
    });
  });
});

describe("an extreme rate move between the 402 and the submit", () => {
  // The sweep above is arithmetic over figures the provider really emitted.
  // This drives the whole submit path across the same extremes, so the ledger
  // legs and the pre-settle gate are exercised at the pairs, not just the
  // derivation.
  const CASES = [
    { priceMicro: 1, at402: 1_000_000, atSubmit: 10_000 },
    { priceMicro: 3_174, at402: 10_000, atSubmit: 1_000_000 },
    { priceMicro: 1_000_000, at402: 617_283, atSubmit: 31_415 },
  ];

  for (const { priceMicro, at402, atSubmit } of CASES) {
    it(`funds ${priceMicro}µ across $${at402}/BTC → $${atSubmit}/BTC`, async () => {
      const h = harness();
      const quoted = await advertised(at402, { priceMicro });
      settle(quoted, atSubmit);

      const result = await verifyUpfrontPayment({
        x402Payment: X402_HEADER,
        x402Config: X402,
        requiredMsats: quoteMsats(priceMicro, atSubmit),
        fxFetcher: warmFetcher(atSubmit),
        creditLedger: h.ledger,
        processedPayments: h.processedPayments,
        priceFiat: { currency: "usd", amountMicro: priceMicro },
        callerPubkey: CALLER,
        dvmId: DVM_ID,
        jobId: "job-1",
        creditEnvelope: {
          creditId: "c1",
          drawId: "d1",
          fund: { amountMicro: priceMicro, commitment: fundingCommitment(X402_HEADER) },
        },
      });

      expect(result.error).toBeUndefined();
      expect((await h.ledger.get("c1"))?.balanceMicro).toBe(priceMicro);
      expect((await h.ledger.getDraw({ creditId: "c1", drawId: "d1" }))?.amountMicro).toBe(
        priceMicro
      );
    });
  }
});

describe("a genuine overpayment", () => {
  beforeEach(() => {
    settle(OVERPAID_USDC_MICRO);
  });

  it("still pro-rates at the advertised ratio", async () => {
    const h = harness();
    const result = await fundAndDraw(h, OVERPAID_MICRO);

    expect(result.error).toBeUndefined();
    expect(vi.mocked(verifyX402Payment)).toHaveBeenCalled();
    const credit = await h.ledger.get("c1");
    // The full paid amount funds, as `fundedMicroFor` specifies;
    // the explicit draw takes the quoted price and the rest stays as balance.
    expect(credit?.balanceMicro).toBe(OVERPAID_MICRO);
    expect(credit?.availableMicro).toBe(OVERPAID_MICRO - PRICE_MICRO);
  });

  it("refuses a caller that signed the quoted price, stating the pro-rata figure", async () => {
    const h = harness();
    const result = await fundAndDraw(h, PRICE_MICRO);

    expect(result.error?.body.error).toBe("funding_commitment_mismatch");
    expect(result.error?.body.expected_micro).toBe(OVERPAID_MICRO);
    expect(await h.ledger.get("c1")).toBeUndefined();
  });

  });
