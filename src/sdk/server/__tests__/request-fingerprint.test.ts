import { describe, expect, it } from "vitest";

import { requestFingerprint } from "../request-fingerprint";

/**
 * The fingerprint is the replay gate: it must be stable across
 * everything a legitimate retry changes, and sensitive to everything that would
 * make it a different call.
 */
describe("requestFingerprint", () => {
  const base = {
    capability: "do",
    params: { lang: "en" },
    data: { action: "publish", tags: ["a", "b"] },
  };

  it("is stable across key order and re-serialisation", () => {
    // The resume sweep stores the body as a parsed object and
    // re-`JSON.stringify`s it, so byte-equality is not on offer — canonical
    // JSON is what makes the two attempts agree.
    const reordered = {
      capability: "do",
      data: { tags: ["a", "b"], action: "publish" },
      params: { lang: "en" },
    };
    expect(requestFingerprint(base, { stripAuthEnvelope: false })).toBe(
      requestFingerprint(reordered, { stripAuthEnvelope: false })
    );
  });

  it("ignores the auth envelope on a signed DVM so a re-signed retry matches", () => {
    const first = {
      capability: "do",
      params: { lang: "en" },
      data: {
        ...base.data,
        pubkey: "ab".repeat(32),
        signature: "cd".repeat(64),
        timestamp: 1,
        nonce: "n1",
        auth_statement: { path: "/v1/job" },
      },
    };
    const resigned = {
      capability: "do",
      params: { lang: "en" },
      data: {
        ...base.data,
        pubkey: "ab".repeat(32),
        signature: "ef".repeat(64),
        timestamp: 2,
        nonce: "n2",
        auth_statement: { path: "/v1/request-resume/request-1" },
      },
    };
    expect(requestFingerprint(first, { stripAuthEnvelope: true })).toBe(
      requestFingerprint(resigned, { stripAuthEnvelope: true })
    );
    // The signed payload still differs from the same call made unsigned — the
    // stripped fields are gone, not merely equal.
    expect(requestFingerprint(first, { stripAuthEnvelope: true })).toBe(
      requestFingerprint(base, { stripAuthEnvelope: true })
    );
  });

  it("keeps envelope-shaped keys when the DVM declares no auth", () => {
    const withNonce = { capability: "do", data: { action: "publish", nonce: "user-field" } };
    const without = { capability: "do", data: { action: "publish" } };
    expect(requestFingerprint(withNonce, { stripAuthEnvelope: false })).not.toBe(
      requestFingerprint(without, { stripAuthEnvelope: false })
    );
  });

  it("changes when the work asked for changes", () => {
    const cases = [
      { ...base, capability: "other" },
      { ...base, params: { lang: "fr" } },
      { ...base, data: { action: "exfiltrate", tags: ["a", "b"] } },
      { ...base, input: "legacy-string" },
    ];
    const original = requestFingerprint(base, { stripAuthEnvelope: false });
    for (const variant of cases) {
      expect(requestFingerprint(variant, { stripAuthEnvelope: false })).not.toBe(original);
    }
  });
});
