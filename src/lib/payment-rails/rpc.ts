export type RpcSource = "override" | "bundled";

/**
 * A resolved RPC URL and the source that supplied it.
 *
 * The bundled endpoint is optional because viem does not provide one for
 * every chain x402 can be configured with.
 */
export type RpcResolution =
  | { url: string; source: "override" }
  | { url: string | undefined; source: "bundled" };

/** Viem HTTP transport options carrying an override endpoint's in-memory authentication headers. */
export interface RpcHttpTransportOptions {
  fetchOptions: { headers: Record<string, string> };
}

/**
 * Resolve an environment RPC override, treating empty and whitespace-only
 * values as unset.
 */
export function resolveRpcOverride(
  envValue: string | undefined,
  bundled: string
): {
  url: string;
  source: RpcSource;
};
export function resolveRpcOverride(envValue: string | undefined, bundled?: string): RpcResolution;
export function resolveRpcOverride(envValue: string | undefined, bundled?: string): RpcResolution {
  const override = envValue?.trim() ?? "";
  return override.length > 0
    ? { url: override, source: "override" }
    : { url: bundled, source: "bundled" };
}

/** Parse explicit JSON RPC headers without applying them to bundled public endpoints. */
export function resolveRpcHttpTransportOptions(
  source: RpcSource,
  envValue: string | undefined
): RpcHttpTransportOptions | undefined {
  if (source !== "override" || !envValue?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch {
    throw new Error("RPC headers must be a JSON object of non-empty string values.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("RPC headers must be a JSON object of non-empty string values.");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      typeof value !== "string" ||
      value.length === 0 ||
      /[\r\n]/.test(value)
    )
      throw new Error("RPC headers must be a JSON object of non-empty string values.");
    headers[name] = value;
  }
  if (Object.keys(headers).length === 0)
    throw new Error("RPC headers must be a JSON object of non-empty string values.");
  return { fetchOptions: { headers } };
}
