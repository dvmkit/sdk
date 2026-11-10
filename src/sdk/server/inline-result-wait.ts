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
const INLINE_RESULT_MESSAGES_PAGE_SIZE = 16;

export async function inlineResultMessages(store: JobStore, job: JobRecord): Promise<Message[] | undefined> {
  if (!job.messages.some((message) => message.type === "artifact")) return undefined;
  return boundedResultMessages(store, job);
}

/** A completed job's messages for a response body, or undefined when redacted or over the inline cap. */
export async function boundedResultMessages(store: JobStore, job: JobRecord): Promise<Message[] | undefined> {
  if (job.status !== "completed" || job.redactedAt !== undefined) return undefined;
  const messages: Message[] = [];
  let bytes = 2; // JSON array brackets.
  const append = (message: Message): boolean => {
    bytes += (messages.length > 0 ? 1 : 0) + Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes > INLINE_RESULT_MESSAGES_MAX_BYTES) return false;
    messages.push(message);
    return true;
  };
  if (isStreamableJobStore(store)) {
    let afterSeq = 0;
    for (;;) {
      const page = await store.getMessages(job.id, afterSeq, {
        includeHeld: true, limit: INLINE_RESULT_MESSAGES_PAGE_SIZE,
      });
      for (const message of page) if (!append(message)) return undefined;
      if (page.length < INLINE_RESULT_MESSAGES_PAGE_SIZE) break;
      afterSeq = page[page.length - 1].seq;
    }
    if (messages.length > 0) return messages;
  }
  for (const message of job.messages) {
    if (message.seq > 0 && !append(message)) return undefined;
  }
  return messages;
}
