/** Cross-process store writer. Roles rendezvous before mutating; the iteration limit bounds a stalled sibling. */

import { existsSync, writeFileSync } from "fs";
import { join } from "path";

import { recordDrainReceipts, recordFundResponse, recordPendingDrain } from "../../credit-store";

const [role, endpoint, callerPubkey, creditId, iterationsRaw] = process.argv.slice(2);
const iterations = Number(iterationsRaw);
const configDir = process.env.DVM_CONFIG_DIR ?? "";

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rendezvous(other: string): void {
  writeFileSync(join(configDir, `${role}.ready`), "");
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(configDir, `${other}.ready`)) && Date.now() < deadline) sleepSync(5);
}

if (role === "churn") {
  rendezvous("drains");
  // Keep rewriting for as long as the drain writer is still filing, so the
  // overlap covers its whole window rather than the first entry or two. The
  // iteration count is only a backstop against a child that never finishes.
  const done = join(configDir, "drains.done");
  for (let i = 1; i <= iterations && !existsSync(done); i += 1) {
    recordFundResponse({
      endpoint,
      callerPubkey,
      credit: {
        credit_id: creditId,
        currency: "usd",
        balance_micro: 1_000_000,
        remaining_micro: 1_000_000 - i,
        expiry_ms: 0,
        expired: false,
        drainable: true,
        ledger_seq: i,
      },
      targetMicro: 1_000_000,
    });
  }
} else if (role === "drains") {
  rendezvous("churn");
  for (let i = 0; i < iterations; i += 1) {
    recordPendingDrain(endpoint, callerPubkey, {
      drainId: `drain-${String(i)}`,
      creditId,
      method: "cashu",
      payout: { kind: "cashu" },
      requestedAt: 1_000 + i,
    });
    recordDrainReceipts({
      endpoint,
      callerPubkey,
      drainId: `drain-${String(i)}`,
      creditId,
      receipts: [{ drain_id: `drain-${String(i)}`, amount_micro: 100 }],
      read: { reachable: true },
      now: 2_000 + i,
    });
    sleepSync(25);
  }
  writeFileSync(join(configDir, "drains.done"), "");
} else {
  throw new Error(`unknown role: ${role}`);
}
