import assert from "node:assert/strict";
import test from "node:test";

import { createTestContext } from "@dvmkit/sdk/testing";

import dvm from "./handler.ts";

test("the quickstart handler returns its input", async () => {
  const ctx = createTestContext({ input: { text: "hello" } });

  await dvm.capabilities.echo.onJob(ctx);

  assert.equal(ctx.completed, true);
  assert.equal(ctx.summary, "Echoed the input");
  assert.deepEqual(ctx.messages[0], {
    type: "artifact",
    content: { mime_type: "text/plain", data: "hello" },
  });
});
