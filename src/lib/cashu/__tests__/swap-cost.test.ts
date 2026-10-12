import { Amount, type Wallet } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import { swapFeeForProofs, swapSendReserve } from "../swap-cost";

/**
 * A mint keyset priced at `ppk` per input, with the power-of-two denominations
 * every real keyset carries. `getFeesForKeyset` / `getFeesForProofs` reproduce
 * cashu-ts's own bodies so the reserve is exercised against the arithmetic the
 * swap will actually do.
 */
function mintAt(ppk: number, keysetId = "k1", denominations?: number[]): Wallet {
  const keys: Record<number, string> = {};
  for (const a of denominations ?? powersOfTwoTo(1024)) keys[a] = "02" + "cc".repeat(32);
  return {
    getKeyset: () => ({ id: keysetId, fee: ppk, keys }),
    getFeesForKeyset: (nInputs: number, id: string) => {
      if (id !== keysetId) throw new Error(`No keyset found with ID ${id}`);
      return Amount.from(Math.floor(Math.max((nInputs * ppk + 999) / 1000, 0)));
    },
    getFeesForProofs: (proofs: { id: string }[]) => {
      let ppkSum = 0;
      for (const p of proofs) {
        if (p.id !== keysetId)
          throw new Error(`Could not get fee. No keyset found for keyset id: ${p.id}`);
        ppkSum += ppk;
      }
      return Amount.from(Math.ceil(ppkSum / 1000));
    },
  } as unknown as Wallet;
}

function inputs(n: number, id = "k1"): { id: string }[] {
  return Array.from({ length: n }, () => ({ id }));
}

function powersOfTwoTo(max: number): number[] {
  const out: number[] = [];
  for (let a = 1; a <= max; a *= 2) out.push(a);
  return out;
}

describe("swapSendReserve", () => {
  it("reserves nothing at a zero-fee mint", () => {
    const reserve = swapSendReserve(mintAt(0), 10);
    expect(reserve(inputs(1))).toBe(0);
    expect(reserve(inputs(40))).toBe(0);
  });

  it("reserves 2 sats for a 10-sat send off one input at 100 ppk", () => {
    // The figure measured against a live Nutshell 0.19.2 mint: splitAmount(10)
    // is [8,2], so the receiver fee `includeFees(true)` adds is
    // ceil(2*100/1000) = 1, and this swap's own input fee is ceil(1*100/1000)
    // = 1. The old per-input-only model reserved 1 and the mint refused.
    const reserve = swapSendReserve(mintAt(100), 10);
    expect(reserve(inputs(1))).toBe(2);
  });

  it("grows the per-input half with the input count, holding the receiver half fixed", () => {
    const reserve = swapSendReserve(mintAt(100), 10);
    // receiver fee 1, plus ceil(n*100/1000).
    expect(reserve(inputs(10))).toBe(2);
    expect(reserve(inputs(11))).toBe(3);
    expect(reserve(inputs(20))).toBe(3);
    expect(reserve(inputs(21))).toBe(4);
  });

  it("runs the receiver-fee fixpoint when the fee outputs cost a fee of their own", () => {
    // amount 1023 = ten 1-bit denominations; at 100 ppk that is a 1-sat
    // receiver fee, whose own [1] output makes eleven — still 2 ppk-sats… so
    // step up to 1000 ppk, where each output costs a full sat: ten outputs =
    // 10 sats of receiver fee, whose split [8,2] adds two more outputs, which
    // costs 12, which splits to [8,4] — the loop settles at 12.
    const reserve = swapSendReserve(mintAt(1000), 1023);
    expect(reserve([])).toBe(12);
  });

  it("runs the fixpoint to convergence however far past the amount it settles", () => {
    // A 1-sat send at 3000 ppk settles at a receiver fee of 8 — the fee's own
    // outputs keep costing more than the fee until it lands on the single
    // [8] denomination. Any bound drawn from the amount would have cut the
    // loop short and handed the mint an under-sized swap, which is the bug
    // this module exists to prevent.
    expect(swapSendReserve(mintAt(3000), 1)([])).toBe(8);
  });

  it("refuses a keyset whose fixpoint diverges rather than under-reserving", () => {
    // A keyset with nothing but a 1-sat denomination splits every fee into as
    // many outputs as it has sats, so at 1000 ppk each pass costs exactly what
    // it buys and the loop never settles. The caller reads this as
    // `keys_unavailable` and fails over to another mint.
    const oneSatOnly = mintAt(1000, "k1", [1]);
    expect(() => swapSendReserve(oneSatOnly, 1)).toThrow(/cannot be priced at this mint/);
  });

  it("propagates a mint that won't name a keyset", () => {
    const broken = {
      getKeyset: () => {
        throw new Error("Keyset has no keys loaded");
      },
    } as unknown as Wallet;
    expect(() => swapSendReserve(broken, 10)).toThrow("Keyset has no keys loaded");
  });
});

describe("swapFeeForProofs", () => {
  it("prices the inputs at their own keysets", () => {
    expect(swapFeeForProofs(mintAt(100), inputs(1))).toBe(1);
    expect(swapFeeForProofs(mintAt(100), inputs(11))).toBe(2);
  });

  it("falls back to the bound keyset when a proof's keyset isn't loaded", () => {
    // A throw here would happen inside proof selection under the wallet lock
    // and abandon a spend the wallet can afford.
    const wallet = mintAt(100);
    expect(swapFeeForProofs(wallet, inputs(11, "unknown-keyset"))).toBe(2);
  });
});
