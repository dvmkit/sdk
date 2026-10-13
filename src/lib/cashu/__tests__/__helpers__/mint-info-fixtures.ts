/**
 * Real-shaped NUT-06 `/v1/info` `nuts` blocks for tests that reason about mint
 * capability.
 *
 * Captured from the live mints on 2026-07-31, not hand-idealised: the
 * capability reads these fixtures exercise are the ones that decide whether a
 * per-call spend routes to a mint or around it, and a synthetic `nuts` object
 * would let a wrong read pass. Note what a healthy mint does *not* say — there
 * is no `"3"` key on either. Swap is a baseline operation nobody advertises,
 * which is why {@link canSwap} reads its absence as capable.
 */

export const HEALTHY_MINT_NUTS: Record<string, unknown> = {
  "4": {
    methods: [
      {
        method: "bolt11",
        unit: "sat",
        min_amount: 0,
        max_amount: 1000000,
        options: { description: true },
      },
    ],
    disabled: false,
  },
  "5": {
    methods: [{ method: "bolt11", unit: "sat", min_amount: 0, max_amount: 1000000 }],
    disabled: false,
  },
  "7": { supported: true },
  "8": { supported: true },
  "9": { supported: true },
  "10": { supported: true },
  "11": { supported: true },
  "12": { supported: true },
  "14": { supported: true },
  "20": { supported: true },
  "17": {
    supported: [
      {
        method: "bolt11",
        unit: "sat",
        commands: ["bolt11_melt_quote", "proof_state", "bolt11_mint_quote"],
      },
    ],
  },
  "19": {
    cached_endpoints: [
      { method: "POST", path: "/v1/mint/bolt11" },
      { method: "POST", path: "/v1/melt/bolt11" },
      { method: "POST", path: "/v1/swap" },
    ],
    ttl: 604800,
  },
};

/** Melt-only snapshot from 2026-07-30: required NUTs remain advertised while minting and swaps are disabled. */
export const MELT_ONLY_MINT_NUTS: Record<string, unknown> = {
  "3": { supported: false, disabled: true },
  "4": {
    methods: [
      { method: "bolt11", unit: "sat", method_name: "bolt11", options: { description: true } },
    ],
    disabled: true,
  },
  "5": {
    methods: [{ method: "bolt11", unit: "sat", method_name: "bolt11" }],
    disabled: false,
  },
  "7": { supported: true },
  "8": { supported: true },
  "9": { supported: true },
  "10": { supported: true },
  "11": { supported: true },
  "12": { supported: true },
  "14": { supported: true },
  "20": { supported: true },
  "15": { methods: [{ method: "bolt11", unit: "sat" }] },
  "17": {
    supported: [
      {
        method: "bolt11",
        unit: "sat",
        commands: ["bolt11_melt_quote", "proof_state", "bolt11_mint_quote"],
      },
    ],
  },
  "29": { supported: true, max_batch_size: 1000 },
};

/** Full `/v1/info` document around a `nuts` block, in coinos/Nutshell shape. */
export function mintInfoDocument(nuts: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "Test Mint",
    pubkey: "02fb2009743c0cc2a13309c807ac5c3aa772d9b17241801194e3b938811e6644c1",
    version: "Nutshell/0.20.3",
    description: "fixture mint",
    nuts,
  };
}
