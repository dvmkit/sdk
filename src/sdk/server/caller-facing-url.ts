/**
 * Resolve the configured public origin used in caller-facing URLs.
 *
 * A malformed value must never leak into a response. Ignore it and let the
 * request-derived fallback apply instead. `URL.origin` deliberately discards
 * paths, queries, fragments, credentials, and trailing slashes.
 */
export function resolvePublicOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * The request URL a caller should bind to, optionally rebased onto the DVM's
 * configured public origin. With no valid override the original string is
 * returned byte-for-byte.
 */
export function callerFacingRequestUrl(
  requestUrl: string,
  publicOrigin: string | undefined
): string {
  if (!publicOrigin) return requestUrl;
  const request = new URL(requestUrl);
  return `${publicOrigin}${request.pathname}${request.search}`;
}
