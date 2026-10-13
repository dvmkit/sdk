/**
 * Credit fields belong to the raw signed body. The funding commitment hashes the header
 * artifact, binding money outside that body to its intended credit.
 *
 * Schema projection strips undeclared protocol keys before builder input parsing, without
 * changing canonical signing bytes. Signature verification must use the original wire body; a
 * parsed projection may omit credit fields.
 */
export interface CreditEnvelope {
  creditId: string;
  drawId: string;
  fund?: CreditFundCommitment;
}

export interface CreditFundCommitment {
  /** Funding amount in 1e-6 units of the credit's currency. */
  amountMicro: number;
  /** SHA-256 hex over the raw funding artifact bytes. */
  commitment: string;
}

export const CREDIT_ENVELOPE_KEYS = ["credit_id", "draw_id", "fund"] as const;

/**
 * Thrown by {@link extractCreditEnvelope} on a structurally invalid credit
 * envelope — half a pair, a `fund` block without credit fields, wrong types.
 * Carries a caller-facing message; the route maps it to a 400.
 */
export class CreditEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditEnvelopeError";
  }
}

/**
 * Extract the credit envelope from the raw wire `body.data`. Returns
 * `undefined` when no credit field is present (the implicit / legacy shape).
 * Throws {@link CreditEnvelopeError} on partial or malformed fields — a
 * request that names half a draw is a caller bug, not an implicit payment.
 */
export function extractCreditEnvelope(data: unknown): CreditEnvelope | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const obj = data as Record<string, unknown>;
  const creditId = obj.credit_id;
  const drawId = obj.draw_id;
  const fund = obj.fund;
  if (creditId === undefined && drawId === undefined && fund === undefined) return undefined;
  if (typeof creditId !== "string" || creditId.length === 0) {
    throw new CreditEnvelopeError(
      "credit fields present but credit_id is missing or not a non-empty string"
    );
  }
  if (typeof drawId !== "string" || drawId.length === 0) {
    throw new CreditEnvelopeError(
      "credit fields present but draw_id is missing or not a non-empty string"
    );
  }
  if (fund === undefined) return { creditId, drawId };
  if (fund === null || typeof fund !== "object" || Array.isArray(fund)) {
    throw new CreditEnvelopeError("fund must be an object: { amount_micro, commitment }");
  }
  const f = fund as Record<string, unknown>;
  if (
    typeof f.amount_micro !== "number" ||
    !Number.isSafeInteger(f.amount_micro) ||
    f.amount_micro < 1
  ) {
    throw new CreditEnvelopeError("fund.amount_micro must be a positive safe integer");
  }
  if (typeof f.commitment !== "string" || !/^[0-9a-f]{64}$/.test(f.commitment)) {
    throw new CreditEnvelopeError("fund.commitment must be 64 lowercase hex chars (SHA-256)");
  }
  return { creditId, drawId, fund: { amountMicro: f.amount_micro, commitment: f.commitment } };
}

/**
 * Return protocol keys not declared by the schema. Schema-declared keys remain available,
 * including /v1/credit’s differently shaped credit_id and fund fields. Submit separately
 * extracts and validates the credit envelope from raw body.data; declaring a key does not
 * bypass that validation.
 */
export function creditEnvelopeIgnoreFields(schema: unknown): readonly string[] {
  const declared = objectShapeKeys(schema);
  if (!declared) return CREDIT_ENVELOPE_KEYS;
  return CREDIT_ENVELOPE_KEYS.filter((key) => !declared.has(key));
}

/**
 * Remove undeclared credit keys before schema parsing. Preserve nonobject/array inputs and
 * objects with no removable keys. Never derive signing bytes from this projection; signatures
 * cover the raw wire body.
 */
export function stripCreditEnvelope(schema: unknown, data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  const removable = new Set(creditEnvelopeIgnoreFields(schema).filter((key) => key in obj));
  if (removable.size === 0) return data;
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !removable.has(key)));
}

/**
 * Unreadable schema shapes declare no fields, so all protocol keys are removable. Zod object
 * refinement retains its readable shape.
 */
function objectShapeKeys(schema: unknown): Set<string> | undefined {
  if (schema === null || typeof schema !== "object") return undefined;
  const shape = (schema as { shape?: unknown }).shape;
  if (shape === null || typeof shape !== "object") return undefined;
  return new Set(Object.keys(shape as Record<string, unknown>));
}
