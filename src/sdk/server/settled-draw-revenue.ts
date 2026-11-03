import type { DrawRecord } from "./credit-ledger";
import { settledShare } from "./credit-draw-resolution";

/**
 * The amounts a credit-backed job books as revenue, read off its settled draw.
 *
 * The job's counters (`paidMsats`, `nativeAmount`) were stamped from the draw when each payment
 * landed, and can also carry legs the draw never absorbed. The settled draw is the authority on
 * what the draw itself was worth, so only the draw's component of each counter is corrected and
 * every other leg stays as it was.
 */
export function settledDrawRevenue(
  job: { paidMsats: number; nativeAmount?: number },
  draw: Pick<DrawRecord, "amountMicro" | "allocatedMsats" | "railValue" | "partialSettle">
): { paidMsats: number; nativeAmount?: number } {
  return {
    paidMsats: settledDrawMsats(job.paidMsats, draw),
    ...(job.nativeAmount !== undefined && { nativeAmount: settledDrawNative(job.nativeAmount, draw) }),
  };
}

/**
 * On the Bitcoin rails the settle re-prices the draw off the funding lots it consumed, so the
 * pooled slice `allocateDrawValue` stamped when the hold was placed (which could not yet know
 * which deposit the draw would take) is a forecast the ledger has since corrected; a partial
 * settle likewise scales it down to the settled part. Booking the forecast leaves a residue
 * between sats revenue and sats received on a credit topped up at a second rate. The job row and
 * its receipt keep it deliberately: they attest what the caller's payment was worth when it
 * landed, which is the question they were asked.
 *
 * Applied as a **delta**, not a substitution. `paidMsats` is a sum of legs, and only the legs
 * that reached the ledger are inside the draw's allocation: the "degrades rather than refusing
 * money" paths (`credit-midjob-topup.test.ts`) take a mid-job payment that writes no ledger row
 * at all (a cross-rail top-up, an exact top-up on a channel-bound credit, a top-up on a draw that
 * already settled), and `withDrawBasis` leaves those legs the rail's own msats. Replacing the
 * whole figure would book those sats nowhere; correcting this draw's component leaves them where
 * they are.
 *
 * A **zero forecast** is the one shape where the counter holds a figure the ledger never
 * allocated, so there is nothing to subtract: `withDrawBasis` and `recordedDrawPayment` both
 * overlay only a positive allocation, leaving the leg at the rail's own msats, the ask. Not a
 * hypothetical on an upgraded host: a legacy multi-rate credit whose pooled `msats_remaining` has
 * clamped to 0 (legacy settles decremented it by the blend while the lots shed the cheaper FIFO
 * figure) forecasts 0 on every draw while the lots still price the settle, so booking the counter
 * would preserve an unbacked ask value straight through the upgrade. The settled figure replaces
 * the total there, which does give up the delta's one virtue on that one credit (a no-ledger-row
 * top-up gets absorbed with the ask) against an alternative that books a price no deposit backs
 * on every job it runs. Where neither figure exists, as on a rail funded with no msats basis, a
 * partly settled draw books the settled fraction of the counter.
 *
 * A credit with no sats basis at all allocates nothing and re-prices nothing
 * (`isInKindDepletion` is false on basisless lots), and on a draw the settle never re-priced the
 * delta is a no-op, `allocatedMsats` reading back as `drawMsats`.
 */
function settledDrawMsats(
  paidMsats: number,
  draw: Pick<DrawRecord, "amountMicro" | "allocatedMsats" | "railValue" | "partialSettle">
): number {
  if (draw.allocatedMsats > 0) {
    return Math.max(0, paidMsats - draw.allocatedMsats + draw.railValue.drawMsats);
  }
  if (draw.railValue.drawMsats > 0) return draw.railValue.drawMsats;
  if (draw.partialSettle) {
    return settledShare(Math.max(0, paidMsats), draw.amountMicro, draw.partialSettle.heldMicro);
  }
  return paidMsats;
}

/** The released remainder's native value never reached revenue, so it leaves the counter. */
function settledDrawNative(
  nativeAmount: number,
  draw: Pick<DrawRecord, "partialSettle">
): number {
  const released = draw.partialSettle?.releasedNative;
  if (released === undefined || released === null) return nativeAmount;
  return Math.max(0, nativeAmount - released);
}
