/**
 * True if `url` is a known test/dev Cashu mint — one that settles no real
 * money (the FakeWallet mint on `localhost:3338`, or a public test mint).
 * Used to refuse production-ish boots that would silently no-op every payment
 * URL *format* validation is the mint health check's job, so an
 * unparseable input is treated as "not a known test mint" (`false`).
 */
export function isTestMintUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // `new URL` keeps the brackets on an IPv6 literal (`[::1]`); strip them.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  return TEST_MINT_HOSTS.has(host);
}

/** Loopback hosts the FakeWallet docker mint binds to in dev/CI (`:3338`). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** Public Nutshell test mints — settle no real money. */
const TEST_MINT_HOSTS = new Set(["testnut.cashu.space", "dvmkit-testmint.fly.dev"]);
