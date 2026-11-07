import { diagnosticConsole } from "../../observability/diagnostic-console";

export const FLY_KEEPALIVE_PATH = "/_sdk/keepalive";

interface Keepalive {
  users: number;
  timer?: ReturnType<typeof setInterval>;
  request?: AbortController;
}

// Mounted DVMs share one proxy heartbeat for the same Machine.
const keepalives = new Map<string, Keepalive>();
const idleAbort = Symbol("keepalive idle");
let warned = false;

export function acquireFlyKeepalive(env: Record<string, string>): () => void {
  const app = env.FLY_APP_NAME;
  const machine = env.FLY_MACHINE_ID;
  if (!app || !machine) return () => {};

  const url = `http://${app}.flycast${FLY_KEEPALIVE_PATH}`;
  const key = `${url}\n${machine}`;
  let state = keepalives.get(key);
  if (!state) {
    state = { users: 0 };
    keepalives.set(key, state);
  }
  const active = state;
  if (active.users++ === 0) {
    active.timer = setInterval(() => {
      if (!active.request) void ping();
    }, 15_000);
    active.timer.unref();
  }

  async function ping(): Promise<void> {
    const controller = new AbortController();
    active.request = controller;
    const timeout = setTimeout(() => controller.abort(), 5_000);
    timeout.unref();
    try {
      const response = await fetch(url, {
        headers: { "fly-force-instance-id": machine },
        signal: controller.signal,
        redirect: "error",
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Fly keepalive refused");
    } catch {
      // Abort on the last release is intentional. Network/HTTP failures are
      // advisory: a missing Flycast DNS record must never fail the handler.
      if (active.users > 0 && controller.signal.reason !== idleAbort && !warned) {
        warned = true;
        diagnosticConsole.warn({ level: "warn", event: "fly_keepalive_failed" });
      }
    } finally {
      clearTimeout(timeout);
      active.request = undefined;
      if (active.users === 0) keepalives.delete(key);
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--active.users !== 0) return;
    clearInterval(active.timer);
    active.timer = undefined;
    active.request?.abort(idleAbort);
    if (!active.request) keepalives.delete(key);
  };
}
