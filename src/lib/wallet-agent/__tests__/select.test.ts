import { describe, expect, it } from "vitest";

import type { SwapSendReserve } from "../../cashu/swap-cost";
import { coveringMintsForSpend, selectProofsForSpend } from "../select";
import type { AgentProof } from "../store";

function proof(
  mint: string,
  amount: number,
  secret: string,
  status: "valid" | "in_flight" = "valid"
): AgentProof {
  return {
    mint,
    secret,
    C: "02" + "ff".repeat(32),
    amount,
    id: "k1",
    locked_to_pubkey: "02" + "ab".repeat(32),
    status,
  };
}

const MINT = "https://mint.example";

/**
 * The per-input half of a swap's cost at `ppk`, on its own. The selector's job
 * is to honour whatever reserve it is handed; that the reserve itself matches
 * cashu-ts is `swap-cost.test.ts`'s job.
 */
function inputFeeOnly(ppk: number): SwapSendReserve {
  return (inputs) => Math.ceil((inputs.length * ppk) / 1000);
}

describe("selectProofsForSpend", () => {
  it("picks largest-first to minimise input count (fewer inputs ⇒ smaller mint fee)", () => {
    const proofs = [proof(MINT, 1, "a"), proof(MINT, 2, "b"), proof(MINT, 4, "c")];
    const r = selectProofsForSpend({ proofs, mintAllowlist: [MINT], amountSats: 3 });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.totalSats).toBe(4);
    expect(r.selected.map((p) => p.amount)).toEqual([4]);
    expect(r.mint).toBe(MINT);
  });

  it("with no swapReserveSats, target is exactly amountSats (no swap-fee buffer)", () => {
    const proofs = [proof(MINT, 5, "a"), proof(MINT, 5, "b"), proof(MINT, 1, "c")];
    const r = selectProofsForSpend({ proofs, mintAllowlist: [MINT], amountSats: 10 });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.totalSats).toBe(10);
    expect(r.selected.map((p) => p.amount)).toEqual([5, 5]);
  });

  it("with a reserve, target grows with input count (insufficient when wallet covers price but not price + count-aware fee)", () => {
    // 18 × 1-sat proofs at input_fee_ppk=100 → fee for 18 inputs = ceil(18*100/1000) = 2 sats.
    // Need total ≥ amountSats + 2 = 18 + 2 = 20, but balance is only 18 → insufficient_balance.
    const proofs = Array.from({ length: 18 }, (_, i) => proof(MINT, 1, `p${i}`));
    const r = selectProofsForSpend({
      proofs,
      mintAllowlist: [MINT],
      amountSats: 18,
      swapReserveSats: inputFeeOnly(100),
    });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.code).toBe("insufficient_balance");
    }
  });

  it("with a reserve, succeeds when the wallet covers price + count-aware fee", () => {
    // 21 × 1-sat proofs at input_fee_ppk=100. Walk: total grows 1,2,...,21; fee
    // grows 1,1,...,3. Need total ≥ 18 + fee at the current count.
    // n=20: total=20, fee=ceil(20*100/1000)=2, required=20 → covers exactly.
    const proofs = Array.from({ length: 21 }, (_, i) => proof(MINT, 1, `p${i}`));
    const r = selectProofsForSpend({
      proofs,
      mintAllowlist: [MINT],
      amountSats: 18,
      swapReserveSats: inputFeeOnly(100),
    });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.selected.length).toBe(20);
    expect(r.totalSats).toBe(20);
  });

  it("with a reserve and mixed denominations, largest-first keeps input count tiny", () => {
    // 1 × 50 plus 30 × 1-sat proofs. Need 18 at input_fee_ppk=100. Largest-first:
    // pick the 50, total=50, count=1 → required=18+1=19; 50 ≥ 19. Done in one input.
    const proofs = [
      proof(MINT, 50, "big"),
      ...Array.from({ length: 30 }, (_, i) => proof(MINT, 1, `p${i}`)),
    ];
    const r = selectProofsForSpend({
      proofs,
      mintAllowlist: [MINT],
      amountSats: 18,
      swapReserveSats: inputFeeOnly(100),
    });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.selected.map((p) => p.amount)).toEqual([50]);
    expect(r.totalSats).toBe(50);
  });

  it("returns no_eligible_mint when wallet has no proofs at any DVM mint", () => {
    const proofs = [proof("https://other.mint", 1, "a"), proof("https://other.mint", 2, "b")];
    const r = selectProofsForSpend({ proofs, mintAllowlist: [MINT], amountSats: 1 });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.code).toBe("no_eligible_mint");
    }
  });

  it("returns insufficient_balance when wallet has matching mint but not enough sats", () => {
    const proofs = [proof(MINT, 1, "a"), proof(MINT, 2, "b")];
    const r = selectProofsForSpend({ proofs, mintAllowlist: [MINT], amountSats: 100 });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.code).toBe("insufficient_balance");
    }
  });

  it("reserves the whole swap cost, not just the per-input fee", () => {
    // Price 10 plus input fee 1 and receiver fee 1 needs 12; [8,2,1] is short.
    const proofs = [proof(MINT, 8, "a"), proof(MINT, 2, "b"), proof(MINT, 1, "c")];
    const reserve: SwapSendReserve = (inputs) => 1 + Math.ceil((inputs.length * 100) / 1000);

    const r = selectProofsForSpend({
      proofs,
      mintAllowlist: [MINT],
      amountSats: 10,
      swapReserveSats: reserve,
    });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error.code).toBe("insufficient_balance");
  });

  it("one more sat clears the same shape", () => {
    // Same mint and price, wallet holding 12: [8,2,1,1]. Walk stops at
    // [8,2,1,1] = 12 ≥ 10 + 1 + ceil(4*100/1000) = 12.
    const proofs = [
      proof(MINT, 8, "a"),
      proof(MINT, 2, "b"),
      proof(MINT, 1, "c"),
      proof(MINT, 1, "d"),
    ];
    const r = selectProofsForSpend({
      proofs,
      mintAllowlist: [MINT],
      amountSats: 10,
      swapReserveSats: (inputs) => 1 + Math.ceil((inputs.length * 100) / 1000),
    });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.totalSats).toBe(12);
    expect(r.selected).toHaveLength(4);
  });

  it("ignores in_flight proofs (only valid proofs count toward selection)", () => {
    const proofs = [proof(MINT, 5, "a", "in_flight"), proof(MINT, 5, "b")];
    const r = selectProofsForSpend({ proofs, mintAllowlist: [MINT], amountSats: 10 });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.code).toBe("insufficient_balance");
    }
  });

  it("first-mint-wins: a covering mint earlier in the allowlist takes precedence", () => {
    const A = "https://a.mint";
    const B = "https://b.mint";
    const proofs = [proof(A, 100, "a"), proof(B, 5, "b1"), proof(B, 5, "b2"), proof(B, 5, "b3")];
    const r = selectProofsForSpend({ proofs, mintAllowlist: [A, B], amountSats: 10 });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.mint).toBe(A);
    expect(r.totalSats).toBe(100);
  });

  it("rejects non-positive amounts", () => {
    const r = selectProofsForSpend({ proofs: [], mintAllowlist: [MINT], amountSats: 0 });
    expect("error" in r).toBe(true);
  });

  it("rejects empty mintAllowlist", () => {
    const r = selectProofsForSpend({ proofs: [], mintAllowlist: [], amountSats: 1 });
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error.code).toBe("no_eligible_mint");
    }
  });
});

describe("coveringMintsForSpend", () => {
  const A = "https://a.mint";
  const B = "https://b.mint";
  const C = "https://c.mint";

  it("returns every covering mint in allowlist order, so failover walks the DVM's own preference", () => {
    const proofs = [proof(A, 100, "a"), proof(B, 100, "b"), proof(C, 100, "c")];
    const r = coveringMintsForSpend({ proofs, mintAllowlist: [C, A, B], amountSats: 10 });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.mints).toEqual([C, A, B]);
  });

  it("excludes mints that can't cover, so failover never attempts a mint it already knows is short", () => {
    const proofs = [proof(A, 4, "a"), proof(B, 100, "b")];
    const r = coveringMintsForSpend({ proofs, mintAllowlist: [A, B], amountSats: 10 });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.mints).toEqual([B]);
  });

  it("ignores in-flight and builder-reserved proofs, matching the selection pool", () => {
    const reserved: AgentProof = {
      ...proof(A, 100, "a"),
      reserved_for: "builder/scrape.example.com",
    };
    const proofs = [reserved, proof(B, 100, "b", "in_flight")];
    const r = coveringMintsForSpend({ proofs, mintAllowlist: [A, B], amountSats: 10 });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error.code).toBe("no_eligible_mint");
  });

  it("returns insufficient_balance when a mint holds something but not enough", () => {
    const r = coveringMintsForSpend({
      proofs: [proof(A, 4, "a")],
      mintAllowlist: [A],
      amountSats: 10,
    });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error.code).toBe("insufficient_balance");
  });

  it("dedupes a repeated mint so failover attempts it at most once per call", () => {
    const proofs = [proof(A, 100, "a"), proof(B, 100, "b")];
    const r = coveringMintsForSpend({ proofs, mintAllowlist: [A, B, A], amountSats: 10 });
    if ("error" in r) throw new Error(`unexpected error: ${r.error.message}`);
    expect(r.mints).toEqual([A, B]);
  });

  it("returns no_eligible_mint for an empty allowlist and a non-positive amount is rejected", () => {
    const empty = coveringMintsForSpend({ proofs: [], mintAllowlist: [], amountSats: 1 });
    expect("error" in empty && empty.error.code).toBe("no_eligible_mint");
    const zero = coveringMintsForSpend({ proofs: [], mintAllowlist: [A], amountSats: 0 });
    expect("error" in zero && zero.error.code).toBe("insufficient_balance");
  });
});
