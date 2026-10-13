/**
 * Run the verification steps for one source tree. `run` is injected so the release
 * contract exercises this production dispatcher without starting another suite.
 *
 * @param {{ cleanSource: boolean, requireDatabase: boolean, databaseUrl: string | undefined, packedSafetyReport: string | undefined, run: (step: { name: string, args: string[], skip?: string }) => void }} options
 */
export function dispatchVerification(options) {
  const sourceSteps = [
    { name: "README quickstart", args: ["run", "check:readme-quickstart"] },
    { name: "caller ownership", args: ["run", "check:ownership"] },
    { name: "lint", args: ["run", "lint"] },
    { name: "build", args: ["run", "build"] },
    { name: "internal tree shaking", args: ["run", "check:tree-shaking"] },
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "typecheck scripts", args: ["run", "typecheck:scripts"] },
    { name: "unit tests", args: ["test"] },
    { name: "server tests", args: ["run", "test:server"] },
    { name: "public examples", args: ["run", "test:examples"] },
    { name: "database tests", args: ["run", "test:db"], skip: options.databaseUrl ? undefined : "DATABASE_URL is unset" },
    { name: "public API surface", args: ["run", "check:api"] },
    { name: "package shape", args: ["run", "check:package"] },
    { name: "consumer install", args: ["run", "check:consumer"] },
    { name: "packed artifact safety", args: ["run", "check:public-safety", "--", "--pack-only", ...(options.packedSafetyReport ? ["--report", options.packedSafetyReport] : [])] },
    { name: "release contract", args: ["run", "check:release"] },
  ];
  const outerSteps = [
    { name: "toolchain", args: ["run", "check:toolchain"] },
    { name: "README quickstart", args: ["run", "check:readme-quickstart"] },
    { name: "repository safety", args: ["run", "check:public-safety", "--", "--skip-pack"] },
    { name: "clean source gate", args: ["run", "clean-install-smoke", ...(options.requireDatabase ? ["--", "--require-database"] : [])] },
  ];
  const steps = options.cleanSource ? sourceSteps : outerSteps;
  for (const step of steps) options.run(step);
  return steps;
}

/**
 * Assert the observable contract of a verification dispatcher. This deliberately
 * records calls instead of inspecting source, so comments and dead code cannot
 * satisfy a release requirement.
 *
 * @param {(options: Parameters<typeof dispatchVerification>[0]) => unknown} dispatch
 */
export function assertReleaseDispatch(dispatch) {
  const outer = record(dispatch, { cleanSource: false, requireDatabase: true, databaseUrl: "postgres://localhost/dvmkit_test", packedSafetyReport: undefined });
  assertCalls(outer, [
    ["run", "check:toolchain"],
    ["run", "check:readme-quickstart"],
    ["run", "check:public-safety", "--", "--skip-pack"],
    ["run", "clean-install-smoke", "--", "--require-database"],
  ], "outer verification");

  const source = record(dispatch, { cleanSource: true, requireDatabase: true, databaseUrl: "postgres://localhost/dvmkit_test", packedSafetyReport: "/tmp/packed-report.json" });
  const required = [
    ["run", "check:readme-quickstart"],
    ["run", "check:ownership"], ["run", "lint"], ["run", "build"], ["run", "check:tree-shaking"], ["run", "typecheck"], ["run", "typecheck:scripts"],
    ["test"], ["run", "test:server"], ["run", "test:examples"], ["run", "test:db"], ["run", "check:api"], ["run", "check:package"],
    ["run", "check:consumer"], ["run", "check:public-safety", "--", "--pack-only", "--report", "/tmp/packed-report.json"], ["run", "check:release"],
  ];
  assertCalls(source, required, "clean-source verification");

  const stopped = [];
  try {
    dispatch({ cleanSource: false, requireDatabase: false, databaseUrl: undefined, packedSafetyReport: undefined, run: (step) => {
      stopped.push(step.args);
      throw new Error("stop");
    } });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "stop") throw error;
  }
  if (stopped.length !== 1) throw new Error("verification dispatcher must stop after a failed command");
}

/** @param {(options: Parameters<typeof dispatchVerification>[0]) => unknown} dispatch @param {Omit<Parameters<typeof dispatchVerification>[0], "run">} options */
function record(dispatch, options) {
  /** @type {string[][]} */
  const calls = [];
  dispatch({ ...options, run: (step) => calls.push(step.args) });
  return calls;
}

/** @param {string[][]} actual @param {string[][]} expected @param {string} label */
function assertCalls(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must execute the required commands once, in order, with their required flags`);
  }
}
