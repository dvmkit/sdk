import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { msatsToUsdc } from "../../lib/currency";
import {
  buildPaymentRequirements,
  decodePayment,
  type VerifyResponse,
  verifyX402Payment,
  type X402Config,
  type X402Receipt,
} from "../../lib/x402";
import { verifyWithFacilitator } from "../../lib/x402/facilitator-request";
import { announceTier } from "../../test-support/tier-announce";
import {
  BASE_SEPOLIA_CAIP2,
  BASE_SEPOLIA_RPC,
  isBaseSepoliaReachable,
  isCanonicalBaseSepoliaExactSignature,
  isFacilitatorReachable,
  loadFundedPayerKey,
  probePayerFunding,
  usdcBalance,
  X402_FACILITATOR,
  X402_FACILITATOR_AUTH,
} from "./__helpers__/base-sepolia";
import { canonicalBaseSepoliaPaymentHeader } from "./__helpers__/canonical-x402-payment";
import {
  canRunUnfundedX402Rejection,
  classifyX402Failure,
  isLocallyProvenUnfundedRejection,
  skipLiveX402,
  skipOrFailLiveX402,
  type SkippableTestContext,
  x402FacilitatorEndpointClass,
  x402FailureReason,
  x402RpcEndpointClass,
} from "./__helpers__/x402-live-tier";

/**
 * Real gasless USDC settlement on Base Sepolia, using a pre-funded payer.
 * Counterparty/funding outages may announce a skip; our envelope defects fail.
 * The unfunded-payer refusal needs reachable services but no funded payer.
 */

const SERVER_RATE = 100_000;

// 1000 msats @ $100k/BTC → 1000 µUSDC = $0.001. Trivial spend, easy on-chain delta.
const AMOUNT_MSATS = 1000;
const REQUIRED_USDC_MICRO = BigInt(msatsToUsdc(AMOUNT_MSATS, SERVER_RATE));
const RESOURCE = "https://x402-testnet.integration/v1/job";

/** The tier's name in every announcement — one string, so a CI log greps clean. */
const TIER = "x402 integration";

const ENABLED = Boolean(process.env.X402_TESTNET_RPC && process.env.X402_TESTNET_PRIVATE_KEY);
// A guard block throws out of a probe rather than reading as an outage, so an
// unallowlisted host fails the run here instead of quietly skipping the tier.
// Both probes run to completion before the verdict is combined — `&&` would
// short-circuit, hiding a blocked facilitator behind a genuinely-down RPC.
const probes = ENABLED
  ? await Promise.allSettled([isBaseSepoliaReachable(), isFacilitatorReachable()])
  : [];
for (const probe of probes) {
  if (probe.status === "rejected") throw probe.reason;
}
const [rpcProbe, facilitatorProbe] = probes;
const rpcUp = rpcProbe?.status === "fulfilled" && rpcProbe.value;
const facilitatorUp = facilitatorProbe?.status === "fulfilled" && facilitatorProbe.value;
const REACHABLE = ENABLED && rpcUp && facilitatorUp;
// The payer probe needs the RPC, so it runs only once reachability holds. It is
// the difference between "the shared wallet is empty, top it up" and a red tier
// that reads like a protocol regression.
const payerKey = loadFundedPayerKey();
const funding =
  REACHABLE && payerKey ? await probePayerFunding(payerKey, REQUIRED_USDC_MICRO) : null;
const RUNNABLE = REACHABLE && (funding?.funded ?? false);
// `/verify` must read the token's authorization state and payer balance. A
// working `eth_chainId` with a failing `eth_call` is therefore a partial chain
// outage, not enough to ask the facilitator for a balance-classified rejection.
// Zero stays runnable: a drained wallet is the exact case this test exercises.
const REJECTION_RUNNABLE = canRunUnfundedX402Rejection(REACHABLE, funding?.balanceMicro);
if (ENABLED) {
  // An enabled tier states its verdict either way: an outage skips rather than
  // reddens, but it must never do so unnoticed — and it names which
  // dependency is down, so a skip in a CI log is actionable on its own. A running tier
  // prints the payer balance too: the wallet has no faucet and is topped up by
  // hand, so that line is the only advance warning before it drains.
  const rpcEndpointClass = x402RpcEndpointClass(BASE_SEPOLIA_RPC);
  const facilitatorEndpointClass = x402FacilitatorEndpointClass(X402_FACILITATOR);
  const down = [
    rpcUp ? null : "Base Sepolia",
    facilitatorUp ? null : `the ${facilitatorEndpointClass}`,
  ].filter(Boolean);
  const detail = RUNNABLE
    ? `Base Sepolia reachable via ${rpcEndpointClass}, ${facilitatorEndpointClass}, ${funding?.detail}`
    : REACHABLE && !REJECTION_RUNNABLE
      ? `Base Sepolia ${rpcEndpointClass}; ${funding?.detail} — settlement and unfunded-payer rejection skipped because chain-state reads are unavailable`
      : REACHABLE
        ? `Base Sepolia ${rpcEndpointClass}; ${funding?.detail} — settlement skipped, the unfunded-payer rejection still runs`
        : `Base Sepolia ${rpcEndpointClass}; X402_TESTNET_RPC + key are set but ${down.join(" and ")} ${
            down.length > 1 ? "are" : "is"
          } unavailable`;
  announceTier(TIER, RUNNABLE ? "ran" : "skipped", detail ?? "unknown");
}

async function skipIfFacilitatorRejectedCanonicalSignature(
  ctx: SkippableTestContext,
  paymentHeader: string,
  reason: string,
  where: string
): Promise<void> {
  if (reason !== "invalid_exact_evm_signature") return;
  if (!(await isCanonicalBaseSepoliaExactSignature(paymentHeader))) return;
  skipLiveX402(
    ctx,
    TIER,
    `${reason} (canonical Base Sepolia signature recovers locally to its payer)`,
    where
  );
}

describe.skipIf(!RUNNABLE)("x402 Base Sepolia round-trip (real settlement)", () => {
  it("server challenge → client signs → facilitator verify+settle, with recipient delta", async (ctx) => {
    const fundedKey = loadFundedPayerKey();
    if (!fundedKey) throw new Error("unreachable: gate requires X402_TESTNET_PRIVATE_KEY");

    // Recipient: a fresh address whose USDC delta proves the transfer settled
    // on-chain. Never funded — it starts at 0 and receives exactly the charge.
    const recipient = privateKeyToAccount(generatePrivateKey());
    const config: X402Config = {
      payTo: recipient.address,
      network: BASE_SEPOLIA_CAIP2,
      facilitator: X402_FACILITATOR,
      ...(X402_FACILITATOR_AUTH ? { facilitatorAuth: X402_FACILITATOR_AUTH } : {}),
    };

    // Baseline for the delta assertion. The public RPC is rate-limited, and
    // losing the tier to a 429 before it has settled anything is the noise this
    // gate exists to keep off unrelated PRs.
    let recipientBefore: bigint;
    try {
      recipientBefore = await usdcBalance(recipient.address);
    } catch (err) {
      skipLiveX402(ctx, TIER, x402FailureReason(err), "recipient baseline read");
    }

    const paymentHeader = await canonicalBaseSepoliaPaymentHeader(
      fundedKey, recipient.address, REQUIRED_USDC_MICRO, RESOURCE
    );

    // Server verifies against the live facilitator: signature + balance (/verify),
    // then a real on-chain USDC transfer (/settle) returning the tx hash. Both
    // legs can throw rather than return a receipt — `verifyWithFacilitator` and
    // `settleWithFacilitator` turn a non-2xx into an `invalidReason` but pass a
    // transport failure straight through — so the throw is classified too.
    let receipt: X402Receipt;
    try {
      receipt = await verifyX402Payment(
        paymentHeader,
        config,
        REQUIRED_USDC_MICRO,
        RESOURCE,
        SERVER_RATE
      );
    } catch (err) {
      skipOrFailLiveX402(ctx, TIER, x402FailureReason(err), "verify/settle");
    }
    if (!receipt.verified) {
      // Keep the facilitator reason so canonical-signature rejection can be distinguished
      // from an SDK defect. An unnamed rejection fails rather than skipping.
      const reason = receipt.invalidReason ?? "unnamed_rejection";
      await skipIfFacilitatorRejectedCanonicalSignature(
        ctx,
        paymentHeader,
        reason,
        "verify/settle"
      );
      skipOrFailLiveX402(ctx, TIER, reason, "verify/settle");
    }
    expect(receipt.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.amountUsdcMicro).toBe(Number(REQUIRED_USDC_MICRO));

    // Belt-and-suspenders: the recipient actually received the transfer. The
    // facilitator may return before the tx is mined, so poll the balance until
    // the delta lands (base-sepolia ~2s blocks; generous bound). The public RPC
    // is rate-limited, so a read error keeps polling rather than reddening the
    // tier — the settlement itself already succeeded above.
    const deadline = Date.now() + 30_000;
    let delta = 0n;
    let readError: string | null = null;
    while (Date.now() < deadline) {
      try {
        delta = (await usdcBalance(recipient.address)) - recipientBefore;
        readError = null;
        if (delta > 0n) break;
      } catch (err) {
        readError = x402FailureReason(err);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // A settled payment whose delta never lands is a real regression — unless we
    // never got a clean read, which is the RPC's problem, not ours.
    if (delta === 0n && readError) skipLiveX402(ctx, TIER, readError, "recipient balance read");
    expect(delta).toBe(REQUIRED_USDC_MICRO);
  }, 90_000);
});

// Gated on readable chain state, not RUNNABLE: this one signs with a throwaway
// key and spends nothing, so zero balance is fine, but `/verify` cannot prove
// that balance while `eth_call` is unavailable. Riding the funded settlement
// gate would let a drained wallet quietly take the rejection coverage with it.
describe.skipIf(!REJECTION_RUNNABLE)("x402 Base Sepolia rejection (unfunded payer)", () => {
  it("rejects a payment from an unfunded key (facilitator /verify fails, no settlement)", async (ctx) => {
    // A fresh, unfunded key: the EIP-3009 signature is valid, but the facilitator's
    // /verify sees a zero balance and rejects — so /settle is never called and
    // nothing drains. Proves our facilitator-rejection path against a real facilitator.
    const unfundedKey = generatePrivateKey();
    const recipient = privateKeyToAccount(generatePrivateKey());
    const config: X402Config = {
      payTo: recipient.address,
      network: BASE_SEPOLIA_CAIP2,
      facilitator: X402_FACILITATOR,
      ...(X402_FACILITATOR_AUTH ? { facilitatorAuth: X402_FACILITATOR_AUTH } : {}),
    };

    const paymentHeader = await canonicalBaseSepoliaPaymentHeader(
      unfundedKey, recipient.address, REQUIRED_USDC_MICRO, RESOURCE
    );

    const payment = decodePayment(paymentHeader);
    const requirementOpts = {
      x402Config: config,
      requiredUsdcMicro: REQUIRED_USDC_MICRO,
      resource: RESOURCE,
    };
    const requirements =
      payment.x402Version === 1
        ? buildPaymentRequirements({ ...requirementOpts, version: 1 })
        : buildPaymentRequirements({ ...requirementOpts, version: 2 });

    let verification: VerifyResponse;
    try {
      // Stop at `/verify`: this lane proves the facilitator rejected the
      // unfunded payer and must never make `/settle` reachable.
      verification = await verifyWithFacilitator(payment, requirements, config);
    } catch (err) {
      skipLiveX402(ctx, TIER, x402FailureReason(err), "verify (unfunded key)");
    }

    expect(verification.isValid, "facilitator verified an unfunded payer").toBe(false);
    // A transaction field on a rejected `/verify` response is contradictory
    // evidence and stays red even though this test never calls `/settle`.
    expect(
      (verification as { transaction?: unknown }).transaction,
      "a rejected verification returned a transaction hash"
    ).toBeUndefined();
    const reason = verification.invalidReason ?? "unnamed_rejection";
    const canonicalSignature = await isCanonicalBaseSepoliaExactSignature(paymentHeader);
    expect(
      canonicalSignature,
      "unfunded payment header is not canonical for Base Sepolia USDC"
    ).toBe(true);

    // A transport/status failure means the facilitator never reached a payment
    // verdict. Keep that counterparty condition as a skip; application-level
    // rejection wording is deliberately irrelevant to this lane.
    if (classifyX402Failure(reason) === "facilitator") {
      skipLiveX402(ctx, TIER, reason, "verify (unfunded key)");
    }

    // `REJECTION_RUNNABLE` read the chain once before the suite, but the RPC can
    // degrade mid-run. Re-read the generated payer: zero is the
    // successful result that proves the facilitator was obliged to reject.
    let balanceMicro: bigint;
    try {
      balanceMicro = await usdcBalance(privateKeyToAccount(unfundedKey).address);
    } catch (err) {
      skipLiveX402(
        ctx,
        TIER,
        `${reason} (canonical signature; chain re-read: ${x402FailureReason(err)})`,
        "verify (unfunded key)"
      );
    }
    expect(
      isLocallyProvenUnfundedRejection({ canonicalSignature, balanceMicro }),
      `rejected payer unexpectedly holds ${balanceMicro} micro-USDC`
    ).toBe(true);
  }, 90_000);
});
