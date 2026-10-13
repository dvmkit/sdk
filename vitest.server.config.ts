import { defineConfig } from "vitest/config";

import { cliStateSandboxEnv } from "./src/test-support/cli-state-sandbox.js";

export default defineConfig({
  test: {
    clearMocks: true,
    env: cliStateSandboxEnv(),
    globalSetup: ["src/test-support/global-cli-state-sandbox.ts"],
    include: ["test/**/*.server.test.ts", "src/**/*.server.test.ts"],
    restoreMocks: true,
    setupFiles: [
      "src/test-support/setup-network-guard.ts",
      "src/test-support/setup-fx-mock.ts",
    ],
  },
});
