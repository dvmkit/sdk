import { describe, expect, it, vi } from "vitest";

const { FakeOutputData } = vi.hoisted(() => {
  class FakeOutputData {
    constructor(
      public blindedMessage: { amount: { toNumber: () => number }; B_: string; id: string },
      public blindingFactor: bigint,
      public secret: Uint8Array,
      public ephemeralE?: string
    ) {}
    toProof(_sig: unknown, _keyset: unknown): unknown {
      throw new Error("not used in this test");
    }
  }
  return { FakeOutputData };
});

vi.mock("@cashu/cashu-ts", () => ({
  Amount: {
    from: (x: unknown) => ({
      toNumber: () =>
        typeof x === "object" && x !== null && "toNumber" in x
          ? (x as { toNumber: () => number }).toNumber()
          : Number(x),
    }),
  },
  OutputData: FakeOutputData,
}));

import { rehydrateOutputData, serializeOutputData } from "../output-data";

describe("output-data serialize/rehydrate", () => {
  it("serializes a P2PK-shaped OutputData to lowercase hex JSON-friendly fields", () => {
    const envelope = new TextEncoder().encode('["P2PK",{"data":"02ab"}]');
    const out = new FakeOutputData(
      { amount: { toNumber: () => 64 }, B_: "02BB64", id: "k1" },
      BigInt("0xdeadbeef"),
      envelope,
      "ephem-e"
    );
    const [serialized] = serializeOutputData([
      out as unknown as Parameters<typeof serializeOutputData>[0][number],
    ]);
    expect(serialized.blinded_message).toEqual({ amount: 64, B_: "02BB64", id: "k1" });
    expect(serialized.blinding_factor).toBe("deadbeef");
    expect(serialized.secret).toBe("5b225032504b222c7b2264617461223a2230326162227d5d");
    expect(serialized.ephemeral_e).toBe("ephem-e");
    const [hydrated] = rehydrateOutputData([serialized]);
    expect(hydrated.blindedMessage.B_).toBe("02BB64");
    expect(hydrated.blindedMessage.id).toBe("k1");
    expect(hydrated.blindedMessage.amount.toNumber()).toBe(64);
    expect(hydrated.blindingFactor).toBe(0xdeadbeefn);
    expect(hydrated.secret).toEqual(envelope);
    expect(hydrated.ephemeralE).toBe("ephem-e");
  });

  it("pads odd-length bigints with a leading zero so hex always has even length", () => {
    const out = new FakeOutputData(
      { amount: { toNumber: () => 1 }, B_: "02", id: "k1" },
      0xfn,
      new Uint8Array([0x01])
    );
    const [serialized] = serializeOutputData([
      out as unknown as Parameters<typeof serializeOutputData>[0][number],
    ]);
    expect(serialized.blinding_factor).toBe("0f");
  });

  it("rejects malformed hex on rehydrate", () => {
    expect(() =>
      rehydrateOutputData([
        {
          blinded_message: { amount: 1, B_: "02", id: "k1" },
          blinding_factor: "not-hex",
          secret: "00",
        },
      ])
    ).toThrow();
    expect(() =>
      rehydrateOutputData([
        {
          blinded_message: { amount: 1, B_: "02", id: "k1" },
          blinding_factor: "00",
          secret: "0",
        },
      ])
    ).toThrow();
  });
});
