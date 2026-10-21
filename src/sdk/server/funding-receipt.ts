import type { DrawFundingReceipt, FundingReceipt } from "../../lib/receipt";
import { isDrawFundingReceipt, isFundingReceipt } from "../../lib/receipt";
import type { CreditLedgerLike, FundingRecord } from "./credit-ledger";
import type { ReceiptIssuer } from "./receipt-issuer";

/**
 * Without an issuer, return undefined. Reuse a stored artifact; otherwise issue only when
 * the original funding tuple is complete, using its creation time. Return the store’s
 * write-once winner.
 *
 * A row bound to a job or draw is mid-job evidence and belongs to
 * {@link drawFundingReceiptFor}: the receipt slot is write-once, so signing it
 * here as an opening receipt would misstate the draw's sequence and the
 * post-growth balance and leave the draw funding artifact unissuable forever.
 */
export async function fundingReceiptFor(
  ledger: CreditLedgerLike,
  issuer: ReceiptIssuer | undefined,
  funding: FundingRecord
): Promise<FundingReceipt | undefined> {
  if (!issuer) return undefined;
  if (funding.receipt) return isFundingReceipt(funding.receipt) ? funding.receipt : undefined;
  if (
    funding.callerPubkey === null ||
    funding.balanceAfterMicro === null ||
    funding.ledgerSeq === null ||
    isDrawBound(funding)
  ) {
    return undefined;
  }
  const receipt = issuer.issueFunding({
    creditId: funding.creditId,
    fundId: funding.fundId,
    fundedMicro: funding.amountMicro,
    balanceAfterMicro: funding.balanceAfterMicro,
    ledgerSeq: funding.ledgerSeq,
    callerPubkey: funding.callerPubkey,
    issuedAt: Math.floor(funding.createdAt / 1000),
  });
  const saved = await ledger.saveFundingReceipt({
    creditId: funding.creditId,
    fundId: funding.fundId,
    receipt,
  });
  return isFundingReceipt(saved) ? saved : undefined;
}

function isDrawBound(funding: FundingRecord): boolean {
  return Boolean(funding.jobId) || Boolean(funding.drawId);
}

/**
 * The mid-job counterpart of {@link fundingReceiptFor}: the row's job and draw
 * bindings and committed tuple are the signing inputs, so a lost
 * acknowledgement, a replayed payment and a later job read all reissue the
 * identical artifact. `currency` comes from the credit, which never changes
 * denomination. Returns the store's write-once winner, or undefined when the
 * row is not a completed mid-job draw funding.
 */
export async function drawFundingReceiptFor(
  ledger: CreditLedgerLike,
  issuer: ReceiptIssuer | undefined,
  funding: FundingRecord,
  currency: string
): Promise<DrawFundingReceipt | undefined> {
  if (!issuer) return undefined;
  if (funding.receipt) return isDrawFundingReceipt(funding.receipt) ? funding.receipt : undefined;
  if (
    funding.callerPubkey === null ||
    funding.balanceAfterMicro === null ||
    funding.ledgerSeq === null ||
    !funding.jobId ||
    !funding.drawId
  ) {
    return undefined;
  }
  const receipt = issuer.issueDrawFunding({
    creditId: funding.creditId,
    jobId: funding.jobId,
    drawId: funding.drawId,
    fundId: funding.fundId,
    ...(funding.paymentSeq !== null && funding.paymentSeq !== undefined && {
      paymentSeq: funding.paymentSeq,
    }),
    currency,
    fundedMicro: funding.amountMicro,
    balanceAfterMicro: funding.balanceAfterMicro,
    ledgerSeq: funding.ledgerSeq,
    callerPubkey: funding.callerPubkey,
    issuedAt: Math.floor(funding.createdAt / 1000),
  });
  const saved = await ledger.saveFundingReceipt({
    creditId: funding.creditId,
    fundId: funding.fundId,
    receipt,
  });
  return isDrawFundingReceipt(saved) ? saved : undefined;
}
