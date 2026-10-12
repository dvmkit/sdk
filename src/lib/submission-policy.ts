export interface JobPolicy {
  /** Maximum total spend for the entire job (msats). */
  maxTotalMsats: number;
  /** Auto-pay threshold — payments at or below this don't need confirmation (msats). */
  autoPayBelowMsats: number;
  /** Hard cap on any single payment request (msats). Rejects oversized requests outright. */
  maxIncrementMsats: number;
  /** Maximum number of payments the CLI will honour for this job. Required — agents must declare expectations. */
  maxPayments: number;
}
