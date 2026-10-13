/**
 * Wire strings the Tempo session handshake is keyed on, shared by the SDK that
 * writes them and the caller that reads them.
 *
 * Deliberately dependency-free and on the `src/lib/` side of the boundary:
 * `src/sdk/server/` imports from `src/lib/` freely, and nothing in `src/lib/`
 * may import back.
 */

/**
 * The reason a DVM gives when it has accepted a Tempo session's on-chain
 * management top-up and now wants the cumulative voucher that funds against it.
 *
 * mppx's session hook posts the management credential and expects an empty
 * success before it will sign the voucher; dvmkit shares `/v1/credit` for both
 * phases, so the SDK answers that step with a 402 carrying this reason plus the
 * voucher challenge, and `credit-fund.ts`'s bridge translates exactly that
 * answer into the 204 mppx is waiting for.
 *
 * Written once here because the coupling is otherwise a substring match across
 * two modules with nothing linking them: a reword on the SDK side — the sort of
 * thing payment-language pass does routinely — would stop the
 * translation, mppx would never build the voucher, and every Tempo session
 * top-up would wedge, caught only by the non-per-PR Tempo money loop.
 * Same reasoning as `MPPX_HMAC_MISMATCH_REASON` in `sdk/server/mpp-setup.ts`.
 */
export const TEMPO_SESSION_UPDATED_REASON =
  "Tempo session updated; attach the next voucher to fund this credit.";
