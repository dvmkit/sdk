import { describe, expect, it } from "vitest";

import { DvmError } from "../errors";

describe("DvmError", () => {
  it("preserves relay fields and remains an Error", () => {
    const data = { fundingOptions: [{ method: "lightning" }] };
    const err = new DvmError("wallet_missing", "No wallet", "Run dvm wallet setup", data);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({
      name: "DvmError",
      code: "wallet_missing",
      message: "No wallet",
      hint: "Run dvm wallet setup",
      data,
    });
  });

  it("leaves omitted relay fields undefined", () => {
    const err = new DvmError("test", "msg");
    expect(err.hint).toBeUndefined();
    expect(err.data).toBeUndefined();
  });
});
