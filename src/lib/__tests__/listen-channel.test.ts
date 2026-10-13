import { EventEmitter } from "node:events";

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ListenChannel } from "../listen-channel";

class FakeClient extends EventEmitter {
  queries: string[] = [];
  released = false;
  releaseErr: unknown = null;
  query(sql: string): Promise<void> {
    this.queries.push(sql);
    return Promise.resolve();
  }
  release(err?: unknown): void {
    this.released = true;
    this.releaseErr = err ?? null;
  }
}

/** Hold LISTEN pending so a socket failure can precede its query response. */
class StallingClient extends FakeClient {
  private rejectQuery: ((err: unknown) => void) | null = null;
  override query(sql: string): Promise<void> {
    this.queries.push(sql);
    return new Promise((_resolve, reject) => {
      this.rejectQuery = reject;
    });
  }
  /** Simulate an unexpected socket reset during the in-flight LISTEN: pg emits
   * 'error' on the client and rejects the active query. */
  dropSocket(err: Error): void {
    this.emit("error", err);
    this.rejectQuery?.(err);
  }
}

class FakePool {
  private next: (FakeClient | Error)[] = [];
  connects = 0;
  enqueue(item: FakeClient | Error): void {
    this.next.push(item);
  }
  connect(): Promise<FakeClient> {
    this.connects++;
    const item = this.next.shift();
    if (!item) return Promise.reject(new Error("no more clients queued"));
    if (item instanceof Error) return Promise.reject(item);
    return Promise.resolve(item);
  }
}

function asPool(p: FakePool): Pool {
  return p as unknown as Pool;
}

describe("ListenChannel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("LISTENs on start and forwards matching notifications", async () => {
    const pool = new FakePool();
    const client = new FakeClient();
    pool.enqueue(client);

    const seen: (string | undefined)[] = [];
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase",
      onNotification: (payload) => seen.push(payload),
    });
    await ch.start();

    expect(client.queries).toEqual(["LISTEN tcase"]);

    client.emit("notification", { channel: "tcase", payload: "abc" });
    client.emit("notification", { channel: "other", payload: "xyz" });
    expect(seen).toEqual(["abc"]);
  });

  it("reconnects after the LISTEN connection drops", async () => {
    const pool = new FakePool();
    const first = new FakeClient();
    const second = new FakeClient();
    pool.enqueue(first);
    pool.enqueue(second);

    const seen: (string | undefined)[] = [];
    const lost: Error[] = [];
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase",
      backoffMs: [10],
      onNotification: (payload) => seen.push(payload),
      onLost: (err) => err && lost.push(err),
    });
    await ch.start();

    first.emit("error", new Error("conn reset"));
    expect(lost.map((e) => e.message)).toEqual(["conn reset"]);
    expect(first.released).toBe(true);

    await vi.advanceTimersByTimeAsync(20);
    expect(pool.connects).toBe(2);
    expect(second.queries).toEqual(["LISTEN tcase"]);

    second.emit("notification", { channel: "tcase", payload: "post-reconnect" });
    expect(seen).toEqual(["post-reconnect"]);
  });

  it("backs off and surfaces reconnect failures, then succeeds on a later attempt", async () => {
    const pool = new FakePool();
    pool.enqueue(new Error("boom-1"));
    pool.enqueue(new Error("boom-2"));
    const recover = new FakeClient();
    pool.enqueue(recover);

    const fails: { attempt: number; err: unknown }[] = [];
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase",
      backoffMs: [10, 20, 30],
      onNotification: () => undefined,
      onReconnectFailed: (attempt, err) => fails.push({ attempt, err }),
    });
    await ch.start();
    expect(fails).toHaveLength(1);
    expect(fails[0].attempt).toBe(0);

    await vi.advanceTimersByTimeAsync(15);
    expect(fails).toHaveLength(2);
    expect(fails[1].attempt).toBe(1);

    await vi.advanceTimersByTimeAsync(35);
    expect(pool.connects).toBe(3);
    expect(recover.queries).toEqual(["LISTEN tcase"]);

    await ch.stop();
    expect(recover.released).toBe(true);
  });

  it("stop() cancels pending reconnects after connection loss", async () => {
    const pool = new FakePool();
    const client = new FakeClient();
    pool.enqueue(client);
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase",
      backoffMs: [10],
      onNotification: () => undefined,
    });
    await ch.start();

    client.emit("error", new Error("transient"));
    await ch.stop();

    pool.enqueue(new FakeClient());
    await vi.advanceTimersByTimeAsync(50);
    expect(pool.connects).toBe(1);
  });

  it("does not crash when the socket dies during the LISTEN query, and reconnects", async () => {
    const pool = new FakePool();
    const stalled = new StallingClient();
    const recover = new FakeClient();
    pool.enqueue(stalled);
    pool.enqueue(recover);

    const seen: (string | undefined)[] = [];
    const lost: (Error | undefined)[] = [];
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase",
      backoffMs: [10],
      onNotification: (payload) => seen.push(payload),
      onLost: (err) => lost.push(err),
    });

    // Let connect() resolve pool.connect(), attach the error handler, and reach
    // the pending LISTEN query before we drop the socket. Pre-fix the handler is
    // attached only *after* this query resolves, so the drop below emits an
    // unhandled 'error' and the .not.toThrow() assertion fails (== the crash).
    const started = ch.start();
    for (let i = 0; i < 20 && stalled.queries.length === 0; i++) {
      await Promise.resolve();
    }
    expect(stalled.queries).toEqual(["LISTEN tcase"]);

    // The socket dies mid-LISTEN. Must route to the reconnect path, not throw an
    // unhandled 'error' event (which, pre-fix, exited the process).
    expect(() => {
      stalled.dropSocket(new Error("ECONNRESET"));
    }).not.toThrow();
    await started;

    expect(stalled.released).toBe(true);
    expect(lost.map((e) => e?.message)).toEqual(["ECONNRESET"]);

    await vi.advanceTimersByTimeAsync(20);
    expect(pool.connects).toBe(2);
    expect(recover.queries).toEqual(["LISTEN tcase"]);

    recover.emit("notification", { channel: "tcase", payload: "back" });
    expect(seen).toEqual(["back"]);
  });
});
