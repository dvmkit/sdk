import { createHash } from "node:crypto";
import type { Pool } from "pg";

import { diagnosticConsole } from "../../observability/diagnostic-console";
import { askExpired } from "./ask-expiry";
import { BalancePaymentError, settleAskFromBalance } from "./balance-payment";
import type { StandingMandate } from "./credit-envelope";
import { CreditLedger, CreditLedgerError } from "./credit-ledger";

/** Why a mandate left an ask open for the caller to pay. Catalogued as `paymentSkipReasons`. */
export type MandateSkipReason =
  | "mandate_expired"
  | "mandate_ask_cap"
  | "mandate_total_cap"
  | "mandate_balance"
  | "mandate_currency"
  | "mandate_draw_owned_elsewhere"
  | "mandate_ask_unpriced"
  | "mandate_credit_unavailable";

export type MandateSettlement =
  | { outcome: "paid"; requestSeq: number; seq: number; replayed: boolean }
  | { outcome: "skipped"; requestSeq: number; reason: MandateSkipReason }
  /** No open ask to pay: none was written, it is already paid, or the job ended. */
  | { outcome: "none" };

/** One payment identity per ask, so a retried or replayed settlement can never charge twice. */
export function mandatePaymentId(jobId: string, requestSeq: number): string {
  return `mandate:${createHash("sha256").update(JSON.stringify(["mandate", jobId, requestSeq])).digest("hex")}`;
}

/**
 * Pay the job's open ask from its caller's credit under the standing mandate stored on its row, in the same
 * transaction shape as a signed balance payment. Every limit is evaluated under the job row lock
 * from durable rows. When any fails, nothing moves and the ask stays open for a signed payment.
 * Safe to call repeatedly: an ask that is already paid, by either path, is left alone.
 */
export async function settleMandateAsk(args: {
  pool: Pool;
  ledger: CreditLedger;
  jobId: string;
  dvmId: string;
  nowMs?: number;
}): Promise<MandateSettlement> {
  const tx = await args.pool.connect();
  let requestSeq: number | undefined;
  try {
    await tx.query("BEGIN");
    const jobs = await tx.query<{
      status: string; dvm_id: string | null; requester_pubkey: string | null; credit_id: string | null;
      draw_id: string | null; pending_payment_fiat_micro: string | null;
      pending_payment_fiat_currency: string | null; pending_payment_msats: string | null;
      asked_topup_micro: string | null; next_seq: number; mandate: StandingMandate | null;
    }>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [args.jobId]);
    const job = jobs.rows[0];
    const mandate = job?.mandate;
    if (!job || !mandate || (job.dvm_id !== null && job.dvm_id !== args.dvmId) || !job.requester_pubkey ||
        ["completed", "failed", "cancelled"].includes(job.status)) {
      return await none(tx);
    }
    const asks = await tx.query<{ data: { seq: number; content: { credit?: { amount_micro: number; currency: string }; expires_at_ms?: number } } }>(
      `SELECT data FROM job_messages WHERE job_id=$1 AND data->>'type'='payment-request'
       AND data->>'from'='provider' AND status='verified' ORDER BY seq DESC LIMIT 1`, [args.jobId]);
    const ask = asks.rows[0]?.data;
    if (!ask) return await none(tx);
    requestSeq = ask.seq;
    const paymentId = mandatePaymentId(args.jobId, ask.seq);
    const prior = await tx.query<{ payment_id: string; response: { seq: number } }>(
      "SELECT payment_id, response FROM credit_balance_payments WHERE job_id=$1 AND request_seq=$2", [args.jobId, ask.seq]);
    if (prior.rows[0]) {
      await tx.query("COMMIT");
      return prior.rows[0].payment_id === paymentId
        ? { outcome: "paid", requestSeq: ask.seq, seq: prior.rows[0].response.seq, replayed: true }
        : { outcome: "none" };
    }
    // Cleared by whichever payment settled this ask first, on any rail.
    if (job.pending_payment_msats === null || Number(job.pending_payment_msats) <= 0) return await none(tx);
    const now = args.nowMs ?? Date.now();
    if (askExpired(ask.content.expires_at_ms, now)) return await none(tx);
    const skip = async (reason: MandateSkipReason): Promise<MandateSettlement> => {
      await tx.query("ROLLBACK");
      return { outcome: "skipped", requestSeq: ask.seq, reason };
    };
    const priced = ask.content.credit;
    if (!priced || Number(job.pending_payment_fiat_micro) !== priced.amount_micro ||
        job.pending_payment_fiat_currency !== priced.currency ||
        job.asked_topup_micro === null || Number(job.asked_topup_micro) < priced.amount_micro) {
      return await skip("mandate_ask_unpriced");
    }
    if (now >= mandate.expires_at_ms) return await skip("mandate_expired");
    if (priced.amount_micro > mandate.max_ask_micro) return await skip("mandate_ask_cap");
    const { rows: [credit] } = await tx.query<{ caller_pubkey: string; currency: string }>(
      "SELECT caller_pubkey,currency FROM credits WHERE credit_id=$1", [mandate.credit_id]);
    if (!credit || credit.caller_pubkey !== job.requester_pubkey) return await skip("mandate_credit_unavailable");
    if (credit.currency !== priced.currency) return await skip("mandate_currency");
    // The admitted ids are authorization intent, not a reservation: another job may already hold
    // this draw. Only a draw this job is bound to, or a fresh one created here, may be grown.
    if ((job.credit_id !== null || job.draw_id !== null) &&
        (job.credit_id !== mandate.credit_id || job.draw_id !== mandate.draw_id)) {
      return await skip("mandate_draw_owned_elsewhere");
    }
    const { rows: [draw] } = await tx.query<{ job_id: string | null; amount_micro: string }>(
      "SELECT job_id, amount_micro FROM credit_draws WHERE credit_id=$1 AND draw_id=$2",
      [mandate.credit_id, mandate.draw_id]);
    if (draw && (job.credit_id === null || draw.job_id !== args.jobId)) return await skip("mandate_draw_owned_elsewhere");
    // The draw's amount is everything held for this job, the upfront included.
    const heldMicro = draw ? Number(draw.amount_micro) : 0;
    if (heldMicro + priced.amount_micro > mandate.max_total_micro) return await skip("mandate_total_cap");
    const content = { mandate: true, credit_id: mandate.credit_id, draw_id: mandate.draw_id, payment_id: paymentId,
      request_seq: ask.seq, amount_micro: priced.amount_micro, currency: priced.currency };
    const fingerprint = createHash("sha256").update(JSON.stringify([
      "mandate", args.dvmId, args.jobId, mandate.credit_id, mandate.draw_id, ask.seq, priced.amount_micro, priced.currency,
    ])).digest("hex");
    const response = await settleAskFromBalance({ tx, ledger: args.ledger, jobId: args.jobId, dvmId: args.dvmId, job,
      creditId: mandate.credit_id, drawId: mandate.draw_id, amountMicro: priced.amount_micro, credit: content,
      paymentId, fingerprint, requestSeq: ask.seq });
    await tx.query("COMMIT");
    return { outcome: "paid", requestSeq: ask.seq, seq: response.seq, replayed: false };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    if (requestSeq !== undefined && error instanceof CreditLedgerError) {
      // A draw id another job recorded first surfaces from the ledger rather than the job row.
      const reason: MandateSkipReason = error.code === "insufficient_credit" ? "mandate_balance"
        : error.code === "draw_conflict" ? "mandate_draw_owned_elsewhere" : "mandate_credit_unavailable";
      return { outcome: "skipped", requestSeq, reason };
    }
    // A conflict is a draw that appeared for another job; a clipped growth means the job's ask
    // total no longer covers this ask.
    if (requestSeq !== undefined && error instanceof BalancePaymentError) {
      return { outcome: "skipped", requestSeq,
        reason: error.body.error === "credit_payment_conflict" ? "mandate_draw_owned_elsewhere" : "mandate_ask_unpriced" };
    }
    throw error;
  } finally {
    tx.release();
  }
}

/**
 * Mandated jobs suspended on an ask that has gone quiet since `beforeMs`: the newest provider
 * message is still the ask, so either its settlement never ran (the asking worker died) or it
 * settled and no worker claimed the resume. A job with an unanswered prompt is left out: once
 * its paid ask is claimed it still awaits input, and the caller's answer resumes it anyway.
 * A provider prompt carries its id as `content.id`; the caller's answer names it as `prompt_id`.
 * Oldest first; pass the last row back as `after` for the next page.
 */
export async function findQuietMandatedAsks(pool: Pool, args: {
  dvmId: string; beforeMs: number; capabilities: string[]; limit: number;
  after?: { lastActivityAt: number; id: string };
}): Promise<{ id: string; lastActivityAt: number }[]> {
  const { rows } = await pool.query<{ id: string; last_activity_at: string }>(
    `SELECT j.id, j.last_activity_at FROM jobs j
     WHERE j.status='awaiting-input' AND j.mandate IS NOT NULL AND j.last_activity_at < $1
       AND (j.dvm_id IS NULL OR j.dvm_id=$2) AND j.capability = ANY($3::text[])
       AND ($5::bigint IS NULL OR (j.last_activity_at, j.id) > ($5::bigint, $6::text))
       AND (SELECT m.data->>'type' FROM job_messages m WHERE m.job_id=j.id AND m.status='verified'
            AND m.data->>'from'='provider' ORDER BY m.seq DESC LIMIT 1)='payment-request'
       AND NOT EXISTS (SELECT 1 FROM job_messages p WHERE p.job_id=j.id AND p.status='verified'
            AND p.data->>'from'='provider' AND p.data->>'type'='prompt'
            AND NOT EXISTS (SELECT 1 FROM job_messages r WHERE r.job_id=j.id AND r.status='verified'
              AND r.data->>'from'='requester' AND r.data->>'type'='response'
              AND r.data->'content'->>'prompt_id' = p.data->'content'->>'id'))
     ORDER BY j.last_activity_at, j.id LIMIT $4`,
    [args.beforeMs, args.dvmId, args.capabilities, args.limit, args.after?.lastActivityAt ?? null, args.after?.id ?? null]);
  return rows.map((row) => ({ id: row.id, lastActivityAt: Number(row.last_activity_at) }));
}

/** Emit the limit that left a mandated ask open. */
export function reportMandateSkip(settlement: MandateSettlement): void {
  if (settlement.outcome !== "skipped") return;
  diagnosticConsole.warn({ event: "mandate_payment_skipped", reason: settlement.reason });
}

async function none(tx: { query: (sql: string) => Promise<unknown> }): Promise<MandateSettlement> {
  await tx.query("ROLLBACK");
  return { outcome: "none" };
}
