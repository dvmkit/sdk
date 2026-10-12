
import {
  type AttestationPayload,
  buildAttestation,
  generateIdentity,
  signAttestation,
} from "../../builder-identity";
import type {
  DrainReceipt,
  FundingReceipt,
  JobReceipt,
  UnsignedDrainReceipt,
  UnsignedFundingReceipt,
  UnsignedJobReceipt,
} from "../../receipt";
import {
  computeResultHash,
  signDrainReceipt,
  signFundingReceipt,
  signReceipt,
} from "../../receipt";
import {
  deriveReceiptKeypair,
  deriveReceiptSecret,
  receiptPubkeyFromSecret,
} from "../../receipt-key";
import type { ReceiptTrustAnchor } from "../../receipt-verify";

export const BUILDER_SECRET = "11".repeat(32);
export const WORDCOUNT_DVM_ID = "dvm-wordcount";

/**
 * Two caller signing identities, for the tests that care whose receipts they
 * are (the trust ladder is scoped to the signing identity). The
 * value is only ever compared, never verified against a signature, so a stable
 * constant is enough and a derived keypair would buy nothing.
 *
 * `unsignedReceipt` still defaults `requester_pubkey` to `null` on purpose:
 * that is the honest shape of a job that carried no signed-request auth.
 */
export const CALLER_A = "aa".repeat(32);
export const CALLER_B = "bc".repeat(32);

export function unsignedReceipt(overrides: Partial<UnsignedJobReceipt> = {}): UnsignedJobReceipt {
  return {
    v: 1,
    job_id: "job-a7571b-1",
    dvm_id: WORDCOUNT_DVM_ID,
    dvm: "wordcount",
    capability: "count",
    outcome: "completed",
    reason: null,
    seq: 4213,
    issued_at: 1789300000,
    requester_pubkey: null,
    paid: {
      msats: 19000,
      rail: "cashu",
      native_amount: null,
      native_asset: null,
      tx_hash: null,
      mint: "https://mint.example",
    },
    result_hash: computeResultHash("6 words", []),
    receipt_pubkey: receiptPubkeyFromSecret(deriveReceiptSecret(BUILDER_SECRET, WORDCOUNT_DVM_ID)),
    ...overrides,
  };
}

export function unsignedDrainReceipt(
  overrides: Partial<UnsignedDrainReceipt> = {}
): UnsignedDrainReceipt {
  return {
    v: 1,
    kind: "credit_drain",
    credit_id: "9e107d9d-0a1b-4c6e-8f2a-3b5c7d9e1f2a",
    drain_id: "5c2f8a1e-7b3d-4e9f-a1c2-d4e6f8a0b2c4",
    event: "requested",
    method: "cashu",
    amount_micro: 300_000,
    balance_after_micro: 0,
    ledger_seq: 5,
    issued_at: 1789300000,
    caller_pubkey: "bb".repeat(32),
    dvm_id: WORDCOUNT_DVM_ID,
    dvm: "wordcount",
    receipt_pubkey: receiptPubkeyFromSecret(deriveReceiptSecret(BUILDER_SECRET, WORDCOUNT_DVM_ID)),
    ...overrides,
  };
}

export function unsignedFundingReceipt(
  overrides: Partial<UnsignedFundingReceipt> = {}
): UnsignedFundingReceipt {
  return {
    v: 1,
    kind: "credit_funding",
    credit_id: "credit-1",
    fund_id: "fund-1",
    funded_micro: 500_000,
    balance_after_micro: 750_000,
    ledger_seq: 3,
    issued_at: 1789300000,
    caller_pubkey: "bb".repeat(32),
    dvm_id: WORDCOUNT_DVM_ID,
    dvm: "wordcount",
    receipt_pubkey: receiptPubkeyFromSecret(deriveReceiptSecret(BUILDER_SECRET, WORDCOUNT_DVM_ID)),
    ...overrides,
  };
}

export interface AttestedDvm {
  identity: { secret: string; pubkey: string };
  receiptKey: { secret: string; pubkey: string };
  attestation: AttestationPayload;
  anchor: ReceiptTrustAnchor;
  sign: (overrides?: Partial<UnsignedJobReceipt>) => JobReceipt;
  signDrain: (overrides?: Partial<UnsignedDrainReceipt>) => DrainReceipt;
  signFunding: (overrides?: Partial<UnsignedFundingReceipt>) => FundingReceipt;
}

export function attestedDvm(slug = "wordcount"): AttestedDvm {
  const identity = generateIdentity();
  const dvmId = `dvm-${slug}`;
  const receiptKey = deriveReceiptKeypair(identity.secret, dvmId);
  const attestation = buildAttestation({
    dvmId,
    slug,
    capabilities: ["count"],
    builderPubkey: identity.pubkey,
    receiptPubkey: receiptKey.pubkey,
    deployedAt: 1789200000,
  });
  const signature = signAttestation(attestation, identity.secret);
  return {
    identity,
    receiptKey,
    attestation,
    anchor: {
      pubkey: identity.pubkey,
      attestation: attestation as unknown as Record<string, unknown>,
      signature,
    },
    sign: (overrides = {}) =>
      signReceipt(
        unsignedReceipt({
          dvm_id: dvmId,
          dvm: slug,
          receipt_pubkey: receiptKey.pubkey,
          ...overrides,
        }),
        receiptKey.secret
      ),
    signDrain: (overrides = {}) =>
      signDrainReceipt(
        unsignedDrainReceipt({
          dvm_id: dvmId,
          dvm: slug,
          receipt_pubkey: receiptKey.pubkey,
          ...overrides,
        }),
        receiptKey.secret
      ),
    signFunding: (overrides = {}) =>
      signFundingReceipt(
        unsignedFundingReceipt({
          dvm_id: dvmId,
          dvm: slug,
          receipt_pubkey: receiptKey.pubkey,
          ...overrides,
        }),
        receiptKey.secret
      ),
  };
}
