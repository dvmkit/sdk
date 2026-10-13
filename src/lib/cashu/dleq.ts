import type { ProofLike } from "@cashu/cashu-ts";

/**
 * Explain the one unrecoverable DLEQ case without exposing proof material:
 * a mint now requires evidence that legacy persisted proofs never carried.
 */
export function missingDleqRecoveryDiagnostic(proofs: ProofLike[], error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/dleq/i.test(message) || proofs.every((proof) => proof.dleq !== undefined)) return null;
  return "This mint requires DLEQ evidence for legacy P2PK proofs, but the stored proofs do not contain it. The NUT-11 key can authorize the spend but cannot recreate DLEQ; contact the mint operator for recovery.";
}
