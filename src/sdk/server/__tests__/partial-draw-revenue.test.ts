/* Revenue for a job that did not complete but whose draw settled in part, on the memory stores. */
import { describe } from "vitest";

import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { describePartialDrawRevenue } from "./__helpers__/partial-draw-revenue";

describe("partly settled draw revenue (memory job store)", () => {
  describePartialDrawRevenue(() =>
    Promise.resolve({ jobStore: new MemoryJobStore(), ledger: new MemoryCreditLedger() })
  );
});
