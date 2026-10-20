import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { FxFetcher, FxRateSnapshot } from "../pricing/fx";
import { fiatToSatsCeil, fxRateFor, parseUsdPrice, satsToFiat } from "../pricing/index";
import type { CreditView, FundingMethod, PriceValue, ResolvedCreditConfig } from "../types";
import { stablecoinCreditInstrumentAllowed } from "./credit-funding-policy";
import type { CreditLedgerLike, CreditSnapshot } from "./credit-ledger";
import { isNonChannelBitcoinRail } from "./credit-lots";

/**
 * Public, cacheable prepaid terms exclude caller IDs and balances. toCreditTerms explicitly
 * whitelists this shape so later caller-specific menu fields cannot leak into /v1/info.
 */
export interface CreditTerms {
  /** Signed balance payments on the job messages endpoint are supported. */
  balance_payment?: true;
  /** Smallest funding accepted, in 1e-6 units of `currency`. */
  min_micro: number;
  /** Largest residual balance a caller may hold, in 1e-6 units of `currency`. */
  max_micro: number;
  /** Credit lifetime from the most recent funding, in ms. */
  ttl_ms: number;
  /** Currency the whole block and resulting credit are denominated in. */
  currency: string;
  /** Rails a top-up may be funded over. */
  funding: FundingMethod[];
  /**
   * Tempo methods are actionable. withheld names configured but temporarily unavailable
   * instruments, preserving capability discovery without advertising them for funding.
   */
  tempo?: {
    methods: { method: string; intent: "charge" | "session" }[];
    withheld?: { method: string; intent: "charge" | "session"; reason: string }[];
  };
  /**
   * Present with offered x402 funding. Reusable batch settlement is enabled by default; exact
   * requires explicit acceptance of its manual refund obligation.
   */
  x402?: { schemes: { scheme: string; network: string }[] };
  /**
   * Configured Lightning receive floor in micro-units of currency, including the advertised
   * FX margin. Issuance checks the raw sats floor at current rates; arbitrary drift can still
   * make the advertised amount insufficient.
   */
  lightning_min_micro?: number;
}

/**
 * Funding options and sizing in the wire denomination. max_micro limits residual balance,
 * not a job’s price; fund-and-draw can spend a larger payment immediately. Lightning funds
 * credit but is not an attached-proof payment method.
 *
 * An authenticated caller’s live credit may add an echo with funded and spendable balance;
 * pending holds are included only in the funded figure.
 */
export interface CreditMenu extends CreditTerms {
  /** The caller's credit this echo describes. Present only with the echo. */
  credit_id?: string;
  /** Funded balance, pending holds NOT subtracted. */
  balance_micro?: number;
  /** Spendable balance — what a draw is actually checked against. */
  remaining_micro?: number;
  /** Absolute expiry of the echoed credit, ms since epoch. */
  expiry_ms?: number;
}

export interface BuildCreditMenuArgs {
  /**
   * Which runtime is answering. `"isolate"` is refused unconditionally — see
   * the gate in {@link buildCreditMenu}.
   */
  runtime: "container" | "isolate";
  /** The DVM's resolved `credit` block; `undefined` means it didn't opt in. */
  config: ResolvedCreditConfig | undefined;
  /**
   * Use the DVM’s declared denomination, including /v1/credit where no quote response supplies
   * it. Quote validation refuses a different denomination before menu construction.
   */
  currency: string;
  /** Rails this DVM settles over — the menu's funding options. */
  funding: FundingMethod[];
  /** Tempo methods wired for credit funding; builder policy filters the actionable menu. */
  tempoMethods?: { method: string; intent: "charge" | "session" }[];
  /** Tempo methods this DVM is configured for but is not offering right now. */
  tempoWithheld?: { method: string; intent: "charge" | "session"; reason: string }[];

  x402Schemes?: { scheme: string; network: string }[];
  /**
   * Configured raw receive floor in sats, rendered with an FX margin for the menu. Failure
   * omits Lightning while allowing the rest of the menu; issuance checks the raw floor at
   * current request-time rates.
   */
  lightningFundingMinSats?: number;
  /**
   * Read the configured accepted mint list, not its health-filtered advertisement. Non-channel
   * Bitcoin refunds need a mint, but configuration alone does not establish refund solvency.
   */
  hasAcceptedMint?: boolean;
  fxFetcher: FxFetcher;
  /** True when the descriptor declares an auth scheme (see the gate). */
  hasAuth: boolean;
  ledger?: CreditLedgerLike;
  /** devMode tolerates a non-durable ledger; production does not. */
  devMode?: boolean;
  /** Verified caller pubkey — required for the balance echo, never a fallback id. */
  callerPubkey?: string;
}

export interface CreditMenuConfigInputs {
  runtime: "container" | "isolate";
  config: ResolvedCreditConfig | undefined;
  hasAuth: boolean;
  ledger?: CreditLedgerLike;
  devMode?: boolean;
}

/**
 * Shared static eligibility for the menu and capability refresh: container runtime, opt-in,
 * auth and a ledger durable outside devMode. Transient FX availability is excluded so an
 * outage does not erase configured capability.
 */
export function creditMenuConfigured<T extends CreditMenuConfigInputs>(
  args: T
): args is T & { config: ResolvedCreditConfig; ledger: CreditLedgerLike } {
  // Isolates have no durable credit backend, even with devMode enabled.
  if (args.runtime === "isolate") return false;
  if (!args.config) return false;
  if (!args.hasAuth) return false;
  if (!args.ledger) return false;
  if (!args.ledger.durable && !args.devMode) {
    warnOnce(
      "credit_menu_suppressed_non_durable",
      "credit menu suppressed: the credit ledger is in-memory, so balances would not survive a restart or reach a second machine. Wire Postgres (DATABASE_URL) to advertise credit."
    );
    return false;
  }
  return true;
}

/**
 * Return no menu for static ineligibility or unresolvable denomination bounds. Isolates
 * currently lack durable credit storage; anonymous balances must not be advertised.
 *
 * Select the caller echo only from live, same-currency credits with spendable value.
 */
export async function buildCreditMenu(args: BuildCreditMenuArgs): Promise<CreditMenu | undefined> {
  if (!creditMenuConfigured(args)) return undefined;

  const currency = args.currency.toLowerCase();
  let bounds: { minMicro: number; maxMicro: number };
  try {
    bounds = await resolveCreditBounds(args.config, currency, args.fxFetcher);
  } catch {
    // Omit the credit menu on FX failure without failing the underlying sale.
    warnOnce(
      "credit_menu_bounds_unavailable",
      `credit menu suppressed: could not express the configured credit bounds in ${currency}.`
    );
    return undefined;
  }

  const tempoMethods = (args.tempoMethods ?? []).filter((method) =>
    stablecoinCreditInstrumentAllowed(
      args.config.allowOneShotStablecoin,
      method.intent === "session" ? "tempo_session" : "tempo_charge"
    )
  );
  const tempoWithheld = (args.tempoWithheld ?? []).filter((method) =>
    stablecoinCreditInstrumentAllowed(
      args.config.allowOneShotStablecoin,
      method.intent === "session" ? "tempo_session" : "tempo_charge"
    )
  );
  const x402Schemes =
    args.currency === "usd"
      ? (args.x402Schemes ?? []).filter((scheme) =>
          stablecoinCreditInstrumentAllowed(
            args.config.allowOneShotStablecoin,
            scheme.scheme === "batch-settlement" ? "x402_batch_settlement" : "x402_exact"
          )
        )
      : [];
  const funding = args.funding.filter((rail) => {
    if (rail === "tempo") return tempoMethods.length > 0;
    if (rail === "x402") return x402Schemes.length > 0;
    /**
     * Non-channel Bitcoin refunds use Cashu notes, so a configured mint is required even when
     * explicit paymentMethods bypass default filtering. This establishes a possible refund rail,
     * not the sats or solvency needed to fulfill it.
     */
    if (isNonChannelBitcoinRail(rail)) return args.hasAcceptedMint === true;
    return true;
  });

  const menu: CreditMenu = {
    min_micro: bounds.minMicro,
    max_micro: bounds.maxMicro,
    ttl_ms: args.config.ttlSeconds * 1000,
    currency,
    funding,

    // Keep withheld Tempo capability discoverable even when no method is currently offered.
    ...((tempoMethods.length > 0 || tempoWithheld.length > 0) && {
      tempo: {
        methods: tempoMethods,
        ...(tempoWithheld.length > 0 && { withheld: tempoWithheld }),
      },
    }),

    // a builder who overrides `paymentMethods` can drop x402 from `funding`
    // while the rail stays wired, and terms for a rail the menu doesn't offer
    // are the same misadvertisement in the other direction.
    ...(funding.includes("x402") && x402Schemes.length > 0 && { x402: { schemes: x402Schemes } }),
  };

  // Needs an fx snapshot even on a USD DVM — the floor is sats —
  // so it fetches on its own terms; the snapshot is cached, so the USD path
  // gains one rate read per cache window, not per request. A failure here
  // drops the rail, never the menu (see `lightningFundingMinSats`).
  if (funding.includes("lightning") && args.lightningFundingMinSats !== undefined) {
    try {
      const fx = await args.fxFetcher.fetch();
      menu.lightning_min_micro = lightningFloorMicro(args.lightningFundingMinSats, fx, currency);
    } catch {
      warnOnce(
        "credit_menu_lightning_floor_unavailable",
        `credit menu degraded: could not express the Lightning funding floor in ${currency}, so ` +
          "the lightning rail is omitted from the funding menu until a rate is available."
      );
      menu.funding = menu.funding.filter((rail) => rail !== "lightning");
    }
  }

  const echo = await selectPrimaryCredit({
    ledger: args.ledger,
    callerPubkey: args.callerPubkey,
    currency,
  });
  if (echo) {
    menu.credit_id = echo.creditId;
    menu.balance_micro = echo.balanceMicro;
    menu.remaining_micro = echo.availableMicro;
    menu.expiry_ms = echo.expiryMs;
  }
  return menu;
}

/**
 * Choose the largest live, active, same-currency spendable balance; newest creation breaks
 * a tie. Released implicit payments can hold reclaimable value and are eligible too.
 *
 * The caller supplies a verified pubkey. Anonymous/missing identity returns no credit; the
 * ledger’s anonymous pool must not be exposed to an individual caller.
 */
export async function selectPrimaryCredit(args: {
  ledger: CreditLedgerLike;
  callerPubkey?: string;
  currency: string;
  nowMs?: number;
}): Promise<CreditSnapshot | undefined> {
  const pubkey = args.callerPubkey;
  if (!pubkey || pubkey === "anonymous") return undefined;
  const nowMs = args.nowMs ?? Date.now();
  const credits = await args.ledger.getForCaller(pubkey, { nowMs });
  let best: CreditSnapshot | undefined;
  for (const credit of credits) {
    if (credit.expired) continue;
    if (credit.status !== "active") continue;
    if (credit.currency !== args.currency) continue;
    if (credit.availableMicro <= 0) continue;
    if (
      !best ||
      credit.availableMicro > best.availableMicro ||
      (credit.availableMicro === best.availableMicro && credit.createdAt > best.createdAt)
    ) {
      best = credit;
    }
  }
  return best;
}

export function toCreditView(snapshot: CreditSnapshot): CreditView {
  return {
    creditId: snapshot.creditId,
    currency: snapshot.currency,
    balanceMicro: snapshot.balanceMicro,
    availableMicro: snapshot.availableMicro,
    expiryMs: snapshot.expiryMs,
    expired: snapshot.expired,
  };
}

/**
 * Omit the credit key entirely when there is no menu; consumers use presence to determine
 * whether credit is offered.
 */
export function attachCreditMenu(
  body: Record<string, unknown>,
  menu: CreditMenu | undefined
): Record<string, unknown> {
  if (menu) body.credit = menu;
  return body;
}

/**
 * Explicitly whitelist public /v1/info terms. A future caller-specific menu field cannot
 * cross this cacheable boundary merely by being added to CreditMenu.
 */
export function toCreditTerms(menu: CreditMenu): CreditTerms {
  return {
    ...(menu.balance_payment && { balance_payment: true }),
    min_micro: menu.min_micro,
    max_micro: menu.max_micro,
    ttl_ms: menu.ttl_ms,
    currency: menu.currency,
    funding: [...menu.funding],
    ...(menu.tempo && {
      tempo: {
        methods: menu.tempo.methods.map((method) => ({ ...method })),
        ...(menu.tempo.withheld && {
          withheld: menu.tempo.withheld.map((method) => ({ ...method })),
        }),
      },
    }),
    ...(menu.x402 && {
      x402: { schemes: menu.x402.schemes.map((scheme) => ({ ...scheme })) },
    }),
    ...(menu.lightning_min_micro !== undefined && {
      lightning_min_micro: menu.lightning_min_micro,
    }),
  };
}

/**
 * Finite margin on the fiat advertisement absorbs limited FX drift; issuance enforces the
 * raw sats floor at its current rate. The margin is not an additional refusal threshold.
 */
export const LIGHTNING_FLOOR_FX_MARGIN = 1.15;

/**
 * Render the sats-physical Lightning receive floor into 1e-6 units of the
 * menu's currency, margined per {@link LIGHTNING_FLOOR_FX_MARGIN}. Ceil so the
 * advertised figure never understates the floor. Throws when the snapshot
 * can't quote the currency — the caller degrades by dropping the rail.
 */
export function lightningFloorMicro(
  floorSats: number,
  fx: FxRateSnapshot,
  currency: string
): number {
  const fiat = satsToFiat(floorSats, fxRateFor(fx, currency));
  const micro = Math.ceil(fiat * LIGHTNING_FLOOR_FX_MARGIN * 1_000_000);
  if (!Number.isSafeInteger(micro) || micro < 1) {
    throw new Error(`lightning floor of ${floorSats} sats is not expressible in ${currency}`);
  }
  return micro;
}

/**
 * Convert the builder's USD bounds into 1e-6 units of the response's
 * currency. A USD quote needs no rate at all; anything else pivots through
 * sats on one snapshot so both bounds stay consistent with each other.
 *
 * Throws when a rate is missing — the caller turns that into a suppressed
 * menu, never a failed quote.
 */
async function resolveCreditBounds(
  config: ResolvedCreditConfig,
  currency: string,
  fxFetcher: FxFetcher
): Promise<{ minMicro: number; maxMicro: number }> {
  const fx = currency !== "usd" ? await fxFetcher.fetch() : undefined;
  return {
    minMicro: toMicro(config.min, currency, fx),
    maxMicro: toMicro(config.max, currency, fx),
  };
}

function toMicro(value: PriceValue, currency: string, fx: FxRateSnapshot | undefined): number {
  const usd = parseUsdPrice(value, "credit bound");
  let amount: number;
  if (currency === "usd") {
    amount = usd;
  } else {
    // usd → sats → target currency, through the one snapshot so both legs
    // are consistent with each other.
    if (!fx) throw new Error("fx snapshot required to convert a USD bound");
    amount = satsToFiat(fiatToSatsCeil(usd, fxRateFor(fx, "usd")), fxRateFor(fx, currency));
  }
  const micro = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(micro) || micro < 1) {
    throw new Error(`credit bound ${JSON.stringify(value)} is not expressible in ${currency}`);
  }
  return micro;
}

const warned = new Set<string>();

/** One structured warning per process per reason — these fire on every quote. */
function warnOnce(event: string, message: string): void {
  if (warned.has(event)) return;
  warned.add(event);
  diagnosticConsole.warn({ level: "warn", event, message });
}
