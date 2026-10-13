import { describe, expect, it } from "vitest";

import { type CreditMenu, parseCreditMenu } from "../../transport/types";
import {
  offersX402CreditChannel,
  offersX402CreditFlavour,
  offersX402CreditFunding,
  x402CreditChannelNetworks,
  x402CreditExactNetworks,
  x402CreditFlavour,
  x402CreditFundingNetworks,
  x402FlavourForInstrument,
  x402InstrumentForFlavour,
} from "../menu";

const BASE_SEPOLIA = "eip155:84532";
const BASE = "eip155:8453";

const MENU: CreditMenu = {
  min_micro: 10_000,
  max_micro: 5_000_000,
  ttl_ms: 1,
  currency: "usd",
  funding: ["x402"],
  x402: {
    schemes: [
      { scheme: "exact", network: BASE_SEPOLIA },
      { scheme: "batch-settlement", network: BASE_SEPOLIA },
    ],
  },
};

/** The shape the fix is really about: the rail is on, no channel behind it. */
const EXACT_ONLY: CreditMenu = {
  ...MENU,
  x402: { schemes: [{ scheme: "exact", network: BASE_SEPOLIA }] },
};

/** A server predating the sub-block: the rail is named, no scheme is. */
const NO_BLOCK: CreditMenu = { ...MENU, x402: undefined };

describe("offersX402CreditChannel", () => {
  it("accepts a batch-settlement channel on the wallet's own chain", () => {
    expect(offersX402CreditChannel(MENU, BASE_SEPOLIA)).toBe(true);
    expect(offersX402CreditChannel(MENU)).toBe(true);
  });

  it("refuses an exact-only DVM — the rail is real, the channel isn't", () => {
    expect(offersX402CreditChannel(EXACT_ONLY, BASE_SEPOLIA)).toBe(false);
    expect(offersX402CreditChannel(EXACT_ONLY)).toBe(false);
  });

  it("refuses a menu that advertises the rail but carries no block at all", () => {
    expect(offersX402CreditChannel(NO_BLOCK)).toBe(false);
    expect(offersX402CreditChannel(undefined)).toBe(false);
  });

  it("refuses a channel on another chain", () => {
    expect(offersX402CreditChannel(MENU, BASE)).toBe(false);
  });
});

describe("offersX402CreditFunding", () => {
  it("accepts either flavour on the wallet's own chain", () => {
    expect(offersX402CreditFunding(MENU, BASE_SEPOLIA)).toBe(true);
    expect(offersX402CreditFunding(EXACT_ONLY, BASE_SEPOLIA)).toBe(true);
  });

  it("refuses either flavour on another chain", () => {
    expect(offersX402CreditFunding(MENU, BASE)).toBe(false);
    expect(offersX402CreditFunding(EXACT_ONLY, BASE)).toBe(false);
  });

  it("refuses a menu that names no scheme at all", () => {
    expect(offersX402CreditFunding(NO_BLOCK)).toBe(false);
    expect(offersX402CreditFunding(undefined)).toBe(false);
  });
});

describe("x402CreditFlavour", () => {
  it("prefers the channel wherever both are offered — a deposit amortizes", () => {
    expect(x402CreditFlavour(MENU, BASE_SEPOLIA)).toBe("batch-settlement");
  });

  it("falls back to exact where that is all the DVM opens", () => {
    expect(x402CreditFlavour(EXACT_ONLY, BASE_SEPOLIA)).toBe("exact");
  });

  it("answers nothing off the wallet's chain, or with no block at all", () => {
    expect(x402CreditFlavour(MENU, BASE)).toBeUndefined();
    expect(x402CreditFlavour(EXACT_ONLY, BASE)).toBeUndefined();
    expect(x402CreditFlavour(NO_BLOCK, BASE_SEPOLIA)).toBeUndefined();
  });

  it("picks exact when the channel is on a chain this wallet isn't pinned to", () => {
    const split: CreditMenu = {
      ...MENU,
      x402: {
        schemes: [
          { scheme: "exact", network: BASE_SEPOLIA },
          { scheme: "batch-settlement", network: BASE },
        ],
      },
    };
    expect(x402CreditFlavour(split, BASE_SEPOLIA)).toBe("exact");
    expect(x402CreditFlavour(split, BASE)).toBe("batch-settlement");
  });
});

describe("the network readers", () => {
  it("names only the channel chains — `exact` entries are not channels", () => {
    expect(x402CreditChannelNetworks(MENU)).toEqual([BASE_SEPOLIA]);
    expect(x402CreditChannelNetworks(EXACT_ONLY)).toEqual([]);
    expect(x402CreditChannelNetworks(undefined)).toEqual([]);
  });

  it("names only the exact chains", () => {
    expect(x402CreditExactNetworks(MENU)).toEqual([BASE_SEPOLIA]);
    expect(x402CreditExactNetworks({ ...MENU, x402: { schemes: [] } })).toEqual([]);
  });

  it("unions both flavours without repeating a chain", () => {
    expect(x402CreditFundingNetworks(MENU)).toEqual([BASE_SEPOLIA]);
    expect(x402CreditFundingNetworks(EXACT_ONLY)).toEqual([BASE_SEPOLIA]);
    expect(x402CreditFundingNetworks(NO_BLOCK)).toEqual([]);
  });
});

describe("the credit binding, in both vocabularies", () => {
  it("asks after one named flavour, where x402CreditFlavour would prefer the other", () => {
    expect(offersX402CreditFlavour(MENU, BASE_SEPOLIA, "exact")).toBe(true);
    expect(offersX402CreditFlavour(MENU, BASE_SEPOLIA, "batch-settlement")).toBe(true);
    // The case a bound credit is refused on: the rail is offered, its flavour isn't.
    expect(offersX402CreditFlavour(EXACT_ONLY, BASE_SEPOLIA, "batch-settlement")).toBe(false);
    expect(offersX402CreditFlavour(MENU, BASE, "exact")).toBe(false);
    expect(offersX402CreditFlavour(NO_BLOCK, BASE_SEPOLIA, "exact")).toBe(false);
  });

  it("round-trips a flavour through the server's instrument names", () => {
    expect(x402InstrumentForFlavour("exact")).toBe("x402_exact");
    expect(x402InstrumentForFlavour("batch-settlement")).toBe("x402_channel");
    expect(x402FlavourForInstrument("x402_exact")).toBe("exact");
    expect(x402FlavourForInstrument("x402_channel")).toBe("batch-settlement");
  });

  it("reads no flavour out of another rail's instrument", () => {
    // A cross-rail refusal carries the credit's whole binding, so this is what
    // keeps a Tempo one from seeding an x402 pin.
    expect(x402FlavourForInstrument("tempo_session")).toBeUndefined();
    expect(x402FlavourForInstrument("tempo_charge")).toBeUndefined();
    expect(x402FlavourForInstrument(undefined)).toBeUndefined();
  });
});

describe("parseCreditMenu — the x402 sub-block", () => {
  it("carries a well-formed block through", () => {
    expect(parseCreditMenu(JSON.parse(JSON.stringify(MENU)))?.x402).toEqual(MENU.x402);
  });

  it("keeps a menu from a server that predates the block", () => {
    const { x402: _x402, ...legacy } = MENU;
    expect(parseCreditMenu(legacy)).toBeDefined();
  });

  it("drops the whole menu when the block is malformed", () => {
    expect(parseCreditMenu({ ...MENU, x402: { schemes: [{ scheme: 2 }] } })).toBeUndefined();
    expect(parseCreditMenu({ ...MENU, x402: { schemes: "batch-settlement" } })).toBeUndefined();
  });
});
