import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { withSdkInitLock } from "../init-lock";

function fakePool() {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client) } as unknown as Pool, client };
}

describe("SDK initialization lock on one pool", () => {
  it("runs independent callbacks one at a time while sharing the advisory lock", async () => {
    const { pool, client } = fakePool();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const events: string[] = [];

    const first = withSdkInitLock(pool, async () => {
      events.push("first start");
      firstStarted();
      await firstGate;
      events.push("first end");
    });
    await started;
    const second = withSdkInitLock(pool, async () => { events.push("second"); });
    await Promise.resolve();
    expect(events).toEqual(["first start"]);
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(["first start", "first end", "second"]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("permits nested initialization and continues the queue after a callback fails", async () => {
    const { pool, client } = fakePool();
    const events: string[] = [];
    const first = withSdkInitLock(pool, async () => {
      await withSdkInitLock(pool, async () => { events.push("nested"); });
      throw new Error("init failed");
    });
    const second = withSdkInitLock(pool, async () => { events.push("follower"); });

    await expect(first).rejects.toThrow("init failed");
    await expect(second).resolves.toBeUndefined();
    expect(events).toEqual(["nested", "follower"]);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
