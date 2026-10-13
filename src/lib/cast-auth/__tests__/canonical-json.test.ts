import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalize, type JsonValue } from "../canonical-json";

interface Vector {
  name: string;
  input: JsonValue;
  canonical: string;
}

const vectorsPath = fileURLToPath(new URL("./fixtures/vectors.json", import.meta.url));
const vectorsFile = JSON.parse(readFileSync(vectorsPath, "utf8")) as { vectors: Vector[] };

describe("canonicalize", () => {
  it.each(vectorsFile.vectors)("vector: $name", ({ input, canonical }) => {
    expect(canonicalize(input)).toBe(canonical);
  });

  it("omits undefined object properties (matching JSON.stringify)", () => {
    const value = { a: 1, b: undefined as unknown as JsonValue, c: 2 };
    expect(canonicalize(value)).toBe(`{"a":1,"c":2}`);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
  });

  it("rejects unsupported scalar types", () => {
    expect(() => canonicalize(BigInt(1) as unknown as JsonValue)).toThrow(TypeError);
  });
});
