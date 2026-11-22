import type { LockPubkey } from "../../lib/cashu/lock-pubkey";
import type { MessageType } from "../../lib/messages/types";
import { fromJobRecord, type ServerJob } from "./job";
import type { ProcessPaymentOutcome } from "./job-manager";
import type { JobRecord } from "./job-store";
import type { MintHealthTracker } from "./mint-health-tracker";

/** The two `JobManager` steps needed to accept a payment before routing it. */
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
 * Accept a payment without installing a handler. The store decides under the
 * job row lock whether it pays an open ask or lands as the caller's balance.
 */
export async function acceptLatePayment(args: {
  recorder: LatePaymentRecorder;
  record: JobRecord;
  content: Record<string, unknown>;
  receiveOptions: () => Promise<{ lockPubkeys?: LockPubkey[]; mintHealthTracker?: MintHealthTracker }>;
}): Promise<{ job: ServerJob; inboundSeq: number | null; outcome: ProcessPaymentOutcome }> {
  const job = fromJobRecord(args.record);
  const body = { type: "payment" as const, content: args.content };
  const inboundSeq = await args.recorder.recordInboundPending(job, body.type, body.content);
  const outcome = await args.recorder.processPayment(job, body, inboundSeq, await args.receiveOptions());
  return { job, inboundSeq, outcome };
}
