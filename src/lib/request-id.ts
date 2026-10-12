/** Maximum length of a caller-generated public request identifier. */
export const MAX_REQUEST_ID_LENGTH = 128;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** True when a value is a URL-safe caller-generated request identifier. */
export function isPublicRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}
