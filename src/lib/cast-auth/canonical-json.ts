export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Object keys sort recursively in UTF-16 code-unit order; arrays preserve order.
 * Undefined object properties are omitted. Unsupported scalars, including
 * non-finite numbers, throw TypeError. Callers strip unsigned fields themselves.
 */
export function canonicalize(value: JsonValue): string {
  return JSON.stringify(sortDeep(value));
}

/**
 * UTF-8 encoding of the canonical JSON form.
 */
export function canonicaliseForSigning(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function sortDeep(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalize: non-finite number is not JSON-serialisable`);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === "object") {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      sorted[key] = sortDeep(v);
    }
    return sorted;
  }
  throw new TypeError(`canonicalize: unsupported value of type ${typeof value}`);
}
