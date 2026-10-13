import { defineConfig } from "vitest/config";

import { cliStateSandboxEnv } from "./src/test-support/cli-state-sandbox.js";

export default defineConfig({
  test: {
    clearMocks: true,
    env: cliStateSandboxEnv(),
    fileParallelism: false,
    globalSetup: ["src/test-support/global-cli-state-sandbox.ts"],
    include: [
      "test/**/*.db.test.ts",
      "src/**/*.db.test.ts",
      "src/sdk/__tests__/revenue-reporter.test.ts",
    ],
    restoreMocks: true,
    setupFiles: [
      "src/test-support/setup-network-guard.ts",
      "src/test-support/setup-fx-mock.ts",
    ],
  },
});
