
import { describe, expect, it } from "vitest";

import type { FxFetcher } from "../../pricing/index";
import type { ResolvedCreditConfig } from "../../types";
import { buildCreditMenu, selectPrimaryCredit } from "../credit-menu";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { durableLedger, fundCredit } from "./__helpers__/credit-fixtures";

const CALLER = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const stubFx: FxFetcher = {
  fetch: () =>
    Promise.resolve({ rates: { usd: 100_000, eur: 90_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd", "eur"],
};

const deadFx: FxFetcher = {
  fetch: () => Promise.reject(new Error("rate provider down")),
  supportedCurrencies: () => ["usd"],
};

const CONFIG: ResolvedCreditConfig = {
  min: "$0.10",
  max: "$5.00",
  ttlSeconds: 30 * 24 * 60 * 60,
  allowOneShotStablecoin: false,
};

function args(overrides: Partial<Parameters<typeof buildCreditMenu>[0]> = {}) {
  return {
    runtime: "container" as const,
    config: CONFIG,
    currency: "usd",
    funding: ["cashu" as const],

    hasAcceptedMint: true,
    fxFetcher: stubFx,
    hasAuth: true,
    ledger: durableLedger(),
    ...overrides,
  };
}

describe("credit menu assembly", () => {
  it("advertises the configured bounds in the quote's currency", async () => {
    const menu = await buildCreditMenu(args());
    expect(menu).toEqual({
      min_micro: 100_000,
      max_micro: 5_000_000,
      ttl_ms: 30 * 24 * 60 * 60 * 1000,
      currency: "usd",
      funding: ["cashu"],
    });
  });

  it("advertises only reusable Tempo sessions by default", async () => {
    const menu = await buildCreditMenu(
      args({
        funding: ["tempo"],
        tempoMethods: [
          { method: "tempo", intent: "session" },
          { method: "tempo", intent: "charge" },
        ],
      })
    );
    expect(menu?.tempo).toEqual({
      methods: [{ method: "tempo", intent: "session" }],
    });
  });

  it("advertises only reusable x402 batch settlement by default", async () => {
    const schemes = [
      { scheme: "exact", network: "eip155:84532" },
      { scheme: "batch-settlement", network: "eip155:84532" },
    ];
    const menu = await buildCreditMenu(args({ funding: ["x402"], x402Schemes: schemes }));
    expect(menu?.x402).toEqual({ schemes: [schemes[1]] });
  });

  it("restores both one-payment stablecoin instruments under explicit opt-in", async () => {
    const menu = await buildCreditMenu(
      args({
        config: { ...CONFIG, allowOneShotStablecoin: true },
        funding: ["tempo", "x402"],
        tempoMethods: [
          { method: "tempo", intent: "session" },
          { method: "tempo", intent: "charge" },
        ],
        x402Schemes: [
          { scheme: "exact", network: "eip155:84532" },
          { scheme: "batch-settlement", network: "eip155:84532" },
        ],
      })
    );
    expect(menu?.tempo?.methods.map((method) => method.intent)).toEqual(["session", "charge"]);
    expect(menu?.x402?.schemes.map((scheme) => scheme.scheme)).toEqual([
      "exact",
      "batch-settlement",
    ]);
  });

  it("omits stablecoin rails that have no reusable instrument", async () => {
    const menu = await buildCreditMenu(
      args({
        funding: ["cashu", "tempo", "x402"],
        tempoMethods: [{ method: "tempo", intent: "charge" }],
        x402Schemes: [{ scheme: "exact", network: "eip155:84532" }],
      })
    );
    expect(menu?.funding).toEqual(["cashu"]);
    expect(menu?.tempo).toBeUndefined();
    expect(menu?.x402).toBeUndefined();
  });

  it("preserves a withheld reusable Tempo capability without advertising the rail", async () => {
    const menu = await buildCreditMenu(
      args({
        funding: ["tempo"],
        tempoMethods: [{ method: "tempo", intent: "charge" }],
        tempoWithheld: [{ method: "tempo", intent: "session", reason: "observer_unconfirmed" }],
      })
    );
    expect(menu?.funding).toEqual([]);
    expect(menu?.tempo).toEqual({
      methods: [],
      withheld: [{ method: "tempo", intent: "session", reason: "observer_unconfirmed" }],
    });
  });

  it("omits the x402 sub-block when the rail isn't wired at all", async () => {
    const menu = await buildCreditMenu(args({ funding: ["cashu"], x402Schemes: [] }));
    expect(menu?.x402).toBeUndefined();
  });

  it("omits the x402 sub-block for a rail the menu doesn't offer", async () => {
    const menu = await buildCreditMenu(
      args({
        funding: ["cashu"],
        x402Schemes: [{ scheme: "batch-settlement", network: "eip155:84532" }],
      })
    );
    expect(menu?.x402).toBeUndefined();
  });

  it("omits x402 funding from a non-USD menu", async () => {
    const menu = await buildCreditMenu(
      args({
        currency: "eur",
        funding: ["cashu", "x402"],
        x402Schemes: [{ scheme: "batch-settlement", network: "eip155:84532" }],
      })
    );
    expect(menu?.funding).toEqual(["cashu"]);
    expect(menu?.x402).toBeUndefined();
  });

  it("needs no fx at all for a USD quote (bounds are already USD)", async () => {
    const menu = await buildCreditMenu(args({ fxFetcher: deadFx }));
    expect(menu?.min_micro).toBe(100_000);
    expect(menu?.max_micro).toBe(5_000_000);
  });

  it("expresses USD-configured bounds in a non-USD quote currency", async () => {
    const menu = await buildCreditMenu(args({ currency: "eur" }));
    expect(menu?.currency).toBe("eur");

    expect(menu?.min_micro).toBe(90_000);
  });

  describe("per-rail Lightning minimum", () => {
    it("advertises the margined floor in USD", async () => {
      const menu = await buildCreditMenu(
        args({ funding: ["cashu", "lightning"], lightningFundingMinSats: 2000 })
      );

      expect(menu?.lightning_min_micro).toBe(2_300_000);
      expect(menu?.funding).toEqual(["cashu", "lightning"]);
    });

    it("renders the floor in the quote's own currency", async () => {
      const menu = await buildCreditMenu(
        args({ currency: "eur", funding: ["cashu", "lightning"], lightningFundingMinSats: 2000 })
      );

      expect(menu?.lightning_min_micro).toBe(2_070_000);
    });

    it("drops the lightning rail — not the menu — when fx is down on a USD quote", async () => {
      // The bounds path needs no fx for USD, but the floor is sats-physical
      // and always does. The degradation must stay scoped to the rail whose
      // minimum can't be stated honestly.
      const menu = await buildCreditMenu(
        args({
          fxFetcher: deadFx,
          funding: ["cashu", "lightning"],
          lightningFundingMinSats: 2000,
        })
      );
      expect(menu).toBeDefined();
      expect(menu?.funding).toEqual(["cashu"]);
      expect(menu?.lightning_min_micro).toBeUndefined();
      expect(menu?.min_micro).toBe(100_000);
    });

    it("keeps charge-only Tempo excluded when the Lightning floor FX lookup fails", async () => {
      const menu = await buildCreditMenu(
        args({
          fxFetcher: deadFx,
          funding: ["cashu", "tempo", "lightning", "x402"],
          tempoMethods: [{ method: "tempo", intent: "charge" }],
          x402Schemes: [{ scheme: "batch-settlement", network: "eip155:84532" }],
          lightningFundingMinSats: 2000,
        })
      );
      expect(menu?.funding).toEqual(["cashu", "x402"]);
      expect(menu?.tempo).toBeUndefined();
      expect(menu?.x402?.schemes).toEqual([
        { scheme: "batch-settlement", network: "eip155:84532" },
      ]);
      expect(menu?.lightning_min_micro).toBeUndefined();
    });

    it("keeps explicit Cashu and Lightning overrides excluded without an accepted mint", async () => {
      const menu = await buildCreditMenu(
        args({
          fxFetcher: deadFx,
          funding: ["cashu", "lightning", "x402"],
          hasAcceptedMint: false,
          x402Schemes: [{ scheme: "batch-settlement", network: "eip155:84532" }],
          lightningFundingMinSats: 2000,
        })
      );
      expect(menu?.funding).toEqual(["x402"]);
      expect(menu?.lightning_min_micro).toBeUndefined();
    });

    it("omits the Lightning minimum when the mint gate excludes the rail", async () => {
      const menu = await buildCreditMenu(
        args({
          funding: ["cashu", "lightning"],
          hasAcceptedMint: false,
          lightningFundingMinSats: 2000,
        })
      );
      expect(menu?.funding).toEqual([]);
      expect(menu?.lightning_min_micro).toBeUndefined();
    });

    it("omits the field when lightning isn't offered or no floor is configured", async () => {
      const noLightning = await buildCreditMenu(args({ lightningFundingMinSats: 2000 }));
      expect(noLightning?.lightning_min_micro).toBeUndefined();
      const noFloor = await buildCreditMenu(args({ funding: ["cashu", "lightning"] }));
      expect(noFloor?.lightning_min_micro).toBeUndefined();
      expect(noFloor?.funding).toEqual(["cashu", "lightning"]);
    });
  });

  describe("refusal ladder", () => {
    it("refuses the isolate runtime even when everything else says yes", async () => {
      // All other eligibility conditions hold, so only the isolate gate can suppress this menu.
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 2_000_000,
        expiryMs: FUTURE_MS,
      });
      const menu = await buildCreditMenu(
        args({ runtime: "isolate", ledger, callerPubkey: CALLER })
      );
      expect(menu).toBeUndefined();
    });

    it("refuses a DVM that did not opt in", async () => {
      expect(await buildCreditMenu(args({ config: undefined }))).toBeUndefined();
    });

    it("refuses a DVM without descriptor auth", async () => {

      expect(await buildCreditMenu(args({ hasAuth: false }))).toBeUndefined();
    });

    it("refuses a non-durable ledger outside devMode, and allows it inside", async () => {
      const memory = new MemoryCreditLedger();
      expect(await buildCreditMenu(args({ ledger: memory }))).toBeUndefined();
      expect(await buildCreditMenu(args({ ledger: memory, devMode: true }))).toBeDefined();
    });

    it("omits the block rather than failing the quote when fx is down", async () => {
      const menu = await buildCreditMenu(args({ currency: "eur", fxFetcher: deadFx }));
      expect(menu).toBeUndefined();
    });
  });

  describe("balance echo", () => {
    it("echoes the caller's live credit", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 2_000_000,
        expiryMs: FUTURE_MS,
      });
      const menu = await buildCreditMenu(args({ ledger, callerPubkey: CALLER }));
      expect(menu?.credit_id).toBe("c1");
      expect(menu?.balance_micro).toBe(2_000_000);
      expect(menu?.remaining_micro).toBe(2_000_000);
      expect(menu?.expiry_ms).toBe(FUTURE_MS);
    });

    it("omits the echo for an unauthenticated caller", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 2_000_000,
        expiryMs: FUTURE_MS,
      });
      const menu = await buildCreditMenu(args({ ledger }));
      expect(menu).toBeDefined();
      expect(menu?.balance_micro).toBeUndefined();
      expect(menu?.credit_id).toBeUndefined();
    });

    it("never echoes another caller's balance", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: OTHER,
        currency: "usd",
        amountMicro: 2_000_000,
        expiryMs: FUTURE_MS,
      });
      const menu = await buildCreditMenu(args({ ledger, callerPubkey: CALLER }));
      expect(menu?.balance_micro).toBeUndefined();
    });

    it("subtracts pending holds — the echo is spendable, not funded, balance", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 2_000_000,
        expiryMs: FUTURE_MS,
      });
      await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 500_000 });
      const menu = await buildCreditMenu(args({ ledger, callerPubkey: CALLER }));
      expect(menu?.balance_micro).toBe(2_000_000);
      expect(menu?.remaining_micro).toBe(1_500_000);
    });
  });
});

describe("selectPrimaryCredit", () => {
  it("picks the largest spendable balance among several", async () => {
    const ledger = new MemoryCreditLedger();
    for (const [id, amount] of [
      ["small", 100_000],
      ["big", 900_000],
      ["mid", 400_000],
    ] as const) {
      await fundCredit(ledger, {
        creditId: id,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: amount,
        expiryMs: FUTURE_MS,
      });
    }
    const picked = await selectPrimaryCredit({ ledger, callerPubkey: CALLER, currency: "usd" });
    expect(picked?.creditId).toBe("big");
  });

  it("skips expired, foreign-currency, and drained credits", async () => {
    const ledger = new MemoryCreditLedger();
    await fundCredit(ledger, {
      creditId: "expired",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 900_000,
      expiryMs: Date.now() - 1_000,
    });
    await fundCredit(ledger, {
      creditId: "eur",
      callerPubkey: CALLER,
      currency: "eur",
      amountMicro: 900_000,
      expiryMs: FUTURE_MS,
    });
    await fundCredit(ledger, {
      creditId: "live",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
    });
    await fundCredit(ledger, {
      creditId: "drained", callerPubkey: CALLER, currency: "usd",
      amountMicro: 900_000, expiryMs: FUTURE_MS,
    });
    await ledger.requestDrain({
      creditId: "drained", drainId: "drain", callerPubkey: CALLER,
      method: "cashu", payout: { refund_pubkey: `02${"cd".repeat(32)}` },
    });
    const picked = await selectPrimaryCredit({ ledger, callerPubkey: CALLER, currency: "usd" });
    expect(picked?.creditId).toBe("live");
    await ledger.requestDrain({
      creditId: "live", drainId: "drain-live", callerPubkey: CALLER,
      method: "cashu", payout: { refund_pubkey: `02${"cd".repeat(32)}` },
    });
    expect(await selectPrimaryCredit({ ledger, callerPubkey: CALLER, currency: "usd" })).toBeUndefined();
  });

  it("refuses to resolve an anonymous or missing caller", async () => {
    const ledger = new MemoryCreditLedger();
    await fundCredit(ledger, {
      creditId: "pool",
      callerPubkey: "anonymous",
      currency: "usd",
      amountMicro: 900_000,
      expiryMs: FUTURE_MS,
    });
    expect(
      await selectPrimaryCredit({ ledger, callerPubkey: "anonymous", currency: "usd" })
    ).toBeUndefined();
    expect(await selectPrimaryCredit({ ledger, currency: "usd" })).toBeUndefined();
  });
});
