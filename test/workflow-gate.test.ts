import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { startCashuMint } from "../scripts/start-cashu-mint.mjs";
import { assertGateJob } from "../scripts/workflow-gate.mjs";

type Step = { name?: string; run?: string; uses?: string; shell?: string; if?: string; with?: Record<string, unknown> };
type Job = { "timeout-minutes"?: unknown; steps: Step[] };

function job(workflow: string, name: string): Job {
  const document = parse(readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8")) as {
    jobs: Record<string, Job>;
  };
  return structuredClone(document.jobs[name]);
}

const releaseBuild = () => job("release.yml", "build");
const named = (build: Job, name: string) => {
  const step = build.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`release build has no step ${name}`);
  return step;
};

describe("gate job contract", () => {
  it("accepts the committed verify and release gate jobs", () => {
    expect(() => assertGateJob(job("verify.yml", "verify"), "verify")).not.toThrow();
    expect(() => assertGateJob(releaseBuild(), "release")).not.toThrow();
  });

  it.each<[string, (build: Job) => void, string]>([
    [
      "a swallowed gate failure",
      (build) => {
        const gate = named(build, "Run full verification gate");
        gate.run = gate.run?.replace("tee .artifacts/verify.log", "tee .artifacts/verify.log || true");
      },
      "must fail when the gate exits",
    ],
    [
      "tee under the default shell without pipefail",
      (build) => {
        const gate = named(build, "Run full verification gate");
        delete gate.shell;
        gate.run = gate.run?.replace("set -euo pipefail\n", "");
      },
      "must fail when the gate exits",
    ],
    [
      "gate output that is not saved",
      (build) => {
        const gate = named(build, "Run full verification gate");
        gate.run = gate.run?.replace(" 2>&1 | tee .artifacts/verify.log", "");
      },
      "must save the gate's stdout and stderr",
    ],
    [
      "a missing mint",
      (build) => { build.steps = build.steps.filter((step) => step.name !== "Start local Cashu mint"); },
      "must start the Cashu mint",
    ],
    [
      "a mint started after the gate",
      (build) => {
        const mint = named(build, "Start local Cashu mint");
        build.steps = build.steps.filter((step) => step !== mint);
        build.steps.splice(build.steps.indexOf(named(build, "Run full verification gate")) + 1, 0, mint);
      },
      "must start the Cashu mint",
    ],
    [
      "packaging after a failed gate",
      (build) => { named(build, "Pack twice and bind the artifact digest").if = "always()"; },
      "must not run after a failed gate",
    ],
    [
      "a gate log uploaded only on success",
      (build) => { delete named(build, "Upload verification log").if; },
      "even when the gate fails",
    ],
    ["no build timeout", (build) => { delete build["timeout-minutes"]; }, "timeout-minutes"],
    ["Actions' default timeout", (build) => { build["timeout-minutes"] = 360; }, "timeout-minutes"],
  ])("rejects %s", (_, mutate, message) => {
    const build = releaseBuild();
    mutate(build);
    expect(() => assertGateJob(build, "release")).toThrow(message);
  });
});

describe("local mint startup", () => {
  it("fails after printing container logs when the mint never answers", async () => {
    const docker = vi.fn((_args: string[]) => 0);
    const probe = vi.fn(() => Promise.resolve(false));
    await expect(startCashuMint({ docker, probe, wait: () => Promise.resolve(), attempts: 3 })).rejects.toThrow(
      "did not answer"
    );
    expect(probe).toHaveBeenCalledTimes(3);
    expect(docker).toHaveBeenLastCalledWith(["logs", "sdk-cashu-mint"]);
  });

  it("fails without waiting when the container cannot start", async () => {
    const probe = vi.fn(() => Promise.resolve(true));
    await expect(startCashuMint({ docker: () => 125, probe, wait: () => Promise.resolve() })).rejects.toThrow(
      "could not start"
    );
    expect(probe).not.toHaveBeenCalled();
  });
});
