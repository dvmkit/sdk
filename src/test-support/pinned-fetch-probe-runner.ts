import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function runPinnedFetchProbe(scenario: string, network = false): Promise<void> {
  await exec(process.execPath, [
    "--import", "tsx",
    fileURLToPath(new URL("./pinned-fetch-lifecycle-probe.ts", import.meta.url)),
    scenario, ...(network ? ["network"] : []),
  ], { timeout: 10_000 });
}

export const pinnedFetchScenarios = [
  "success", "known-length", "keepalive", "literal", "early-response", "redirect", "refusal", "misdirected",
  "pre-abort", "abort", "network-error", "source-error", "response-cancel", "response-abort",
];
