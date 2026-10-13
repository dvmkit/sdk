import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CreditEnvelopeError,
  creditEnvelopeIgnoreFields,
  extractCreditEnvelope,
  stripCreditEnvelope,
} from "../credit-envelope";
import { createSignedRequestVerifier, signedRequestInput } from "../signed-request";

const COMMITMENT = "ab".repeat(32);

describe("extractCreditEnvelope", () => {
  it("returns undefined for legacy-shaped data (implicit N=1 stays byte-valid)", () => {
    expect(extractCreditEnvelope(undefined)).toBeUndefined();
    expect(extractCreditEnvelope({ action: "go" })).toBeUndefined();
    expect(extractCreditEnvelope("primitive")).toBeUndefined();
    expect(extractCreditEnvelope(null)).toBeUndefined();
  });

  it("extracts a pure draw", () => {
    expect(extractCreditEnvelope({ credit_id: "c1", draw_id: "d1", action: "go" })).toEqual({
      creditId: "c1",
      drawId: "d1",
    });
  });

  it("extracts a fund-and-draw", () => {
    expect(
      extractCreditEnvelope({
        credit_id: "c1",
        draw_id: "d1",
        fund: { amount_micro: 100_000, commitment: COMMITMENT },
      })
    ).toEqual({
      creditId: "c1",
      drawId: "d1",
      fund: { amountMicro: 100_000, commitment: COMMITMENT },
    });
  });

  it.each([
    [{ credit_id: "c1" }],
    [{ draw_id: "d1" }],
    [{ credit_id: "", draw_id: "d1" }],
    [{ credit_id: "c1", draw_id: 7 }],
    [{ fund: { amount_micro: 1, commitment: COMMITMENT } }],
    [{ credit_id: "c1", draw_id: "d1", fund: "nope" }],
    [{ credit_id: "c1", draw_id: "d1", fund: { amount_micro: 0, commitment: COMMITMENT } }],
    [{ credit_id: "c1", draw_id: "d1", fund: { amount_micro: 1.5, commitment: COMMITMENT } }],
    [{ credit_id: "c1", draw_id: "d1", fund: { amount_micro: 1, commitment: "short" } }],
  ])("throws on structurally broken shapes: %j", (data) => {
    expect(() => extractCreditEnvelope(data)).toThrow(CreditEnvelopeError);
  });
});

describe("stripCreditEnvelope", () => {
  const capabilitySchema = z
    .object({
      pubkey: z.string(),
      signature: z.string(),
      timestamp: z.number(),
      nonce: z.string(),
      action: z.string(),
    })
    .strict();

  it("removes the reserved keys a capability schema doesn't declare", () => {
    expect(creditEnvelopeIgnoreFields(capabilitySchema)).toEqual(["credit_id", "draw_id", "fund"]);
    const wire = {
      action: "go",
      credit_id: "c1",
      draw_id: "d1",
      fund: { amount_micro: 1, commitment: COMMITMENT },
    };
    expect(stripCreditEnvelope(capabilitySchema, wire)).toEqual({ action: "go" });
    expect(wire.credit_id).toBe("c1");
  });

  it("strips a malformed envelope too, so extraction is what refuses it", () => {
    const wire = { action: "go", credit_id: "c1" };
    expect(stripCreditEnvelope(capabilitySchema, wire)).toEqual({ action: "go" });
    expect(() => extractCreditEnvelope(wire)).toThrow(CreditEnvelopeError);
  });

  it("leaves a key the schema declares — /v1/credit's own request shape", () => {
    const creditRequest = z.object({
      op: z.enum(["fund", "balance", "drain"]),
      credit_id: z.string().optional(),
      fund: z.object({ amount_micro: z.number(), fund_id: z.string() }).optional(),
    });
    expect(creditEnvelopeIgnoreFields(creditRequest)).toEqual(["draw_id"]);
    const body = { op: "fund", credit_id: "c1", fund: { amount_micro: 1, fund_id: "f1" } };
    expect(stripCreditEnvelope(creditRequest, body)).toBe(body);
  });

  it("is identity on data with no reserved keys, and on non-objects", () => {
    const data = { action: "go" };
    expect(stripCreditEnvelope(capabilitySchema, data)).toBe(data);
    expect(stripCreditEnvelope(capabilitySchema, "primitive")).toBe("primitive");
    expect(stripCreditEnvelope(capabilitySchema, null)).toBeNull();
    expect(stripCreditEnvelope(capabilitySchema, undefined)).toBeUndefined();
  });

  it("treats a schema with no readable shape as declaring nothing", () => {
    expect(creditEnvelopeIgnoreFields(z.string())).toEqual(["credit_id", "draw_id", "fund"]);
    expect(creditEnvelopeIgnoreFields(undefined)).toEqual(["credit_id", "draw_id", "fund"]);
    expect(creditEnvelopeIgnoreFields(z.object({ fund: z.string() }).refine(() => true))).toEqual([
      "credit_id",
      "draw_id",
    ]);
  });
});

describe("signature coverage of the credit envelope", () => {
  const schema = z.object({
    pubkey: z.string(),
    signature: z.string(),
    timestamp: z.number(),
    nonce: z.string(),
    action: z.string(),
  });
  const verifier = createSignedRequestVerifier(schema);
  const PRIVKEY = new Uint8Array(32).fill(5);

  it("verifies the raw wire body, credit fields included", () => {
    const wire = verifier.signRequest(PRIVKEY, {
      action: "go",
      credit_id: "c1",
      draw_id: "d1",
    }) as unknown as Record<string, unknown>;
    expect(() => verifier.checkAuth(signedRequestInput({ data: wire }))).not.toThrow();
    // Parsing omits undeclared credit fields, so that projection cannot reproduce the signed
    // wire bytes.
    expect(() => verifier.checkAuth(schema.parse(wire))).toThrow();
  });

  it("reads the persisted JSON-string form back to the same bytes", () => {
    const wire = verifier.signRequest(PRIVKEY, {
      action: "go",
      credit_id: "c1",
      draw_id: "d1",
    }) as unknown as Record<string, unknown>;
    expect(verifier.canonicalBytes(signedRequestInput({ input: JSON.stringify(wire) }))).toEqual(
      verifier.canonicalBytes(signedRequestInput({ data: wire }))
    );
  });
});
