import { describe, expect, it } from "vitest";

import { resolveRpcOverride } from "../rpc";

describe("resolveRpcOverride", () => {
  it.each([undefined, "", "   "])("uses the bundled URL when the override is %j", (envValue) => {
    expect(resolveRpcOverride(envValue, "https://bundled.example/rpc")).toEqual({
      url: "https://bundled.example/rpc",
      source: "bundled",
    });
  });

  it("trims and uses a non-empty override", () => {
    expect(
      resolveRpcOverride("  https://override.example/rpc  ", "https://bundled.example/rpc")
    ).toEqual({
      url: "https://override.example/rpc",
      source: "override",
    });
  });

  it("preserves an undefined bundled URL when no override is set", () => {
    expect(resolveRpcOverride(undefined)).toEqual({ url: undefined, source: "bundled" });
  });
});
