import { randomUUID } from "node:crypto";
import { isTerminal } from "./job";
import type { JobRecord, JobStore } from "./job-store";

/** Authenticated caller metadata; omitted fields on older services mean unknown. */
export interface JobContentMetadata {
  content_expires_at: number | null;
  content_available: boolean;
}

/** Admin-only history; reasons and signer identities never appear on caller responses. */
export interface ContentHoldsResponse extends JobContentMetadata {
  job_id: string;
  baseline_content_expires_at: number | null;
  holds: (ContentHold & { review_overdue: boolean })[];
  events: ContentHoldEvent[];
}

export interface ContentHoldEvent {
  id: string;
  hold_id: string;
  job_id: string;
  action: "placed" | "renewed" | "cleared";
  actor: string;
  reason: string;
  at: number;
  review_due_at: number;
}

export interface ContentHold {
  id: string;
  job_id: string;
  purpose: "support" | "dispute";
  reason: string;
  actor: string;
  created_at: number;
  review_due_at: number;
  cleared_at: number | null;
}

export interface ContentHoldHistory {
  holds: ContentHold[];
  events: ContentHoldEvent[];
}

export type ContentHoldMutation =
  | { action: "placed"; purpose: "support" | "dispute"; reason: string; review_due_at: number; actor: string; at: number }
  | { action: "renewed"; hold_id: string; reason: string; review_due_at: number; actor: string; at: number }
  | { action: "cleared"; hold_id: string; reason: string; actor: string; at: number };

/** Mutations and redaction must serialize on the same job, including across processes. */
export interface ContentHoldStore extends JobStore {
  getContentSnapshot(jobId: string, dvmId?: string): Promise<{ job: JobRecord; history: ContentHoldHistory } | undefined>;
  mutateContentHold(jobId: string, mutation: ContentHoldMutation, dvmId?: string): Promise<ContentHoldHistory>;
}

export class ContentHoldError extends Error {
  constructor(public readonly code: "job_not_found" | "content_unavailable" | "hold_not_active") {
    super(code);
  }
}

export function isContentHoldStore(store: JobStore): store is ContentHoldStore {
  return "getContentSnapshot" in store && "mutateContentHold" in store;
}

export function contentMetadata(
  job: Pick<JobRecord, "status" | "lastActivityAt" | "redactedAt">,
  retentionDays: number,
  holds: ContentHold[] = []
): JobContentMetadata {
  const baseline = baselineContentExpiry(job, retentionDays);
  return {
    content_expires_at: holds.some((hold) => hold.cleared_at === null) ? null : baseline,
    content_available: job.redactedAt === undefined,
  };
}

export function baselineContentExpiry(
  job: Pick<JobRecord, "status" | "lastActivityAt">,
  retentionDays: number
): number | null {
  return retentionDays > 0 && isTerminal(job.status)
    ? job.lastActivityAt + retentionDays * 86_400_000
    : null;
}

export function applyContentHoldMutation(
  job: JobRecord,
  history: ContentHoldHistory,
  mutation: ContentHoldMutation
): ContentHoldHistory {
  if (job.redactedAt !== undefined) throw new ContentHoldError("content_unavailable");
  const result = structuredClone(history);
  let hold: ContentHold;
  if (mutation.action === "placed") {
    hold = {
      id: randomUUID(), job_id: job.id, purpose: mutation.purpose,
      reason: mutation.reason, actor: mutation.actor, created_at: mutation.at,
      review_due_at: mutation.review_due_at, cleared_at: null,
    };
    result.holds.push(hold);
  } else {
    const existing = result.holds.find((item) => item.id === mutation.hold_id && item.cleared_at === null);
    if (!existing) throw new ContentHoldError("hold_not_active");
    hold = existing;
    if (mutation.action === "cleared") hold.cleared_at = mutation.at;
    else hold.review_due_at = mutation.review_due_at;
    hold.reason = mutation.reason;
  }
  result.events.push({
    id: randomUUID(), hold_id: hold.id, job_id: job.id, action: mutation.action,
    actor: mutation.actor, reason: mutation.reason, at: mutation.at,
    review_due_at: hold.review_due_at,
  });
  return result;
}
