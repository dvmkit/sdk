/** Write enabled-tier verdicts directly to stderr; Vitest can suppress console
 * output. Callers gate announcements so ordinary runs stay quiet. */
export function announceTier(name: string, verdict: "ran" | "skipped", detail: string): void {
  const label = verdict === "ran" ? "RUNNING" : "SKIPPED";
  process.stderr.write(`[${name}] ${label} — ${detail}\n`);
}
