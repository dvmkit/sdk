import { OutputData, PaymentRequest } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/index";
import { cashuPaymentRequest, proofSetRequestId, withFxHistory } from "../cashu-payment-request";
import { assessCashuLock } from "../wallet-accumulator-receive";

describe("cashuPaymentRequest", () => {
  const DVM_KEY = toLockPubkey("02" + "ab".repeat(32));
  const PAYER_KEY = "02" + "ef".repeat(32);
  const base = { requiredMsats: 21_500, mints: ["https://mint.example.com"], lockPubkey: DVM_KEY };
  const WINDOW = 518_400;

  it("encodes the same request as before when refund_delay is off", () => {
    // Captured from the encoder before refund_delay existed; any byte change breaks wallets' caches and fixtures.
    expect(cashuPaymentRequest(base)).toBe(
      "creqApGFhFmF1Y3NhdGFtgXgYaHR0cHM6Ly9taW50LmV4YW1wbGUuY29tZW51dDEwo2FrZFAyUEthZHhCMDJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYXSA"
    );
  });

  it("advertises the enforced window plus a ten-minute round trip as refund_delay", () => {
    const request = PaymentRequest.fromEncodedRequest(cashuPaymentRequest({ ...base, lockWindowSeconds: WINDOW }));
    expect(request.nut10).toEqual({ kind: "P2PK", data: DVM_KEY, tags: [["refund_delay", "519000"]] });
  });

  it("is banked when a wallet builds its lock from the request, and floors that lock where the receive path does", () => {
    const request = PaymentRequest.fromEncodedRequest(cashuPaymentRequest({ ...base, lockWindowSeconds: WINDOW }));
    const delay = Number(request.nut10!.tags![0]![1]);
    const receivedAt = 1_790_000_000;
    // A payer following the proposal locks to its clock plus the delay; the payee's floor is that less the tolerance.
    const payerSecret = (locktime: number) => {
      const lock = { ...request.toP2PKOptions()!, locktime, refundKeys: [PAYER_KEY] };
      return new TextDecoder().decode(OutputData.createSingleP2PKData(lock, 1, "00" + "11".repeat(7)).secret);
    };
    const honest = payerSecret(receivedAt + delay - 600);
    expect(JSON.parse(honest)[1].tags).toContainEqual(["refund_delay", "519000"]);
    const floorSec = receivedAt + WINDOW;
    expect(assessCashuLock(honest, [DVM_KEY], receivedAt, floorSec)).toEqual({ kind: "exclusive", lockPubkey: DVM_KEY });
    expect(assessCashuLock(payerSecret(receivedAt + delay - 601), [DVM_KEY], receivedAt, floorSec)).toMatchObject({
      code: "lock_not_exclusive",
      locktimeBelowFloor: true,
    });
  });
});

describe("proofSetRequestId", () => {
  it("names a proof set the same however a wallet orders its proofs", () => {
    expect(proofSetRequestId(["b", "a", "c"])).toBe(proofSetRequestId(["c", "b", "a"]));
  });

  it("names a different set differently, including a subset of it", () => {
    const whole = proofSetRequestId(["a", "b"]);
    expect(proofSetRequestId(["a"])).not.toBe(whole);
    expect(proofSetRequestId(["a", "c"])).not.toBe(whole);
    // Joining secrets without a delimiter would make these collide.
    expect(proofSetRequestId(["ab", "c"])).not.toBe(proofSetRequestId(["a", "bc"]));
  });
});

describe("withFxHistory", () => {
  function fetcher(rates: number[]): FxFetcher {
    let call = 0;
    return {
      // A fresh object on every call, as a fetcher re-reading its source would return.
      fetch: () => Promise.resolve({ rates: { usd: rates[Math.min(call++, rates.length - 1)]! }, as_of: `t${call}` }),
      supportedCurrencies: () => ["usd"],
    };
  }

  const at = (usd: number) => ({ rates: { usd }, as_of: "any" }) as FxRateSnapshot;

  it("keeps the replaced rates reachable while later fetches return the same rates", async () => {
    const fx = withFxHistory(fetcher([100, 80, 80, 80]));
    await fx.fetch();
    expect(fx.previousFor(at(100))).toBeUndefined();
    await fx.fetch();
    await fx.fetch();
    await fx.fetch();
    expect(fx.previousFor(at(80))?.rates.usd).toBe(100);
  });

  it("times the hold from the last price at the replaced rates, so an idle DVM does not honour an old quote", async () => {
    let clock = 0;
    const fx = withFxHistory(fetcher([100, 100, 80]), { holdWindowMs: 600_000, now: () => clock });
    await fx.fetch();
    clock = 1_000_000;
    await fx.fetch(); // the same rates priced another request
    clock = 1_000_001;
    await fx.fetch(); // the refresh
    clock = 1_600_000;
    expect(fx.previousFor(at(80))?.rates.usd).toBe(100);
    clock += 1;
    expect(fx.previousFor(at(80))).toBeUndefined();
  });

  it("gives no hold when the replaced rates last priced anything longer ago than the window", async () => {
    let clock = 0;
    const fx = withFxHistory(fetcher([100, 80]), { holdWindowMs: 600_000, now: () => clock });
    await fx.fetch();
    clock = 5_000_000; // idle for hours, then the first request after waking sees new rates
    await fx.fetch();
    expect(fx.previousFor(at(80))).toBeUndefined();
  });

  it("holds against the rates that priced the request, not whichever rates a later refresh made current", async () => {
    const fx = withFxHistory(fetcher([100, 80, 64]));
    await fx.fetch();
    const pricedAt = await fx.fetch();
    await fx.fetch(); // a refresh landing while the request is being verified
    expect(fx.previousFor(pricedAt)?.rates.usd).toBe(100);
    expect(fx.previousFor(at(64))?.rates.usd).toBe(80);
  });
});
