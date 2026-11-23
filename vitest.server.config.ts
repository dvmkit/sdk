import { defineConfig } from "vitest/config";

import { cliStateSandboxEnv } from "./src/test-support/cli-state-sandbox.js";

export default defineConfig({
  test: {
    clearMocks: true,
    env: cliStateSandboxEnv(),
    // Server tests poll real workers and Postgres. The 1s poll and 5s test defaults flake on a loaded host;
    // the test timeout stays above the poll timeout so a slow poll fails with its own message.
    expect: { poll: { timeout: 10_000 } },
    testTimeout: 30_000,
    globalSetup: ["src/test-support/global-cli-state-sandbox.ts"],
    include: ["test/**/*.server.test.ts", "src/**/*.server.test.ts"],
    restoreMocks: true,
    setupFiles: [
      "src/test-support/setup-network-guard.ts",
      "src/test-support/setup-fx-mock.ts",
    ],
  },
});
