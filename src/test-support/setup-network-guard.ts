/** Block external fetch and Node HTTP(S), allowing loopback and enabled testnet
 * tier hosts from network-guard-policy.ts. Typed guard refusals must not become
 * silent outage skips. Load before setup-fx-mock so canned FX responses win.
 * Wrap both request and get; other setup files may replace fetch afterwards. */

import { createRequire } from "node:module";

import {
  allowedTestnetHosts,
  NetworkGuardBlockedError,
} from "./network-guard-policy";

/**
 * The testnet hostnames this run opens, resolved once at setup — the env can't
 * change between here and the test file. Exported so a test can assert the guard
 * reads the policy, rather than re-deriving the same answer on both sides.
 */
export const ALLOWED_TESTNET_HOSTS: ReadonlySet<string> = allowedTestnetHosts(process.env);

/**
 * The guard's own allow decision, exported so it can be exercised against a
 * synthetic host set on any box — a run with no tier enabled would otherwise
 * have no way to catch this dropping its allowlist consult.
 */
export function isNetworkGuardAllowed(
  url: string,
  allowedTestnetHostnames: ReadonlySet<string> = ALLOWED_TESTNET_HOSTS
): boolean {
  try {
    const { hostname } = new URL(url);
    return LOOPBACK_HOSTNAMES.has(hostname) || allowedTestnetHostnames.has(hostname);
  } catch {
    // Unparseable/relative input — let the real fetch surface its own error
    // rather than mask it behind a misleading "network blocked" message.
    return true;
  }
}

/**
 * The URL a `node:http` / `node:https` call would reach, resolved from either
 * calling form — `request(url[, options][, cb])` or `request(options[, cb])`,
 * with `options` overriding the URL exactly as Node merges them.
 *
 * `null` means "this names no network host": a `socketPath` (unix socket), or a
 * shape/URL we can't parse. The guard lets those through for the same reason the
 * `fetch` half does — Node's own error is more useful than a misleading
 * "network blocked".
 */
export function nodeRequestUrl(
  args: readonly unknown[],
  defaultProtocol: "http:" | "https:"
): string | null {
  const [first, second] = args;
  let base: URL | null = null;
  let options: NodeRequestOptions | undefined;

  if (typeof first === "string" || first instanceof URL) {
    try {
      base = new URL(first.toString());
    } catch {
      return null;
    }
    options = asRequestOptions(second);
  } else {
    options = asRequestOptions(first);
    if (options === undefined) return null;
  }

  if (nonEmpty(options?.socketPath)) return null;

  const protocol = nonEmpty(options?.protocol) ?? base?.protocol ?? defaultProtocol;
  const host = normalizeHost(
    nonEmpty(options?.hostname) ?? nonEmpty(options?.host) ?? base?.hostname ?? "localhost"
  );
  const port = options?.port != null ? String(options.port) : (base?.port ?? "");
  const path = nonEmpty(options?.path) ?? (base ? `${base.pathname}${base.search}` : "/");

  try {
    return new URL(
      `${protocol}//${host}${port ? `:${port}` : ""}${path.startsWith("/") ? path : `/${path}`}`
    ).href;
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type NodeHttpModule = Record<"request" | "get", (...args: unknown[]) => unknown>;

/** The subset of Node's request options that decides where a request goes. */
interface NodeRequestOptions {
  protocol?: string | null;
  host?: string | null;
  hostname?: string | null;
  port?: number | string | null;
  path?: string | null;
  socketPath?: string | null;
}

function asRequestOptions(value: unknown): NodeRequestOptions | undefined {
  if (value === null || typeof value !== "object" || value instanceof URL) return undefined;
  return value as NodeRequestOptions;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `options.host` may carry a `:port`; `options.hostname` may be a bare IPv6
 * literal. Both have to come out as something `new URL()` accepts and as the
 * spelling {@link LOOPBACK_HOSTNAMES} uses.
 */
function normalizeHost(host: string): string {
  if (host.startsWith("[")) return host;
  const colon = host.lastIndexOf(":");
  if (colon === -1) return host;
  const head = host.slice(0, colon);
  if (head.includes(":")) return `[${host}]`; // bare IPv6 literal
  return /^\d+$/.test(host.slice(colon + 1)) ? head : host;
}

const innerFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async function fetchWithNetworkGuard(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (isNetworkGuardAllowed(url)) {
    return await innerFetch(input, init);
  }
  throw new NetworkGuardBlockedError(
    url,
    `Blocked unstubbed outbound fetch to ${url} in a unit test. ` +
      `Unit tests must not reach a real network host — mock the client module ` +
      `that wraps this call (e.g. vi.mock("../../lib/platform-client")) or stub ` +
      `fetch directly with vi.stubGlobal("fetch", ...). If this is a live-network ` +
      `test tier that is supposed to reach this host, declare the tier and its ` +
      `gating env vars in src/__tests__/network-guard-policy.ts.`
  );
} as typeof fetch;

/**
 * Marks a builtin as already wrapped. The patch is process-global while this
 * file is per-test-file, so it has to be re-entrant even though vitest's forks
 * pool isolates each file today.
 */
const NODE_HTTP_GUARD_INSTALLED = Symbol.for("dvmkit.network-guard.node-http");

function installNodeHttpGuard(mod: NodeHttpModule, defaultProtocol: "http:" | "https:"): void {
  const marker = mod as unknown as Record<symbol, boolean | undefined>;
  if (marker[NODE_HTTP_GUARD_INSTALLED] === true) return;
  marker[NODE_HTTP_GUARD_INSTALLED] = true;

  const scheme = defaultProtocol.slice(0, -1);
  // `get` too, not just `request`: Node's `get` calls the module-local `request`
  // binding rather than the exported property, so wrapping one never covers the
  // other.
  for (const name of ["request", "get"] as const) {
    const inner = mod[name];
    mod[name] = function requestWithNetworkGuard(this: unknown, ...args: unknown[]): unknown {
      const url = nodeRequestUrl(args, defaultProtocol);
      if (url !== null && !isNetworkGuardAllowed(url)) {
        throw new NetworkGuardBlockedError(
          url,
          `Blocked unstubbed outbound node:${scheme} request to ${url} in a unit test. ` +
            `Unit tests must not reach a real network host — a client library that ships ` +
            `its own transport (stripe's NodeHttpClient, the AWS SDK, ws) never touches ` +
            `globalThis.fetch, so stubbing fetch does not cover it. Inject a stub client ` +
            `instead (e.g. StripeService's 5th constructor arg), or vi.mock("node:${scheme}"). ` +
            `If this is a live-network test tier that is supposed to reach this host, declare ` +
            `the tier and its gating env vars in src/__tests__/network-guard-policy.ts.`
        );
      }
      return inner.apply(this, args);
    };
  }
}

// `createRequire` rather than `import * as http`: an ES module namespace object
// is frozen and would not take the patch, while the CJS `module.exports` object
// this returns is the very one `require("https")` hands stripe et al.
const nodeRequire = createRequire(import.meta.url);
installNodeHttpGuard(nodeRequire("node:http") as NodeHttpModule, "http:");
installNodeHttpGuard(nodeRequire("node:https") as NodeHttpModule, "https:");
