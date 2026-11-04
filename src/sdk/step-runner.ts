import { AsyncLocalStorage } from "node:async_hooks";

import type { StepCache, StepRecord } from "./step-cache";
import type { JobCost, SDKJobContext } from "./types";

/**
 * The cost declarations captured by each active `ctx.step()` miss
 *
 * Every declaration is copied into every frame in the current async branch.
 * That makes an inner miss part of both its own record and its outer miss's
 * record; replaying an inner hit while an outer miss is active does the same.
 * Sibling steps only see the frames they inherited, so a fanned-out batch does
 * not leak one step's costs into another step's record. The owner also keeps a
 * different job started from the same async call tree from inheriting them.
 */
const stepCostScope = new AsyncLocalStorage<{ owner: object; frames: JobCost[][] }>();

export function createStepRunner(
  cache: StepCache,
  declareCost: (cost: JobCost) => void,
  onStep?: (record: StepRecord) => Promise<void>
): { step: SDKJobContext["step"]; recordCost(cost: JobCost): void } {
  const owner = {};
  const writes = new Map<string, Promise<void>>();
  return {
    recordCost(cost) {
      const scope = stepCostScope.getStore();
      if (scope?.owner === owner) {
        for (const frame of scope.frames) frame.push(cost);
      }
    },
    async step<T>(id: string, fn: () => Promise<T>): Promise<T> {
      if (cache.has(id)) {
        await writes.get(id);
        const record = cache.getRecord(id);
        for (const declared of record.costs ?? []) declareCost(declared);
        return record.value as T;
      }
      const costs: JobCost[] = [];
      const scope = stepCostScope.getStore();
      const parentFrames = scope?.owner === owner ? scope.frames : [];
      const result = await stepCostScope.run(
        { owner, frames: [...parentFrames, costs] },
        fn
      );
      cache.set(id, result, costs);
      if (onStep) {
        const persistence = onStep(cache.getRecord(id));
        writes.set(id, persistence);
        try {
          await persistence;
        } finally {
          writes.delete(id);
        }
      }
      return result;
    },
  };
}
