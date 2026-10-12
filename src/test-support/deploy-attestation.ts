import {
  type AttestationPayload,
  buildAttestation,
  signAttestation,
} from "../lib/builder-identity";
import type { JsonValue } from "../lib/cast-auth/canonical-json";
import { deriveReceiptKeypair } from "../lib/receipt-key";

export interface DeployAttestation {
  identityPubkey: string;
  payload: AttestationPayload;
  signature: string;
  capabilities: JsonValue;
  receiptSecret?: string;
}

export interface SignDeployAttestationArgs {
  builderSecret: string;
  builderPubkey: string;
  dvmId: string;
  slug: string;
  capabilities: JsonValue;
  withReceiptKey?: boolean;
}

/** Build signed deployment metadata for server tests without builder CLI coupling. */
export function signDeployAttestation(args: SignDeployAttestationArgs): DeployAttestation {
  const receipt = args.withReceiptKey
    ? deriveReceiptKeypair(args.builderSecret, args.dvmId)
    : undefined;
  const payload = buildAttestation({
    dvmId: args.dvmId,
    slug: args.slug,
    capabilities: args.capabilities,
    builderPubkey: args.builderPubkey,
    receiptPubkey: receipt?.pubkey,
  });
  return {
    identityPubkey: args.builderPubkey,
    payload,
    signature: signAttestation(payload, args.builderSecret),
    capabilities: args.capabilities,
    receiptSecret: receipt?.secret,
  };
}

export function attestationEnv(attestation: DeployAttestation): Record<string, string> {
  const env: Record<string, string> = {
    DVMKIT_BUILDER_PUBKEY: attestation.identityPubkey,
    DVMKIT_BUILDER_ATTESTATION: JSON.stringify(attestation.payload),
    DVMKIT_BUILDER_SIGNATURE: attestation.signature,
    DVMKIT_DVM_ID: attestation.payload.dvm_id,
    DVMKIT_CANONICAL_DVM_ID: attestation.payload.dvm_id,
  };
  if (attestation.receiptSecret) env.DVMKIT_RECEIPT_KEY = attestation.receiptSecret;
  return env;
}
