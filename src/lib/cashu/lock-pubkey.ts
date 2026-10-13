declare const lockPubkeyBrand: unique symbol;

/**
 * NUT-11 P2PK lock pubkey, lowercase-by-construction. Hex-encoded compressed
 * secp256k1 pubkey (66 chars starting with `02` / `03`), normalised via
 * `toLockPubkey`. The brand exists so any in-memory site that compares
 * lock-pubkeys against each other — receive matching, monitor orphan/retired
 * lookups, melt-pending keypair maps — gets a compile-time guarantee that
 * both sides have been normalised. Raw strings off the wire or out of the DB
 * must pass through `toLockPubkey` before they're treated as one.
 */
export type LockPubkey = string & { readonly [lockPubkeyBrand]: never };

/**
 * Brand a raw lock-pubkey string. Trims surrounding whitespace and lowercases
 * the hex so equality is structural. Idempotent on values that are already
 * lowercase. Does not validate the curve point — assertions about hex shape
 * live at the wire-validation layer (e.g. the `/admin/cashu/rotate-lock-pubkey`
 * regex in `admin-cashu.ts`).
 */
export function toLockPubkey(raw: string): LockPubkey {
  return raw.trim().toLowerCase() as LockPubkey;
}
