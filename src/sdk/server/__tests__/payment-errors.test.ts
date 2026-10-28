import { describe, expect, it } from "vitest";

import { paymentErrorBody, type PaymentErrorCode } from "../payment";

// Every error code must specify retryability and nonempty display/hint copy.
// Record<PaymentErrorCode, boolean> makes omitted new codes a type error.
const EXPECTED_RETRYABLE: Record<PaymentErrorCode, boolean> = {
  payment_invalid: false,
  x402_not_offered: false,
  payment_method_requires_signature: false,
  x402_settlement_ambiguous: true,
  cashu_unavailable: false,
  cashu_not_p2pk_locked: false,
  mint_health_pending: true,
  cashu_mint_sick: true,
  payment_insufficient: true,
  payment_unapplied: true,
  insufficient_credit: true,
  credit_expired: true,
  credit_unbacked: false,
  credit_not_found: true,
  tempo_channel_closing: false,
  // only the operator finishing or closing out the wedged refund
  // lifts this hold, so re-sending the identical request can never clear it.
  settlement_pending: false,
  draw_conflict: false,
  funding_commitment_mismatch: false,
  credit_not_supported: false,
  one_shot_credit_not_supported: false,
  credit_below_min: true,
  // re-sending the identical sub-floor amount can never succeed —
  // the fix is a different amount or a different rail, both named in `extra`.
  below_rail_minimum: false,
  credit_over_max: true,
  credit_id_unavailable: true,
  nothing_to_drain: true,
  // unlike `nothing_to_drain`, the balance is real — it is just
  // worth less than one satoshi at the rate its own funding landed at, and no
  // amount of waiting changes that. Only a top-up makes it reclaimable.
  drain_below_dust: false,
  drain_not_found: true,
  drain_method_unsupported: false,
  drain_conflict: false,
  tempo_channel_exit_required: false,
  // the voucher verified and the ledger rolled back, so the identical
  // request is exactly what should be re-sent once the chain path recovers.
  x402_settlement_submission_failed: true,
  settlement_not_on_chain: true,
  chain_unreachable: true,
  settlement_unbookmarked: false,
  facilitator_channel_state_unavailable: true,
  // `lightning_settlement_pending` is retryable because re-sending
  // the same request IS the protocol — that is how a paid invoice gets
  // credited. `lightning_invoice_expired` is not: that bolt11 can never be
  // paid, so only a new fund_id can succeed.
  lightning_settlement_pending: true,
  lightning_invoice_expired: false,
  lightning_unavailable: true,
  missing_request_id: false,
  missing_lock_pubkey: false,
  invalid_token: false,
  not_p2pk_locked: false,
  wrong_lock_pubkey: false,
  lock_not_exclusive: false,
  proof_not_unspent: false,
  mint_unreachable: true,
  proof_pending: true,
  replay_rejected: false,
};

const ALL_CODES = Object.keys(EXPECTED_RETRYABLE) as PaymentErrorCode[];

describe("paymentErrorBody", () => {
  it.each(ALL_CODES)("carries the four agent-facing fields for %s", (code) => {
    const body = paymentErrorBody(code, { message: "operator log line" });

    expect(body.error).toBe(code);
    expect(body.message).toBe("operator log line");
    // display/hint are relayed to a human verbatim — must be non-empty strings.
    expect(typeof body.display).toBe("string");
    expect((body.display as string).length).toBeGreaterThan(0);
    expect(typeof body.hint).toBe("string");
    expect((body.hint as string).length).toBeGreaterThan(0);
    expect(body.retryable).toBe(EXPECTED_RETRYABLE[code]);
  });

  it("uses the per-code hint by default and lets a caller override it", () => {
    const defaulted = paymentErrorBody("cashu_mint_sick", { message: "m" });
    const overridden = paymentErrorBody("cashu_mint_sick", {
      message: "m",
      hint: "Try one of: https://healthy.example",
    });

    expect(defaulted.hint).not.toBe("Try one of: https://healthy.example");
    expect(overridden.hint).toBe("Try one of: https://healthy.example");
    // display still comes from the table — override is hint-only.
    expect(overridden.display).toBe(defaulted.display);
  });

  it("preserves ad-hoc extras (mints / amounts) alongside the standard fields", () => {
    const body = paymentErrorBody("payment_insufficient", {
      message: "short pay",
      extra: {
        required_msats: 1000,
        received_msats: 400,
        mints: ["https://mint.example"],
      },
    });

    expect(body.required_msats).toBe(1000);
    expect(body.received_msats).toBe(400);
    expect(body.mints).toEqual(["https://mint.example"]);
    // extras don't clobber the contract fields.
    expect(body.error).toBe("payment_insufficient");
    expect(body.retryable).toBe(true);
    expect(typeof body.display).toBe("string");
  });

  it("keeps display free of the internal message jargon", () => {
    // The whole point of `display` is that an agent can relay it verbatim: it
    // must not echo the operator-facing `message`, which carries rail internals.
    const body = paymentErrorBody("payment_invalid", {
      message: "MPP credential verification failed",
    });
    expect(body.display).not.toBe(body.message);
    expect(body.display as string).not.toContain("MPP credential");
  });

  it("describes ambiguous x402 reconciliation as a service problem, not a failed payment", () => {
    const absent = paymentErrorBody("settlement_not_on_chain", { message: "absent" });
    const unreachable = paymentErrorBody("chain_unreachable", { message: "rpc timeout" });

    expect(absent.display).toContain("balance is still in the x402 channel");
    expect(absent.hint).toContain("same drain_id");
    expect(unreachable.display).toContain("service-side problem");
    expect(unreachable.display).toContain("not a failure of your payment");
    expect(unreachable.hint).toContain("Do not re-sign repeatedly");
  });
});
