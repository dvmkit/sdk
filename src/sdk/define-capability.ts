import type { CapabilityConfig, ZodLike } from "./types";

/**
 * Infer each capability's input, state, and quote data before adding it to a capabilities map.
 * Use one call per map entry; schema transforms determine the parsed input and quote-data types.
 */
export function defineCapability<
  State = Record<string, unknown>,
  InputSchema extends ZodLike | undefined = undefined,
  QuoteData = Record<string, unknown>,
>(config: CapabilityConfig<State, InputSchema, QuoteData>): NoInfer<CapabilityConfig<State, InputSchema, QuoteData>> {
  // Prevent an enclosing heterogeneous map from overriding local schema inference.
  return config;
}
