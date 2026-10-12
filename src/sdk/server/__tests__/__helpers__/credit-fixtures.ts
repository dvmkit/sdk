import type {
  CreditFundingBasis,
  CreditLedgerLike,
  DrawRecord,
  DrawResult,
} from "../../credit-ledger.js";
import { MemoryCreditLedger } from "../../memory-credit-ledger.js";

/**
 * Zero rail value is the default when a test concerns ledger balances rather than instrument
 * accounting. Explicit rail-value subjects supply their own basis; legacy basisless reads use
 * a separate fixture.
 */
export const TEST_FUNDING_BASIS: CreditFundingBasis = {
  rail: "cashu",
  paidMsats: 0,
  fundingRef: "test-funding",
};

export function fundCredit(
  ledger: CreditLedgerLike,
  args: Omit<Parameters<CreditLedgerLike["fund"]>[0], "basis"> & {
    basis?: CreditFundingBasis;
  }
): ReturnType<CreditLedgerLike["fund"]> {
  return ledger.fund({ ...args, basis: args.basis ?? TEST_FUNDING_BASIS });
}

/**
 * Override the durability flag only to exercise funding behavior behind the production menu
 * guard. The underlying memory ledger remains nondurable. loseFundings models a missing
 * persisted funding read without changing the credit balance.
 */
export function durableLedger(
  opts: { ledger?: MemoryCreditLedger; loseFundings?: boolean } = {}
): CreditLedgerLike {
  const ledger = opts.ledger ?? new MemoryCreditLedger();
  return new Proxy(ledger, {
    get(target, prop, receiver) {
      if (prop === "durable") return true;
      if (prop === "getFunding" && opts.loseFundings) return () => Promise.resolve(undefined);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  }) as unknown as CreditLedgerLike;
}

/**
 * Model legacy stored rows with no rail basis. Only draw/getDraw projections are overridden;
 * current writes still require a basis, and growth keeps its ordinary behavior.
 */
export class LegacyNullRailLedger extends MemoryCreditLedger {
  override async draw(args: Parameters<CreditLedgerLike["draw"]>[0]): Promise<DrawResult> {
    return withRail(await super.draw(args), null);
  }

  override async getDraw(args: {
    creditId: string;
    drawId: string;
  }): Promise<DrawRecord | undefined> {
    const rec = await super.getDraw(args);
    return rec && withRail(rec, null);
  }
}

/**
 * Model an unrecognized stored rail on draw/read projections. Production code must decline to
 * book that rail rather than cast it into a supported funding method.
 */
export class UnrecognizedRailLedger extends MemoryCreditLedger {
  override async draw(args: Parameters<CreditLedgerLike["draw"]>[0]): Promise<DrawResult> {
    return withRail(await super.draw(args), UNRECOGNIZED_RAIL);
  }

  override async getDraw(args: {
    creditId: string;
    drawId: string;
  }): Promise<DrawRecord | undefined> {
    const rec = await super.getDraw(args);
    return rec && withRail(rec, UNRECOGNIZED_RAIL);
  }
}

/**
 * Empty a credit's pooled `msats_remaining` while leaving its funding lots
 * intact — the shape a legacy multi-rate Bitcoin credit arrives in on an
 * upgraded host. Earlier settles decremented the pool by the
 * blended slice while the lots shed the cheaper FIFO figure, so the pool can
 * reach zero with sats still on deposit; from then on every hold forecasts 0
 * and the job's counter carries the ask instead of an allocation.
 *
 * Poked through the private map because the code that produced the skew is
 * the code replaced — there is no longer a way to reach it forwards.
 */
export function clampPooledRailValueToZero(ledger: MemoryCreditLedger, creditId: string): void {
  const credit = (
    ledger as unknown as { credits: Map<string, { msatsRemaining: number }> }
  ).credits.get(creditId);
  if (!credit) throw new Error(`clampPooledRailValueToZero: credit ${creditId} not found`);
  credit.msatsRemaining = 0;
}

/** Reproduce a legacy credit whose balance survived but its funding lots did not. */
export function removeFundingLots(ledger: MemoryCreditLedger, creditId: string): void {
  const credit = (
    ledger as unknown as { credits: Map<string, { lots: unknown[] }> }
  ).credits.get(creditId);
  if (!credit) throw new Error(`removeFundingLots: credit ${creditId} not found`);
  credit.lots = [];
}

export const UNRECOGNIZED_RAIL = "solana";

function withRail<T extends DrawResult | DrawRecord>(value: T, rail: string | null): T {
  return {
    ...value,
    railValue: {
      ...value.railValue,
      drawMsats: 0,
      drawNative: null,
      rail,
      nativeAsset: null,
      mint: null,
      fundingRef: null,
    },
  };
}
