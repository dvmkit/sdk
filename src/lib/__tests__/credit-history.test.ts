import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dir: "",
  failWrite: false,
  failSync: false,
  failWritesAlways: false,
}));
vi.mock("../../defaults", async (original) => ({
  ...(await original<typeof import("../../defaults")>()),
  get CONFIG_DIR() {
    return state.dir;
  },
  get CREDITS_FILE() {
    return join(state.dir, "credits.json");
  },
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      if (state.failWrite || state.failWritesAlways) {
        state.failWrite = false;
        fs.writeSync(args[0], Buffer.from('{"v":1'));
        throw new Error("interrupted append");
      }
      return fs.writeSync(...args);
    },
    fsyncSync: (fd: number) => {
      if (state.failSync) {
        state.failSync = false;
        state.failWritesAlways = false;
        throw new Error("sync failed");
      }
      fs.fsyncSync(fd);
    },
  };
});
import {
  applyImplicitReceiptCredit,
  ensureProvisionalCredit,
  forgetCredit,
  markImplicitCreditLost,
  listCredits,
  loadCredit,
  recordPendingDrain,
  listImplicitCredits,
  readCompletedCreditHistory,
  recordDrainReceipts,
  settleDrainEvidence,
} from "../credit-store";
import {
  archiveCompletedCreditRecords,
  completedLoss,
} from "../credit-history";
import { attestedDvm } from "./fixtures/receipt-fixture";
import { verifyDrainReceiptChain } from "../receipt-verify";

const root = mkdtempSync(join(tmpdir(), "credit-history-"));
const children = new Set<ChildProcess>();
const endpoint = "https://refund.example.com";
const caller = "bb".repeat(32);
const dvm = attestedDvm();
const pending = {
  drainId: "unresolved",
  creditId: "credit",
  method: "tempo",
  payout: {},
  requestedAt: 1,
  mppCredential: "SECRET-RECOVERY",
};
function credit() {
  return {
    endpoint,
    callerPubkey: caller,
    creditId: "credit",
    currency: "usd",
    balanceMicro: 100,
    remainingMicro: 100,
    ledgerSeq: 1,
    expiryMs: 9e12,
    targetMicro: 100,
    status: "active",
    openedAt: 1,
    updatedAt: 1,
    pendingDrains: [pending],
  };
}
function loss(i: number) {
  return {
    endpoint,
    callerPubkey: caller,
    creditId: `imp:cashu:payment-${i}`,
    currency: "usd",
    remainingMicro: 123,
    ledgerSeq: 1,
    expiryMs: 100,
    status: "lost",
    lossReason: "expired",
    releasedByJobId: `job-${i}`,
    releasedAt: 1,
    updatedAt: 200 + i,
  };
}
function store(
  credits: unknown[] = [credit()],
  implicitCredits: unknown[] = [],
) {
  writeFileSync(
    join(state.dir, "credits.json"),
    JSON.stringify({ credits, implicitCredits }),
  );
}
function refund(id: string, at = 300) {
  recordDrainReceipts({
    endpoint,
    callerPubkey: caller,
    drainId: id,
    creditId: "credit",
    receipts: [
      dvm.signDrain({
        drain_id: id,
        credit_id: "credit",
        event: "sent",
        amount_micro: 321,
      }),
    ],
    read: { reachable: true, anchor: dvm.anchor },
    now: 250,
  });
  settleDrainEvidence({
    endpoint,
    callerPubkey: caller,
    drainId: id,
    now: at,
    settlement: {
      rail: "cashu",
      currency: "usd",
      amountMicro: 321,
      feeMicro: 7,
    },
  });
}
beforeEach(() => {
  state.dir = mkdtempSync(join(root, "case-"));
  state.failWrite = false;
  state.failSync = false;
});
afterAll(async () => {
  // Vitest timeouts do not cancel spawned processes; stop them before removing their files.
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once("close", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  rmSync(root, { recursive: true, force: true });
});

describe("completed credit history", () => {
  it("retains refunds and losses beyond the working caps, with signed offline evidence and no credentials", () => {
    store();
    for (let i = 0; i < 12; i++) refund(`drain-${i}`, 300 + i);
    store(
      listCredits(),
      Array.from({ length: 12 }, (_, i) => loss(i)),
    );
    expect(listImplicitCredits()).toHaveLength(8);
    expect(listCredits()[0].drainEvidence).toHaveLength(8);
    const records = readCompletedCreditHistory({ limit: 100 }).records;
    expect(records).toHaveLength(24);
    const refundRecord = records.find(
      (record) => record.kind === "completed_refund",
    )!;
    expect(refundRecord).toMatchObject({
      rail: "cashu",
      currency: "usd",
      amountMicro: 321,
      feeMicro: 7,
      settledAt: 300,
      collectedAt: 250,
      outcome: "refunded",
    });
    if (refundRecord.kind !== "completed_refund")
      throw new Error("missing refund");
    expect(
      verifyDrainReceiptChain({
        receipt: refundRecord.receipts[0],
        builder: refundRecord.anchor,
        expectedDrainId: refundRecord.drainId,
        expectedCreditId: refundRecord.creditId,
      }).status,
    ).toBe("verified");
    const archived = readFileSync(
      join(state.dir, "credits-history.jsonl"),
      "utf8",
    );
    expect(archived).not.toContain("SECRET-RECOVERY");
    expect(archived).not.toContain("mppCredential");
    expect(listCredits()[0].pendingDrains).toEqual([pending]);
  });

  it("paginates equal timestamps and filtered snapshots without including later appends", () => {
    store(
      [],
      Array.from({ length: 11 }, (_, i) => ({ ...loss(i), updatedAt: 500 })),
    );
    const first = readCompletedCreditHistory({ limit: 3, endpoint });
    store(
      [],
      [
        { ...loss(99), endpoint: "https://other.example.com", updatedAt: 500 },
        { ...loss(100), updatedAt: 1 },
      ],
    );
    readCompletedCreditHistory();
    const records = [...first.records];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = readCompletedCreditHistory({ limit: 3, endpoint, cursor });
      records.push(...page.records);
      cursor = page.nextCursor;
    }
    expect(records).toHaveLength(11);
    expect(new Set(records.map((record) => record.id)).size).toBe(11);
    expect(records.map((record) => record.creditId)).not.toContain(
      "imp:cashu:payment-100",
    );
    expect(
      readCompletedCreditHistory({ limit: 100, endpoint }).records,
    ).toHaveLength(12);
    expect(() =>
      readCompletedCreditHistory({
        cursor: first.nextCursor,
        endpoint: "https://other.example.com",
      }),
    ).toThrow("different filters");
    expect(() => readCompletedCreditHistory({ limit: 101 })).toThrow(
      "1 through 100",
    );
  });

  it("returns newest-first snapshot pages with descending equal-time ties and direction-bound cursors", () => {
    store(
      [],
      Array.from({ length: 11 }, (_, i) => ({
        ...loss(i),
        updatedAt: i < 8 ? 500 : 600,
      })),
    );
    const ascending = readCompletedCreditHistory({
      limit: 100,
      endpoint,
    }).records;
    const first = readCompletedCreditHistory({
      limit: 3,
      endpoint,
      order: "desc",
    });
    store([], [{ ...loss(100), updatedAt: 900 }]);
    readCompletedCreditHistory();
    const records = [...first.records];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = readCompletedCreditHistory({
        limit: 3,
        endpoint,
        order: "desc",
        cursor,
      });
      records.push(...page.records);
      cursor = page.nextCursor;
    }
    expect(records).toEqual([...ascending].reverse());
    expect(
      readCompletedCreditHistory({ limit: 1, endpoint, order: "desc" })
        .records[0].creditId,
    ).toBe("imp:cashu:payment-100");
    expect(() =>
      readCompletedCreditHistory({ endpoint, cursor: first.nextCursor }),
    ).toThrow("different filters");
    expect(() =>
      readCompletedCreditHistory({ order: "invalid" as "asc" }),
    ).toThrow("asc or desc");
  });

  it("fails closed on interrupted append and retries a torn tail without losing or duplicating evidence", () => {
    store(
      [],
      Array.from({ length: 10 }, (_, i) => loss(i)),
    );
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    state.failWrite = true;
    expect(() => readCompletedCreditHistory()).toThrow("interrupted append");
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    expect(readCompletedCreditHistory({ limit: 100 }).records).toHaveLength(10);
    const journal = readFileSync(
      join(state.dir, "credits-history.jsonl"),
      "utf8",
    );
    listImplicitCredits();
    readCompletedCreditHistory();
    expect(readFileSync(join(state.dir, "credits-history.jsonl"), "utf8")).toBe(
      journal,
    );
    expect(listImplicitCredits()).toHaveLength(8);
  });

  it("retries a complete but unsynced append before eviction", () => {
    store(
      [],
      Array.from({ length: 10 }, (_, i) => loss(i)),
    );
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    state.failSync = true;
    expect(() => readCompletedCreditHistory()).toThrow("sync failed");
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    state.failSync = true;
    expect(() => readCompletedCreditHistory()).toThrow("sync failed");
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    expect(readCompletedCreditHistory({ limit: 100 }).records).toHaveLength(10);
    expect(
      readFileSync(join(state.dir, "credits-history.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(10);
  });

  it("preserves completed source bundles on unsupported secret fields and refuses corrupt complete journal lines", () => {
    store();
    refund("good");
    const record = listCredits()[0];
    record.drainEvidence!.push({
      drainId: "bad",
      creditId: "credit",
      collectedAt: 1,
      settledAt: 2,
      receipts: [
        {
          ...dvm.signDrain({ drain_id: "bad", credit_id: "credit" }),
          proofs: "SECRET-PROOF",
        },
      ],
    });
    store([record]);
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    expect(() => readCompletedCreditHistory()).toThrow("unsupported fields");
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    expect(
      readFileSync(join(state.dir, "credits-history.jsonl"), "utf8"),
    ).not.toContain("SECRET-PROOF");
    store([], [loss(1)]);
    appendFileSync(join(state.dir, "credits-history.jsonl"), "{bad}\n");
    expect(() => readCompletedCreditHistory()).toThrow();
    expect(
      JSON.parse(readFileSync(join(state.dir, "credits.json"), "utf8"))
        .implicitCredits,
    ).toHaveLength(1);
  });

  it("archives colliding provider refunds before each working projection evicts evidence", () => {
    const otherDvm = attestedDvm("other");
    const providers = [
      { endpoint, dvm, dvmId: "dvm-wordcount" },
      { endpoint: "https://other.example.com", dvm: otherDvm, dvmId: "dvm-other" },
    ];
    for (const provider of providers) {
      const identity = { dvmId: provider.dvmId, builderPubkey: provider.dvm.identity.pubkey };
      ensureProvisionalCredit({
        endpoint: provider.endpoint,
        identity,
        callerPubkey: caller,
        creditId: "credit",
        currency: "usd",
        targetMicro: 100,
      });
      for (let i = 0; i < 10; i++) {
        const drainId = `refund-${i}`;
        recordDrainReceipts({
          endpoint: provider.endpoint,
          identity,
          callerPubkey: caller,
          creditId: "credit",
          drainId,
          receipts: [provider.dvm.signDrain({
            drain_id: drainId,
            credit_id: "credit",
            event: "sent",
            amount_micro: 321,
          })],
          read: { reachable: true, anchor: provider.dvm.anchor },
          now: 250 + i,
        });
        settleDrainEvidence({
          endpoint: provider.endpoint,
          identity,
          callerPubkey: caller,
          drainId,
          now: 300 + i,
          settlement: { rail: "cashu", currency: "usd", amountMicro: 321, feeMicro: 7 },
        });
      }
    }

    const working = listCredits();
    expect(working).toHaveLength(2);
    expect(working.map((record) => record.drainEvidence?.length)).toEqual([8, 8]);
    expect(readCompletedCreditHistory({ limit: 100 }).records).toHaveLength(20);
    for (const provider of providers) {
      const archived = readCompletedCreditHistory({ endpoint: provider.endpoint }).records;
      expect(archived).toHaveLength(10);
      expect(archived.every((record) => record.dvmId === provider.dvmId && record.endpointAliases.length === 0))
        .toBe(true);
      for (const record of archived) {
        expect(record.kind).toBe("completed_refund");
        if (record.kind === "completed_refund") {
          expect(verifyDrainReceiptChain({
            receipt: record.receipts[0],
            builder: record.anchor,
            expectedDrainId: record.drainId,
            expectedCreditId: record.creditId,
          }).status).toBe("verified");
        }
      }
    }
  });

  it("preserves stable refund identity after endpoint aliases and DVM identity become known", () => {
    store();
    refund("identity");
    const before = readCompletedCreditHistory().records[0];
    const record = listCredits()[0];
    record.dvmId = "dvm-wordcount";
    record.attestedBuilderPubkey = dvm.identity.pubkey;
    record.endpointAliases = ["https://alias.example.com"];
    store([record]);
    const after = readCompletedCreditHistory({
      endpoint: "https://alias.example.com",
      dvmId: "dvm-wordcount",
    }).records;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(readCompletedCreditHistory().records).toHaveLength(1);
  });

  it("deduplicates a learned identity within one batch, preserves its first ID and newer revision on replay, and separates conflicting identities", () => {
    const original = {
      ...loss(1),
      status: "lost" as const,
      lossReason: "expired" as const,
    };
    const learned = {
      ...original,
      dvmId: "dvm-wordcount",
      attestedBuilderPubkey: dvm.identity.pubkey,
      updatedAt: 600,
    };
    const stale = { ...original, updatedAt: 400 };
    const records = [original, learned, stale].map(completedLoss);
    archiveCompletedCreditRecords(records);
    const staged = readCompletedCreditHistory({ limit: 100 }).records;
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      id: records[0].id,
      dvmId: learned.dvmId,
      occurredAt: 600,
    });
    rmSync(join(state.dir, "credits-history.jsonl"));
    store([], [original, learned]);
    const seeded = readCompletedCreditHistory({ limit: 100 }).records;
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      id: records[0].id,
      dvmId: learned.dvmId,
      occurredAt: 600,
    });
    archiveCompletedCreditRecords(records);
    store([], [original, learned]);
    expect(readCompletedCreditHistory({ limit: 100 }).records).toEqual(seeded);
    const conflict = {
      ...learned,
      dvmId: "dvm-other",
      attestedBuilderPubkey: "cc".repeat(32),
    };
    archiveCompletedCreditRecords([
      completedLoss(learned),
      completedLoss(conflict),
    ]);
    expect(readCompletedCreditHistory({ limit: 100 }).records).toHaveLength(2);
  });

  it("preserves learned identity and aliases across equal-time and newer unknown replay without bridging conflicting identities", () => {
    const known = {
      ...loss(1),
      updatedAt: 600,
      dvmId: "dvm-a",
      attestedBuilderPubkey: dvm.identity.pubkey,
      endpointAliases: ["https://alias.example.com"],
    };
    store([], [known]);
    const canonical = readCompletedCreditHistory().records[0].id;
    store([], [{ ...loss(1), updatedAt: 600 }]);
    expect(readCompletedCreditHistory().records).toMatchObject([
      {
        id: canonical,
        dvmId: "dvm-a",
        attestedBuilderPubkey: dvm.identity.pubkey,
        endpointAliases: known.endpointAliases,
      },
    ]);
    expect(
      readCompletedCreditHistory({ endpoint: known.endpointAliases[0] })
        .records,
    ).toHaveLength(1);
    store([], [{ ...loss(1), updatedAt: 700, remainingMicro: 456 }]);
    expect(readCompletedCreditHistory().records).toMatchObject([
      {
        id: canonical,
        dvmId: "dvm-a",
        occurredAt: 700,
        amountMicro: 456,
        endpointAliases: known.endpointAliases,
      },
    ]);
    store(
      [],
      [
        {
          ...loss(1),
          updatedAt: 500,
          endpointAliases: ["https://older.example.com"],
        },
      ],
    );
    expect(
      readCompletedCreditHistory({ endpoint: "https://older.example.com" })
        .records,
    ).toMatchObject([
      { id: canonical, dvmId: "dvm-a", occurredAt: 700, amountMicro: 456 },
    ]);
    store(
      [],
      [
        {
          ...known,
          dvmId: "dvm-b",
          attestedBuilderPubkey: "cc".repeat(32),
          updatedAt: 700,
        },
      ],
    );
    const separated = readCompletedCreditHistory({ limit: 100 }).records;
    expect(separated).toHaveLength(2);
    expect(separated.map((row) => row.dvmId).sort()).toEqual([
      "dvm-a",
      "dvm-b",
    ]);
    expect(readCompletedCreditHistory({ limit: 100 }).records).toEqual(
      separated,
    );
  });

  it("upgrades partial identity on the same origin without authenticating unrelated hosts by a claimed ID", () => {
    const partial = { ...loss(1), updatedAt: 600, dvmId: "dvm-a" };
    const otherHost = { ...partial, endpoint: "https://other.example.com" };
    store([], [partial, otherHost]);
    const unverified = readCompletedCreditHistory({ limit: 100 }).records;
    expect(unverified).toHaveLength(2);
    const canonical = unverified.find((row) => row.endpoint === endpoint)!.id;
    const complete = {
      ...partial,
      attestedBuilderPubkey: dvm.identity.pubkey,
      endpointAliases: ["https://alias.example.com"],
    };
    store([], [complete, otherHost]);
    const learned = readCompletedCreditHistory({ limit: 100 }).records;
    expect(learned).toHaveLength(2);
    expect(
      readCompletedCreditHistory({ endpoint: "https://alias.example.com" })
        .records,
    ).toMatchObject([
      {
        id: canonical,
        dvmId: "dvm-a",
        attestedBuilderPubkey: dvm.identity.pubkey,
      },
    ]);
    store([], [partial, otherHost]);
    expect(readCompletedCreditHistory({ limit: 100 }).records).toEqual(learned);
    store(
      [],
      [
        {
          ...complete,
          endpoint: "https://relocated.example.com",
          endpointAliases: [],
        },
        otherHost,
      ],
    );
    expect(readCompletedCreditHistory({ limit: 100 }).records).toHaveLength(2);
    expect(readCompletedCreditHistory({ endpoint }).records).toMatchObject([
      { id: canonical, attestedBuilderPubkey: dvm.identity.pubkey },
    ]);
    expect(
      readCompletedCreditHistory({ endpoint: otherHost.endpoint }).records,
    ).toMatchObject([{ attestedBuilderPubkey: null }]);
  });

  it("archives legacy missing and zero-sentinel collection times as unknown while preserving known times and working compatibility", () => {
    const evidence = [undefined, 0, 90].map((collectedAt, i) => ({
      drainId: `legacy-time-${i}`,
      creditId: "credit",
      settledAt: 300 + i,
      ...(collectedAt === undefined ? {} : { collectedAt }),
      receipts: [
        dvm.signDrain({ drain_id: `legacy-time-${i}`, credit_id: "credit" }),
      ],
    }));
    store([{ ...credit(), drainEvidence: evidence }]);
    const records = readCompletedCreditHistory().records;
    expect(
      records.map((row) =>
        row.kind === "completed_refund" ? row.collectedAt : undefined,
      ),
    ).toEqual([null, null, 90]);
    expect(records.map((row) => row.occurredAt)).toEqual([300, 301, 302]);
    expect(
      loadCredit(endpoint, caller)?.drainEvidence?.map(
        (row) => row.collectedAt,
      ),
    ).toEqual([0, 0, 90]);
    expect(readCompletedCreditHistory().records).toEqual(records);
  });

  it("seeds legacy settled bundles on load before a subsequent working projection trim", () => {
    const evidence = Array.from({ length: 10 }, (_, i) => ({
      drainId: `legacy-${i}`,
      creditId: "credit",
      collectedAt: 90,
      settledAt: 100 + i,
      receipts: [
        dvm.signDrain({ drain_id: `legacy-${i}`, credit_id: "credit" }),
      ],
      anchor: dvm.anchor,
    }));
    store([{ ...credit(), drainEvidence: evidence }]);
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    state.failWrite = true;
    expect(() => readCompletedCreditHistory()).toThrow("interrupted append");
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    const seeded = readCompletedCreditHistory({ limit: 100 }).records;
    expect(seeded).toHaveLength(10);
    expect(seeded[0]).toMatchObject({
      settledAt: 100,
      collectedAt: 90,
      currency: null,
      feeMicro: null,
    });
    refund("new", 200);
    expect(listCredits()[0].drainEvidence).toHaveLength(8);
    expect(readCompletedCreditHistory({ limit: 100 }).records).toHaveLength(11);
  });

  it("does not replace a newer archived bundle with a replayed older working projection", () => {
    store();
    refund("replayed");
    const oldProjection = readFileSync(join(state.dir, "credits.json"), "utf8");
    recordDrainReceipts({
      endpoint,
      callerPubkey: caller,
      drainId: "replayed",
      creditId: "credit",
      receipts: [
        dvm.signDrain({
          drain_id: "replayed",
          credit_id: "credit",
          event: "picked_up",
        }),
      ],
      read: { reachable: true, anchor: dvm.anchor },
      now: 400,
    });
    writeFileSync(join(state.dir, "credits.json"), oldProjection);
    const records = readCompletedCreditHistory().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      collectedAt: 400,
      receipts: [expect.objectContaining({ event: "picked_up" })],
      settledAt: 300,
    });
  });

  it("does not borrow a replacement credit's denomination for an older refund", () => {
    store([{ ...credit(), creditId: "replacement", currency: "eur" }]);
    recordDrainReceipts({
      endpoint,
      callerPubkey: caller,
      drainId: "older-credit",
      creditId: "credit",
      receipts: [
        dvm.signDrain({
          drain_id: "older-credit",
          credit_id: "credit",
          event: "sent",
        }),
      ],
      read: { reachable: true, anchor: dvm.anchor },
      now: 250,
    });
    settleDrainEvidence({
      endpoint,
      callerPubkey: caller,
      drainId: "older-credit",
      now: 300,
    });
    expect(readCompletedCreditHistory().records[0]).toMatchObject({
      creditId: "credit",
      currency: null,
      feeMicro: null,
    });
  });

  it("keeps active recovery usable without trimming unsupported completed observations", () => {
    const evidence = Array.from({ length: 10 }, (_, i) => ({
      drainId: `opaque-${i}`,
      creditId: "credit",
      receipts: [{ event: "sent", bearer: "SECRET-OPAQUE" }],
      collectedAt: 100,
      settledAt: 200 + i,
    }));
    store([{ ...credit(), drainEvidence: evidence }]);
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    expect(loadCredit(endpoint, caller)?.pendingDrains).toEqual([pending]);
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    expect(() => readCompletedCreditHistory()).toThrow("unrecognized receipt");
    const retry = { ...pending, drainId: "new-retry" };
    recordPendingDrain(endpoint, caller, retry);
    expect(loadCredit(endpoint, caller)?.pendingDrains).toEqual([
      pending,
      retry,
    ]);
    expect(loadCredit(endpoint, caller)?.drainEvidence).toEqual(evidence);
    expect(
      JSON.parse(readFileSync(join(state.dir, "credits.json"), "utf8"))
        .credits[0].drainEvidence,
    ).toEqual(evidence);
  });

  it("keeps active reads and retry writes usable on persistent archive I/O failure without evicting completed sources", () => {
    const evidence = Array.from({ length: 10 }, (_, i) => ({
      drainId: `io-${i}`,
      creditId: "credit",
      receipts: [
        dvm.signDrain({
          drain_id: `io-${i}`,
          credit_id: "credit",
          event: "sent",
        }),
      ],
      collectedAt: 100,
      settledAt: 200 + i,
    }));
    const losses = Array.from({ length: 10 }, (_, i) => loss(i));
    store([{ ...credit(), drainEvidence: evidence }], losses);
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    state.failWritesAlways = true;
    expect(loadCredit(endpoint, caller)?.pendingDrains).toEqual([pending]);
    expect(listImplicitCredits()).toHaveLength(10);
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    expect(() => readCompletedCreditHistory()).toThrow("interrupted append");
    const retry = { ...pending, drainId: "io-retry" };
    recordPendingDrain(endpoint, caller, retry);
    const persisted = JSON.parse(
      readFileSync(join(state.dir, "credits.json"), "utf8"),
    );
    expect(persisted.credits[0].pendingDrains).toEqual([pending, retry]);
    expect(persisted.credits[0].drainEvidence).toEqual(evidence);
    expect(persisted.implicitCredits).toEqual(losses);
    state.failWritesAlways = false;
    expect(readCompletedCreditHistory({ limit: 100 }).records).toHaveLength(20);
    expect(loadCredit(endpoint, caller)?.drainEvidence).toHaveLength(8);
    expect(listImplicitCredits()).toHaveLength(8);
  });

  it("requires successful archival before explicit forgetting removes completed evidence", () => {
    store();
    refund("forgotten");
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    rmSync(join(state.dir, "credits-history.jsonl"));
    state.failWritesAlways = true;
    expect(() => forgetCredit(endpoint, caller)).toThrow("interrupted append");
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    state.failWritesAlways = false;
    forgetCredit(endpoint, caller);
    expect(loadCredit(endpoint, caller)).toBeUndefined();
    expect(readCompletedCreditHistory().records[0]).toMatchObject({
      drainId: "forgotten",
      settledAt: 300,
    });
  });

  it.each(["zero", "positive", "remark"] as const)(
    "retains an unarchived loss before %s reconciliation changes its terminal facts",
    (operation) => {
      const row = loss(1);
      store([], [row]);
      const source = readFileSync(join(state.dir, "credits.json"), "utf8");
      state.failWritesAlways = true;
      if (operation === "remark") {
        markImplicitCreditLost({
          endpoint,
          callerPubkey: caller,
          creditId: row.creditId,
          reason: "not_found",
          now: 400,
        });
      } else {
        applyImplicitReceiptCredit({
          endpoint,
          callerPubkey: caller,
          jobId: "reconcile",
          outcome: "completed",
          currency: "eur",
          issuedAtMs: 1,
          now: 400,
          credit: {
            credit_id: row.creditId,
            draw_id: "draw",
            amount: 123,
            balance_after: operation === "zero" ? 0 : 99,
            ledger_seq: 2,
          },
        });
      }
      expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(
        source,
      );
      expect(listImplicitCredits()[0]).toMatchObject(row);
      state.failWritesAlways = false;
      if (operation === "zero") {
        expect(
          applyImplicitReceiptCredit({
            endpoint,
            callerPubkey: caller,
            jobId: "reconcile",
            outcome: "completed",
            currency: "usd",
            issuedAtMs: 1,
            now: 400,
            credit: {
              credit_id: row.creditId,
              draw_id: "draw",
              amount: 123,
              balance_after: 0,
              ledger_seq: 2,
            },
          }).pruned,
        ).toBe(true);
        expect(listImplicitCredits()).toHaveLength(0);
      }
      expect(readCompletedCreditHistory().records[0]).toMatchObject({
        amountMicro: 123,
        reason: "expired",
        occurredAt: 201,
      });
    },
  );

  it("defers a completed receipt refresh when it would replace unarchived evidence", () => {
    store();
    refund("refresh");
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    const before = JSON.parse(source).credits[0].drainEvidence[0];
    rmSync(join(state.dir, "credits-history.jsonl"));
    const refresh = () =>
      recordDrainReceipts({
        endpoint,
        callerPubkey: caller,
        drainId: "refresh",
        creditId: "credit",
        receipts: [
          dvm.signDrain({
            drain_id: "refresh",
            credit_id: "credit",
            event: "picked_up",
          }),
        ],
        read: { reachable: true, anchor: dvm.anchor },
        now: 400,
      });
    state.failWritesAlways = true;
    refresh();
    expect(loadCredit(endpoint, caller)?.drainEvidence?.[0]).toEqual(before);
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    state.failWritesAlways = false;
    refresh();
    expect(readCompletedCreditHistory().records[0]).toMatchObject({
      collectedAt: 400,
      receipts: [expect.objectContaining({ event: "picked_up" })],
    });
  });

  it("does not collapse legacy duplicate rows until their terminal loss facts are archived", () => {
    const terminal = loss(1);
    const active = {
      ...terminal,
      status: "active",
      remainingMicro: 456,
      ledgerSeq: 2,
      expiryMs: 9e12,
      updatedAt: 300,
    };
    store([], [terminal, active]);
    const source = readFileSync(join(state.dir, "credits.json"), "utf8");
    state.failWritesAlways = true;
    expect(listImplicitCredits()).toHaveLength(2);
    expect(readFileSync(join(state.dir, "credits.json"), "utf8")).toBe(source);
    state.failWritesAlways = false;
    expect(readCompletedCreditHistory().records[0]).toMatchObject({
      amountMicro: 123,
      reason: "expired",
    });
    expect(
      JSON.parse(readFileSync(join(state.dir, "credits.json"), "utf8"))
        .implicitCredits,
    ).toHaveLength(1);
  });

  it("serializes real concurrent processes and replayed legacy seeding", async () => {
    store(
      [],
      Array.from({ length: 16 }, (_, i) => loss(i)),
    );
    const modulePath = resolve("src/lib/credit-store.ts");
    const script = `import {readCompletedCreditHistory} from ${JSON.stringify(modulePath)}; for(let i=0;i<3;i++) { if(readCompletedCreditHistory({limit:100}).records.length !== 16) throw new Error('lost history'); }`;
    await Promise.all(
      Array.from(
        { length: 3 },
        () =>
          new Promise<void>((accept, reject) => {
            const child = spawn(
              process.execPath,
              ["--import", "tsx", "--input-type=module", "-e", script],
              {
                env: { ...process.env, DVM_CONFIG_DIR: state.dir },
                stdio: ["ignore", "ignore", "pipe"],
              },
            );
            children.add(child);
            child.once("close", () => children.delete(child));
            let stderr = "";
            child.stderr.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.on("error", reject);
            child.on("exit", (code) =>
              code === 0 ? accept() : reject(new Error(stderr)),
            );
          }),
      ),
    );
    expect(readCompletedCreditHistory({ limit: 100 }).records).toHaveLength(16);
    expect(
      readFileSync(join(state.dir, "credits-history.jsonl"), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(16);
  });
});
