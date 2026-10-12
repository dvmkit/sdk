import type { SwapSendReserve } from "../cashu/swap-cost";
import type { AgentProof } from "./store";

/**
 * Structured failure modes from {@link selectProofsForSpend}. Surfaced
 * through `dvm request` so the CLI's `--human` output and JSON-mode
 * `error` field can carry the same `code`/`message`/`hint` shape every
 * other DVM-CLI surface uses.
 */
export type SelectError =
  | {
      code: "no_eligible_mint";
      message: string;
      hint: string;
    }
  | {
      code: "insufficient_balance";
      message: string;
      hint: string;
    };

export interface SelectionResult {
  /** The chosen proofs, in the order they should be sent to the DVM. */
  selected: AgentProof[];
  mint: string;
  /** Sum of `selected[].amount`, in sats. Equals `amountSats + the swap's reserve` or more — overshoot returns as `keep` change. */
  totalSats: number;
}

/**
 * Pick proofs from the agent wallet to cover a per-call swap-path spend
 * Only used by the swap path — reserve-direct
 * has its own bounded-overshoot subset-sum.
 *
 * Algorithm: for each mint in `mintAllowlist` order (first-mint-wins),
 * greedily pick the wallet's `status: "valid"` proofs with no `reserved_for`
 * marker at that mint in **descending** amount order (largest-first) until
 * the cumulative total covers `amountSats + swapReserveSats(picked so far)`.
 * Largest-first minimises input count so the mint's per-input swap fee stays
 * small and predictable; the resulting overshoot returns to the wallet as
 * `keep` change (see `spend.ts`'s `keepAsP2PK`).
 *
 * Eligibility here is based on lifecycle status and reservation metadata, not
 * on the proof's NUT-11 lock authority. `reserved_for` keeps pre-funded
 * reserve proofs out of this pool for the reserve-direct path, while
 * `locked_to_pubkey` records the P2PK authority. This filter therefore allows
 * explicitly unlocked proofs; the later swap supplies the agent's master key
 * for input signing, so this selector does not itself establish that every
 * candidate is spendable by that key.
 *
 * `swapReserveSats` prices the swap this selection feeds — built for the
 * chosen mint by {@link swapSendReserve}, which derives it from cashu-ts's own
 * fee helpers rather than re-modelling NUT-02 here (the model this
 * replaced reserved only the per-input fee and missed what `includeFees(true)`
 * adds, so a wallet whose total landed exactly on the target had its swap
 * refused by the mint). The swap path enumerates its candidate mints with
 * {@link coveringMintsForSpend} first, then calls this once per candidate it
 * actually attempts, scoped to that mint and with that mint's own reserve —
 * fees are per mint and are never carried across a failover. With
 * `swapReserveSats` omitted the target is just `amountSats`.
 *
 * Returns `{ error }` when no mint can satisfy the call. Callers surface
 * `no_eligible_mint` / `insufficient_balance` as the outcome — the
 * agent-wallet cashu_p2pk rail is the only Cashu path.
 */
export function selectProofsForSpend(args: {
  proofs: AgentProof[];
  mintAllowlist: string[];
  amountSats: number;
  swapReserveSats?: SwapSendReserve;
}): SelectionResult | { error: SelectError } {
  if (args.amountSats <= 0) {
    return {
      error: {
        code: "insufficient_balance",
        message: `amountSats must be positive; got ${args.amountSats}.`,
        hint: "Pass a positive sat amount.",
      },
    };
  }
  if (args.mintAllowlist.length === 0) {
    return { error: noAcceptedMintsError() };
  }

  const reserveSats = args.swapReserveSats ?? (() => 0);
  let largestEligibleBalance = 0;

  for (const mint of args.mintAllowlist) {
    const candidates = eligibleProofsAt(args.proofs, mint);
    const balance = candidates.reduce((sum, p) => sum + p.amount, 0);
    largestEligibleBalance = Math.max(largestEligibleBalance, balance);
    if (balance < args.amountSats) continue;

    const selected: AgentProof[] = [];
    let total = 0;
    for (const p of candidates) {
      selected.push(p);
      total += p.amount;
      const required = args.amountSats + reserveSats(selected);
      if (total >= required) {
        return { selected, mint, totalSats: total };
      }
    }
  }

  return { error: noCoverError(largestEligibleBalance, args.amountSats) };
}

/**
 * Every mint in `mintAllowlist` order whose eligible balance covers
 * `amountSats` before fees, deduplicated — the candidate set the spend's mint
 * failover walks, each entry attempted at most once per call.
 *
 * This is the multi-answer form of the fee-free provisional pass
 * {@link selectProofsForSpend} used to run: the mint's `input_fee_ppk` isn't
 * known until the mint is loaded, so the fee-aware selection happens per
 * candidate, once, at attempt time. The first entry is exactly the mint the
 * old single-answer provisional pass would have returned, so an allowlist with
 * one covering mint is unchanged.
 *
 * Returns the same `no_eligible_mint` / `insufficient_balance` errors as
 * {@link selectProofsForSpend} when nothing covers — callers surface them
 * identically, and both rely on that for the soft fall-through to another rail.
 */
export function coveringMintsForSpend(args: {
  proofs: AgentProof[];
  mintAllowlist: string[];
  amountSats: number;
}): { mints: string[] } | { error: SelectError } {
  if (args.amountSats <= 0) {
    return {
      error: {
        code: "insufficient_balance",
        message: `amountSats must be positive; got ${args.amountSats}.`,
        hint: "Pass a positive sat amount.",
      },
    };
  }
  if (args.mintAllowlist.length === 0) {
    return { error: noAcceptedMintsError() };
  }

  const mints: string[] = [];
  let largestEligibleBalance = 0;
  for (const mint of args.mintAllowlist) {
    const balance = eligibleProofsAt(args.proofs, mint).reduce((sum, p) => sum + p.amount, 0);
    largestEligibleBalance = Math.max(largestEligibleBalance, balance);
    // Deduped: a DVM is free to advertise the same mint twice, and each mint
    // must be attempted at most once per call.
    if (balance >= args.amountSats && !mints.includes(mint)) mints.push(mint);
  }

  if (mints.length === 0) {
    return { error: noCoverError(largestEligibleBalance, args.amountSats) };
  }
  return { mints };
}

/**
 * Valid, unreserved proofs at `mint`, largest first. Largest-first minimises
 * input count so the mint's per-input swap fee stays small and predictable.
 *
 * `reserved_for` is application-level reservation metadata for pre-funded
 * reserve proofs; it is separate from `locked_to_pubkey`, the NUT-11 P2PK
 * authority. This filter does not assert that a proof is master-key-locked,
 * so explicitly unlocked proofs can appear. Reserve proofs enter the spend
 * flow via the reserve-direct path in `prepareAgentSpend`.
 */
function eligibleProofsAt(proofs: AgentProof[], mint: string): AgentProof[] {
  return proofs
    .filter((p) => p.mint === mint && p.status === "valid" && p.reserved_for === undefined)
    .slice()
    .sort((a, b) => b.amount - a.amount);
}

function noAcceptedMintsError(): SelectError {
  return {
    code: "no_eligible_mint",
    message: "DVM advertises no Cashu mints for the agent-wallet path.",
    hint: "Use a different DVM, or fall back to the legacy --auto-pay flow.",
  };
}

function noCoverError(largestEligibleBalance: number, amountSats: number): SelectError {
  if (largestEligibleBalance === 0) {
    return {
      code: "no_eligible_mint",
      message: "Agent wallet has no proofs at any of the DVM's accepted mints.",
      hint: "Fund the wallet at one of the DVM's accepted mints with: dvm wallet fund <amount>",
    };
  }
  return {
    code: "insufficient_balance",
    message: `Agent wallet has ${largestEligibleBalance} sats at the DVM's mints; need ${amountSats} plus the per-call mint swap fee.`,
    hint: "Top the wallet up with: dvm wallet fund <amount>",
  };
}
