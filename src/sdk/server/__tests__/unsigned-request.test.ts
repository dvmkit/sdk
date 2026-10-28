import { describe, expect, it } from "vitest";
import { z } from "zod";

import { secp256k1Auth } from "../secp256k1-auth";
import { takesUnsignedPath, unsignedInputSchema } from "../unsigned-request";

const envelope = {
  pubkey: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
};

describe("unsignedInputSchema", () => {
  it("drops only the envelope fields and keeps strictness and object refinements", () => {
    const schema = z
      .object({ ...envelope, text: z.string().default("d") })
      .strict()
      .refine((value) => value.text !== "forbidden", { message: "forbidden text" });
    const narrowed = unsignedInputSchema(schema);
    if (!narrowed) throw new Error("a refined object schema should narrow");

    expect(narrowed.safeParse({})).toEqual({ success: true, data: { text: "d" } });
    expect(narrowed.safeParse({ text: "forbidden" }).success).toBe(false);
    expect(narrowed.safeParse({ text: "ok", extra: 1 }).success).toBe(false);
    // The builder's schema itself still demands the envelope.
    expect(schema.safeParse({ text: "ok" }).success).toBe(false);
  });

  it("leaves a schema it cannot narrow signed-only", () => {
    const piped = z.object({ ...envelope, text: z.string() }).transform((value) => value.text);
    expect(unsignedInputSchema(piped)).toBeUndefined();
  });
});

describe("takesUnsignedPath", () => {
  const allowing = secp256k1Auth({ allowUnsignedPaid: true });

  it("takes the unsigned path only when the option is on and no envelope field is present", () => {
    expect(takesUnsignedPath(allowing, { data: { text: "hi" } })).toBe(true);
    expect(takesUnsignedPath(allowing, { input: JSON.stringify({ text: "hi" }) })).toBe(true);
    expect(takesUnsignedPath(secp256k1Auth(), { data: { text: "hi" } })).toBe(false);
    expect(takesUnsignedPath(undefined, { data: { text: "hi" } })).toBe(false);
  });

  it.each(["pubkey", "signature", "timestamp", "nonce", "auth_statement"])(
    "treats a body carrying only %s as signed",
    (field) => {
      expect(takesUnsignedPath(allowing, { data: { text: "hi", [field]: null } })).toBe(false);
      expect(takesUnsignedPath(allowing, { input: JSON.stringify({ [field]: "x" }) })).toBe(false);
    }
  );
});
