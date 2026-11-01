import type { ServerJob } from "./job";
import { isTerminal } from "./job";
import type { JobStore } from "./job-store";
import { isStreamableJobStore } from "./job-store";

/** Wait for a persisted response boundary without taking ownership of the job. */
export function waitForInlineResult(
  store: JobStore,
  jobId: string,
  localJob: ServerJob | undefined,
  seconds: number,
  signal: AbortSignal
): Promise<void> {
  if (seconds === 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    let checking = false;
    let queued = false;
    let unsubscribe: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearInterval(poll);
      signal.removeEventListener("abort", abort);
      localJob?.listeners.delete(notify);
      unsubscribe?.();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    const check = async () => {
      if (done) return;
      if (checking) { queued = true; return; }
      checking = true;
      try {
        do {
          queued = false;
          const job = await store.get(jobId);
          if (!job || isTerminal(job.status) || job.status === "awaiting-input") finish();
        } while (queued && !done);
      } catch (error) {
        finish(error);
      } finally {
        checking = false;
      }
    };
    const notify = () => { void check(); };
    const deadline = setTimeout(finish, seconds * 1000);
    signal.addEventListener("abort", abort, { once: true });
    localJob?.listeners.add(notify);
    if (signal.aborted) { finish(); return; }
    if (isStreamableJobStore(store)) {
      // Subscribe before the second read so a concurrent commit cannot be missed.
      try {
        void store.subscribeNotifications(jobId, notify).then((stop) => {
          if (done) stop();
          else { unsubscribe = stop; notify(); }
        }, finish);
      } catch (error) {
        finish(error);
      }
    } else {
      // Custom snapshot stores may persist after their last local message event.
      poll = setInterval(notify, 100);
    }
    notify();
  });
}
