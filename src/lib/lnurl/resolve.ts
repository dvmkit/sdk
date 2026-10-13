import { bech32 } from "@scure/base";

import { DvmError } from "../errors";

export interface LnAddressParts {
  user: string;
  domain: string;
}

interface LnurlPayParams {
  callback: string;
  minSendable: number;
  maxSendable: number;
  tag: string;
}

const LNURL_TIMEOUT_MS = 10_000;

export function parseLnAddress(address: string): LnAddressParts {
  const at = address.indexOf("@");
  if (at < 1 || at === address.length - 1) {
    throw new DvmError(
      "lnurl_invalid_address",
      `Invalid Lightning address: "${address}"`,
      "Expected format: user@domain (e.g. alice@getalby.com)"
    );
  }
  const user = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!domain.includes(".")) {
    throw new DvmError(
      "lnurl_invalid_address",
      `Invalid Lightning address domain: "${domain}"`,
      "Domain must contain at least one dot (e.g. getalby.com)"
    );
  }
  return { user, domain };
}

/**
 * Resolve a payee identifier to the LNURL-pay metadata URL to GET.
 *
 * Two forms are accepted, because both are what wallets hand people when they
 * ask "where do I send it":
 *   - `user@domain` (LUD-16) — becomes `https://{domain}/.well-known/lnurlp/{user}`.
 *   - `lnurl1…` (LUD-01 bech32) — decodes to the URL directly. Case-insensitive,
 *     and a `lightning:` scheme prefix is tolerated since that's what a QR scan
 *     yields. The 90-character bech32 limit is lifted (LNURL strings routinely
 *     exceed it); the checksum is still verified, so a mistyped string fails
 *     here rather than at an unrelated HTTP error later.
 */
export function resolveLnurlPayMetadataUrl(target: string): string {
  const trimmed = target.trim().replace(/^lightning:/i, "");
  if (/^lnurl1/i.test(trimmed)) {
    let url: string;
    try {
      const { words } = bech32.decode(trimmed.toLowerCase() as `${string}1${string}`, 2000);
      url = new TextDecoder().decode(bech32.fromWords(words));
    } catch (err) {
      throw new DvmError(
        "lnurl_invalid_address",
        `Invalid LNURL: ${err instanceof Error ? err.message : String(err)}`,
        "Re-copy the lnurl1… string, or use a Lightning address (user@domain) instead."
      );
    }
    if (!/^https:\/\//i.test(url)) {
      throw new DvmError(
        "lnurl_invalid_address",
        `LNURL decoded to a non-HTTPS URL: ${url}`,
        "Only https LNURL endpoints are accepted."
      );
    }
    return url;
  }
  const { user, domain } = parseLnAddress(trimmed);
  return `https://${domain}/.well-known/lnurlp/${user}`;
}

export async function fetchLnurlPayInvoice(
  lnAddress: string,
  amountMsats: number
): Promise<string> {
  const metadataUrl = resolveLnurlPayMetadataUrl(lnAddress);

  let params: LnurlPayParams;
  try {
    const resp = await fetch(metadataUrl, {
      signal: AbortSignal.timeout(LNURL_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    params = (await resp.json()) as LnurlPayParams;
  } catch (err) {
    throw new DvmError(
      "lnurl_metadata_unreachable",
      `Failed to fetch LNURL-pay metadata from ${metadataUrl}: ${err instanceof Error ? err.message : String(err)}`,
      "The Lightning address provider may be down. Try again later."
    );
  }

  if (params.tag !== "payRequest") {
    throw new DvmError(
      "lnurl_invalid_response",
      `LNURL-pay endpoint returned unexpected tag: "${params.tag}"`,
      "Expected a payRequest response from the Lightning address provider."
    );
  }
  if (!params.callback) {
    throw new DvmError(
      "lnurl_invalid_response",
      "LNURL-pay endpoint missing callback URL",
      "The Lightning address provider returned an invalid response."
    );
  }

  if (amountMsats < params.minSendable) {
    throw new DvmError(
      "lnurl_amount_out_of_range",
      `Amount ${amountMsats} msats is below minimum ${params.minSendable} msats`,
      `The Lightning address requires at least ${Math.ceil(params.minSendable / 1000)} sats.`
    );
  }
  if (amountMsats > params.maxSendable) {
    throw new DvmError(
      "lnurl_amount_out_of_range",
      `Amount ${amountMsats} msats exceeds maximum ${params.maxSendable} msats`,
      `The Lightning address allows at most ${Math.floor(params.maxSendable / 1000)} sats.`
    );
  }

  const sep = params.callback.includes("?") ? "&" : "?";
  const invoiceUrl = `${params.callback}${sep}amount=${amountMsats}`;
  let pr: string;
  try {
    const resp = await fetch(invoiceUrl, {
      signal: AbortSignal.timeout(LNURL_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const body = (await resp.json()) as { pr?: string; reason?: string };
    if (!body.pr) {
      throw new Error(body.reason ?? "No payment request in response");
    }
    pr = body.pr;
  } catch (err) {
    throw new DvmError(
      "lnurl_invoice_failed",
      `Failed to fetch invoice from ${lnAddress}: ${err instanceof Error ? err.message : String(err)}`,
      "Could not get a Lightning invoice from the address provider."
    );
  }

  return pr;
}

/**
 * Validate a Lightning address (or `lnurl1…` string) by probing its LNURL-pay
 * endpoint. Verifies the provider returns a valid payRequest response (LUD-06)
 * without fetching an invoice. Used as a deploy-time pre-flight check for
 * `--payout`, and as the pre-flight for `dvm wallet cash-out` so a typo'd
 * destination fails before any proof is marked in-flight.
 */
export async function validateLnAddress(address: string): Promise<void> {
  const metadataUrl = resolveLnurlPayMetadataUrl(address);

  let params: LnurlPayParams;
  try {
    const resp = await fetch(metadataUrl, {
      signal: AbortSignal.timeout(LNURL_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    params = (await resp.json()) as LnurlPayParams;
  } catch (err) {
    throw new DvmError(
      "lnurl_preflight_failed",
      `LNURL pre-flight failed for ${address}: could not reach ${metadataUrl} — ${err instanceof Error ? err.message : String(err)}`,
      "Check the Lightning address and try again. The provider may be down."
    );
  }

  if (params.tag !== "payRequest") {
    throw new DvmError(
      "lnurl_preflight_failed",
      `LNURL pre-flight failed for ${address}: unexpected tag "${params.tag}" (expected "payRequest")`,
      "The Lightning address provider returned an invalid response."
    );
  }
  if (!params.callback) {
    throw new DvmError(
      "lnurl_preflight_failed",
      `LNURL pre-flight failed for ${address}: missing callback URL`,
      "The Lightning address provider returned an incomplete response."
    );
  }
  if (typeof params.minSendable !== "number" || typeof params.maxSendable !== "number") {
    throw new DvmError(
      "lnurl_preflight_failed",
      `LNURL pre-flight failed for ${address}: missing or invalid sendable bounds`,
      "The Lightning address provider returned malformed pay parameters."
    );
  }
}
