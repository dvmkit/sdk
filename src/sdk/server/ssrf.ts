import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

import { Agent, getGlobalDispatcher, type Dispatcher } from "undici";

/**
 * Why `assertSafeUrl` refused this URL. Carried on `SSRFError` so callers can
 * branch without string-matching `err.message` — DNS failures (NXDOMAIN, empty
 * resolution), unparseable URLs, and a non-https scheme each have distinct
 * recovery paths and shouldn't collapse together.
 */
export type SSRFReason = "invalid_url" | "insecure_scheme" | "private_address" | "dns_failed";

/**
 * Thrown when an input URL points at internal infrastructure we refuse to
 * fetch from inside the cluster. Carries a `reason` discriminator so the
 * caller can map cleanly onto its public taxonomy instead of inspecting the
 * message string.
 */
export class SSRFError extends Error {
  readonly code = "ssrf_blocked" as const;
  readonly reason: SSRFReason;
  constructor(reason: SSRFReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Pluggable DNS resolver. Defaults to `node:dns/promises` `lookup(host, { all: true })`. */
export type SSRFResolver = (host: string) => Promise<{ address: string; family: number }[]>;

/**
 * Configurable hooks for `assertSafeUrl`. Defaults preserve the dvmkit
 * baseline denylist; extra entries compose with (never replace) the defaults.
 */
export interface SSRFGuardOpts {
  resolver?: SSRFResolver;
  /** Additional exact hostnames to deny on top of the defaults (lowercased on input). */
  extraHostnamesExact?: Iterable<string>;
  /**
   * Additional hostname suffixes to deny on top of the defaults. Each entry
   * should include the leading dot (e.g. `.example.invalid`) — the same shape
   * the defaults use.
   */
  extraHostnameSuffixes?: Iterable<string>;
  /** Additional IPv4 predicate. Returns true for an unsafe address. */
  extraUnsafeIPv4?: (ipv4: string) => boolean;
  /** Additional IPv6 predicate. Returns true for an unsafe address. */
  extraUnsafeIPv6?: (ipv6: string) => boolean;
  /**
   * Underlying fetch implementation `createPinnedFetch` wraps. Defaults to
   * `globalThis.fetch`. Pass an instrumented wrapper (e.g. scribe's
   * `ctx.fetch` from `createInstrumentedFetch`) to keep `dvm.fetch` spans
   * around outbound HEAD / GET — the dispatcher pin for every safe redirect
   * hop is preserved because `init.dispatcher` flows through any thin fetch
   * wrapper unchanged.
   */
  baseFetch?: typeof fetch;
  /**
   * Called after a redirect response is accepted and before the target is
   * resolved or connected. Lets an outer transport refuse to replay an
   * original request once its source has demonstrably responded.
   */
  onRedirectFollowed?: () => void;
}

/**
 * Reject URLs whose host points at internal infrastructure — private /
 * link-local IP ranges, the AWS / GCP metadata IP, Fly's `*.internal`
 * service-discovery names, and a small denylist of obviously-internal
 * hostnames. Defence-in-depth — full mitigation belongs at the egress firewall
 * and at fetch-time IP pinning (`createPinnedFetch`).
 *
 * Throws `SSRFError` with a `reason` discriminator so callers can branch onto
 * their own typed error taxonomy.
 */
export async function assertSafeUrl(url: string, opts?: SSRFGuardOpts): Promise<void> {
  await resolveAndValidate(url, opts);
}

/**
 * A `fetch`-compatible function pinned to a single pre-validated IP address.
 *
 * Returned by {@link createPinnedFetch}. Closes the DNS-rebinding window in
 * which `assertSafeUrl` validates an address but the subsequent `fetch()`
 * re-resolves DNS and lands on a different (private) address.
 *
 * Callers MUST `await close()` when done with the pin so undici's connection
 * pool is released.
 */
export interface PinnedFetch {
  /** Fetch whose initial request and every followed redirect are pinned to their pre-validated address sets. */
  fetch: typeof fetch;
  /** Primary (first) validated address of the initial URL. */
  address: string;
  /** IP family (4 or 6) of {@link address} (the primary). */
  family: number;
  /** Release the undici connection pool backing this pinned fetch. */
  close(): Promise<void>;
}

/**
 * Resolve the URL's host once, validate every answer against the same
 * denylist `assertSafeUrl` applies, then return a `fetch` whose `connect.lookup`
 * replays that frozen, pre-validated address set (see {@link buildPinnedLookup}).
 * Redirects are followed manually: each target URL is independently required
 * to be HTTPS, resolved once, denylist-checked, and pinned before it can be
 * requested. That prevents an automatic redirect from reusing the source
 * host's dispatcher for a different hostname, while keeping a redirect from
 * opening a DNS-rebinding window.
 *
 * Throws `SSRFError` with the same `reason` discriminator as `assertSafeUrl`,
 * so error-mapping paths (`mapSsrfError` in cast/scribe) work unchanged.
 *
 * For IP-literal URLs no dispatcher is needed, but redirects still pass
 * through the same validation loop.
 *
 * Replaying the full validated set (not just `addresses[0]`) preserves Node's
 * happy-eyeballs fallback across the answers — a host whose first address is an
 * unroutable family still connects via the others — while keeping the rebind
 * window closed, since every replayed address was already denylist-checked.
 *
 * Pass `opts.baseFetch` to wrap an instrumented fetch (e.g. scribe's
 * `ctx.fetch` from `createInstrumentedFetch`) — `dvm.fetch` spans flow
 * through because `init.dispatcher` is forwarded to the underlying
 * `globalThis.fetch` unchanged.
 */
export async function createPinnedFetch(url: string, opts?: SSRFGuardOpts): Promise<PinnedFetch> {
  const validated = await resolveAndValidate(url, opts);
  const baseFetch = opts?.baseFetch ?? fetch;
  const initialUrl = new URL(url);
  const agents: Agent[] = [];
  const targets = new Map<string, PinnedTarget>();

  const createTarget = (next: ValidatedHost): PinnedTarget => {
    if (next.kind === "literal") return {};
    const agent = new Agent({
      connect: { lookup: buildPinnedLookup(next.addresses) },
    });
    agents.push(agent);
    return { agent };
  };

  targets.set(initialUrl.origin, createTarget(validated));

  const targetFor = async (requestUrl: string): Promise<PinnedTarget> => {
    const parsed = new URL(requestUrl);
    const existing = targets.get(parsed.origin);
    if (existing) return existing;

    const target = createTarget(await resolveAndValidate(parsed.href, opts));
    targets.set(parsed.origin, target);
    return target;
  };

  const pinnedFetch: typeof fetch = async (input, init) => {
    let request = new Request(input, init);
    let redirects = 0;

    try {
      for (;;) {
        const target = await targetFor(request.url);
        const response = await fetchPinnedHop(request, target, baseFetch);

        if (!isRedirect(response.status) || request.redirect === "manual") return response;

        const location = response.headers.get("location");
        if (location === null) return response;

        await discardResponse(response);
        if (request.redirect === "error") {
          throw new TypeError("fetch failed: redirect mode is set to error");
        }
        if (redirects >= MAX_PINNED_REDIRECTS) {
          throw new TypeError("fetch failed: maximum redirect count exceeded");
        }

        request = requestForRedirect(request, new URL(location, request.url), response.status);
        redirects += 1;
        opts?.onRedirectFollowed?.();
      }
    } catch (error) {
      await request.body?.cancel(error).catch(() => undefined);
      throw error;
    }
  };

  return {
    fetch: pinnedFetch,
    address: validated.address,
    family: validated.family,
    close: async () => {
      await Promise.all(agents.map((agent) => agent.close()));
    },
  };
}

interface PinnedTarget {
  agent?: Agent;
}

async function fetchPinnedHop(
  request: Request,
  target: PinnedTarget,
  baseFetch: typeof fetch
): Promise<Response> {
  if (!request.body) {
    return baseFetch(request, (target.agent
      ? { redirect: "manual", dispatcher: target.agent }
      : { redirect: "manual" }) as RequestInit);
  }

  const body = request.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false;
  let dispatched = false;
  const upload = Readable.from((async function* () {
    if (stopped) return;
    reader = body.getReader();
    try {
      while (!stopped) {
        const next = await reader.read();
        if (next.done || stopped) return;
        yield next.value;
      }
    } finally {
      reader.releaseLock();
      reader = undefined;
    }
  })(), { objectMode: false, highWaterMark: 64 * 1024 });

  const stop = async (reason?: unknown): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await (reader ? reader.cancel(reason) : body.cancel(reason)).catch(() => undefined);
  };
  const onAbort = (): void => { void stop(request.signal.reason); };
  request.signal.addEventListener("abort", onAbort, { once: true });

  // Native fetch tees bodies even in manual redirect mode. Give it an empty
  // body for response handling and instrumentation, and send the actual body
  // once through its pinned dispatcher instead of creating an unread replay.
  const dispatcher: Pick<Dispatcher, "dispatch"> = {
    dispatch(options, handler) {
      if (dispatched) throw new TypeError("fetch failed: cannot safely replay a request body");
      dispatched = true;
      return (target.agent ?? getGlobalDispatcher()).dispatch({
        ...options,
        body: upload,
      }, handler);
    },
  };

  try {
    return await baseFetch(request, {
      redirect: "manual",
      // A stream also prevents native automatic body replay (e.g. on HTTP 421).
      body: new ReadableStream({ start(controller) { controller.close(); } }),
      duplex: "half",
      // Node's keepalive is a no-op, but rejects streaming request envelopes.
      keepalive: false,
      dispatcher,
    } as RequestInit);
  } finally {
    request.signal.removeEventListener("abort", onAbort);
    await stop();
  }
}

const MAX_PINNED_REDIRECTS = 20;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Apply Fetch's redirect method rules to the GET/HEAD requests this pinned
 * transport serves. A body-bearing 307/308 cannot be safely replayed after it
 * has been sent, so fail closed rather than letting a redirect bypass pinning.
 */
function requestForRedirect(request: Request, target: URL, status: number): Request {
  const headers = new Headers(request.headers);
  if (new URL(request.url).origin !== target.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
    headers.delete("host");
  }

  const method = request.method.toUpperCase();
  const switchToGet =
    (status === 303 && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST");
  if (switchToGet) {
    headers.delete("content-length");
    headers.delete("content-type");
    return redirectRequest(target, request, headers, "GET");
  }
  if (method !== "GET" && method !== "HEAD") {
    throw new TypeError("fetch failed: cannot safely replay a request body across this redirect");
  }
  return redirectRequest(target, request, headers, method);
}

function redirectRequest(target: URL, request: Request, headers: Headers, method: string): Request {
  return new Request(target, {
    method,
    headers,
    signal: request.signal,
    redirect: request.redirect,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  });
}

/**
 * Build the undici `connect.lookup` for a pinned fetch over a set of
 * already-validated addresses.
 *
 * Node's `net.connect` runs with `autoSelectFamily: true` by default (Node
 * 18.13+) — it calls `lookup` with `{ all: true }` and requires the ARRAY
 * callback form `cb(null, [{ address, family }])`. The legacy single-address
 * form `cb(null, address, family)` makes Node read an `undefined` address
 * under autoSelectFamily and throw `ERR_INVALID_IP_ADDRESS`, which surfaced as
 * `upstream_network` on every pinned HEAD/GET.
 *
 * Returning the full pre-validated set (rather than only `addresses[0]`) keeps
 * the DNS-rebind window closed — no re-resolution happens at connect time, and
 * every address here was already denylist-checked — while preserving
 * fallback across families when the first address is unroutable.
 */
export function buildPinnedLookup(
  addresses: { address: string; family: number }[]
): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, cb: unknown): void => {
    if (options.all === false) {
      const first = addresses[0] as { address: string; family: number };
      (cb as (err: Error | null, address: string, family: number) => void)(
        null,
        first.address,
        first.family
      );
    } else {
      (cb as (err: Error | null, result: { address: string; family: number }[]) => void)(
        null,
        addresses
      );
    }
  }) as unknown as LookupFunction;
}

type ValidatedHost =
  | { kind: "literal"; address: string; family: number }
  | {
      kind: "resolved";
      address: string;
      family: number;
      /** Every validated address from the single resolution, primary first. */
      addresses: { address: string; family: number }[];
    };

async function resolveAndValidate(
  url: string,
  opts: SSRFGuardOpts | undefined
): Promise<ValidatedHost> {
  const resolver = opts?.resolver ?? defaultResolver;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SSRFError("invalid_url", `url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new SSRFError("insecure_scheme", `url must be https; got ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "") {
    throw new SSRFError("invalid_url", "url has no host");
  }

  if (HOSTNAME_DENYLIST_EXACT.has(host) || matchesExtraExact(host, opts?.extraHostnamesExact)) {
    throw new SSRFError("private_address", `url host "${host}" is on the SSRF denylist`);
  }
  for (const suffix of HOSTNAME_DENYLIST_SUFFIX) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) {
      throw new SSRFError(
        "private_address",
        `url host "${host}" matches denied suffix "${suffix}"`
      );
    }
  }
  if (opts?.extraHostnameSuffixes) {
    for (const suffix of opts.extraHostnameSuffixes) {
      const s = suffix.toLowerCase();
      if (host === s.slice(1) || host.endsWith(s)) {
        throw new SSRFError("private_address", `url host "${host}" matches denied suffix "${s}"`);
      }
    }
  }

  const stripped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIPv4(stripped) || isIPv6(stripped)) {
    if (isUnsafeAddress(stripped, opts)) {
      throw new SSRFError(
        "private_address",
        `url host "${stripped}" is in a blocked address range`
      );
    }
    return { kind: "literal", address: stripped, family: isIPv4(stripped) ? 4 : 6 };
  }

  let addresses: { address: string; family: number }[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    throw new SSRFError(
      "dns_failed",
      `url host "${host}" failed DNS resolution: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (addresses.length === 0) {
    throw new SSRFError("dns_failed", `url host "${host}" resolved to no addresses`);
  }
  for (const { address } of addresses) {
    if (isUnsafeAddress(address, opts)) {
      throw new SSRFError(
        "private_address",
        `url host "${host}" resolves to blocked address "${address}"`
      );
    }
  }
  const validated = addresses.map((a) => ({ address: a.address, family: a.family }));
  const first = validated[0] as { address: string; family: number };
  return { kind: "resolved", address: first.address, family: first.family, addresses: validated };
}

const HOSTNAME_DENYLIST_EXACT = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);

const HOSTNAME_DENYLIST_SUFFIX = [".internal", ".local", ".localhost", ".lan"];

async function defaultResolver(host: string): Promise<{ address: string; family: number }[]> {
  return lookup(host, { all: true });
}

function matchesExtraExact(host: string, extras: Iterable<string> | undefined): boolean {
  if (!extras) return false;
  for (const entry of extras) {
    if (entry.toLowerCase() === host) return true;
  }
  return false;
}

function isUnsafeAddress(address: string, opts: SSRFGuardOpts | undefined): boolean {
  if (isIPv4(address)) {
    if (isUnsafeIPv4(address)) return true;
    return opts?.extraUnsafeIPv4?.(address) === true;
  }
  if (isIPv6(address)) {
    if (isUnsafeIPv6(address)) return true;
    return opts?.extraUnsafeIPv6?.(address) === true;
  }
  return true;
}

function isUnsafeIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 10.0.0.0/8 — RFC 1918 private
  if (a === 10) return true;
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (incl. AWS/GCP metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — RFC 1918 private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 — IETF protocol assignments (RFC 6890); 192.0.2.0/24 — TEST-NET-1 (RFC 5737).
  // The rest of 192.0.0.0/16 (e.g. 192.0.66.0/24, used by Akamai/NASA) is publicly routable.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // 192.168.0.0/16 — RFC 1918 private
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 — benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved
  if (a >= 240) return true;
  return false;
}

function isUnsafeIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  // ::1 — loopback
  if (lower === "::1") return true;
  // :: — unspecified
  if (lower === "::") return true;
  // fe80::/10 — link-local
  if (
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  // fc00::/7 — unique local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // ::ffff:0:0/96 — IPv4-mapped. Node's URL parser canonicalises the dotted
  // form (`::ffff:10.0.0.1`) to compressed hex (`::ffff:a00:1`), so we
  // handle both shapes.
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    if (isIPv4(tail)) return isUnsafeIPv4(tail);
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (m) {
      const high = parseInt(m[1], 16);
      const low = parseInt(m[2], 16);
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const c = (low >> 8) & 0xff;
      const d = low & 0xff;
      return isUnsafeIPv4(`${a.toString()}.${b.toString()}.${c.toString()}.${d.toString()}`);
    }
  }
  // ff00::/8 — multicast
  if (lower.startsWith("ff")) return true;
  return false;
}
