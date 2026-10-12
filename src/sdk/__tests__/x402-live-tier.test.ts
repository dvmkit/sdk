import { describe, expect, it, vi } from "vitest";

import { NetworkGuardBlockedError } from "../../test-support/network-guard-policy";
import {
  canRunUnfundedX402Rejection,
  classifyX402Failure,
  isExactEvmVerificationHealthy,
  isLocallyProvenUnfundedRejection,
  loadX402TestnetFacilitatorConfig,
  payerFundingDetail,
  skipLiveX402,
  skipOrFailLiveX402,
  type SkippableTestContext,
  x402FacilitatorEndpointClass,
  x402FailureReason,
  x402RpcEndpointClass,
} from "./__helpers__/x402-live-tier";

/**
 * The skip-vs-fail boundary for the live Base Sepolia settlement tier
 * driven here without the testnet secret — which is the point: the
 * tier itself only runs in CI with `X402_TESTNET_PRIVATE_KEY` provisioned, so
 * the decision that classifies a facilitator outage separately from a code failure has to be
 * assertable from a plain `npm test`.
 */

/** Stands in for vitest's `TestContext`, recording the note a skip carries. */
function stubContext(): { ctx: SkippableTestContext; notes: string[] } {
  const notes: string[] = [];
  const skip = ((...args: unknown[]) => {
    notes.push(typeof args[0] === "string" ? args[0] : String(args[1] ?? ""));
    throw new Error("test skipped");
  }) as SkippableTestContext["skip"];
  return { ctx: { skip }, notes };
}

describe("x402RpcEndpointClass", () => {
  it("recognises Base's public endpoint without depending on URL decoration", () => {
    expect(x402RpcEndpointClass("https://sepolia.base.org")).toBe("public fallback RPC");
    expect(x402RpcEndpointClass("https://sepolia.base.org/rpc?probe=1")).toBe(
      "public fallback RPC"
    );
  });

  it("labels an authenticated non-public endpoint without returning its credential", () => {
    const credential = "test-credential-that-must-not-reach-logs";
    const label = x402RpcEndpointClass(
      `https://api.developer.coinbase.com/rpc/v1/base-sepolia/${credential}`
    );

    expect(label).toBe("dedicated RPC");
    expect(label).not.toContain(credential);
    expect(label).not.toContain("coinbase.com");
  });

  it("keeps a malformed configured value redacted", () => {
    expect(x402RpcEndpointClass("credential-shaped but not a URL")).toBe("configured RPC");
  });
});

describe("x402 testnet facilitator config", () => {
  it("keeps the public fallback available for an explicit local run", () => {
    expect(loadX402TestnetFacilitatorConfig({})).toEqual({
      facilitator: "https://x402.org/facilitator",
    });
  });

  it("loads a complete dedicated auth pair", () => {
    expect(
      loadX402TestnetFacilitatorConfig({
        X402_TESTNET_FACILITATOR: "https://facilitator.example.test/x402",
        X402_TESTNET_FACILITATOR_KEY_ID: "key-id",
        X402_TESTNET_FACILITATOR_KEY_SECRET: "key-secret",
      })
    ).toEqual({
      facilitator: "https://facilitator.example.test/x402",
      facilitatorAuth: { keyId: "key-id", keySecret: "key-secret" },
    });
  });

  it.each([
    { X402_TESTNET_FACILITATOR_KEY_ID: "key-id" },
    { X402_TESTNET_FACILITATOR_KEY_SECRET: "key-secret" },
  ])("fails loudly on a partial auth pair", (env) => {
    expect(() => loadX402TestnetFacilitatorConfig(env)).toThrow(
      "X402_TESTNET_FACILITATOR_KEY_ID and X402_TESTNET_FACILITATOR_KEY_SECRET must be configured together"
    );
  });

  it("fails loudly when CI requires dedicated auth and any part is absent", () => {
    expect(() => loadX402TestnetFacilitatorConfig({ X402_TESTNET_REQUIRE_AUTH: "true" })).toThrow(
      "Authenticated x402 testnet facilitator required"
    );
  });
});

describe("x402FacilitatorEndpointClass", () => {
  it("recognises only the exact public fallback", () => {
    expect(x402FacilitatorEndpointClass("https://x402.org/facilitator/")).toBe(
      "public fallback facilitator"
    );
    expect(x402FacilitatorEndpointClass("https://api.cdp.coinbase.com/platform/v2/x402")).toBe(
      "dedicated facilitator"
    );
  });

  it("never returns a credential-bearing URL", () => {
    const credential = "secret-that-must-not-reach-logs";
    const label = x402FacilitatorEndpointClass(`https://facilitator.example.test/${credential}`);
    expect(label).toBe("dedicated facilitator");
    expect(label).not.toContain(credential);
    expect(label).not.toContain("example.test");
  });
});

describe("canRunUnfundedX402Rejection", () => {
  it("runs with a readable zero balance, so a drained wallet keeps the rejection coverage", () => {
    expect(canRunUnfundedX402Rejection(true, 0n)).toBe(true);
  });

  it("does not run when chain-state reads failed or the chain is unreachable", () => {
    expect(canRunUnfundedX402Rejection(true, null)).toBe(false);
    expect(canRunUnfundedX402Rejection(true, undefined)).toBe(false);
    expect(canRunUnfundedX402Rejection(false, 0n)).toBe(false);
  });
});

describe("isLocallyProvenUnfundedRejection", () => {
  const evidence = {
    canonicalSignature: true,
    balanceMicro: 0n,
  };

  it("accepts canonical-signature and zero-balance evidence without a facilitator reason", () => {
    expect(isLocallyProvenUnfundedRejection(evidence)).toBe(true);
  });

  it.each([{ canonicalSignature: false }, { balanceMicro: 1n }])(
    "rejects incomplete or contradictory local evidence: %o",
    (override) => {
      expect(isLocallyProvenUnfundedRejection({ ...evidence, ...override })).toBe(false);
    }
  );
});

describe("isExactEvmVerificationHealthy", () => {
  it("accepts a valid response", () => {
    expect(isExactEvmVerificationHealthy({ isValid: true })).toBe(true);
  });

  it("accepts a signed payload rejected for insufficient balance", () => {
    expect(
      isExactEvmVerificationHealthy({
        isValid: false,
        invalidReason: "invalid_exact_evm_insufficient_balance",
      })
    ).toBe(true);
  });

  it("accepts CDP's opaque rejection from its independently signed liveness probe", () => {
    expect(
      isExactEvmVerificationHealthy({
        isValid: false,
        invalidReason: "invalid_payload",
      })
    ).toBe(true);
  });

  it("rejects a reference payload rejected as an invalid signature", () => {
    expect(
      isExactEvmVerificationHealthy({
        isValid: false,
        invalidReason: "invalid_exact_evm_signature",
      })
    ).toBe(false);
  });

  it("rejects malformed probe responses", () => {
    expect(isExactEvmVerificationHealthy(undefined)).toBe(false);
    expect(isExactEvmVerificationHealthy({ isValid: false })).toBe(false);
  });
});

describe("classifyX402Failure", () => {
  it.each(["facilitator_status_500"])(
    "reads %s as the counterparty failing",
    (reason) => {
      expect(classifyX402Failure(reason)).toBe("facilitator");
    }
  );

  it("reads a rate-limit or timeout status as the counterparty declining to answer", () => {
    expect(classifyX402Failure("facilitator_status_429")).toBe("facilitator");
    expect(classifyX402Failure("facilitator_status_408")).toBe("facilitator");
  });

  it("reads the facilitator's own unexpected_* reasons as the counterparty failing", () => {
    expect(classifyX402Failure("unexpected_verify_error")).toBe("facilitator");
    expect(classifyX402Failure("unexpected_settle_error")).toBe("facilitator");
  });

  it("reads a transport failure as the counterparty failing", () => {
    expect(classifyX402Failure("transport_error: fetch failed")).toBe("facilitator");
    expect(classifyX402Failure("transport_timeout: signal timed out")).toBe("facilitator");
  });

  it("reads a drained payer as a funding condition", () => {
    expect(classifyX402Failure("insufficient_funds")).toBe("funding");
    expect(classifyX402Failure("insufficient_balance")).toBe("funding");
  });

  it("reads x402.org's own drained-payer wording as funding, despite its invalid_* prefix", () => {
    // Captured from the live facilitator against a fresh unfunded key. Read as
    // "envelope" it would redden CI every time the shared wallet runs out —
    // exactly the drained-wallet-looks-like-a-regression case opens on.
    expect(classifyX402Failure("invalid_exact_evm_insufficient_balance")).toBe("funding");
  });

  it.each([
    "Details: replacement transaction underpriced",
    "Details: replacement fee too low",
    "Details: nonce too low",
    "Details: nonce too high",
    "Details: already known",
    // Casing is the facilitator's to choose; the match must not depend on it.
    "Details: Replacement Transaction Underpriced",
  ])("reads %s as the facilitator's own mempool, not our envelope", (reason) => {
    expect(classifyX402Failure(reason)).toBe("facilitator");
  });

  it("keeps a reverted broadcast a hard failure — same dump shape, our envelope", () => {
    // The negative that bounds the arm above. A bad signature or a spent
    // authorization arrives in an identical viem dump; only the `Details:` line
    // separates it from the relayer's own nonce race, so matching the dump
    // wrapper rather than the mempool condition would turn this green.
    const reverted = `Missing or invalid parameters.

URL: https://sepolia.base.org
Docs: https://viem.sh/docs/contract/writeContract
Details: execution reverted: FiatTokenV2: invalid signature
Version: viem@2.48.11`;
    expect(classifyX402Failure(reverted)).toBe("envelope");
    expect(
      classifyX402Failure(
        "Details: execution reverted: FiatTokenV2: authorization is used or canceled"
      )
    ).toBe("envelope");
  });

  it("keeps a drained payer funding, even when a broadcast condition rides along", () => {
    // Funding is checked above the broadcast arm on purpose: both skip, but the
    // announcement is the only warning anyone gets before the shared wallet dies.
    expect(classifyX402Failure("invalid_exact_evm_insufficient_balance: nonce too low")).toBe(
      "funding"
    );
  });

  it.each([
    "invalid_exact_evm_payload_signature",
    "unsupported_scheme",
  ])("keeps %s a hard failure — that is our envelope", (reason) => {
    expect(classifyX402Failure(reason)).toBe("envelope");
  });

  it("keeps a 4xx that isn't a rate limit a hard failure — the facilitator read our envelope and refused it", () => {
    expect(classifyX402Failure("facilitator_status_400")).toBe("envelope");
    expect(classifyX402Failure("facilitator_status_401")).toBe("envelope");
    expect(classifyX402Failure("facilitator_status_404")).toBe("envelope");
  });

  it("keeps verify.ts's own fallbacks hard failures", () => {
    for (const reason of [
      "decode_failed",
      "unsupported_version",
      "verify_failed",
      "settle_failed",
    ]) {
      expect(classifyX402Failure(reason)).toBe("envelope");
    }
  });

  it("defaults an unclassified reason to a hard failure, so it reddens CI with its name attached", () => {
    expect(classifyX402Failure("some_reason_nobody_has_seen_yet")).toBe("envelope");
    expect(classifyX402Failure("unnamed_rejection")).toBe("envelope");
  });
});

describe("x402FailureReason", () => {
  it("rethrows a network-guard block rather than converting it — a blocked host must never skip", () => {
    const blocked = new NetworkGuardBlockedError("https://x402.org/facilitator", "blocked");
    expect(() => x402FailureReason(blocked)).toThrow(blocked);
  });

  it("names a transport failure and carries its message", () => {
    const reason = x402FailureReason(new TypeError("fetch failed"));
    expect(reason).toBe("transport_error: fetch failed");
    expect(classifyX402Failure(reason)).toBe("facilitator");
  });

  it("names an aborted request as a timeout", () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    expect(x402FailureReason(err)).toBe(
      "transport_timeout: The operation was aborted due to timeout"
    );
  });

  it("stringifies a non-Error throw", () => {
    expect(x402FailureReason("socket hang up")).toBe("transport_error: socket hang up");
  });
});

describe("skipOrFailLiveX402", () => {
  it("skips a facilitator 5xx, announcing and noting the reason", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { ctx, notes } = stubContext();

    expect(() =>
      skipOrFailLiveX402(ctx, "x402 integration", "facilitator_status_502", "verify/settle")
    ).toThrow("test skipped");

    expect(notes[0]).toContain("facilitator_status_502");
    const announced = String(stderr.mock.calls[0]?.[0]);
    expect(announced).toContain("[x402 integration] SKIPPED");
    expect(announced).toContain("facilitator_status_502");
    expect(announced).toContain("verify/settle");
  });

  it("skips a drained payer", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { ctx, notes } = stubContext();

    expect(() =>
      skipOrFailLiveX402(ctx, "x402 integration", "insufficient_funds", "verify/settle")
    ).toThrow("test skipped");
    expect(notes[0]).toContain("insufficient_funds");
  });

  it("fails an invalid signature — our envelope, never a skip — and names it", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { ctx, notes } = stubContext();

    expect(() =>
      skipOrFailLiveX402(
        ctx,
        "x402 integration",
        "invalid_exact_evm_payload_signature",
        "verify/settle"
      )
    ).toThrow(/invalid_exact_evm_payload_signature/);

    expect(notes).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("fails an unclassified reason, with the reason in the message", () => {
    const { ctx } = stubContext();
    expect(() =>
      skipOrFailLiveX402(ctx, "x402 integration", "brand_new_reason", "verify/settle")
    ).toThrow(/brand_new_reason/);
  });
});

describe("skipLiveX402", () => {
  it("announces to stderr, where vitest's default reporter can't swallow it", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { ctx } = stubContext();

    expect(() =>
      skipLiveX402(
        ctx,
        "x402 integration",
        "transport_error: fetch failed",
        "recipient balance read"
      )
    ).toThrow("test skipped");

    expect(String(stderr.mock.calls[0]?.[0])).toContain(
      "[x402 integration] SKIPPED — live settlement declined at recipient balance read: transport_error: fetch failed"
    );
  });
});

describe("payerFundingDetail", () => {
  const address = "0x1111111111111111111111111111111111111111";

  it("names the address and the balance when the wallet is healthy", () => {
    const detail = payerFundingDetail({
      address,
      balanceMicro: 900_000n,
      minMicro: 1000n,
    });
    expect(detail).toBe(`payer ${address} holds 0.900000 USDC`);
  });

  it("names the address, the balance and the shortfall when it can't cover a run", () => {
    const detail = payerFundingDetail({ address, balanceMicro: 500n, minMicro: 1000n });
    expect(detail).toContain(address);
    expect(detail).toContain("0.000500");
    expect(detail).toContain("0.001000");
    expect(detail).toContain("docs/operations/x402-test-wallet.md");
  });

  it("nags before the wallet drains, so the top-up isn't discovered by a skip", () => {
    const detail = payerFundingDetail({ address, balanceMicro: 50_000n, minMicro: 1000n });
    expect(detail).toContain("top up soon");
  });

  it("says so when the balance couldn't be read, and carries the error", () => {
    const detail = payerFundingDetail({
      address,
      balanceMicro: null,
      minMicro: 1000n,
      error: "eth_call → HTTP 429",
    });
    expect(detail).toBe(`payer ${address} balance unreadable (eth_call → HTTP 429)`);
  });
});
