import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCreditTerms } from "../src/lib/transport/types";

const fixture = JSON.parse(readFileSync(new URL("../protocol-fixtures/jit-refund-park-v1.json", import.meta.url), "utf8"));

describe("portable JIT refund park discovery", () => {
  it("reads support only from the explicit flag", () => {
    expect(parseCreditTerms(fixture.discovery.receiving_off_supported.credit)?.jit_refund_park).toBe(true);
    const old = parseCreditTerms(fixture.discovery.old_server_unsupported.credit);
    expect(old).toBeDefined();
    expect(old?.jit_refund_park).toBeUndefined();
  });

  it("treats non-true values as unsupported", () => {
    const terms = fixture.discovery.receiving_off_supported.credit;
    for (const value of [false, "true", 1, null]) {
      expect(parseCreditTerms({ ...terms, jit_refund_park: value })?.jit_refund_park).toBeUndefined();
    }
  });
});
