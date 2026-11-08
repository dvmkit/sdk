import type { ZodLike } from "./types";

// auth_statement is protocol-owned and removed before capability validation.
export const CAPABILITY_SIGNED_FIELDS = ["pubkey", "signature", "timestamp", "nonce"] as const;

/** Undefined means the schema cannot be checked without parsing caller input. */
export function missingSignedSchemaFields(schema: ZodLike): readonly string[] | undefined {
  const def = (schema._zod as { def?: {
    type?: unknown;
    shape?: Record<string, unknown>;
    catchall?: ZodLike;
  } } | undefined)?.def;
  if (def?.type !== "object" || !def.shape || typeof def.shape !== "object") return undefined;
  const shape = def.shape;
  if (def.catchall !== undefined) {
    const catchallType = (def.catchall._zod as { def?: { type?: unknown } } | undefined)?.def?.type;
    if (catchallType !== "never") return [];
  }
  return CAPABILITY_SIGNED_FIELDS.filter(field => !Object.hasOwn(shape, field));
}

/** Only fields actually removed by parsing are builder errors; absent caller fields stay auth errors. */
export function droppedSignedFields(raw: unknown, parsed: unknown): readonly string[] {
  if (!isRecord(raw)) return [];
  return CAPABILITY_SIGNED_FIELDS.filter(field => field in raw && (!isRecord(parsed) || !(field in parsed)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
