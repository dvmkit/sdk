import { describe, expect, it } from "vitest";

import { sha256hex } from "../../lib/hash";

describe("sha256hex", () => {
  it("matches the independent SHA-256 hello vector", () => {
    const result = sha256hex("hello");
    expect(result).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("produces different hashes for different inputs", () => {
    expect(sha256hex("a")).not.toBe(sha256hex("b"));
  });
});
