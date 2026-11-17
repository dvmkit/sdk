/**
 * Credit fields belong to the raw signed body. The funding commitment hashes the header
 * artifact, binding money outside that body to its intended credit.
 *
 * Schema projection strips mandate and undeclared credit keys before builder input parsing, without
 * changing canonical signing bytes. Signature verification must use the original wire body; a
 * parsed projection may omit credit fields.
 */
export interface CreditEnvelope {
  creditId: string;
  drawId: string;
  fund?: CreditFundCommitment;
  mandate?: StandingMandate;
}

export interface CreditFundCommitment {
  /** Funding amount in 1e-6 units of the credit's currency. */
  amountMicro: number;
  /** SHA-256 hex over the raw funding artifact bytes. */
  commitment: string;
}

/** Accepted credit authorization. Custom job stores must preserve it unchanged after insert. */
export interface StandingMandate {
  credit_id: string;
  draw_id: string;
  max_total_micro: number;
  max_ask_micro: number;
  expires_at_ms: number;
}

export class InvalidMandateError extends Error {}

/**
 * Read the accepted authorization without revalidating its acceptance-time expiry.
 * The intended draw id is not reserved at admission. Before paying an ask, never use a draw
 * belonging to another job; leave that ask open for ordinary payment instead.
 */
export function getStandingMandate(job: { mandate?: StandingMandate }): StandingMandate | undefined {
  return job.mandate;
}

function parseMandate(raw: unknown, creditId: unknown, drawId: unknown): StandingMandate {
  if (typeof creditId !== "string" || !creditId || typeof drawId !== "string" || !drawId) {
    throw new InvalidMandateError("mandate requires non-empty credit_id and draw_id.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidMandateError("mandate must be an object with max_total_micro, max_ask_micro and expires_at_ms.");
  }
  const m = raw as Record<string, unknown>;
  if (Object.keys(m).some((key) => !["max_total_micro", "max_ask_micro", "expires_at_ms"].includes(key))) {
    throw new InvalidMandateError("mandate contains an unknown key.");
  }
  for (const key of ["max_total_micro", "max_ask_micro"] as const) {
    if (typeof m[key] !== "number" || !Number.isSafeInteger(m[key]) || m[key] < 1) {
      throw new InvalidMandateError(`mandate.${key} must be a positive safe integer.`);
    }
  }
  if ((m.max_ask_micro as number) > (m.max_total_micro as number)) {
    throw new InvalidMandateError("mandate.max_ask_micro must not exceed max_total_micro.");
  }
  const now = Date.now();
  if (typeof m.expires_at_ms !== "number" || !Number.isSafeInteger(m.expires_at_ms) ||
      m.expires_at_ms <= now || m.expires_at_ms > now + 7 * 86_400_000) {
    throw new InvalidMandateError("mandate.expires_at_ms must be in the future and at most 7 days away.");
  }
  return { credit_id: creditId, draw_id: drawId, max_total_micro: m.max_total_micro as number, max_ask_micro: m.max_ask_micro as number,
    expires_at_ms: m.expires_at_ms };
}

export const CREDIT_ENVELOPE_KEYS = ["credit_id", "draw_id", "fund", "mandate"] as const;

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
  const mandate = "mandate" in obj ? parseMandate(obj.mandate, creditId, drawId) : undefined;
  if (creditId === undefined && drawId === undefined && fund === undefined && mandate === undefined) return undefined;
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
  if (fund === undefined) return { creditId, drawId, ...(mandate && { mandate }) };
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
  return { creditId, drawId, ...(mandate && { mandate }), fund: { amountMicro: f.amount_micro, commitment: f.commitment } };
}

/**
 * Return mandate and protocol keys not declared by the schema. Other declared keys remain available,
 * including /v1/credit’s differently shaped credit_id and fund fields. Submit separately
 * extracts and validates the credit envelope from raw body.data; declaring a key does not
 * bypass that validation.
 */
export function creditEnvelopeIgnoreFields(schema: unknown): readonly string[] {
  const declared = objectShapeKeys(schema);
  if (!declared) return CREDIT_ENVELOPE_KEYS;
  return CREDIT_ENVELOPE_KEYS.filter((key) => key === "mandate" || !declared.has(key));
}

/**
 * Remove mandate and undeclared credit keys before schema parsing. Preserve nonobject/array inputs and
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
