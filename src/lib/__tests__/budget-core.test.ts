import { describe, expect, it } from "vitest";
import { checkBudgetForLedger, spendEntry, type BudgetLedger } from "../budget-core";

const now = new Date("2026-04-17T12:00:00Z");

describe("explicit budget accounting", () => {
  it.each([
    ["daily", "2026-04-17T00:00:00Z", "2026-04-18T00:00:00Z"],
    ["weekly", "2026-04-13T00:00:00Z", "2026-04-20T00:00:00Z"],
    ["monthly", "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z"],
  ] as const)("checks explicit %s caps and stored USD without repricing history", (window, start, end) => {
    const base = { jobId: "payment", providerEndpoint: "https://example.com", msats: 1_000_000, btcRate: 50_000, usd: 0.5 };
    const ledger: BudgetLedger = {
      caps: { [`${window}Usd`]: 2.5 },
      entries: [
        { ...base, timestamp: new Date(start).getTime() - 1, usd: 100 },
        { ...base, timestamp: new Date(start).getTime() },
        { ...base, timestamp: now.getTime(), kind: "float_fund", usd: 0.25 },
        { ...base, timestamp: now.getTime(), kind: "credit_fund", usd: 0.75 },
      ],
    };
    expect(checkBudgetForLedger(ledger, { plannedMsats: 1_000_000, btcRate: 100_000, now })).toEqual({ ok: true });
    expect(checkBudgetForLedger(ledger, { plannedMsats: 1_000_001, btcRate: 100_000, now })).toEqual({
      ok: false, window, spentUsd: 1.5, limitUsd: 2.5, resetsAt: new Date(end).getTime(),
      breakdown: { totalUsd: 1.5, jobsUsd: 0.5, floatFundingsUsd: 0.25, creditFundingsUsd: 0.75 },
    });
    expect(ledger.entries).toHaveLength(4);
  });

  it("constructs confirmed spend evidence without losing null fee fields or legacy job shape", () => {
    expect(spendEntry({
      jobId: "payment", providerEndpoint: "https://example.com", msats: 1_250_000,
      btcRate: 100_000, now, kind: "job", principalMsats: 1_000_000,
      routingFeeMsats: null, totalWalletFeeMsats: 250_000, unitemizedWalletFeeMsats: null,
      walletDebitMsats: 1_250_000, label: "processing", labelSource: "provider",
    })).toEqual({
      timestamp: now.getTime(), jobId: "payment", providerEndpoint: "https://example.com",
      msats: 1_250_000, btcRate: 100_000, usd: 1.25, principalMsats: 1_000_000,
      routingFeeMsats: null, totalWalletFeeMsats: 250_000, unitemizedWalletFeeMsats: null,
      walletDebitMsats: 1_250_000, label: "processing", labelSource: "provider",
    });
  });
});
