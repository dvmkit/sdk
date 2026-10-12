import { describe, expect, it } from "vitest";
import { z } from "zod";

import { humanizeZodError } from "../server/zod-error";

const SCHEMA_URL = "https://dvm.example.com/v1/info";

function captureError(schema: z.ZodType, input: unknown): z.ZodError {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected schema to reject input");
  return result.error;
}

describe("humanizeZodError", () => {
  it("emits a chunking hint for too_big string fields (narrate-style)", () => {
    const schema = z.object({ text: z.string().max(50_000) });
    const err = captureError(schema, { text: "a".repeat(50_001) });

    const { message, hint } = humanizeZodError(err, { schemaUrl: SCHEMA_URL });

    expect(hint).toMatch(/exceeds the 50000-character limit/i);
    expect(hint).toMatch(/split into smaller chunks/i);
    expect(hint).toContain("`text`");
    expect(message).toContain("text");
    expect(message).toMatch(/too long/i);
  });

  it("emits a non-empty hint for too_small string fields with min=1", () => {
    const schema = z.object({ text: z.string().min(1) });
    const err = captureError(schema, { text: "" });

    const { message, hint } = humanizeZodError(err, { schemaUrl: SCHEMA_URL });

    expect(hint).toMatch(/provide non-empty text/i);
    expect(hint).toContain("`text`");
    expect(message).toMatch(/required/i);
  });

  it("falls back to schema-link hint for non-string-bound issues", () => {
    const schema = z.object({ url: z.string() });
    const err = captureError(schema, { url: 42 });

    const { hint } = humanizeZodError(err, { schemaUrl: SCHEMA_URL });

    expect(hint).toBe(`Inspect ${SCHEMA_URL} for the expected input schema.`);
  });

  it("joins multiple issues into a single readable message line", () => {
    const schema = z.object({
      text: z.string().min(1),
      count: z.number().min(1),
    });
    const err = captureError(schema, { text: "", count: 0 });

    const { message } = humanizeZodError(err, { schemaUrl: SCHEMA_URL });

    expect(message).toContain("text:");
    expect(message).toContain("count:");
    expect(message).toContain(";");
    expect(message.startsWith("[")).toBe(false);
    expect(() => JSON.parse(message)).toThrow();
  });

  it("prioritises chunking guidance when both too_big and too_small are present", () => {
    const schema = z.object({
      text: z.string().min(1).max(50),
      title: z.string().min(1),
    });
    const err = captureError(schema, { text: "a".repeat(51), title: "" });

    const { hint } = humanizeZodError(err, { schemaUrl: SCHEMA_URL });

    expect(hint).toMatch(/split into smaller chunks/i);
  });

  it("handles enum/invalid_value with a readable reason", () => {
    const schema = z.object({ format: z.enum(["mp3", "wav"]) });
    const err = captureError(schema, { format: "flac" });

    const { message, hint } = humanizeZodError(err, { schemaUrl: SCHEMA_URL });

    expect(message).toMatch(/format:.*mp3.*wav/);
    expect(hint).toBe(`Inspect ${SCHEMA_URL} for the expected input schema.`);
  });

  it("renders dialogue-style nested paths with dot notation and array indices", () => {
    const schema = z.object({
      dialogue: z.array(z.object({ text: z.string().max(10) })),
    });
    const err = captureError(schema, {
      dialogue: [{ text: "ok" }, { text: "a".repeat(11) }],
    });

    const { message, hint } = humanizeZodError(err, { schemaUrl: SCHEMA_URL });

    expect(message).toContain("dialogue.[1].text");
    expect(hint).toContain("`dialogue.[1].text`");
    expect(hint).toMatch(/split into smaller chunks/i);
  });
});
