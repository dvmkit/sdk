import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { CreditExpiryRelease, CreditLedgerLike } from "./credit-ledger";

/**
 * A timer visits abandoned credits that no caller reads again. The ledger sweep commits the
 * expiry release and zeroes the balance under its lock; nominal expiry alone still permits
 * reclaim until that pass runs.
 */

export interface CreditExpirySweep {
  /** Stop the timer. Idempotent. */
  stop(): void;
  runOnce(): Promise<{ released: CreditExpiryRelease[] }>;
}

export interface CreditExpirySweepOpts {
  /** Sweep period. Defaults to {@link DEFAULT_SWEEP_INTERVAL_MS}; `0` disables the timer. */
  intervalMs?: number;
  /**
   * Delay before the boot pass. Defaults to {@link DEFAULT_BOOT_DELAY_MS}; `0`
   * disables the boot pass, leaving only the interval.
   */
  bootDelayMs?: number;
  limit?: number;
}

/**
 * Return undefined unless the ledger is durable and supports sweeping. A delayed boot pass
 * handles hosts whose brief wakes never reach the periodic timer. Timers are unref’ed so they
 * do not keep the process alive.
 *
 * Log failed passes and allow the next pass to retry. The ledger atomically records each
 * expiry episode and report; revival allows a later episode even at the same expiry instant.
 */
export function startCreditExpirySweep(
  ledger: CreditLedgerLike,
  opts: CreditExpirySweepOpts = {}
): CreditExpirySweep | undefined {
  const sweepExpiredCredits = ledger.sweepExpiredCredits?.bind(ledger);
  if (!sweepExpiredCredits) return undefined;

  const intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const bootDelayMs = opts.bootDelayMs ?? DEFAULT_BOOT_DELAY_MS;
  let stopped = false;

  const runOnce = (): Promise<{ released: CreditExpiryRelease[] }> =>
    sweepExpiredCredits({ limit: opts.limit });

  const pass = (): void => {
    if (stopped) return;
    void runOnce()
      .then(({ released }) => {
        if (released.length === 0) return;
        diagnosticConsole.log(
          {
            level: "credit_expiry_released",
            count: released.length,
            credits: released.map((r) => r.creditId),
          }
        );
      })
      .catch((_err: unknown) => {
        diagnosticConsole.error(
          {
            level: "credit_expiry_sweep_failed",
            error: undefined,
          }
        );
      });
  };

  let bootTimer: ReturnType<typeof setTimeout> | undefined;
  if (bootDelayMs > 0) {
    bootTimer = setTimeout(pass, bootDelayMs);
    bootTimer.unref();
  }
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  if (intervalMs > 0) {
    intervalTimer = setInterval(pass, intervalMs);
    intervalTimer.unref();
  }

  return {
    stop(): void {
      stopped = true;
      if (bootTimer) clearTimeout(bootTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      bootTimer = undefined;
      intervalTimer = undefined;
    },
    runOnce,
  };
}

/**
 * One-hour scan cadence bounds routine work. A delayed or failed pass postpones release;
 * expiry alone does not commit it.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DEFAULT_BOOT_DELAY_MS = 30_000;
