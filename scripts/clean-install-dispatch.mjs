/**
 * Run the locked install and its isolated source verification. `npm` is injected
 * so the release contract can prove this boundary without another install.
 *
 * @param {{ requireDatabase: boolean, npm: (args: string[]) => void }} options
 */
export function dispatchCleanInstall(options) {
  options.npm(["ci"]);
  options.npm([
    "run",
    "verify",
    "--",
    "--clean-source",
    ...(options.requireDatabase ? ["--require-database"] : []),
  ]);
}

/** @param {(options: Parameters<typeof dispatchCleanInstall>[0]) => unknown} dispatch */
export function assertCleanInstallDispatch(dispatch) {
  /** @type {string[][]} */
  const calls = [];
  dispatch({ requireDatabase: true, npm: (args) => calls.push(args) });
  const expected = [["ci"], ["run", "verify", "--", "--clean-source", "--require-database"]];
  if (JSON.stringify(calls) !== JSON.stringify(expected)) {
    throw new Error("clean install must run npm ci then forward mandatory database mode to isolated verification");
  }

  /** @type {string[][]} */
  const failed = [];
  try {
    dispatch({ requireDatabase: true, npm: (args) => {
      failed.push(args);
      throw new Error("stop");
    } });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "stop") throw error;
  }
  if (failed.length !== 1 || JSON.stringify(failed[0]) !== JSON.stringify(["ci"])) {
    throw new Error("clean install must stop when npm ci fails");
  }
}
