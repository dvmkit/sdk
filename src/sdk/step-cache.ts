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
 * Completed records are persisted before a step returns when the store supports
 * per-step writes. serialize() also includes them in yield and terminal snapshots;
 * deserialize() restores them for replay without repeating completed bodies.
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
