import type { LockPubkey } from "../../lib/cashu/lock-pubkey";
import type { MessageType } from "../../lib/messages/types";
import { fromJobRecord, type ServerJob } from "./job";
import type { ProcessPaymentOutcome } from "./job-manager";
import type { JobRecord } from "./job-store";
import type { MintHealthTracker } from "./mint-health-tracker";

/** The two `JobManager` steps a late payment runs, and nothing that resumes a handler. */
export interface LatePaymentRecorder {
  recordInboundPending(job: ServerJob, msgType: MessageType, msgContent: Record<string, unknown>): Promise<number | null>;
  processPayment(
    job: ServerJob,
    body: { type: MessageType; content: Record<string, unknown> },
    inboundSeq: number | null,
    extra?: { lockPubkeys?: LockPubkey[]; mintHealthTracker?: MintHealthTracker }
  ): Promise<ProcessPaymentOutcome>;
}

/**
 * Accept a paid message for a job that already ended. The money has reached
 * the DVM — a Cashu token is locked to it and cannot be spent elsewhere until
 * its locktime — so it is recorded, verified and landed on credit as balance
 * the caller owns, never refused for arriving late. The job is read from the
 * store and handled detached: no handler resumes, no receipt or snapshot is
 * rewritten. The disposition is decided again under the job row lock, so a job
 * whose end has not committed yet still has its ask paid first.
 */
export async function acceptLatePayment(args: {
  recorder: LatePaymentRecorder;
  record: JobRecord;
  content: Record<string, unknown>;
  extra: { lockPubkeys?: LockPubkey[]; mintHealthTracker?: MintHealthTracker };
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const job = fromJobRecord(args.record);
  const body = { type: "payment" as const, content: args.content };
  const inboundSeq = await args.recorder.recordInboundPending(job, body.type, body.content);
  const outcome = await args.recorder.processPayment(job, body, inboundSeq, args.extra);
  if (outcome.error) return { status: outcome.error.status, body: outcome.error.body };
  return {
    status: 201,
    body: {
      seq: inboundSeq ?? job.seq,
      ...(outcome.unappliedCredit && { credit: outcome.unappliedCredit }),
      ...(outcome.drawFundingReceipt && { draw_funding_receipt: outcome.drawFundingReceipt }),
    },
  };
}
