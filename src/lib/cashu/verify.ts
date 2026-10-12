import { getTokenMetadata } from "@cashu/cashu-ts";

import { DvmError } from "../errors";

/** Result of verifying a Cashu token without claiming it. */
export interface TokenVerification {
  mint: string;
  /** Total value of the proofs in msats. */
  totalMsats: number;
  /** Unit declared by the token (e.g. "sat"). Required by cashu-ts wallet.receive(). */
  unit: string;
}

export function verifyCashuToken(token: string, acceptedMints: string[]): TokenVerification {
  let mint: string, unit: string, totalMsats: number;
  try {
    const meta = getTokenMetadata(token);
    mint = meta.mint;
    unit = meta.unit;
    totalMsats = meta.amount.toNumber() * 1000;
  } catch {
    throw new DvmError(
      "cashu_invalid_token",
      "The Cashu token could not be decoded.",
      "Ensure the token is a valid cashuA... or cashuB... string."
    );
  }

  const normalised = acceptedMints.map(normaliseMintUrl);
  if (!normalised.includes(normaliseMintUrl(mint))) {
    throw new DvmError(
      "cashu_mint_not_accepted",
      `Mint ${mint} is not accepted by this provider.`,
      `Accepted mints: ${acceptedMints.join(", ")}`
    );
  }

  return { mint, totalMsats, unit };
}

/** Normalise a mint URL for comparison: lowercase host, strip trailing slash. */
export function normaliseMintUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    // Collapse duplicate slashes in path, resolve . and ..
    u.pathname = u.pathname.replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}
