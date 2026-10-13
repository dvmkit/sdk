import { defineConfig } from "vitest/config";

import { cliStateSandboxEnv } from "./src/test-support/cli-state-sandbox.js";

export default defineConfig({
  test: {
    clearMocks: true,
    env: cliStateSandboxEnv(),
    exclude: [
      "test/**/*.db.test.ts",
      "src/**/*.db.test.ts",
      "**/*.server.test.ts",
      "src/sdk/__tests__/revenue-reporter.test.ts",
    ],
    globalSetup: ["src/test-support/global-cli-state-sandbox.ts"],
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    restoreMocks: true,
    setupFiles: [
      "src/test-support/setup-no-listen.ts",
      "src/test-support/setup-network-guard.ts",
      "src/test-support/setup-fx-mock.ts",
    ],
  },
});
