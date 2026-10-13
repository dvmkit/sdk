import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { entryKind, spendEntry, type BudgetLedger, type RecordSpendOptions } from "./budget-core";

/** Load the persisted ledger. Returns an empty ledger if the file is missing or corrupt. */
export function loadBudgetLedger(file: string): BudgetLedger {
  if (!existsSync(file)) return { caps: {}, entries: [] };
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as Partial<BudgetLedger>;
    return { caps: data.caps ?? {}, entries: data.entries ?? [] };
  } catch {
    return { caps: {}, entries: [] };
  }
}

/**
 * Persist the ledger using a temp-file-and-rename so a crash mid-write cannot
 * leave a partial JSON on disk (which would silently reset configured caps).
 * Confirmed spending is retained indefinitely; budget checks apply their own
 * window cutoffs.
 */
export function saveBudgetLedger(file: string, ledger: BudgetLedger): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  renameSync(tmp, file);
}

/**
 * Record one logical spend at most once across a crash/replay window.
 *
 * Callers must give the logical operation a stable `jobId`. Kind, job id and
 * provider form the idempotency tuple, so unrelated payments on one job can
 * still use the ordinary append-only path (`once = false`).
 * The caller holds its existing payment lock across check, payment, and append;
 * this writer does not create a separate lock domain.
 */
export function appendBudgetSpend(file: string, opts: RecordSpendOptions, once = false): boolean {
  const ledger = loadBudgetLedger(file);
  const kind = opts.kind ?? "job";
  if (
    once && ledger.entries.some(
      (entry) =>
        entryKind(entry) === kind &&
        entry.jobId === opts.jobId &&
        entry.providerEndpoint === opts.providerEndpoint
    )
  ) {
    return false;
  }
  ledger.entries.push(spendEntry(opts));
  saveBudgetLedger(file, ledger);
  return true;
}
