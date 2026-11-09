import { EventEmitter } from "node:events";

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "../../../lib/messages/types";
import { PostgresJobStore } from "../postgres-job-store";

class ListenClient extends EventEmitter {
  query = vi.fn(() => Promise.resolve());
  release = vi.fn();
}

describe("Postgres streaming recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("catches up each cursor and wakes notification-only jobs without another NOTIFY", async () => {
    const first = new ListenClient();
    const second = new ListenClient();
    const history: Message[] = [];
    const messageOnlyHistory: Message[] = [];
    let holdReads = false;
    let releaseReads: () => void = () => undefined;
    const pendingReads = new Promise<void>(resolve => { releaseReads = resolve; });
    const query = vi.fn(async (_sql: string, values: [string, number]) => {
      if (holdReads) await pendingReads;
      const messages = values[0] === "message-only" ? messageOnlyHistory : history;
      return { rows: messages.filter(message => message.seq > values[1]).map(data => ({ data })) };
    });
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const store = new PostgresJobStore({ query, connect } as unknown as Pool);
    const received: number[] = [];
    const resumed: number[] = [];
    const messageOnly: number[] = [];
    const sharedNotify = vi.fn();
    const notifyOnly = vi.fn();
    const removed = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await store.initStreaming();
    await store.subscribeMessages("job", 0, message => received.push(message.seq));
    await store.subscribeMessages("job", 1, message => resumed.push(message.seq));
    await store.subscribeMessages("message-only", 4, message => messageOnly.push(message.seq));
    await store.subscribeNotifications("job", sharedNotify);
    await store.subscribeNotifications("notify-only", notifyOnly);
    const unsubscribe = await store.subscribeNotifications("removed", removed);
    unsubscribe();

    try {
      first.emit("error", Object.assign(new Error("socket lost"), { code: "ECONNRESET" }));
      first.emit("end");
      holdReads = true;
      history.push(
        { seq: 1, from: "provider", type: "text", timestamp: 1, content: { text: "one" } },
        { seq: 2, from: "provider", type: "text", timestamp: 2, content: { text: "two" } },
      );
      messageOnlyHistory.push({ seq: 5, from: "provider", type: "text", timestamp: 3, content: { text: "only" } });
      expect(received).toEqual([]);
      expect(sharedNotify).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(sharedNotify).toHaveBeenCalledOnce();
      expect(notifyOnly).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(JSON.stringify({
        event: "job_messages_listen_restored", level: "info", elapsed_ms: 1000,
      }));

      // A live NOTIFY can overlap the recovery read; both use the same cursors.
      second.emit("notification", { channel: "job_messages", payload: "job" });
      releaseReads();
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toEqual([1, 2]);
      expect(resumed).toEqual([2]);
      expect(messageOnly).toEqual([5]);
    } finally {
      releaseReads();
      await store.shutdownStreaming();
    }
  });

  it.each([
    ["57P01", "57P01"],
    ["ECONNRESET", "ECONNRESET"],
    [undefined, "unknown_error"],
    ["postgres://user:secret@db.example.com/database", "unknown_error"],
    ["X".repeat(1000), "unknown_error"],
  ])("logs only approved codes on loss and failed reconnect (%s)", async (code, expected) => {
    const error = Object.assign(new Error("SENTINEL_SECRET postgres://user:secret@db.example.com/database"), { code });
    const first = new ListenClient();
    const connect = vi.fn().mockResolvedValueOnce(first).mockRejectedValue(error);
    const store = new PostgresJobStore({ connect } as unknown as Pool);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await store.initStreaming();
    try {
      first.emit("error", error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toEqual([
        { event: "job_messages_listen_lost", level: "warn", error_code: expected },
        { event: "job_messages_listen_connect_failed", level: "warn", attempt: 1, error_code: expected },
      ]);
    } finally {
      await store.shutdownStreaming();
    }
  });
});
