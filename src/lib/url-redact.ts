const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;
const NUMERIC_RE = /^\d{4,}$/;
const BASE58_RE = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,}$/;
const OPAQUE_TOKEN_MIN_LENGTH = 32;
const OPAQUE_TOKEN_MIN_UNIQUE_CHARS = 8;
// Stops at whitespace and at the quoting a URL is usually wrapped in, so a
// URL quoted inside a JSON blob doesn't drag the closing quote along.
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'`<>]+/gi;

/**
 * Replace ID-shaped segments in a URL pathname with placeholders.
 *
 *  - UUID → `:uuid`
 *  - Long hex (16+ chars) → `:hex`
 *  - Numeric (4+ digits) → `:n`
 *  - Base58 (32+ chars) → `:b58`
 *  - Opaque path segment (32+ chars, 8+ distinct) → `:token`
 *
 * Conservative: false positives are harmless; false negatives leak PII.
 * Use this directly when you already hold a pathname (e.g. for span
 * dimensions like `route`); use {@link redactUrl} for full URLs.
 */
export function redactPath(pathname: string): string {
  const segments = pathname.split("/");
  const redacted = segments.map((seg) => {
    if (!seg) return seg;
    if (UUID_RE.test(seg)) return ":uuid";
    if (LONG_HEX_RE.test(seg)) return ":hex";
    if (NUMERIC_RE.test(seg)) return ":n";
    if (BASE58_RE.test(seg)) return ":b58";
    if (isOpaqueToken(seg)) return ":token";
    return seg;
  });
  return redacted.join("/");
}

/**
 * Redact sensitive information from a URL before storing it in span attributes.
 *
 * Strips the entire query string (highest-risk PII surface), then applies
 * {@link redactPath} to the pathname.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a valid URL — return as-is rather than crashing the span path.
    return url;
  }
  return `${parsed.origin}${redactPath(parsed.pathname)}`;
}

/**
 * Run {@link redactUrl} over every URL embedded in a free-text string.
 *
 * For text a library composed for us, where the URL isn't a value we hold
 * separately — viem prints its own `URL: …` line into transport errors, so
 * redacting the endpoint we passed in leaves a second copy untouched.
 * Trailing sentence punctuation is pushed back outside the match, so a URL
 * ending a sentence doesn't swallow the period after it.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT_RE, (match) => {
    const trailing = /[.,;:!?)\]}]+$/.exec(match)?.[0] ?? "";
    const url = trailing.length > 0 ? match.slice(0, -trailing.length) : match;
    return `${redactUrl(url)}${trailing}`;
  });
}

function isOpaqueToken(segment: string): boolean {
  if (segment.length < OPAQUE_TOKEN_MIN_LENGTH) return false;

  const distinct = new Set<number>();
  for (let index = 0; index < segment.length; index++) {
    distinct.add(segment.charCodeAt(index));
    if (distinct.size >= OPAQUE_TOKEN_MIN_UNIQUE_CHARS) return true;
  }

  return false;
}
