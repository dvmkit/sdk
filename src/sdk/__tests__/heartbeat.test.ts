import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withProgressHeartbeat } from "../heartbeat";

describe("withProgressHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits synchronously, repeats while pending, and stops after success", async () => {
    const onProgress = vi.fn();
    let resolveFn!: (value: string) => void;
    const promise = withProgressHeartbeat(
      { onProgress, phase: "diarising", percent: 65, intervalMs: 1000 },
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        })
    );
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(65, "diarising");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onProgress).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2500);
    expect(onProgress).toHaveBeenCalledTimes(4);
    expect(onProgress.mock.calls).toEqual(Array.from({ length: 4 }, () => [65, "diarising"]));
    resolveFn("done");
    expect(await promise).toBe("done");
    await vi.advanceTimersByTimeAsync(5000);
    expect(onProgress).toHaveBeenCalledTimes(4);
  });

  it("clears the interval even when fn rejects", async () => {
    const onProgress = vi.fn();
    await expect(
      withProgressHeartbeat(
        { onProgress, phase: "transcribing", percent: 25, intervalMs: 100 },
        () => Promise.reject(new Error("boom"))
      )
    ).rejects.toThrow("boom");
    const callsBefore = onProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(onProgress).toHaveBeenCalledTimes(callsBefore);
  });

  it("is a no-op wrapper when onProgress is undefined", async () => {
    const result = await withProgressHeartbeat(
      { phase: "transcribing", percent: 25, intervalMs: 100 },
      () => Promise.resolve("value")
    );
    expect(result).toBe("value");
  });

  it("defaults intervalMs to 30s when omitted", async () => {
    const onProgress = vi.fn();
    let resolveFn: (value: string) => void = () => undefined;
    const fn = (): Promise<string> =>
      new Promise<string>((resolve) => {
        resolveFn = resolve;
      });
    const promise = withProgressHeartbeat({ onProgress, phase: "diarising", percent: 65 }, fn);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(onProgress).toHaveBeenCalledTimes(1); // only the initial tick

    await vi.advanceTimersByTimeAsync(2_000);
    expect(onProgress).toHaveBeenCalledTimes(2);

    resolveFn("done");
    await promise;
  });
});
