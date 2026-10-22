import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { pinnedFetchScenarios, runPinnedFetchProbe } from "../../../test-support/pinned-fetch-probe-runner";

const exec = promisify(execFile);
const MiB = 1024 * 1024;

it("bounds live upload buffers during slow consumption and after completion", async () => {
  const samples: { retained: number; peakLive: number; peakAhead: number }[] = [];
  for (const size of [16 * MiB, 128 * MiB]) {
    const { stdout } = await exec(process.execPath, [
      "--expose-gc", "--import", "tsx",
      fileURLToPath(new URL("../../../test-support/pinned-upload-probe.ts", import.meta.url)),
      String(size),
    ], { timeout: 25_000 });
    samples.push(JSON.parse(stdout));
  }
  for (const sample of samples) {
    expect(sample.retained, "buffers retained after the upload").toBeLessThan(24 * MiB);
    expect(sample.peakLive, "live buffers while the server reads slowly").toBeLessThan(24 * MiB);
    expect(sample.peakAhead, "producer must respect transport backpressure").toBeLessThan(16 * MiB);
  }
  expect(samples[1]!.retained - samples[0]!.retained).toBeLessThan(8 * MiB);
}, 60_000);

it.each(pinnedFetchScenarios)("releases native fetch streams and dispatchers: %s", async (scenario) => {
  await runPinnedFetchProbe(scenario);
}, 15_000);
