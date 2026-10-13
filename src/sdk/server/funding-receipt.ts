import type { FundingReceipt } from "../../lib/receipt";
import type { CreditLedgerLike, FundingRecord } from "./credit-ledger";
import type { ReceiptIssuer } from "./receipt-issuer";

/**
 * Without an issuer, return undefined. Reuse a stored artifact; otherwise issue only when
 * the original funding tuple is complete, using its creation time. Return the store’s
 * write-once winner.
 */
export async function fundingReceiptFor(
  ledger: CreditLedgerLike,
  issuer: ReceiptIssuer | undefined,
  funding: FundingRecord
): Promise<FundingReceipt | undefined> {
  if (!issuer) return undefined;
  if (funding.receipt) return funding.receipt;
  if (
    funding.callerPubkey === null ||
    funding.balanceAfterMicro === null ||
    funding.ledgerSeq === null
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
  return ledger.saveFundingReceipt({
    creditId: funding.creditId,
    fundId: funding.fundId,
    receipt,
  });
}
