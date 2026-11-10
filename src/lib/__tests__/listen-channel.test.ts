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
  private resolveQuery: (() => void) | null = null;
  override query(sql: string): Promise<void> {
    this.queries.push(sql);
    if (!sql.startsWith("LISTEN ")) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.rejectQuery = reject;
      this.resolveQuery = resolve;
    });
  }
  finishListen(): void {
    this.resolveQuery?.();
  }
  /** Simulate an unexpected socket reset during the in-flight LISTEN: pg emits
   * 'error' on the client and rejects the active query. */
  dropSocket(err: Error): void {
    this.emit("error", err);
    this.rejectQuery?.(err);
  }
}

/** Heartbeat `SELECT 1` can be held pending, then failed or completed on demand. */
class HeartbeatClient extends FakeClient {
  hold = false;
  failWith: Error | null = null;
  private pending: { resolve: () => void; reject: (err: unknown) => void }[] = [];
  override query(sql: string): Promise<void> {
    this.queries.push(sql);
    if (sql !== "SELECT 1") return Promise.resolve();
    if (this.failWith) return Promise.reject(this.failWith);
    if (!this.hold) return Promise.resolve();
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  get heartbeats(): number {
    return this.queries.filter((q) => q === "SELECT 1").length;
  }
  settleHeartbeat(err?: Error): void {
    const next = this.pending.shift();
    if (err) next?.reject(err);
    else next?.resolve();
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
    const restored: number[] = [];
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase",
      backoffMs: [10],
      onNotification: (payload) => seen.push(payload),
      onLost: (err) => err && lost.push(err),
      onRestored: (downtimeMs: number) => restored.push(downtimeMs),
    });
    await ch.start();
    expect(restored).toEqual([]);

    first.emit("error", new Error("conn reset"));
    first.emit("end");
    expect(lost.map((e) => e.message)).toEqual(["conn reset"]);
    expect(first.released).toBe(true);

    await vi.advanceTimersByTimeAsync(20);
    expect(pool.connects).toBe(2);
    expect(second.queries).toEqual(["LISTEN tcase"]);
    expect(restored).toEqual([10]);

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
    const restored: number[] = [];
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase",
      backoffMs: [10, 20, 30],
      onNotification: () => undefined,
      onReconnectFailed: (attempt, err) => fails.push({ attempt, err }),
      onRestored: (downtimeMs: number) => restored.push(downtimeMs),
    });
    await ch.start();
    expect(fails).toHaveLength(1);
    expect(fails[0].attempt).toBe(0);

    await vi.advanceTimersByTimeAsync(15);
    expect(fails).toHaveLength(2);
    expect(fails[1].attempt).toBe(1);
    expect(restored).toEqual([]);

    await vi.advanceTimersByTimeAsync(35);
    expect(pool.connects).toBe(3);
    expect(recover.queries).toEqual(["LISTEN tcase"]);
    expect(restored).toEqual([30]);

    await ch.stop();
    expect(recover.released).toBe(true);
  });

  it("stop() cancels pending reconnects after connection loss", async () => {
    const pool = new FakePool();
    const client = new FakeClient();
    pool.enqueue(client);
    const restored = vi.fn();
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase",
      backoffMs: [10],
      onNotification: () => undefined,
      onRestored: restored,
    });
    await ch.start();

    client.emit("error", new Error("transient"));
    await ch.stop();

    pool.enqueue(new FakeClient());
    await vi.advanceTimersByTimeAsync(50);
    expect(pool.connects).toBe(1);
    expect(restored).not.toHaveBeenCalled();
  });

  it.each([false, true])("restores only after LISTEN succeeds, unless stopped (%s)", async (stop) => {
    const pool = new FakePool();
    const first = new FakeClient();
    const stalled = new StallingClient();
    pool.enqueue(first);
    pool.enqueue(stalled);
    const restored = vi.fn();
    const ch = new ListenChannel(asPool(pool), {
      channel: "tcase", backoffMs: [10],
      onNotification: () => undefined, onRestored: restored,
    });
    await ch.start();
    first.emit("end");
    await vi.advanceTimersByTimeAsync(30);
    expect(stalled.queries).toEqual(["LISTEN tcase"]);
    expect(restored).not.toHaveBeenCalled();

    if (stop) await ch.stop();
    stalled.finishListen();
    await vi.advanceTimersByTimeAsync(0);
    if (stop) {
      expect(restored).not.toHaveBeenCalled();
      expect(stalled.released).toBe(true);
    } else {
      expect(restored).toHaveBeenCalledExactlyOnceWith(30);
    }
    await ch.stop();
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
  describe("heartbeat", () => {
    const MIN = 60_000;
    const opts = (extra: object = {}) => ({
      channel: "tcase",
      backoffMs: [10],
      onNotification: () => undefined,
      ...extra,
    });

    it("sends SELECT 1 on the LISTEN client every five minutes by default", async () => {
      const pool = new FakePool();
      const client = new HeartbeatClient();
      pool.enqueue(client);
      const ch = new ListenChannel(asPool(pool), opts({ heartbeat: true }));
      await ch.start();

      await vi.advanceTimersByTimeAsync(5 * MIN - 1);
      expect(client.queries).toEqual(["LISTEN tcase"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.queries).toEqual(["LISTEN tcase", "SELECT 1"]);
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(client.heartbeats).toBe(2);
      await ch.stop();
    });

    it("honors an interval override", async () => {
      const pool = new FakePool();
      const client = new HeartbeatClient();
      pool.enqueue(client);
      const ch = new ListenChannel(asPool(pool), opts({ heartbeat: { intervalMs: 1000 } }));
      await ch.start();
      await vi.advanceTimersByTimeAsync(2500);
      expect(client.heartbeats).toBe(2);
      await ch.stop();
    });

    it.each([undefined, false])("sends no heartbeat when not opted in (%s)", async (heartbeat) => {
      const pool = new FakePool();
      const client = new HeartbeatClient();
      pool.enqueue(client);
      const ch = new ListenChannel(asPool(pool), opts({ heartbeat }));
      await ch.start();
      await vi.advanceTimersByTimeAsync(60 * MIN);
      expect(client.queries).toEqual(["LISTEN tcase"]);
      await ch.stop();
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects interval %s", (intervalMs) => {
      expect(
        () => new ListenChannel(asPool(new FakePool()), opts({ heartbeat: { intervalMs } }))
      ).toThrow(RangeError);
    });

    it("routes a rejected heartbeat through loss and reconnect without duplicating recovery", async () => {
      const pool = new FakePool();
      const first = new HeartbeatClient();
      const second = new HeartbeatClient();
      pool.enqueue(first);
      pool.enqueue(second);
      first.failWith = new Error("heartbeat refused");
      const lost: (Error | undefined)[] = [];
      const restored: number[] = [];
      const ch = new ListenChannel(
        asPool(pool),
        opts({
          heartbeat: { intervalMs: 100 },
          onLost: (err?: Error) => lost.push(err),
          onRestored: (ms: number) => restored.push(ms),
        })
      );
      await ch.start();

      await vi.advanceTimersByTimeAsync(100);
      expect(lost.map((e) => e?.message)).toEqual(["heartbeat refused"]);
      expect(first.released).toBe(true);
      expect((first.releaseErr as Error).message).toBe("heartbeat refused");

      // The socket's own error/end for the same interruption schedule nothing more.
      first.emit("error", new Error("socket reset"));
      first.emit("end");
      await vi.advanceTimersByTimeAsync(10);
      expect(lost).toHaveLength(1);
      expect(pool.connects).toBe(2);
      expect(second.queries).toEqual(["LISTEN tcase"]);
      expect(restored).toEqual([10]);

      // The replacement's heartbeat restarts only after its LISTEN succeeded.
      await vi.advanceTimersByTimeAsync(100);
      expect(second.heartbeats).toBe(1);
      expect(first.heartbeats).toBe(1);
      await ch.stop();
    });

    it("clears the timer on loss and starts the replacement's only after LISTEN succeeds", async () => {
      const pool = new FakePool();
      const first = new HeartbeatClient();
      const stalled = new StallingClient();
      pool.enqueue(first);
      pool.enqueue(stalled);
      const ch = new ListenChannel(asPool(pool), opts({ heartbeat: { intervalMs: 100 } }));
      await ch.start();

      await vi.advanceTimersByTimeAsync(50);
      first.emit("end");
      await vi.advanceTimersByTimeAsync(10);
      expect(stalled.queries).toEqual(["LISTEN tcase"]);

      await vi.advanceTimersByTimeAsync(500);
      expect(first.heartbeats).toBe(0);
      expect(stalled.queries).toEqual(["LISTEN tcase"]);

      stalled.finishListen();
      await vi.advanceTimersByTimeAsync(99);
      expect(stalled.queries).toEqual(["LISTEN tcase"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(stalled.queries).toEqual(["LISTEN tcase", "SELECT 1"]);
      await ch.stop();
    });

    it("stop() clears the pending heartbeat", async () => {
      const pool = new FakePool();
      const client = new HeartbeatClient();
      pool.enqueue(client);
      const ch = new ListenChannel(asPool(pool), opts({ heartbeat: { intervalMs: 100 } }));
      await ch.start();
      await vi.advanceTimersByTimeAsync(50);
      await ch.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(client.queries).toEqual(["LISTEN tcase", "UNLISTEN *"]);
    });

    it("never overlaps heartbeat queries", async () => {
      const pool = new FakePool();
      const client = new HeartbeatClient();
      client.hold = true;
      pool.enqueue(client);
      const ch = new ListenChannel(asPool(pool), opts({ heartbeat: { intervalMs: 100 } }));
      await ch.start();

      await vi.advanceTimersByTimeAsync(1000);
      expect(client.heartbeats).toBe(1);

      client.settleHeartbeat();
      await vi.advanceTimersByTimeAsync(99);
      expect(client.heartbeats).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.heartbeats).toBe(2);
      await ch.stop();
    });

    it("ignores a late heartbeat failure from a replaced client", async () => {
      const pool = new FakePool();
      const first = new HeartbeatClient();
      const second = new HeartbeatClient();
      first.hold = true;
      pool.enqueue(first);
      pool.enqueue(second);
      const lost = vi.fn();
      const ch = new ListenChannel(
        asPool(pool),
        opts({ heartbeat: { intervalMs: 100 }, onLost: lost })
      );
      await ch.start();

      await vi.advanceTimersByTimeAsync(100);
      expect(first.heartbeats).toBe(1);
      first.emit("end");
      await vi.advanceTimersByTimeAsync(10);
      expect(pool.connects).toBe(2);
      expect(lost).toHaveBeenCalledOnce();

      first.settleHeartbeat(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(lost).toHaveBeenCalledOnce();
      expect(second.released).toBe(false);
      expect(pool.connects).toBe(2);

      await vi.advanceTimersByTimeAsync(100);
      expect(second.heartbeats).toBe(1);
      await ch.stop();
    });

    it("ignores a pending heartbeat failure that lands after stop and restart", async () => {
      const pool = new FakePool();
      const first = new HeartbeatClient();
      const second = new HeartbeatClient();
      first.hold = true;
      pool.enqueue(first);
      pool.enqueue(second);
      const lost = vi.fn();
      const ch = new ListenChannel(
        asPool(pool),
        opts({ heartbeat: { intervalMs: 100 }, onLost: lost })
      );
      await ch.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(first.heartbeats).toBe(1);

      await ch.stop();
      await ch.start();
      expect(pool.connects).toBe(2);

      // The first client's heartbeat was still pending across stop() and start().
      first.settleHeartbeat(new Error("late failure after restart"));
      await vi.advanceTimersByTimeAsync(0);
      expect(lost).not.toHaveBeenCalled();
      expect(first.released).toBe(true);
      expect(second.released).toBe(false);
      expect(pool.connects).toBe(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(second.heartbeats).toBe(1);
      expect(lost).not.toHaveBeenCalled();
      expect(second.released).toBe(false);
      await ch.stop();
    });
  });
});
