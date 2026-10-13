import { msatsToUsd } from "./payment-amounts";

export type BudgetWindow = "daily" | "weekly" | "monthly";

/** User-configured fiat caps. Any subset may be set. */
export interface BudgetCaps {
  dailyUsd?: number;
  weeklyUsd?: number;
  monthlyUsd?: number;
}

/**
 * What kind of outflow a ledger entry records.
 *
 * `job` — sats paid to a DVM for work. `float_fund` — sats moved out of the
 * Lightning float to top the agent up. `credit_fund` — sats moved
 * into a DVM's prepaid credit, whether opened with a job or topped
 * up via `/v1/credit`. All count against the same caps: the cap is on money
 * the agent *moves*, which binds sooner rather than later. Draws against an
 * existing credit are consumption of already-counted money and are never
 * recorded here — `dvm wallet history` surfaces them from signed receipts.
 */
export type BudgetSpendKind = "job" | "float_fund" | "credit_fund";

/** A single recorded spend. USD is captured at spend time using the fetched BTC rate. */
export interface BudgetLedgerEntry {
  /** Unix timestamp (ms) when the payment was confirmed. */
  timestamp: number;
  /** Missing kind denotes a legacy job spend; entryKind supplies that default. */
  kind?: BudgetSpendKind;
  /** Job ID the payment belongs to. For `float_fund`, the funding reference (e.g. a mint quote id). */
  jobId: string;
  /** Provider HTTPS endpoint URL. For `float_fund`, where the sats went (e.g. a mint URL). */
  providerEndpoint: string;
  /** Amount paid in millisatoshis. */
  msats: number;
  /** Invoice principal for an NWC float payment. Absent on other and legacy entries. */
  principalMsats?: number;
  /** Wallet-reported NWC routing fee. Null means the wallet omitted it. */
  routingFeeMsats?: number | null;
  /** Total NWC wallet fee from an exact debit. Null means the total is unprovable. */
  totalWalletFeeMsats?: number | null;
  /** Wallet fee not itemized as routing. Null means the split is unprovable. */
  unitemizedWalletFeeMsats?: number | null;
  /** Exact NWC wallet debit. Null means wallet evidence could not prove it. */
  walletDebitMsats?: number | null;
  /** BTC/USD rate used at spend time. */
  btcRate: number;
  /** USD equivalent at spend time. */
  usd: number;
  /**
   * Human context for wallet history: CLI-authored for upfront payments,
   * provider-supplied for mid-job payment requests. Optional on legacy entries.
   */
  label?: string;
  /**
   * Provenance of {@link label}. `"provider"` marks it as provider-supplied
   * free text (a mid-job `payment-request.reason`) so `dvm wallet history`
   * provenance-wraps it (`{ _source: "provider", text }`) when relaying JSON.
   * Absent for CLI-authored labels.
   */
  labelSource?: "provider";
}

export interface BudgetLedger {
  caps: BudgetCaps;
  entries: BudgetLedgerEntry[];
}

export interface BudgetSpendBreakdown {
  /** Total USD spent in the window — the number caps are checked against. */
  totalUsd: number;
  /** USD paid to DVMs for work. */
  jobsUsd: number;
  /** USD moved out of the Lightning float to top the agent up. */
  floatFundingsUsd: number;
  /** USD moved into DVM prepaid credits. */
  creditFundingsUsd: number;
}

export type BudgetCheckResult =
  | { ok: true }
  | {
      ok: false;
      window: BudgetWindow;
      spentUsd: number;
      limitUsd: number;
      resetsAt: number;
      breakdown: BudgetSpendBreakdown;
    };

export interface RecordSpendOptions {
  msats: number;
  principalMsats?: number;
  routingFeeMsats?: number | null;
  totalWalletFeeMsats?: number | null;
  unitemizedWalletFeeMsats?: number | null;
  walletDebitMsats?: number | null;
  btcRate: number;
  /** Outflow kind. Defaults to `job`. */
  kind?: BudgetSpendKind;
  jobId: string;
  providerEndpoint: string;
  /** Optional short context label — see {@link BudgetLedgerEntry.label}. */
  label?: string;
  /** Set to `"provider"` when {@link label} is provider-supplied free text. */
  labelSource?: "provider";
  now?: Date;
}

/**
 * Check whether a planned spend would exceed any configured cap.
 * Returns the first window violated; if multiple windows would be exceeded,
 * the daily window is reported first, then weekly, then monthly.
 */
export function checkBudgetForLedger(ledger: BudgetLedger, opts: {
  plannedMsats: number;
  btcRate: number;
  now?: Date;
}): BudgetCheckResult {
  const now = opts.now ?? new Date();
  const plannedUsd = msatsToUsd(opts.plannedMsats, opts.btcRate);

  const windows: BudgetWindow[] = ["daily", "weekly", "monthly"];
  for (const window of windows) {
    const limitUsd = capFor(ledger.caps, window);
    if (limitUsd === undefined) continue;

    const start = windowStart(window, now);
    const breakdown = breakdownSince(ledger.entries, start.getTime());
    if (breakdown.totalUsd + plannedUsd > limitUsd) {
      return {
        ok: false,
        window,
        spentUsd: breakdown.totalUsd,
        limitUsd,
        resetsAt: windowEnd(window, now).getTime(),
        breakdown,
      };
    }
  }

  return { ok: true };
}

/** Normalise an entry's kind — legacy entries were all job spends. */
export function entryKind(entry: BudgetLedgerEntry): BudgetSpendKind {
  return entry.kind ?? "job";
}

/** UTC-anchored start of the current window containing `now`. */
export function windowStart(window: BudgetWindow, now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (window === "daily") return d;
  if (window === "weekly") {
    // ISO week starts on Monday — UTC-anchored.
    const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const daysSinceMonday = (dow + 6) % 7;
    d.setUTCDate(d.getUTCDate() - daysSinceMonday);
    return d;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** UTC-anchored end (exclusive) of the current window containing `now`. */
export function windowEnd(window: BudgetWindow, now: Date): Date {
  const start = windowStart(window, now);
  if (window === "daily") {
    return new Date(start.getTime() + 24 * 60 * 60 * 1000);
  }
  if (window === "weekly") {
    return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

export function spendEntry(opts: RecordSpendOptions): BudgetLedgerEntry {
  const usd = msatsToUsd(opts.msats, opts.btcRate);
  const entry: BudgetLedgerEntry = {
    timestamp: (opts.now ?? new Date()).getTime(),
    jobId: opts.jobId,
    providerEndpoint: opts.providerEndpoint,
    msats: opts.msats,
    btcRate: opts.btcRate,
    usd,
  };
  // `job` stays implicit so entries keep the shape they've always had; only a
  // non-default kind is written.
  if (opts.kind !== undefined && opts.kind !== "job") entry.kind = opts.kind;
  if (opts.principalMsats !== undefined) entry.principalMsats = opts.principalMsats;
  if (opts.routingFeeMsats !== undefined) entry.routingFeeMsats = opts.routingFeeMsats;
  if (opts.totalWalletFeeMsats !== undefined)
    entry.totalWalletFeeMsats = opts.totalWalletFeeMsats;
  if (opts.unitemizedWalletFeeMsats !== undefined)
    entry.unitemizedWalletFeeMsats = opts.unitemizedWalletFeeMsats;
  if (opts.walletDebitMsats !== undefined) entry.walletDebitMsats = opts.walletDebitMsats;
  if (opts.label !== undefined) entry.label = opts.label;
  if (opts.labelSource !== undefined) entry.labelSource = opts.labelSource;
  return entry;
}

export function capFor(caps: BudgetCaps, window: BudgetWindow): number | undefined {
  if (window === "daily") return caps.dailyUsd;
  if (window === "weekly") return caps.weeklyUsd;
  return caps.monthlyUsd;
}

export function breakdownSince(entries: BudgetLedgerEntry[], sinceMs: number): BudgetSpendBreakdown {
  const out: BudgetSpendBreakdown = {
    totalUsd: 0,
    jobsUsd: 0,
    floatFundingsUsd: 0,
    creditFundingsUsd: 0,
  };
  for (const e of entries) {
    if (e.timestamp < sinceMs) continue;
    out.totalUsd += e.usd;
    const kind = entryKind(e);
    if (kind === "float_fund") out.floatFundingsUsd += e.usd;
    else if (kind === "credit_fund") out.creditFundingsUsd += e.usd;
    else out.jobsUsd += e.usd;
  }
  return out;
}
