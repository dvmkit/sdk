/** Destroy keep-alive sockets as well as closing listeners, or an HTTP client
 * can reuse a pooled socket to an old server after its port is reassigned.
 * Await the close callback: Server.close returns the server, not a promise. */
import type { Server } from "node:http";

import { serve as honoServe } from "@hono/node-server";
import { afterAll, afterEach } from "vitest";

/** Anything `serve()` will take a fetch handler from — a Hono app, or a bare `{ fetch }`. */
export interface ServableApp {
  fetch: Parameters<typeof honoServe>[0]["fetch"];
}

export interface ServedApps {
  /** Serve `app` on an ephemeral port; resolves its base URL. Tracked for teardown. */
  serve(app: ServableApp): Promise<string>;
  /**
   * Track a server the caller built and listens itself — a raw `createServer`
   * stub that needs its own request listener or its `address()`.
   */
  track<T extends Server>(server: T): T;
  /**
   * Destroy every tracked server's sockets, await its close, and forget it.
   * Runs after each test on its own; call it directly when a test has to
   * retire a server mid-flight (restarting one under a different config).
   */
  closeAll(): Promise<void>;
}

/**
 * Track the servers a suite starts and tear every one of them down after each
 * test. Call at module (or `describe`) scope — it registers its own hook,
 * which is the point: a suite cannot forget the teardown, and a test that
 * starts a second server gets that one destroyed too.
 *
 * Pass `teardown: "all"` for a suite that stands one server up in `beforeAll`
 * and shares it across its tests, where a per-test teardown would retire the
 * server out from under the second test.
 *
 * Pass `teardown: "manual"` when the call site itself can't sit at
 * collection-phase module/describe scope — e.g. behind an async factory a
 * `beforeAll` awaits, as `src/e2e/harness.ts`'s `createHarness()` does.
 * Vitest snapshots each file's hooks before the run phase starts, so an
 * `afterAll`/`afterEach` registered from inside a hook that's already running
 * is a silent no-op: no error, no teardown, ever. `"manual"` skips
 * registering a hook that would never fire; the caller must call
 * {@link ServedApps.closeAll} itself from somewhere that really does run.
 *
 * A suite whose own `afterEach` has ordering to respect — DB cleanup that must
 * follow the close, say — can call {@link ServedApps.closeAll} there directly;
 * the registered hook then finds nothing left to do.
 */
export function servedApps(opts: { teardown?: "each" | "all" | "manual" } = {}): ServedApps {
  const servers: Server[] = [];

  const closeAll = async (): Promise<void> => {
    const pending = servers.splice(0);
    for (const server of pending) {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
    }
  };

  if (opts.teardown === "manual") {
    // No hook registered — the caller owns calling closeAll() itself (see
    // the "manual" doc above for why self-registration would be dead here).
  } else if (opts.teardown === "all") {
    afterAll(closeAll);
  } else {
    afterEach(closeAll);
  }

  return {
    serve(app) {
      return new Promise<string>((resolve) => {
        const server = honoServe({ fetch: app.fetch, port: 0 }, (info) => {
          resolve(`http://localhost:${info.port}`);
        }) as Server;
        servers.push(server);
      });
    },
    track(server) {
      servers.push(server);
      return server;
    },
    closeAll,
  };
}
