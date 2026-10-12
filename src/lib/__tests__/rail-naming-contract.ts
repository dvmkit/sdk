/**
 * The two registers a rail is named in, as literals.
 *
 * Not a test file. {@link CALLER_RAIL_NOUN} is the gloss every surface
 * downstream of a rail choice reads; {@link RAIL_CHOICE_NAME} is the protocol
 * name the choice itself leads with. Holding both here is what keeps the split
 * deliberate rather than accidental — a sweep that finds one table and not the
 * other is how this file came to exist twice.
 */

/**
 * The one noun each rail must read as on every caller-facing surface.
 *
 * `rail-labels.test.ts` pins the table against these literals, and
 * `quote.test.ts`, `wallet.test.ts` and `credit.test.ts` each assert their own
 * command's `--human` output against the same ones. That is the cross-command
 * guarantee in executable form — a rail that drifts on any one of the three
 * fails that command's suite, and a rail that drifts in the table fails all of
 * them.
 *
 * Deliberately literals rather than calls into `rail-labels.ts`: a test that
 * asserted the output equals the function it was rendered from would pass no
 * matter what the copy said.
 */
export const CALLER_RAIL_NOUN = {
  cashu: "ecash",
  lightning: "Lightning",
  x402: "x402 stablecoin",
  tempo: "Tempo stablecoin",
} as const;

/**
 * The one register difference {@link CALLER_RAIL_NOUN} allows: a wallet probe
 * reports what the caller *holds*, and a connected Lightning wallet is a
 * funding float rather than a rail a job can be paid off directly.
 */
export const PROBE_LIGHTNING_NOUN = "Lightning float";

/**
 * The protocol name each rail leads with while the caller is still *choosing*
 * one — `dvm wallet setup`'s onramp titles and the NWC float row beside them
 *
 * Deliberately not {@link CALLER_RAIL_NOUN}, and the pair is why both live
 * here: carved rail choice out of the gloss rule, because at that
 * moment the protocol name is the information — it identifies the row to
 * someone who already holds that money, and it's the `--rail` value they type
 * next. So the setup menu pins "Cashu" while a balance row forbids `Cashu:`,
 * and both are correct. The menu itself is the caller CLI's, in its own
 * repository, and its suite pins this register there; a pass that "fixes" a
 * title to the gloss fails against it. These literals stay here so the gloss
 * side keeps the other register in view.
 */
export const RAIL_CHOICE_NAME = {
  cashu: "Cashu",
  tempo: "Tempo",
  x402: "x402",
  nwc: "NWC",
} as const;
