import { CREDIT_ENVELOPE_KEYS } from "./credit-envelope";
import type { DVMAuthScheme } from "./secp256k1-auth";
import { SIGNED_ENVELOPE_FIELDS, signedRequestInput } from "./signed-request";
import type { ZodLike } from "../types";

/**
 * True when the scheme admits unsigned paid jobs and the raw request input
 * carries none of the signed-envelope fields. The presence of any one field
 * selects the signed path, so a malformed or forged envelope is verified and
 * refused rather than downgraded. Submit and reactivation share this rule.
 */
export function takesUnsignedPath(
  auth: DVMAuthScheme | undefined,
  body: { input?: string; data?: unknown }
): boolean {
  if (!auth?.allowUnsignedPaid) return false;
  const raw = signedRequestInput(body);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return true;
  return !SIGNED_ENVELOPE_FIELDS.some((field) => field in raw);
}

/** True when a raw request input names any prepaid-credit envelope key. */
export function carriesCreditFields(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  return CREDIT_ENVELOPE_KEYS.some((field) => field in raw);
}

/**
 * The capability schema with its signed-envelope fields removed, for
 * validating an unsigned body. Built with the schema's own `clone` so
 * strictness, catchall and object-level refinements are kept (Zod's `omit`
 * refuses refined objects). Undefined when the schema is not an object schema
 * that can be narrowed this way; that capability then stays signed-only.
 */
export function unsignedInputSchema<T>(schema: ZodLike<T>): ZodLike | undefined {
  if (narrowed.has(schema)) return narrowed.get(schema);
  const result = narrow(schema);
  narrowed.set(schema, result);
  return result;
}

const narrowed = new WeakMap<ZodLike, ZodLike | undefined>();

interface CloneableObjectSchema extends ZodLike {
  shape: Record<string, unknown>;
  clone(def: unknown): ZodLike;
  _zod: { def: { type?: unknown } & Record<string, unknown> };
}

function narrow(schema: ZodLike): ZodLike | undefined {
  const candidate = schema as Partial<CloneableObjectSchema>;
  const def = candidate._zod?.def;
  if (
    def?.type !== "object" ||
    typeof candidate.clone !== "function" ||
    candidate.shape === null ||
    typeof candidate.shape !== "object"
  ) {
    return undefined;
  }
  const shape: Record<string, unknown> = { ...candidate.shape };
  for (const field of SIGNED_ENVELOPE_FIELDS) delete shape[field];
  try {
    return candidate.clone({ ...def, shape });
  } catch {
    return undefined;
  }
}
