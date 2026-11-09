import type { ServerJob } from "./job";
import { isTerminal } from "./job";
import type { Message } from "../../lib/messages/types";
import type { JobRecord, JobStore } from "./job-store";
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

// A held paid retry and its generic client both buffer the body. Keep large
// results on the messages endpoint to limit server memory and client/context load.
const INLINE_RESULT_MESSAGES_MAX_BYTES = 1_048_576;

export async function inlineResultMessages(store: JobStore, job: JobRecord): Promise<Message[] | undefined> {
  if (!job.messages.some((message) => message.type === "artifact")) return undefined;
  return boundedResultMessages(store, job);
}

/** A completed job's messages for a response body, or undefined when redacted or over the inline cap. */
export async function boundedResultMessages(store: JobStore, job: JobRecord): Promise<Message[] | undefined> {
  if (job.status !== "completed" || job.redactedAt !== undefined) return undefined;
  let messages = job.messages.filter((message) => message.seq > 0);
  if (isStreamableJobStore(store)) {
    const durable = await store.getMessages(job.id, 0, { includeHeld: true });
    if (durable.length > 0) messages = durable;
  }
  return Buffer.byteLength(JSON.stringify(messages), "utf8") <= INLINE_RESULT_MESSAGES_MAX_BYTES ? messages : undefined;
}
