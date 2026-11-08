import { describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../configure";
import { createTestContext } from "../testing/test-context";
import { secp256k1Auth } from "../server/secp256k1-auth";

const urlSchema = z.object({
  url: z.string(),
  format: z.enum(["markdown", "text"]).default("markdown"),
});

const envelopeShape = {
  pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
};

describe("authenticated capability input schemas", () => {
  const auth = secp256k1Auth({ replayStore: null });
  const onJob = () => {};
  const configure = (input: z.ZodType, flat: boolean) => configureDVM({
    name: "example", auth,
    ...(flat ? { capability: "catalog", input, onJob } : { capabilities: { catalog: { input, onJob } } }),
  });

  it.each([false, true])("rejects stripping and strict object schemas (flat: %s)", flat => {
    for (const schema of [z.object({}), z.strictObject({}), z.object({}).catchall(z.never())]) {
      expect(() => configure(schema, flat)).toThrow(/capability "catalog".*pubkey, signature, timestamp, nonce/);
    }
  });

  it.each(Object.keys(envelopeShape))("names a missing %s field", field => {
    const shape = { ...envelopeShape } as Record<string, z.ZodType>;
    delete shape[field];
    expect(() => configure(z.object(shape), false)).toThrow(
      `capability "catalog" input schema must preserve signed envelope fields: ${field}.`
    );
  });

  it.each([false, true])("accepts explicit fields and non-never catchalls (flat: %s)", flat => {
    for (const schema of [
      z.object(envelopeShape), z.strictObject(envelopeShape),
      z.object({}).passthrough(), z.looseObject({}), z.object({}).catchall(z.unknown()),
    ]) {
      expect(() => configure(schema, flat)).not.toThrow();
    }
  });

  it("checks every capability in a map", () => {
    expect(() => configureDVM({
      name: "example", auth,
      capabilities: {
        valid: { input: z.object(envelopeShape), onJob },
        broken: { input: z.object({}), onJob },
      },
    })).toThrow(/capability "broken".*pubkey, signature, timestamp, nonce/);
  });

  it("allows payload-only schemas without descriptor auth", () => {
    expect(() => configureDVM({ name: "example", input: z.object({}), onJob })).not.toThrow();
  });
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
