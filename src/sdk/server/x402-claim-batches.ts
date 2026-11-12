import type { Channel, ClaimOptions, ClaimResult } from "@x402/evm/batch-settlement/server";

interface ClaimManager {
  claim(opts?: ClaimOptions): Promise<ClaimResult[]>;
}

/** Keep each confirmed batch's accounting ahead of the next external submission. */
export function withX402ClaimBatches<M extends ClaimManager>(manager: M): M {
  const claim = async (opts: ClaimOptions = {}): Promise<ClaimResult[]> => {
    const size = opts.maxClaimsPerBatch ?? 100;
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error("x402 maxClaimsPerBatch must be a positive safe integer");
    }
    let targets: Channel[] | undefined;
    let offset = 0;
    const results: ClaimResult[] = [];
    do {
      const batch = await manager.claim({
        ...opts,
        maxClaimsPerBatch: size,
        selectClaimChannels: async (channels, context) => {
          // Preserve upstream's single selection snapshot and its earned ceilings.
          targets ??= opts.selectClaimChannels ? await opts.selectClaimChannels(channels, context) : channels;
          const selected = targets.slice(offset, offset + size);
          offset += size;
          return selected;
        },
      });
      results.push(...batch);
    } while (targets && offset < targets.length);
    return results;
  };
  return new Proxy(manager, {
    get(target, property, receiver) {
      if (property === "claim") return claim;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
