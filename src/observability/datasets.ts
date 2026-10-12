/** Descriptive diagnostic retention metadata; deletion and case controls belong to the platform. */
export const SPANS_DATASETS = [
  { name: "platform", retentionDays: 730 },
  { name: "cashu", retentionDays: 730 },
  { name: "lightning", retentionDays: 730 },
  { name: "stripe", retentionDays: 730 },
  { name: "x402", retentionDays: 730 },
  { name: "tempo", retentionDays: 730 },
  { name: "isolate", retentionDays: 730 },
  { name: "audit", retentionDays: 730 },
  { name: "cron", retentionDays: 730 },
] as const;

export type DatasetName = (typeof SPANS_DATASETS)[number]["name"];

export const DATASET_NAMES: ReadonlySet<string> = new Set(SPANS_DATASETS.map((d) => d.name));

/** Datasets that only operator-side services (platform-api, router) may write to. */
export const OPERATOR_ONLY_DATASETS: ReadonlySet<string> = new Set<string>(["audit"]);

export type SpanIngestionPrincipalClass = "operator" | "dvm";

export function isDatasetAllowedForSpanPrincipal(
  dataset: string,
  principal: SpanIngestionPrincipalClass
): boolean {
  if (!DATASET_NAMES.has(dataset)) return false;
  switch (principal) {
    case "operator":
      return true;
    case "dvm":
      return !OPERATOR_ONLY_DATASETS.has(dataset);
  }
}

/** Normalize identifiers emitted by DVM images deployed before the Tempo dataset cutover. */
export function normalizeLegacySpanIdentifiers(row: Record<string, unknown>): void {
  if (row.dataset !== "mpp") return;
  row.dataset = "tempo";
  if (row.name === "mpp.issue_challenges") row.name = "tempo.issue_challenges";
  if (row.name === "mpp.verify_credential") row.name = "tempo.verify_credential";
}
