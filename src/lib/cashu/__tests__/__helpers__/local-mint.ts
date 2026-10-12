/**
 * Helpers for tests that round-trip Cashu tokens against a real mint.
 *
 * Backed by Nutshell's FakeWallet Lightning backend, which mints test sats
 * without a Lightning payment or network access beyond localhost. Start it
 * with the same command CI uses, `node scripts/start-cashu-mint.mjs`, and
 * remove it afterward with `docker rm --force sdk-cashu-mint`.
 *
 * Tests gate on `await localMintAvailable()` via `describe.skipIf` so they
 * skip when the mint is absent, matching the optional Postgres suites, and
 * fail instead under the complete gate.
 */
import { getEncodedToken, type Token, Wallet } from "@cashu/cashu-ts";

import { DEFAULT_REQUIRED_NUTS } from "../../health";

/** URL of the local Cashu mint. Override with CASHU_MINT_URL. */
export const LOCAL_MINT_URL = process.env.CASHU_MINT_URL ?? "http://localhost:3338";

/**
 * Probe `/v1/info` on LOCAL_MINT_URL. Returns false on any error, non-2xx,
 * or if the mint does not advertise all NUTs required by `getWallet`.
 */
export async function isMintReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${LOCAL_MINT_URL}/v1/info`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!r.ok) return false;
    const info = (await r.json()) as { nuts?: Record<string, unknown> };
    const nuts = info.nuts ?? {};
    return DEFAULT_REQUIRED_NUTS.every((n) => {
      const entry = nuts[String(n)];
      if (entry === undefined || entry === null) return false;
      return !(typeof entry === "object" && (entry as Record<string, unknown>).supported === false);
    });
  } catch {
    return false;
  }
}

/**
 * `npm run verify -- --require-database` sets DVMKIT_SDK_REQUIRE_MINT, so an
 * absent mint fails that gate instead of skipping its mint-dependent cases.
 */
export async function localMintAvailable(): Promise<boolean> {
  const reachable = await isMintReachable();
  if (!reachable && process.env.DVMKIT_SDK_REQUIRE_MINT === "1") {
    throw new Error(`the complete gate requires the local Cashu mint, which is unreachable at ${LOCAL_MINT_URL}`);
  }
  return reachable;
}

/**
 * Mint a real Cashu token at LOCAL_MINT_URL for the given amount in sats.
 * The FakeWallet backend auto-pays the bolt11 invoice, so no Lightning
 * payment is required. Returns the encoded token.
 */
export async function mintLocalTokens(amountSats: number): Promise<string> {
  const wallet = new Wallet(LOCAL_MINT_URL);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(amountSats);

  // FakeWallet may transition the quote to PAID asynchronously. Poll
  // briefly so mintProofsBolt11 doesn't race against the state update.
  const deadline = Date.now() + 5_000;
  let paidQuote = quote;
  while (paidQuote.state !== "PAID" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    paidQuote = await wallet.checkMintQuoteBolt11(quote.quote);
  }
  if (paidQuote.state !== "PAID") {
    throw new Error(
      `mintLocalTokens: quote ${quote.quote} did not reach PAID within 5s ` +
        `(state=${paidQuote.state}). Check that the FakeWallet backend is ` +
        `enabled on the mint at ${LOCAL_MINT_URL}.`
    );
  }

  const proofs = await wallet.mintProofsBolt11(amountSats, paidQuote);
  const token: Token = { mint: LOCAL_MINT_URL, proofs, unit: "sat" };
  return getEncodedToken(token);
}
