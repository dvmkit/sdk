/* Charging by the piece on the in-memory job store and ledger; the Postgres runner shares the suite. */
import { vi } from "vitest";

import type { JobRecord } from "../job-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { pieceSettlementSuite } from "./__helpers__/piece-settlement";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
const { verifyX402Payment } = await import("../../../lib/x402");

pieceSettlementSuite("charging by the piece, in-memory stores", vi.mocked(verifyX402Payment) as never, () => {
  const jobStore = new MemoryJobStore();
  // The store keeps its rows private; a legacy row is one whose piece list was never written.
  const rows = (jobStore as unknown as { data: Map<string, JobRecord> }).data;
  return Promise.resolve({
    jobStore,
    ledger: new MemoryCreditLedger(),
    forgetPieces: (jobId: string) => {
      delete rows.get(jobId)!.pieces;
      return Promise.resolve();
    },
  });
});
