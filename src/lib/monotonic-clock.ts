/**
 * A `Date.now()` reading that cannot run backwards within its own lifetime
 * Returned by {@link createMonotonicClock}.
 */
export type MonotonicNowMs = () => number;

/** Wall-clock epoch ms projected forward by performance.now() after a backward step.
 * A forward step re-anchors immediately; the anchor starts at construction.
 * During compensation a cutoff can be eager by the backward-step size, so watchdog
 * callers must cap compensation separately. Results are floored to integer milliseconds. */
export function createMonotonicClock(): MonotonicNowMs {
  let anchorWallMs = Date.now();
  let anchorMonoMs = performance.now();
  return () => {
    const wallMs = Date.now();
    const monoMs = performance.now();
    const projectedMs = anchorWallMs + (monoMs - anchorMonoMs);
    const nowMs = wallMs >= projectedMs ? wallMs : projectedMs;
    anchorWallMs = nowMs;
    anchorMonoMs = monoMs;
    // `performance.now()` is sub-millisecond, so the projection carries a
    // fraction the integer epoch-ms it is compared against never has. Floor
    // it, or an untroubled clock reads as a fraction of a millisecond of skew.
    return Math.floor(nowMs);
  };
}
