/**
 * a TIP-1034 channel's **first** voucher reports its chain binding,
 * so the platform registers the channel and its close is observed.
 *
 * The chain is mocked, but the channel store, the credit ledger, the deposit
 * outbox, the platform app and `tempo_channel_registrations` are real Postgres
 * which is the whole point: the defect was a statement-ordering bug inside
 * the acceptance transaction, invisible to any test that fakes the store.
 *
 * The mppx handle is a fake that mirrors the real wiring exactly:
 * `withTempoSessionAcceptance` is the store's own `withVoucherAcceptance`
 * (mpp-setup.ts:633), `getTempoSessionBinding` is the same `store.get()` read
 * (mpp-setup.ts:798-810), and `broadcastCredential` performs the *single*
 * store update mppx's `handleOpenCredential` performs — no earlier write for
 * the commit callback to observe.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import type { FxFetcher } from "../../pricing/index";
import { CreditLedger } from "../credit-ledger";
import { fundingCommitment } from "../funding";
import type { MppxServer } from "../mpp-setup";
import { verifyUpfrontPayment } from "../payment";
import { PostgresConsumedCredentialStore } from "../postgres-consumed-credential-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { RevenueReporter } from "../revenue-reporter";
import { PostgresTempoSessionStore } from "../tempo-session-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const DVM_SCHEMA = `dvm_tempo_registration_tempo_${process.pid}`;
const DVM_ID = "dvm-tempo-registration";
const CALLER = "cd".repeat(32);
const RATE = 100_000;
const PRICE_MICRO = 100_000;
const PRICE_MSATS = 100_000;

const CHAIN_ID = 42431;
const CHANNEL_ID = `0x${"1a".repeat(32)}`;
/** Mixed case on purpose: the wire block must be lowercased before it lands. */
const ESCROW = `0x${"2B".repeat(20)}`;
const PAYEE = `0x${"3C".repeat(20)}`;
const PAYER = `0x${"4d".repeat(20)}`;

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: RATE }, as_of: "2026-08-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/** The open state mppx's `ChannelStore.openChannelState` produces. */
function openState(cumulativeAmount: bigint): Record<string, unknown> {
  return {
    channelId: CHANNEL_ID,
    chainId: CHAIN_ID,
    escrowContract: ESCROW,
    payee: PAYEE,
    payer: PAYER,
    token: `0x${"5e".repeat(20)}`,
    authorizedSigner: PAYER,
    operator: `0x${"00".repeat(20)}`,
    highestVoucherAmount: cumulativeAmount,
    settledOnChain: 0n,
    spent: 0n,
    units: 0,
    deposit: cumulativeAmount * 10n,
    closeRequestedAt: 0n,
    finalized: false,
  };
}

/** A `tempo/session` credential carrying an opening or follow-on voucher. */
function sessionCredential(
  action: "open" | "voucher", cumulativeAmount: bigint, challengeId = `tempo/session-${action}`
) {
  return {
    challenge: {
      id: challengeId,
      realm: "dvm-tempo-registration.test",
      method: "tempo",
      intent: "session",
      request: {},
    },
    payload: { action, channelId: CHANNEL_ID, cumulativeAmount: String(cumulativeAmount) },
  };
}

describe.skipIf(!RUN)("— a first Tempo voucher registers its channel", () => {
  let pool: pg.Pool;
  let store: PostgresTempoSessionStore;
  let ledger: CreditLedger;
  let processed: PostgresProcessedPaymentStore;
  let reporter: RevenueReporter;
  let consumed: PostgresConsumedCredentialStore;

  beforeAll(async () => {
    await recreateSchema(DVM_SCHEMA);
    pool = await pinnedPool(DVM_SCHEMA);
    store = new PostgresTempoSessionStore(pool);
    ledger = new CreditLedger(pool, store);
    processed = new PostgresProcessedPaymentStore(pool);
    reporter = new RevenueReporter(pool, "https://platform.invalid", "token");
    consumed = new PostgresConsumedCredentialStore(pool);
    await Promise.all([
      store.init(), ledger.init(), processed.init(), reporter.init(), consumed.init(),
    ]);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM pending_dvm_reports");
    await pool.query("DELETE FROM mpp_tempo_channels");
    await pool.query("DELETE FROM processed_payments");
    await pool.query("DELETE FROM credit_draws");
    await pool.query("DELETE FROM credit_fundings");
    await pool.query("DELETE FROM credits");
    await pool.query("DELETE FROM consumed_credentials");
  });

  afterAll(async () => {
    await pool.end();
    await dropSchemas(DVM_SCHEMA);
  });

  /**
   * mppx's session runtime, faked at the two seams the SDK actually binds plus
   * the credential broadcast. `broadcastCredential` writes the channel row the
   * way `handleOpenCredential` does — one `store.update`, nothing before it.
   */
  function sessionMpp(cumulativeAmount: bigint, realm?: string): MppxServer {
    return {
      // mppx leaves `realm` undefined when neither Mppx.create nor its env names one.
      realm,
      methods: [
        { name: "tempo", intent: "charge" },
        { name: "tempo", intent: "session" },
      ],
      issueChallenge: (method: string, intent: string) =>
        Promise.resolve({ id: `${method}/${intent}`, method, intent, request: {} }),
      broadcastCredential: async () => {
        await store.update(CHANNEL_ID, (current) => ({
          op: "set",
          value: { ...(current ?? {}), ...openState(cumulativeAmount) },
          result: undefined,
        }));
        return { method: "tempo", status: "success", reference: "0xopen" };
      },
      withTempoSessionAcceptance: store.withVoucherAcceptance.bind(store),
      getTempoSessionBinding: async (channelId: string) => {
        const stored = (await store.get(channelId.toLowerCase())) as Record<string, unknown> | null;
        if (!stored) return null;
        return {
          chainId: Number(stored.chainId),
          escrowContract: String(stored.escrowContract),
          ...(typeof stored.payee === "string" && { payee: stored.payee }),
        };
      },
    } as unknown as MppxServer;
  }

  async function fundFromVoucher(args: {
    action: "open" | "voucher";
    cumulativeAmount: bigint;
    fundId: string;
    dvmId?: string;
    realm?: string | null;
    consumedCredentialStore?: PostgresConsumedCredentialStore;
    challengeId?: string;
  }) {
    const credential = sessionCredential(args.action, args.cumulativeAmount, args.challengeId);
    return verifyUpfrontPayment({
      requiredMsats: PRICE_MSATS,
      priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
      mpp: sessionMpp(
        args.cumulativeAmount,
        args.realm === null ? undefined : (args.realm ?? "dvm-tempo-registration.test")
      ) as never,
      mppCredential: credential as never,
      fxFetcher: stubFx,
      callerPubkey: CALLER,
      dvmId: args.dvmId ?? DVM_ID,
      creditLedger: ledger,
      processedPayments: processed,
      enqueueCreditDeposit: reporter.enqueueDeposit.bind(reporter),
      ...(args.consumedCredentialStore && {
        consumedCredentialStore: args.consumedCredentialStore,
      }),
      // A session credential is a `/v1/credit` instrument; the job
      // surface refuses it before mppx ever broadcasts.
      fundOnly: {
        creditId: "credit-tempo-1995",
        fundId: args.fundId,
        commitment: fundingCommitment(JSON.stringify(credential)),
      },
    });
  }

  async function pendingDeposits(): Promise<
    { payload: { creditId: string; rail: string; tempoChannel?: Record<string, unknown> } }[]
  > {
    const { rows } = await pool.query<{
      payload: { creditId: string; rail: string; tempoChannel?: Record<string, unknown> };
    }>(`SELECT payload FROM pending_dvm_reports WHERE kind = 'deposit' ORDER BY created_at`);
    return rows;
  }

  it("reports the chain binding on the opening voucher, which writes the row itself", async () => {
    const result = await fundFromVoucher({
      action: "open",
      cumulativeAmount: 100_000n,
      fundId: "fund-open",
    });

    expect(result.error).toBeUndefined();
    // Pre-fix this block was absent: the commit callback read the channel
    // before the acceptance transaction had inserted it.
    expect(await pendingDeposits()).toEqual([
      {
        payload: expect.objectContaining({
          creditId: "credit-tempo-1995",
          rail: "tempo",
          instrument: "tempo_session",
          // the session label rides every session-funded deposit,
          // independently of the binding below — it is what lets the platform
          // tell a lost binding from an ordinary `tempo/charge` deposit.
          tempoSession: { channelId: CHANNEL_ID.toLowerCase() },
          tempoChannel: {
            chainId: CHAIN_ID,
            channelId: CHANNEL_ID.toLowerCase(),
            escrow: ESCROW.toLowerCase(),
            payee: PAYEE.toLowerCase(),
          },
        }),
      },
    ]);
  });

  it("still reports the binding on a later voucher against an existing row", async () => {
    await fundFromVoucher({ action: "open", cumulativeAmount: 100_000n, fundId: "fund-first" });
    await pool.query("DELETE FROM pending_dvm_reports");

    const result = await fundFromVoucher({
      action: "voucher",
      cumulativeAmount: 200_000n,
      fundId: "fund-second",
    });

    expect(result.error).toBeUndefined();
    expect(await pendingDeposits()).toEqual([
      {
        payload: expect.objectContaining({
          tempoChannel: expect.objectContaining({ channelId: CHANNEL_ID.toLowerCase() }),
        }),
      },
    ]);
  });

  it("answers a committed funding as funded when no MPP realm is configured", async () => {
    const funded = await fundFromVoucher({
      action: "open", cumulativeAmount: 100_000n, fundId: "fund-realmless",
      realm: null, consumedCredentialStore: consumed,
    });

    expect(funded.error).toBeUndefined();
    expect(funded.paidMsats).toBe(PRICE_MSATS);
    expect((await ledger.get("credit-tempo-1995"))?.balanceMicro).toBe(PRICE_MICRO);
    // The replay key falls back to the challenge's own HMAC-bound realm.
    const { rows } = await pool.query<{ realm: string; challenge_id: string }>(
      "SELECT realm, challenge_id FROM consumed_credentials"
    );
    expect(rows).toEqual([{ realm: "dvm-tempo-registration.test", challenge_id: "tempo/session-open" }]);

    // A higher voucher under the consumed challenge id would book a new delta,
    // so only the consumed-credential refusal can stop it, and it must do so
    // before anything commits.
    const replayed = await fundFromVoucher({
      action: "voucher", cumulativeAmount: 200_000n, fundId: "fund-realmless-replay",
      realm: null, consumedCredentialStore: consumed, challengeId: "tempo/session-open",
    });
    expect(replayed.error?.status).toBe(402);
    expect(replayed.error?.body.message).toBe("MPP credential already used");
    expect((await ledger.get("credit-tempo-1995"))?.balanceMicro).toBe(PRICE_MICRO);
  });

  it("refuses without funding when the replay check itself fails", async () => {
    const failing = new PostgresConsumedCredentialStore(pool);
    vi.spyOn(failing, "has").mockRejectedValue(new Error("replay store unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const refused = await fundFromVoucher({
        action: "open", cumulativeAmount: 100_000n, fundId: "fund-has-fails",
        consumedCredentialStore: failing,
      });
      expect(refused.error?.status).toBe(402);
      expect(await ledger.get("credit-tempo-1995")).toBeUndefined();
    } finally { vi.restoreAllMocks(); }
  });

  it("answers a committed session funding as funded when its replay mark fails", async () => {
    const failing = new PostgresConsumedCredentialStore(pool);
    vi.spyOn(failing, "mark").mockRejectedValue(new Error("replay store unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const funded = await fundFromVoucher({
        action: "open", cumulativeAmount: 100_000n, fundId: "fund-mark-fails",
        consumedCredentialStore: failing,
      });
      expect(funded.error).toBeUndefined();
      expect((await ledger.get("credit-tempo-1995"))?.balanceMicro).toBe(PRICE_MICRO);
      expect(warn.mock.calls.map((call) => JSON.parse(String(call[0])))).toContainEqual(
        expect.objectContaining({ event: "tempo_replay_mark_failed", failure_stage: "replay_store" })
      );
    } finally { vi.restoreAllMocks(); }
  });
});
