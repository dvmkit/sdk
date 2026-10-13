import { describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../configure";
import { createTestContext } from "../testing/test-context";

const urlSchema = z.object({
  url: z.string(),
  format: z.enum(["markdown", "text"]).default("markdown"),
});

describe("input schema — configureDVM", () => {
  it("stores the schema on the descriptor", () => {
    const dvm = configureDVM({
      name: "Extract",
      capability: "test",
      tag: "test",
      input: urlSchema,
      onJob(ctx) {
        ctx.complete(ctx.input.url);
      },
    });

    expect(dvm.inputSchema).toBe(urlSchema);
  });

  it("inputSchema is undefined when no schema provided", () => {
    const dvm = configureDVM({
      name: "Echo",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete(ctx.input);
      },
    });

    expect(dvm.inputSchema).toBeUndefined();
  });
});

describe("input schema — test context", () => {
  it("typed input is accessible in handler", async () => {
    const dvm = configureDVM({
      name: "Extract",
      capability: "test",
      tag: "test",
      input: urlSchema,
      onJob(ctx) {
        ctx.complete(`${ctx.input.url} (${ctx.input.format})`);
      },
    });

    const ctx = createTestContext({
      input: { url: "https://example.com", format: "markdown" as const },
    });
    await Object.values(dvm.capabilities)[0].onJob(ctx);

    expect(ctx.completed).toBe(true);
    expect(ctx.summary).toBe("https://example.com (markdown)");
  });

  });
