import { isPublicRequestId } from "../../lib/request-id";
import { creditEnvelopeIgnoreFields, stripCreditEnvelope } from "./credit-envelope";

/** Protocol-owned request field carried inside a signed request body. */
export const REQUEST_ID_FIELD = "request_id";
/** Versioned domain header carried beside a v2 signed request input. */
export const AUTH_STATEMENT_FIELD = "auth_statement";

/** Auth-schema fields the protocol owns rather than the builder input schema. */
export function protocolEnvelopeIgnoreFields(schema: unknown): readonly string[] {
  return [...creditEnvelopeIgnoreFields(schema), REQUEST_ID_FIELD, AUTH_STATEMENT_FIELD];
}

/** Remove protocol-owned credit and recovery fields before builder input parsing. */
export function stripProtocolEnvelope(schema: unknown, data: unknown): unknown {
  const withoutCredit = stripCreditEnvelope(schema, data);
  if (!isRecord(withoutCredit)) return withoutCredit;
  const {
    [REQUEST_ID_FIELD]: _requestId,
    [AUTH_STATEMENT_FIELD]: _authStatement,
    ...builderInput
  } = withoutCredit;
  return builderInput;
}

/** Read and validate the optional recovery id from a signed request body. */
export function requestIdFromEnvelope(data: unknown): string | undefined {
  if (!isRecord(data) || !(REQUEST_ID_FIELD in data)) return undefined;
  return isPublicRequestId(data[REQUEST_ID_FIELD]) ? data[REQUEST_ID_FIELD] : undefined;
}

export function hasInvalidRequestId(data: unknown): boolean {
  return isRecord(data) && REQUEST_ID_FIELD in data && !isPublicRequestId(data[REQUEST_ID_FIELD]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
