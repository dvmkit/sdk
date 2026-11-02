/* Card funding against the Postgres ledger and processed-payment store: the lot row, and the
 * recovery of a charge that succeeded before its booking committed. */
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CreditLedger, type CreditLedgerLike } from "../credit-ledger";
import { derivedFundCreditId } from "../funding";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { CALLER, cardServer, credentialFor, fakeStripe, fund } from "./__helpers__/card-credit";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_credit_fund_stripe";

async function pool(schema?: string): Promise<Pool> {
  const pg = await import("pg");
  return new pg.default.Pool({
    connectionString: DATABASE_URL,
    ...(schema && { options: `-c search_path=${schema}` }),
  });
}

describe.skipIf(!RUN)("card funding on Postgres", () => {
  let db: Pool;
  let ledger: CreditLedger;
  let processed: PostgresProcessedPaymentStore;

  beforeAll(async () => {
    const admin = await pool();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.end();
    db = await pool(SCHEMA);
    ledger = new CreditLedger(db);
    await ledger.init();
    processed = new PostgresProcessedPaymentStore(db);
    await processed.init();
  });

  afterAll(async () => {
    await db.end();
    const admin = await pool();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  it("stores one stripe lot keyed by the PaymentIntent and never prices it in kind", async () => {
    const { app } = await cardServer({ ledger, serverOpts: { processedPayments: processed } });
    const credential = await credentialFor(app, "lot");
    expect((await fund(app, { fundId: "lot", credential })).status).toBe(200);

    const creditId = derivedFundCreditId(CALLER, "lot");
    const { rows } = await db.query(
      `SELECT rail, funding_ref, sats_funded, credited_micro, remaining_micro
         FROM credit_funding_lots WHERE credit_id = $1`,
      [creditId]
    );
    expect(rows).toEqual([
      {
        rail: "stripe",
        funding_ref: "pi_test_1",
        sats_funded: "0",
        credited_micro: "600000",
        remaining_micro: "600000",
      },
    ]);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(600_000);
    // A card deposit is owed back to the card, not in sats.
    const liability = await ledger.bitcoinDepositLiability();
    expect(JSON.stringify(liability)).not.toContain(creditId);
  });

  it("books a charge whose first booking failed when the same credential is resent", async () => {
    let failNextFund = true;
    const flaky = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop === "fund") {
          return (args: Parameters<CreditLedgerLike["fund"]>[0]) => {
            if (failNextFund) {
              failNextFund = false;
              return Promise.reject(new Error("connection lost after the charge"));
            }
            return target.fund(args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const stripe = fakeStripe("succeed", "pi_recover_");
    const { app } = await cardServer({
      ledger: flaky,
      stripe,
      serverOpts: { processedPayments: processed },
    });
    const credential = await credentialFor(app, "recover");
    const creditId = derivedFundCreditId(CALLER, "recover");

    const lost = await fund(app, { fundId: "recover", credential });
    expect(lost.status).toBe(503);
    const lostBody = await lost.json();
    expect(lostBody).toMatchObject({ reason: "booking_failed", retryable: true });
    expect(lostBody.hint).toMatch(/same credential/);
    expect(stripe.calls).toHaveLength(1);
    expect(await ledger.get(creditId)).toBeUndefined();

    const resent = await fund(app, { fundId: "recover", credential });
    expect(resent.status).toBe(200);
    expect((await resent.json()).credit.balance_micro).toBe(600_000);
    // The resend reached the same PaymentIntent, so the card was charged once.
    expect(stripe.calls.map((call) => call.idempotencyKey)).toEqual([
      stripe.calls[0]!.idempotencyKey,
      stripe.calls[0]!.idempotencyKey,
    ]);
    expect(await ledger.listFundingLots(creditId)).toMatchObject([
      { rail: "stripe", fundingRef: "pi_recover_1", creditedMicro: 600_000 },
    ]);
  });
});
