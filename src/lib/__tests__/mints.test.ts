import { describe, expect, it } from "vitest";

import { isTestMintUrl } from "../mints";

describe("isTestMintUrl", () => {
  it("flags the FakeWallet loopback mint on any port", () => {
    expect(isTestMintUrl("http://localhost:3338")).toBe(true);
    expect(isTestMintUrl("http://localhost:3338/")).toBe(true);
    expect(isTestMintUrl("http://127.0.0.1:3338")).toBe(true);
    expect(isTestMintUrl("http://0.0.0.0:3338")).toBe(true);
    expect(isTestMintUrl("http://[::1]:3338")).toBe(true);
    expect(isTestMintUrl("http://mint.localhost")).toBe(true);
  });

  it("flags public test mints", () => {
    expect(isTestMintUrl("https://testnut.cashu.space")).toBe(true);
    expect(isTestMintUrl("https://testnut.cashu.space/v1/info")).toBe(true);
    expect(isTestMintUrl("https://TESTNUT.cashu.space")).toBe(true);
  });

  it("does not flag production mints", () => {
    expect(isTestMintUrl("https://mint.coinos.io")).toBe(false);
    expect(isTestMintUrl("https://mint.lnvoltz.com")).toBe(false);
    expect(isTestMintUrl("https://mint.example.com")).toBe(false);
  });

  it("returns false for unparseable input (format validation is the health check's job)", () => {
    expect(isTestMintUrl("")).toBe(false);
    expect(isTestMintUrl("not-a-url")).toBe(false);
    expect(isTestMintUrl("localhost:3338")).toBe(false); // no scheme → unparseable host
  });
});
