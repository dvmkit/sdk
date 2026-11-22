import { JobCancelledError } from "./server/job";

export function relativeWakeTime(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError("Sleep duration must be finite and non-negative");
  }
  return Date.now() + durationMs;
}

export function absoluteWakeTime(at: Date | number): number {
  const wakeAt = at instanceof Date ? at.getTime() : at;
  if (!Number.isFinite(wakeAt)) throw new RangeError("Sleep time must be a finite epoch timestamp or valid Date");
  return wakeAt;
}

export function displayWakeTime(wakeAt: number): string {
  const date = new Date(wakeAt);
  return Number.isNaN(date.getTime()) ? `${wakeAt} ms since the Unix epoch` : date.toISOString();
}

export function checkSleepCancellation(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof JobCancelledError ? signal.reason : new JobCancelledError();
  }
}

function sleepTimer(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function waitUntil(wakeAt: number, signal: AbortSignal): Promise<void> {
  for (;;) {
    checkSleepCancellation(signal);
    const remaining = wakeAt - Date.now();
    if (remaining <= 0) return;
    await sleepTimer(Math.min(Math.ceil(remaining), 3_600_000), signal);
  }
}

export async function retrySleepEnd(end: () => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  for (;;) {
    checkSleepCancellation(signal);
    try {
      return await end();
    } catch {
      checkSleepCancellation(signal);
      await sleepTimer(1000, signal);
    }
  }
}
