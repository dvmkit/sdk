import type { JobCost } from "./types";

export interface StepRecord {
  /** Step identifier (must be unique within a job). */
  id: string;

  value: unknown;
  /** Cost declarations made while the step body ran, replayed on cache hits. */
  costs?: JobCost[];
}

/**
 * In-memory cache of step results for durable replay.
 *
 * serialize() is called at yield points and terminal states to batch-persist
 * step results, and deserialize() restores them on re-invocation — enabling
 * handlers to replay deterministically through cached steps and resume from
 * where they left off.
 */
export class StepCache {
  private cache = new Map<string, StepRecord>();

  has(id: string): boolean {
    return this.cache.has(id);
  }

  get(id: string): unknown {
    return this.getRecord(id).value;
  }

  getRecord(id: string): StepRecord {
    const record = this.cache.get(id);
    if (record === undefined) throw new Error(`StepCache: no cached result for step "${id}"`);
    return record;
  }

  set(id: string, value: unknown, costs?: readonly JobCost[]): void {
    this.cache.set(id, {
      id,
      value,
      ...(costs !== undefined && costs.length > 0
        ? { costs: costs.map(({ amount, currency }) => ({ amount, currency })) }
        : {}),
    });
  }

  serialize(): StepRecord[] {
    return [...this.cache.values()];
  }

  static deserialize(records: StepRecord[]): StepCache {
    const cache = new StepCache();
    for (const { id, value, costs } of records) {
      cache.set(id, value, costs);
    }
    return cache;
  }
}
