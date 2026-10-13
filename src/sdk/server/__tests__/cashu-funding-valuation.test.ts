/** Cashu fund-only top-ups credit net principal and report gross face. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FxFetcher } from "../../pricing/fx";
import { fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { verifyUpfrontPayment } from "../payment";
import type { CreditDepositPayload } from "../revenue-reporter";

vi.mock("../../../lib/cashu/verify", () => ({ verifyCashuToken: vi.fn() }));
vi.mock("../wallet-accumulator-receive", () => ({ acceptAccumulatorPayment: vi.fn() }));

const { verifyCashuToken } = await import("../../../lib/cashu/verify");
const { acceptAccumulatorPayment } = await import("../wallet-accumulator-receive");

const CASHU_TOKEN = "cashu-fee-reserved";
const MINT = "https://mint.example";
const CALLER = "aa".repeat(32);
const CREDIT_ID = "credit-fee-aware";
const FUND_ID = "fund-fee-aware";
const GROSS_MSATS = 401_000;
const INPUT_FEE_MSATS = 1_000;
const NET_MSATS = 400_000;

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-08-05T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

describe("Cashu receiver-fee funding valuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyCashuToken).mockReturnValue({
      mint: MINT,
      totalMsats: GROSS_MSATS,
      unit: "sat",
    });
    vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
      const accepted = {
        grossMsats: GROSS_MSATS,
        inputFeeMsats: INPUT_FEE_MSATS,
        mintUrl: MINT,
        netMsats: NET_MSATS,
        paidMsats: NET_MSATS,
      };
      await opts.beforeCommit?.(accepted);
      await opts.withCommitTx?.({} as never, accepted);
      return { kind: "accumulated" as const, ...accepted };
    });
  });

  it("credits a fund-only request at net while preserving gross deposit reconciliation", async () => {
    const ledger = new MemoryCreditLedger();
    const deposits: CreditDepositPayload[] = [];

    const result = await verifyUpfrontPayment({
      cashuToken: CASHU_TOKEN,
      cashuMode: "p2pk-accumulator",
      accumulatorDb: {} as never,
      lockPubkeys: ["02" + "ab".repeat(32)] as never,
      mints: [MINT],
      requestId: "request-fee-aware",
      requiredMsats: NET_MSATS,
      priceFiat: { currency: "usd", amountMicro: NET_MSATS },
      fxFetcher: stubFx,
      creditLedger: ledger,
      callerPubkey: CALLER,
      dvmId: "dvm-fee-aware",
      fundOnly: {
        creditId: CREDIT_ID,
        fundId: FUND_ID,
        commitment: fundingCommitment(CASHU_TOKEN),
      },
      enqueueCreditDeposit: async (_tx, payload) => {
        deposits.push(payload);
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(NET_MSATS);
    expect(result.funding).toMatchObject({
      paidMsats: NET_MSATS,
      grossPaidMsats: GROSS_MSATS,
      cashuInputFeeMsats: INPUT_FEE_MSATS,
      amountMicro: NET_MSATS,
    });
    expect(await ledger.get(CREDIT_ID)).toMatchObject({
      balanceMicro: NET_MSATS,
      availableMicro: NET_MSATS,
    });
    expect(deposits).toEqual([
      expect.objectContaining({
        paidMsats: NET_MSATS,
        grossPaidMsats: GROSS_MSATS,
        cashuInputFeeMsats: INPUT_FEE_MSATS,
        amountMicro: NET_MSATS,
      }),
    ]);
  });
});
