import { describe, expect, it } from "vitest";
import { z } from "zod";

// Import from the top-level SDK barrel — the path a third-party builder uses.
// Regression guard for signing primitives must be reachable from
// "@dvmkit/sdk", not only from "@dvmkit/sdk/server".
import { createSignedRequestVerifier, SignedRequestError } from "../index";

const schema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const PRIVKEY = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

const NOW = 1_700_000_000;

describe("signing primitives via top-level SDK export", () => {
  it("round-trips sign → verify through the top-level barrel", () => {
    const v = createSignedRequestVerifier(schema, {
      replayStore: null,
      now: () => NOW,
    });

    const signed = v.signRequest(
      PRIVKEY,
      { action: "test" },
      { timestamp: NOW, nonce: "smoke-nonce" }
    );

    expect(signed.action).toBe("test");
    const verified = v.checkAuth(signed);
    expect(verified.action).toBe("test");
    expect(verified.pubkey).toBe(signed.pubkey);
    expect(() => v.checkAuth({ ...signed, action: "tampered" })).toThrow(SignedRequestError);
  });
});
