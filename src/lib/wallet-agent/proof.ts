import { Amount, type Proof } from "@cashu/cashu-ts";

import type { AgentProof } from "./store";

/** Optional persistence tags applied while converting a Cashu proof. */
export interface ToAgentProofTags {
  /** `builder/<handle>` marker for a pre-funded builder reserve. */
  reservedFor?: string;
  /** NUT-11 locktime expiry as wall-clock millis. */
  tExpireMs?: number;
}

/** Convert a cashu-ts proof into the lossless agent-wallet disk shape. */
export function toAgentProof(
  proof: Proof,
  mintUrl: string,
  lockedTo: string | null,
  tags: ToAgentProofTags = {}
): AgentProof {
  const out: AgentProof = {
    mint: mintUrl,
    secret: proof.secret,
    C: proof.C,
    amount: Amount.from(proof.amount).toNumber(),
    id: proof.id,
    ...(proof.dleq ? { dleq: { ...proof.dleq } } : {}),
    locked_to_pubkey: lockedTo,
    status: "valid",
  };
  if (tags.reservedFor !== undefined) out.reserved_for = tags.reservedFor;
  if (tags.tExpireMs !== undefined) out.t_expire = tags.tExpireMs;
  return out;
}

/** Rehydrate one persisted proof for cashu-ts without dropping NUT-12 DLEQ. */
export function toCashuProof(proof: AgentProof): Proof {
  return {
    id: proof.id,
    amount: Amount.from(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq ? { dleq: { ...proof.dleq } } : {}),
  };
}

/** Rehydrate persisted proofs for cashu-ts without dropping NUT-12 DLEQ. */
export function toCashuProofs(proofs: AgentProof[]): Proof[] {
  return proofs.map(toCashuProof);
}
