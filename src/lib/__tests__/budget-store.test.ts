import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { expect, it } from "vitest";
import { appendBudgetSpend, loadBudgetLedger } from "../budget-store";

it("owns an explicit ledger path and deduplicates only the full logical payment tuple", () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-store-"));
  const file = join(directory, "state", "budget.json");
  const options = {
    jobId: "payment", providerEndpoint: "https://example.com", msats: 1_000_000,
    btcRate: 100_000, now: new Date("2020-01-01T00:00:00Z"),
  };
  try {
    expect(appendBudgetSpend(file, options, true)).toBe(true);
    expect(appendBudgetSpend(file, { ...options, kind: "job" }, true)).toBe(false);
    expect(appendBudgetSpend(file, { ...options, kind: "credit_fund" }, true)).toBe(true);
    expect(appendBudgetSpend(file, { ...options, providerEndpoint: "https://other.example.com" }, true)).toBe(true);
    expect(appendBudgetSpend(file, options)).toBe(true);
    expect(loadBudgetLedger(file).entries.map((entry) => [entry.kind ?? "job", entry.providerEndpoint])).toEqual([
      ["job", "https://example.com"], ["credit_fund", "https://example.com"],
      ["job", "https://other.example.com"], ["job", "https://example.com"],
    ]);
    if (process.platform !== "win32") expect(statSync(join(directory, "state")).mode & 0o777).toBe(0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
