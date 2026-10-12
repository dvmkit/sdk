import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
  ftruncateSync,
} from "node:fs";
import { CREDITS_FILE } from "../defaults";
import type {
  StoredCredit,
  StoredDrainEvidence,
  StoredImplicitCredit,
} from "./credit-store";
import { DvmError } from "./errors";
import { isDrainReceipt, type DrainReceipt } from "./receipt";
import type { ReceiptTrustAnchor } from "./receipt-verify";

interface CompletedCreditHistoryBase {
  v: 1;
  id: string;
  endpoint: string;
  endpointAliases: string[];
  dvmId: string | null;
  attestedBuilderPubkey: string | null;
  callerPubkey: string;
  creditId: string;
  /** Unsigned local terminal observation, epoch milliseconds. */
  occurredAt: number;
  rail: string | null;
  currency: string | null;
  amountMicro: number | null;
  /** Unknown fees are null, never an inferred zero. */
  feeMicro: number | null;
}

export interface CompletedRefundHistoryRecord extends CompletedCreditHistoryBase {
  kind: "completed_refund";
  outcome: "refunded";
  drainId: string;
  settledAt: number;
  /** Null for legacy missing collection times, including the working-store zero sentinel. */
  collectedAt: number | null;
  receipts: DrainReceipt[];
  anchor?: ReceiptTrustAnchor;
  /** Local settlement is unsigned; consumers authenticate receipts and the advertisement offline. */
  provenance: {
    settlement: "local_observation";
    receipts: "unverified_observations";
    advertisement: "present" | "absent";
  };
}

export interface ExpiredCreditLossHistoryRecord extends CompletedCreditHistoryBase {
  kind: "expired_credit_loss";
  outcome: "lost";
  reason: "expired" | "not_found";
  releasedAt: number;
  expiryMs: number;
  releasedByJobId: string;
}

export type CompletedCreditHistoryRecord =
  | CompletedRefundHistoryRecord
  | ExpiredCreditLossHistoryRecord;
export interface CompletedCreditHistoryQuery {
  /** Defaults to 50; must be an integer from 1 through 100. */
  limit?: number;
  /** Defaults to ascending occurrence time; descending returns the newest page first. */
  order?: "asc" | "desc";
  cursor?: string;
  endpoint?: string;
  dvmId?: string;
  callerPubkey?: string;
}
export interface CompletedCreditHistoryPage {
  records: CompletedCreditHistoryRecord[];
  nextCursor?: string;
}

function historyPath(): string {
  return `${CREDITS_FILE.slice(0, -5)}-history.jsonl`;
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function fail(detail: string): never {
  throw new DvmError(
    "credit_history_unavailable",
    `Completed credit history could not be preserved: ${detail}`,
    "Keep the credit store and history file intact, fix the file access or damage, and retry. Working evidence was not evicted.",
  );
}
const receiptKeys = new Set([
  "v",
  "kind",
  "credit_id",
  "drain_id",
  "event",
  "method",
  "amount_micro",
  "balance_after_micro",
  "ledger_seq",
  "issued_at",
  "caller_pubkey",
  "dvm_id",
  "dvm",
  "receipt_pubkey",
  "signature",
]);
const attestationKeys = new Set([
  "dvm_id",
  "slug",
  "capabilities_hash",
  "builder_pubkey",
  "receipt_pubkey",
  "deployed_at",
]);

// Preserve signed bytes exactly. An unknown field might contain a bearer credential: refuse
// eviction rather than either copying it or stripping it and invalidating the signature.
function safeReceipts(bundle: StoredDrainEvidence): DrainReceipt[] {
  const receipts: DrainReceipt[] = [];
  for (const receipt of bundle.receipts) {
    if (!isDrainReceipt(receipt))
      fail("a completed bundle contains an unrecognized receipt");
    if (Object.keys(receipt).some((key) => !receiptKeys.has(key)))
      fail("a receipt contains unsupported fields");
    if (
      Object.values(receipt).some(
        (value) =>
          (typeof value !== "string" && typeof value !== "number") ||
          (typeof value === "number" &&
            (!Number.isSafeInteger(value) || value < 0)),
      )
    )
      fail("a receipt contains unsupported values");
    receipts.push(receipt);
  }
  return receipts;
}
function safeAnchor(
  anchor: ReceiptTrustAnchor | undefined,
): ReceiptTrustAnchor | undefined {
  if (!anchor) return undefined;
  if (
    typeof anchor.pubkey !== "string" ||
    typeof anchor.signature !== "string" ||
    !anchor.attestation ||
    Object.keys(anchor.attestation).some((key) => !attestationKeys.has(key)) ||
    Object.values(anchor.attestation).some(
      (value) => typeof value !== "string" && typeof value !== "number",
    )
  )
    fail("an advertisement contains unsupported fields");
  return {
    pubkey: anchor.pubkey,
    signature: anchor.signature,
    attestation: anchor.attestation,
  };
}
function hasAttestedIdentity(record: {
  dvmId?: string | null;
  attestedBuilderPubkey?: string | null;
}): boolean {
  return Boolean(record.dvmId && record.attestedBuilderPubkey);
}
function compatibleLocations(
  left: CompletedCreditHistoryRecord,
  right: CompletedCreditHistoryRecord,
): boolean {
  if (hasAttestedIdentity(left) && hasAttestedIdentity(right))
    return (
      left.dvmId === right.dvmId &&
      left.attestedBuilderPubkey === right.attestedBuilderPubkey
    );
  return [left.endpoint, ...left.endpointAliases].some((origin) =>
    [right.endpoint, ...right.endpointAliases].includes(origin),
  );
}

function base(
  record: StoredCredit | StoredImplicitCredit,
  identity: string,
  occurredAt: number,
): CompletedCreditHistoryBase {
  return {
    v: 1,
    id: hash(
      JSON.stringify([
        record.callerPubkey,
        hasAttestedIdentity(record) ? record.dvmId : record.endpoint,
        hasAttestedIdentity(record) ? record.attestedBuilderPubkey : null,
        record.creditId,
        identity,
      ]),
    ),
    endpoint: record.endpoint,
    endpointAliases: record.endpointAliases ?? [],
    dvmId: record.dvmId ?? null,
    attestedBuilderPubkey: record.attestedBuilderPubkey ?? null,
    callerPubkey: record.callerPubkey,
    creditId: record.creditId,
    occurredAt,
    rail: null,
    currency: null,
    amountMicro: null,
    feeMicro: null,
  };
}
export function completedRefund(
  record: StoredCredit,
  bundle: StoredDrainEvidence,
): CompletedRefundHistoryRecord {
  const receipts = safeReceipts(bundle);
  const anchor = safeAnchor(bundle.anchor);
  const receipt = receipts.find(
    (r) => r.drain_id === bundle.drainId && r.credit_id === bundle.creditId,
  );
  const metadata = bundle.settlement;
  if (
    metadata &&
    ((metadata.rail !== null && typeof metadata.rail !== "string") ||
      (metadata.currency !== null && typeof metadata.currency !== "string") ||
      [metadata.amountMicro, metadata.feeMicro].some(
        (value) =>
          value !== null && (!Number.isSafeInteger(value) || value < 0),
      ))
  )
    fail("invalid settlement metadata");
  return {
    ...base(
      { ...record, creditId: bundle.creditId },
      `refund:${bundle.drainId}`,
      bundle.settledAt!,
    ),
    kind: "completed_refund",
    outcome: "refunded",
    drainId: bundle.drainId,
    settledAt: bundle.settledAt!,
    collectedAt: bundle.collectedAt === 0 ? null : bundle.collectedAt,
    rail: metadata?.rail ?? receipt?.method ?? null,
    currency: metadata?.currency ?? null,
    amountMicro: metadata?.amountMicro ?? receipt?.amount_micro ?? null,
    feeMicro: metadata?.feeMicro ?? null,
    receipts,
    ...(anchor ? { anchor } : {}),
    provenance: {
      settlement: "local_observation",
      receipts: "unverified_observations",
      advertisement: anchor ? "present" : "absent",
    },
  };
}
export function completedLoss(
  record: StoredImplicitCredit,
): ExpiredCreditLossHistoryRecord {
  return {
    ...base(record, "loss", record.updatedAt),
    kind: "expired_credit_loss",
    outcome: "lost",
    rail: record.creditId.startsWith("imp:")
      ? record.creditId.split(":")[1] || null
      : null,
    currency: record.currency,
    amountMicro: record.remainingMicro,
    reason: record.lossReason ?? "expired",
    releasedAt: record.releasedAt,
    expiryMs: record.expiryMs,
    releasedByJobId: record.releasedByJobId,
  };
}

function validateHistoryRecord(row: CompletedCreditHistoryRecord): void {
  if (
    !row ||
    row.v !== 1 ||
    typeof row.id !== "string" ||
    !Number.isSafeInteger(row.occurredAt) ||
    typeof row.endpoint !== "string" ||
    typeof row.callerPubkey !== "string" ||
    typeof row.creditId !== "string" ||
    !Array.isArray(row.endpointAliases) ||
    row.endpointAliases.some((value) => typeof value !== "string") ||
    [row.dvmId, row.attestedBuilderPubkey, row.currency, row.rail].some(
      (value) => value !== null && typeof value !== "string",
    ) ||
    [row.amountMicro, row.feeMicro].some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
    )
  )
    fail("invalid complete journal entry");
  if (row.kind === "completed_refund") {
    if (
      row.outcome !== "refunded" ||
      typeof row.drainId !== "string" ||
      !Number.isSafeInteger(row.settledAt) ||
      (row.collectedAt !== null && !Number.isSafeInteger(row.collectedAt)) ||
      !Array.isArray(row.receipts) ||
      row.provenance?.settlement !== "local_observation" ||
      row.provenance.receipts !== "unverified_observations" ||
      !["present", "absent"].includes(row.provenance.advertisement)
    )
      fail("invalid refund entry");
    safeReceipts({
      drainId: row.drainId,
      creditId: row.creditId,
      receipts: row.receipts,
      collectedAt: row.collectedAt ?? 0,
    });
    safeAnchor(row.anchor);
  } else if (row.kind === "expired_credit_loss") {
    if (
      row.outcome !== "lost" ||
      !["expired", "not_found"].includes(row.reason) ||
      !Number.isSafeInteger(row.releasedAt) ||
      !Number.isSafeInteger(row.expiryMs) ||
      typeof row.releasedByJobId !== "string"
    )
      fail("invalid loss entry");
  } else fail("invalid complete journal entry");
}

interface Journal {
  bytes: Buffer;
  complete: number;
  rows: CompletedCreditHistoryRecord[];
}
function journal(): Journal {
  let bytes: Buffer;
  try {
    bytes = readFileSync(historyPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { bytes: Buffer.alloc(0), complete: 0, rows: [] };
    fail(error instanceof Error ? error.message : String(error));
  }
  const complete = bytes.lastIndexOf(10) + 1;
  const rows = bytes
    .subarray(0, complete)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      let row: CompletedCreditHistoryRecord;
      try {
        row = JSON.parse(line) as CompletedCreditHistoryRecord;
      } catch {
        fail("damaged complete journal line");
      }
      validateHistoryRecord(row);
      return row;
    });
  return { bytes, complete, rows };
}

/** Caller holds the credit lock, including during tail recovery and fsync. */
export function archiveCompletedCreditRecords(
  records: CompletedCreditHistoryRecord[],
): void {
  if (!records.length) return;
  try {
    const current = journal();
    const latest = new Map(
      current.rows.map((record) => [record.id, JSON.stringify(record)]),
    );
    const observed = new Map(current.rows.map((record) => [record.id, record]));
    const additions: string[] = [];
    for (const incoming of records) {
      // A learned advertisement or alias must not create a second logical completion.
      const prior = [...observed.values()]
        .reverse()
        .find(
          (row) =>
            row.kind === incoming.kind &&
            row.callerPubkey === incoming.callerPubkey &&
            row.creditId === incoming.creditId &&
            (row.kind !== "completed_refund" ||
              (incoming.kind === "completed_refund" &&
                row.drainId === incoming.drainId)) &&
            compatibleLocations(row, incoming),
        );
      // The journal may be ahead of credits.json after an append succeeded but the store
      // rename failed. Replaying that older source must not retract the durable evidence.
      const newerPrior =
        prior &&
        (incoming.kind === "completed_refund" &&
        prior.kind === "completed_refund"
          ? (prior.collectedAt ?? 0) > (incoming.collectedAt ?? 0)
          : prior.occurredAt > incoming.occurredAt);
      const facts = newerPrior ? prior : incoming;
      // Identity learning and accumulated locations must survive an older or equal-time
      // source replay even when its terminal facts are admitted as a new revision.
      const identity =
        prior && hasAttestedIdentity(prior)
          ? prior
          : hasAttestedIdentity(incoming)
            ? incoming
            : newerPrior || (!incoming.dvmId && !incoming.attestedBuilderPubkey)
              ? (prior ?? incoming)
              : incoming;
      const record = prior
        ? {
            ...facts,
            id: prior.id,
            dvmId: identity.dvmId,
            attestedBuilderPubkey: identity.attestedBuilderPubkey,
            endpointAliases: [
              ...new Set([
                prior.endpoint,
                ...prior.endpointAliases,
                incoming.endpoint,
                ...incoming.endpointAliases,
              ]),
            ].filter((origin) => origin !== facts.endpoint),
          }
        : incoming;
      validateHistoryRecord(record);
      const encoded = JSON.stringify(record);
      if (latest.get(record.id) === encoded) continue;
      additions.push(encoded + "\n");
      latest.set(record.id, encoded);
      observed.set(record.id, record);
    }
    const fd = openSync(historyPath(), "a", 0o600);
    try {
      // Only an uncommitted trailing fragment is removable; complete corrupt lines fail closed.
      if (current.complete !== current.bytes.length)
        ftruncateSync(fd, current.complete);
      const bytes = Buffer.from(additions.join(""));
      let written = 0;
      while (written < bytes.length) {
        const count = writeSync(fd, bytes, written, bytes.length - written);
        if (!count) fail("zero-length append");
        written += count;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    {
      const directory = openSync(
        historyPath().slice(0, historyPath().lastIndexOf("/")),
        "r",
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** Snapshot pagination scans the local journal; only the returned page is bounded. */
export function readCreditHistoryPage(
  query: CompletedCreditHistoryQuery,
): CompletedCreditHistoryPage {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new DvmError(
      "invalid_credit_history_query",
      "History page limit must be an integer from 1 through 100.",
    );
  const order = query.order ?? "asc";
  if (order !== "asc" && order !== "desc")
    throw new DvmError(
      "invalid_credit_history_query",
      "History order must be asc or desc.",
    );
  const direction = order === "asc" ? 1 : -1;
  const filter = JSON.stringify([
    order,
    query.endpoint ? new URL(query.endpoint).origin : null,
    query.dvmId ?? null,
    query.callerPubkey ?? null,
  ]);
  const current = journal();
  let end = current.complete;
  let after: [number, string] | undefined;
  if (query.cursor) {
    try {
      const cursor = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      ) as {
        v: number;
        end: number;
        prefix: string;
        filter: string;
        after: [number, string];
      };
      if (
        cursor.v !== 1 ||
        !Number.isSafeInteger(cursor.end) ||
        cursor.end < 0 ||
        cursor.end > current.complete ||
        (cursor.end > 0 && current.bytes[cursor.end - 1] !== 10) ||
        cursor.filter !== filter ||
        cursor.prefix !==
          hash(current.bytes.subarray(0, cursor.end).toString("utf8")) ||
        !Array.isArray(cursor.after) ||
        !Number.isFinite(cursor.after[0]) ||
        typeof cursor.after[1] !== "string"
      )
        throw new Error("cursor mismatch");
      end = cursor.end;
      after = cursor.after;
    } catch {
      throw new DvmError(
        "invalid_credit_history_cursor",
        "History cursor is invalid, stale, or belongs to different filters.",
      );
    }
  }
  const rows = current.bytes
    .subarray(0, end)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CompletedCreditHistoryRecord);
  const endpoint = query.endpoint ? new URL(query.endpoint).origin : undefined;
  const ordered = [...new Map(rows.map((row) => [row.id, row])).values()]
    .filter(
      (row) =>
        (!endpoint ||
          row.endpoint === endpoint ||
          row.endpointAliases.includes(endpoint)) &&
        (!query.dvmId || row.dvmId === query.dvmId) &&
        (!query.callerPubkey || row.callerPubkey === query.callerPubkey),
    )
    .sort(
      (a, b) =>
        direction *
        (a.occurredAt - b.occurredAt ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
  const remaining = ordered.filter(
    (row) =>
      !after ||
      direction * (row.occurredAt - after[0]) > 0 ||
      (row.occurredAt === after[0] &&
        (direction === 1 ? row.id > after[1] : row.id < after[1])),
  );
  const records = remaining.slice(0, limit);
  const last = records.at(-1);
  return {
    records,
    ...(remaining.length > limit && last
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              v: 1,
              end,
              prefix: hash(current.bytes.subarray(0, end).toString("utf8")),
              filter,
              after: [last.occurredAt, last.id],
            }),
          ).toString("base64url"),
        }
      : {}),
  };
}
