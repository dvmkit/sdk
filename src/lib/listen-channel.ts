import type { Pool, PoolClient } from "pg";

/** Default exponential backoff schedule (ms) between reconnect attempts. */
const DEFAULT_BACKOFF_MS = [1000, 4000, 15_000, 30_000] as const;

export interface ListenChannelOpts {
  channel: string;
  /** Called for every notification on `channel`. Payload may be empty. */
  onNotification: (payload: string | undefined) => void;
  /**
   * Fired after the LISTEN connection drops, before the reconnect is scheduled.
   * Use for one-line operator notices ("LISTEN connection lost — reconnecting…").
   */
  onLost?: (err?: Error) => void;
  /**
   * Fired when a reconnect attempt fails to acquire a fresh LISTEN connection.
   * `attempt` is the failed attempt's index (0-based).
   */
  onReconnectFailed?: (attempt: number, err: unknown) => void;
  /** Override the default `[1s, 4s, 15s, 30s]` backoff schedule. Min length 1. */
  backoffMs?: readonly number[];
}

/**
 * Dedicated `LISTEN <channel>` connection with automatic reconnect.
 *
 * Holds one pool client open for the channel's lifetime. On disconnect the
 * client is released with the error and a fresh client is acquired according
 * to `backoffMs`. The signal is an optimisation, not a correctness gate —
 * callers should still have a fallback (TTL cache, periodic poll) for the
 * window during which the listen connection is down.
 *
 * Router invalidation and live span streams share these backoff/reconnect
 * semantics.
 */
export class ListenChannel {
  private client: PoolClient | null = null;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly backoffMs: readonly number[];

  constructor(
    private pool: Pool,
    private opts: ListenChannelOpts
  ) {
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /**
   * Open the LISTEN connection. Resolves once the initial connect attempt
   * has either succeeded or scheduled a retry — never rejects, so callers
   * can fire-and-forget at boot.
   */
  start(): Promise<void> {
    this.stopped = false;
    return this.connect();
  }

  /** Release the LISTEN client and cancel any pending reconnect. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.query("UNLISTEN *");
      } catch {
        // connection may already be dead
      }
      try {
        client.release();
      } catch {
        // already released or never acquired cleanly
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      this.opts.onReconnectFailed?.(this.reconnectAttempt, err);
      this.scheduleReconnect();
      return;
    }

    // A pooled client is handed back from connect() with no 'error' listener —
    // pg detaches the pool's idle-error guard on checkout — so until we attach
    // our own, an 'error' reaches Node unhandled and exits the process. That gap
    // used to span the LISTEN round-trip below, and a socket dying inside it (the
    // norm right after a Fly suspend→resume, when the snapshotted TCP connection
    // is already dead) crash-looped the whole DVM to Fly's restart cap.
    // Attach the guard synchronously, before the first post-checkout await, so a
    // drop anywhere — connect window, LISTEN round-trip, or steady state — routes
    // to the same reconnect path instead. The `lost` flag dedupes the paired
    // 'error'+'end' emits and a drop racing the LISTEN query's own rejection; the
    // `this.stopped` check lets stop() neutralise this handler (it can't null a
    // `this.client` that isn't assigned yet during the connect window).
    let lost = false;
    const onLost = (err?: Error) => {
      if (lost || this.stopped) return;
      lost = true;
      if (this.client === client) this.client = null;
      this.opts.onLost?.(err);
      try {
        client.release(err ?? new Error("listen connection lost"));
      } catch {
        // ignore — the underlying socket is gone
      }
      this.scheduleReconnect();
    };
    const onEnd = () => {
      onLost();
    };
    client.on("error", onLost);
    client.on("end", onEnd);

    try {
      await client.query(`LISTEN ${this.opts.channel}`);
    } catch (err) {
      // LISTEN failed. If the socket dropped mid-query onLost already fired and
      // scheduled the reconnect; otherwise surface it as a reconnect failure.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `lost` is flipped by the onLost closure fired from the 'error'/'end' event during the await; flow analysis can't see it
      if (!lost) {
        lost = true;
        this.opts.onReconnectFailed?.(this.reconnectAttempt, err);
        try {
          client.release(err instanceof Error ? err : new Error(String(err)));
        } catch {
          // ignore
        }
        this.scheduleReconnect();
      }
      return;
    }

    // The connection dropped during the LISTEN round-trip — onLost has already
    // scheduled the reconnect; don't resurrect the released client.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `lost` is flipped by the onLost closure fired from the 'error'/'end' event during the await; flow analysis can't see it
    if (lost) return;

    // stop() may have run while we awaited connect()/query; release and bail.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- this.stopped can flip across the awaits above
    if (this.stopped) {
      lost = true;
      try {
        await client.query("UNLISTEN *");
      } catch {
        // ignore
      }
      try {
        client.release();
      } catch {
        // ignore
      }
      return;
    }

    this.client = client;
    this.reconnectAttempt = 0;

    client.on("notification", (notification) => {
      if (notification.channel !== this.opts.channel) return;
      this.opts.onNotification(notification.payload);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const idx = Math.min(this.reconnectAttempt, this.backoffMs.length - 1);
    const delay = this.backoffMs[idx];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
