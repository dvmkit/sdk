/**
 * Original accepted job payment, fixed before handler execution. Snake_case is
 * the wire shape. Absence means unknown, while `amount_msats: 0` is known zero.
 * A credit-backed payment describes a pending hold at acceptance, not fresh
 * funding or final settlement: completion settles it, failure/cancellation
 * releases it. Later draw growth and settlement repricing do not change this fact.
 */
export interface UpfrontPayment {
  amount_msats: number;
  /** Exact accepted draw in millionths of `currency`, when recorded. */
  amount_micro?: number;
  currency?: string;
  /** Funding rail for a credit hold, or the accepted per-call rail. */
  rail?: "cashu" | "x402" | "tempo" | "lightning";
  /** Allocated rail-native atomic units, distinct from credit denomination. */
  native_amount?: number;
  native_asset?: string;
  /** Together these identify credit consumption; neither is a spending credential. */
  credit_id?: string;
  draw_id?: string;
}
