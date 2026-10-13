/** One state root per Vitest run, shared by forks. Caller-provided roots win.
 * Set test.env before imports: defaults resolves CONFIG_DIR once, so setupFiles
 * is too late. Reapplication per file prevents an env mutation leaking to the
 * next file; tests needing fresh state per case must provide their own root. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Share DVMKIT_TEST_STATE_ROOT across separately bundled config/globalSetup
 * instances. Apply overrides to the main process as well as worker test.env;
 * removeCliStateSandbox tears down the shared root. */
export function cliStateSandboxEnv(): Record<string, string> {
  const root = (process.env.DVMKIT_TEST_STATE_ROOT ??= mkdtempSync(
    join(tmpdir(), "dvmkit-test-state-")
  ));
  const env = {
    DVM_CONFIG_DIR: process.env.DVM_CONFIG_DIR ?? join(root, ".dvm"),
    DVMKIT_CONFIG_DIR: process.env.DVMKIT_CONFIG_DIR ?? join(root, ".dvmkit"),
    DVMCTL_CONFIG_DIR: process.env.DVMCTL_CONFIG_DIR ?? join(root, ".dvmctl"),
  };
  Object.assign(process.env, env);
  return env;
}

/** Remove the sandbox root, so a run leaves no temp directory behind. */
export function removeCliStateSandbox(): void {
  const root = process.env.DVMKIT_TEST_STATE_ROOT;
  if (!root) return;
  rmSync(root, { recursive: true, force: true });
  delete process.env.DVMKIT_TEST_STATE_ROOT;
}
