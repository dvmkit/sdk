/**
 * Every lock shape the accumulator is expected to accept. The unit table
 * checks the verdict; the live-mint test proves each one is signable by the
 * DVM key and redeemable at a real mint, so an accepted shape cannot be added
 * here without that proof.
 */
export interface AcceptedLockShape {
  label: string;
  data: string;
  tags: string[][];
  /** Which active key the verdict should name: the current one or the retired one. */
  matches: "current" | "retired";
}

export function acceptedLockShapes(keys: {
  current: string;
  retired: string;
  payer: string;
  nowSec: number;
}): AcceptedLockShape[] {
  const { current, retired, payer, nowSec } = keys;
  const weekOut = `${nowSec + 7 * 86_400}`;
  const otherParity = (current.startsWith("02") ? "03" : "02") + current.slice(2);
  return [
    { label: "no tags", data: current, tags: [], matches: "current" },
    { label: "a refund tag without a locktime", data: current, tags: [["refund", payer]], matches: "current" },
    { label: "the reference caller's 7-day lock with a payer refund", data: current, tags: [["locktime", weekOut], ["refund", payer]], matches: "current" },
    { label: "a retired-in-grace DVM key", data: retired, tags: [], matches: "retired" },
    { label: "a DVM key under the other 02/03 prefix", data: otherParity, tags: [], matches: "current" },
    { label: "an explicit SIG_INPUTS sigflag", data: current, tags: [["sigflag", "SIG_INPUTS"]], matches: "current" },
    { label: "an explicit n_sigs of 1", data: current, tags: [["n_sigs", "1"]], matches: "current" },
    { label: "a 1-of-2 main path over two DVM keys", data: current, tags: [["pubkeys", retired.toUpperCase()]], matches: "current" },
    { label: "an n_sigs_refund within the refund keys", data: current, tags: [["locktime", weekOut], ["refund", payer], ["n_sigs_refund", "1"]], matches: "current" },
  ];
}
