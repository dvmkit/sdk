import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const GATE = "npm run verify -- --require-database";
const START_MINT = "node scripts/start-cashu-mint.mjs";
const GATE_LOG = ".artifacts/verify.log";
const MINT_LOG_CAPTURE = "mkdir -p .artifacts\ndocker logs sdk-cashu-mint > .artifacts/cashu-mint.log 2>&1 || true\n";
// Verify's limit; a passing release build takes about eight minutes.
const MAX_TIMEOUT_MINUTES = 30;

/** @typedef {{ name?: string, run?: string, uses?: string, shell?: string, if?: string, "continue-on-error"?: unknown, with?: Record<string, unknown> }} WorkflowStep */
/** @typedef {{ "timeout-minutes"?: unknown, "continue-on-error"?: unknown, steps?: WorkflowStep[] }} WorkflowJob */

/**
 * Assert that a job running the complete gate has its mint, is bounded, keeps its log, and cannot
 * package past a failed gate. The gate step's shell is executed against a failing stub rather than
 * pattern-matched, so a swallowed exit status is caught however it is spelled.
 *
 * @param {WorkflowJob | undefined} job @param {string} label
 */
export function assertGateJob(job, label) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const gateIndex = steps.findIndex((step) => typeof step.run === "string" && step.run.includes(GATE));
  if (gateIndex < 0) throw new Error(`${label} must run ${GATE}`);
  const gate = steps[gateIndex];

  const timeout = job?.["timeout-minutes"];
  if (typeof timeout !== "number" || timeout <= 0 || timeout > MAX_TIMEOUT_MINUTES) {
    throw new Error(`${label} must set timeout-minutes to at most ${MAX_TIMEOUT_MINUTES}`);
  }
  if (job?.["continue-on-error"] !== undefined || gate["continue-on-error"] !== undefined || gate.if !== undefined) {
    throw new Error(`${label} gate must run unconditionally and fail its job`);
  }

  const mintIndex = steps.findIndex((step) => step.run?.trim() === START_MINT);
  if (mintIndex < 0 || mintIndex > gateIndex || steps[mintIndex].if !== undefined) {
    throw new Error(`${label} must start the Cashu mint unconditionally before the gate`);
  }

  const after = steps.slice(gateIndex + 1);
  for (const step of after) {
    if (step.if !== undefined && !isDiagnostic(step)) {
      throw new Error(`${label} step ${step.name ?? step.uses ?? "unnamed"} must not run after a failed gate`);
    }
  }
  if (!after.some((step) => step.if === "always()" && isDiagnostic(step) && artifactPaths(step).includes(GATE_LOG))) {
    throw new Error(`${label} must upload ${GATE_LOG} even when the gate fails`);
  }

  assertGateStepFailsClosed(gate, label);
}

/** @param {WorkflowStep} step @param {string} label */
function assertGateStepFailsClosed(step, label) {
  // How Actions invokes a `run` block on Linux: an explicit `shell: bash` adds pipefail, the
  // default does not.
  const shell =
    step.shell === "bash" ? ["--noprofile", "--norc", "-eo", "pipefail"]
    : step.shell === undefined ? ["-e"]
    : undefined;
  if (!shell) throw new Error(`${label} gate step uses unsupported shell ${step.shell}`);

  for (const status of [7, 0]) {
    const root = mkdtempSync(join(tmpdir(), "sdk-gate-step-"));
    try {
      const bin = join(root, "bin");
      const work = join(root, "work");
      mkdirSync(bin);
      mkdirSync(work);
      writeFileSync(join(bin, "npm"), `#!/bin/sh\necho gate-stdout\necho gate-stderr >&2\nexit ${status}\n`);
      chmodSync(join(bin, "npm"), 0o755);
      writeFileSync(join(root, "step.sh"), step.run ?? "");
      const result = spawnSync("bash", [...shell, join(root, "step.sh")], {
        cwd: work,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
        encoding: "utf8",
      });
      if (result.error) throw new Error(`${label} gate step could not be executed: ${result.error.message}`);
      if ((result.status !== 0) !== (status !== 0)) {
        throw new Error(
          status !== 0
            ? `${label} gate step must fail when the gate exits ${status}`
            : `${label} gate step must pass when the gate passes`
        );
      }
      let log = "";
      try {
        log = readFileSync(join(work, GATE_LOG), "utf8");
      } catch {
        // Reported below with the missing-output message.
      }
      if (!log.includes("gate-stdout") || !log.includes("gate-stderr")) {
        throw new Error(`${label} gate step must save the gate's stdout and stderr to ${GATE_LOG}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/** Steps allowed to run after a failed gate: they only collect evidence under `.artifacts/`. @param {WorkflowStep} step */
function isDiagnostic(step) {
  if (step.run !== undefined) return step.run === MINT_LOG_CAPTURE;
  if (!step.uses?.startsWith("actions/upload-artifact@")) return false;
  const paths = artifactPaths(step);
  return paths.length > 0 && paths.every((path) => path.startsWith(".artifacts/"));
}

/** @param {WorkflowStep} step @returns {string[]} */
function artifactPaths(step) {
  return String(step.with?.path ?? "")
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
}
