import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

import type { SignedRequestDomain } from "../../lib/signed-request-statement";
import { CreditLedger, CreditLedgerError } from "./credit-ledger";
import { drawSettlementRef } from "./funding";
import type { DVMAuthScheme } from "./secp256k1-auth";

export const BALANCE_PAYMENT_SCHEMA = z.object({
  credit_id: z.string().min(1).max(256),
  draw_id: z.string().min(1).max(256),
  payment_id: z.string().min(1).max(256),
  request_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  amount_micro: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z.string().regex(/^[a-z]{3}$/),
  pubkey: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
});

export class BalancePaymentError extends Error {
  constructor(readonly status: 400 | 402 | 409, readonly body: Record<string, unknown>) {
    super(String(body.error));
  }
}

function conflict(error = "credit_payment_conflict"): never {
  throw new BalancePaymentError(409, { error });
}

/** Payment identity is independent of expiring signature envelopes and of draw/funding IDs. */
export async function commitBalancePayment(args: {
  pool: Pool;
  ledger: CreditLedger;
  auth: DVMAuthScheme;
  domain: SignedRequestDomain;
  jobId: string;
  dvmId: string;
  raw: unknown;
  allowFresh?: boolean;
}): Promise<{ response: { seq: number }; replayed: boolean }> {
  // Recheck first so an accepted authorization can recover outside the drift window.
  // Freshness is enforced below only after the durable identity has missed.
  args.auth.recheckSignature(BALANCE_PAYMENT_SCHEMA, args.raw, args.domain);
  const auth = BALANCE_PAYMENT_SCHEMA.parse(args.raw);
  const { pubkey, credit_id, draw_id, payment_id, request_seq, amount_micro, currency } = auth;
  const fingerprint = createHash("sha256").update(JSON.stringify([
    args.domain, args.jobId, pubkey, credit_id, draw_id, payment_id, request_seq, amount_micro, currency,
  ])).digest("hex");
  const tx = await args.pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`balance-payment:${payment_id}`]);
    const prior = await tx.query<{ fingerprint: string; response: { seq: number } }>(
      "SELECT fingerprint, response FROM credit_balance_payments WHERE payment_id=$1", [payment_id]);
    if (prior.rows[0]) {
      if (prior.rows[0].fingerprint !== fingerprint) conflict();
      await tx.query("COMMIT");
      return { response: prior.rows[0].response, replayed: true };
    }
    if (args.allowFresh === false) conflict("balance_payment_unavailable");
    args.auth.checkAuth(BALANCE_PAYMENT_SCHEMA, args.raw, args.domain);
    // Job -> channel -> credit is also the order of terminal snapshot then draw resolution.
    // No money can be held after a terminal snapshot has won this row lock.
    const jobs = await tx.query<{
      status: string; dvm_id: string | null; requester_pubkey: string | null; credit_id: string | null;
      draw_id: string | null; pending_payment_fiat_micro: string | null;
      pending_payment_fiat_currency: string | null; pending_payment_msats: string | null;
      asked_topup_micro: string | null; next_seq: number;
    }>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [args.jobId]);
    const job = jobs.rows[0];
    if (!job || (job.dvm_id !== null && job.dvm_id !== args.dvmId) || job.requester_pubkey !== pubkey) conflict("credit_payment_owner_mismatch");
    if (["completed", "failed", "cancelled"].includes(job.status)) conflict("job_not_active");
    const asks = await tx.query<{ data: { seq: number; content: { credit?: { amount_micro: number; currency: string } } } }>(
      `SELECT data FROM job_messages WHERE job_id=$1 AND data->>'type'='payment-request'
       AND data->>'from'='provider' AND status='verified' ORDER BY seq DESC LIMIT 1`, [args.jobId]);
    const ask = asks.rows[0]?.data;
    if (!ask || ask.seq !== request_seq || !ask.content.credit ||
      ask.content.credit.amount_micro !== amount_micro || ask.content.credit.currency !== currency ||
      Number(job.pending_payment_fiat_micro) !== amount_micro || job.pending_payment_fiat_currency !== currency ||
      Number(job.pending_payment_msats) <= 0 || job.asked_topup_micro === null || Number(job.asked_topup_micro) < amount_micro) {
      conflict("credit_payment_ask_mismatch");
    }
    if ((job.credit_id !== null || job.draw_id !== null) &&
      (job.credit_id !== credit_id || job.draw_id !== draw_id)) conflict();
    const { rows: [credit] } = await tx.query<{ caller_pubkey: string; currency: string }>(
      "SELECT caller_pubkey,currency FROM credits WHERE credit_id=$1", [credit_id]);
    if (!credit || credit.caller_pubkey !== pubkey) conflict("credit_payment_owner_mismatch");
    if (credit.currency !== currency) conflict("credit_payment_currency_mismatch");
    const seq = Number(job.next_seq);
    const message = { seq, from: "requester", type: "payment", timestamp: Math.floor(Date.now() / 1000), content: { credit: args.raw } };
    await tx.query(`INSERT INTO job_messages (job_id,seq,data,status,created_at_ms)
      VALUES ($1,$2,$3,'pending-verification',$4)`, [args.jobId, seq, JSON.stringify(message), Date.now()]);
    if (job.credit_id === null) {
      // Never bind a pre-existing draw: it could belong to another job or authorization.
      const existing = await tx.query("SELECT 1 FROM credit_draws WHERE credit_id=$1 AND draw_id=$2", [credit_id, draw_id]);
      if (existing.rowCount) conflict();
      await args.ledger.draw({ creditId: credit_id, drawId: draw_id, amountMicro: 0,
        jobId: args.jobId, hostingPaymentSeq: seq, tx });
    }
    const grown = await args.ledger.growDraw({ creditId: credit_id, drawId: draw_id,
      jobId: args.jobId, spendExistingBalance: true, hostingPaymentSeq: seq, addAmountMicro: amount_micro, capMicro: Number(job.asked_topup_micro), tx });
    if (grown.addedAmountMicro !== amount_micro) conflict("credit_payment_ask_mismatch");
    const basis = grown.railValue;
    const nativeAsset = basis.nativeAsset;
    await tx.query(`UPDATE jobs SET next_seq=next_seq+1,
      paid_msats=paid_msats+$2, pending_payment_msats=NULL,
      pending_payment_fiat_micro=NULL, pending_payment_fiat_currency=NULL,
      pending_mpp_challenge_ids=NULL, pending_x402_nonce=NULL, pending_x402_amount_usdc_micro=NULL,
      credit_id=$3, draw_id=$4, payment_rail=$5, payment_mint=$6, payment_tx_hash=$7,
      native_amount=$8, native_asset=$9, last_activity_at=$10 WHERE id=$1`,
    [args.jobId, grown.addedRailValue.drawMsats, credit_id, draw_id, basis.rail, basis.mint,
      drawSettlementRef(args.dvmId, credit_id, draw_id), basis.drawNative, nativeAsset, Date.now()]);
    await tx.query("UPDATE job_messages SET status='verified' WHERE job_id=$1 AND seq=$2", [args.jobId, seq]);
    const response = { seq };
    await tx.query("INSERT INTO credit_balance_payments(payment_id,fingerprint,response,job_id,request_seq) VALUES($1,$2,$3,$4,$5)",
      [payment_id, fingerprint, JSON.stringify(response), args.jobId, request_seq]);
    await tx.query("SELECT pg_notify('job_messages', $1)", [args.jobId]);
    await tx.query("COMMIT");
    return { response, replayed: false };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    if (error instanceof CreditLedgerError && error.code === "insufficient_credit") {
      const remaining = error.details.availableMicro ?? 0;
      throw new BalancePaymentError(402, { error: "insufficient_credit", remaining_micro: remaining,
        shortfall_micro: Math.max(0, auth.amount_micro - remaining) });
    }
    if (error instanceof CreditLedgerError) {
      throw new BalancePaymentError(409, { error: error.code });
    }
    throw error;
  } finally {
    tx.release();
  }
}
