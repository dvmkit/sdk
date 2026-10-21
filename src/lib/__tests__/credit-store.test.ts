
import { readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DIR = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "dvm-credit-store-")) as string;
  /* eslint-enable @typescript-eslint/no-require-imports */
});
vi.mock("../../defaults", () => ({
  CONFIG_DIR: TEST_DIR,
  CREDITS_FILE: `${TEST_DIR}/credits.json`,
}));

import {
  applyImplicitReceiptCredit,
  applyReceiptCredit,
  clearPendingDrain,
  clearPendingFunding,
  clearRefillRailUnavailable,
  dvmLocationOrigins,
  ensureProvisionalCredit,
  forgetCredit,
  listCredits,
  listFundingMenuSnapshots,
  listImplicitCredits,
  listPendingFundings,
  loadCredit,
  loadCreditX402Binding,
  loadImplicitCredits,
  loadPendingFunding,
  markCredit,
  markImplicitCreditLost,
  markRefillDrainNoticed,
  markRefillRailUnavailable,
  normalizeCreditEndpoint,
  pendingDrainById,
  pendingDrainFor,
  readCompletedCreditHistory,
  recordBalanceResponse,
  recordCreditX402Instrument,
  recordDrainReceipts,
  recordFundingMenuSnapshot,
  recordFundResponse,
  recordPendingDrain,
  recordPendingFunding,
  recordRefusedDrawBalance,
  settleDrainEvidence,
  type PendingDrain,
  type PendingFunding,
} from "../credit-store";
import type { ReceiptTrustAnchor } from "../receipt-verify";
import type { CreditMenu, CreditWire } from "../transport/types";
import { unsignedDrainReceipt } from "./fixtures/receipt-fixture";

const ENDPOINT = "https://wordcount.example";
const ALIAS_ENDPOINT = "https://wordcount-alt.example";
const DVM_ID = "dvm-wordcount";
/** Already-verified identity pair: the store tests shape and ownership, not attestation cryptography. */
const IDENTITY = { dvmId: DVM_ID, builderPubkey: "ab".repeat(32) };

const IMPOSTOR = { dvmId: DVM_ID, builderPubkey: "ef".repeat(32) };
const IMPOSTOR_ENDPOINT = "https://wordcount-lookalike.example";
const PUBKEY = "bb".repeat(32);
const MENU: CreditMenu = {
  min_micro: 100_000,
  max_micro: 5_000_000,
  ttl_ms: 86_400_000,
  currency: "usd",
  funding: ["cashu", "lightning"],
};
const ANCHOR: ReceiptTrustAnchor = {
  pubkey: "ab".repeat(32),
  attestation: { dvm: "wordcount" },
  signature: "cd".repeat(64),
};

/** Hand-write the store the way an older — or hand-edited — CLI would have. */
function writeStore(credit: Record<string, unknown>): void {
  writeRawStore([
    {
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      currency: "usd",
      balanceMicro: 200_000,
      remainingMicro: 200_000,
      ledgerSeq: 1,
      expiryMs: 0,
      targetMicro: 400_000,
      status: "active",
      openedAt: 0,
      updatedAt: 0,
      ...credit,
    },
  ]);
}

/** Hand-write an arbitrary legacy credit collection. */
function writeRawStore(
  credits: unknown[],
  pendingFundings: unknown = [],
  fundingMenuSnapshots: unknown = []
): void {
  writeFileSync(
    join(TEST_DIR, "credits.json"),
    JSON.stringify({
      credits,
      pendingFundings,
      fundingMenuSnapshots,
    })
  );
}

/** The store as it sits on disk, past every normalising read. */
function rawCredit(): Record<string, unknown> {
  const store = JSON.parse(readFileSync(join(TEST_DIR, "credits.json"), "utf-8")) as {
    credits: Record<string, unknown>[];
  };
  return store.credits[0] ?? {};
}

function wire(overrides: Partial<CreditWire> = {}): CreditWire {
  return {
    credit_id: "credit-1",
    currency: "usd",
    balance_micro: 200_000,
    remaining_micro: 200_000,
    expiry_ms: Date.now() + 86_400_000,
    expired: false,
    drainable: true,
    ledger_seq: 1,
    ...overrides,
  };
}

function drain(drainId: string, creditId?: string): PendingDrain {
  return {
    drainId,
    ...(creditId === undefined ? {} : { creditId }),
    method: "cashu",
    payout: { refund_pubkey: "02" + "cd".repeat(32) },
    requestedAt: 0,
  };
}

beforeEach(() => {
  rmSync(join(TEST_DIR, "credits.json"), { force: true });
  rmSync(join(TEST_DIR, "credits-history.jsonl"), { force: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("normalizeCreditEndpoint", () => {
  it("collapses to the origin and survives junk", () => {
    expect(normalizeCreditEndpoint("https://a.example/v1/")).toBe("https://a.example");
    expect(normalizeCreditEndpoint("not a url/")).toBe("not a url");
  });
});

describe("recordFundResponse", () => {
  it("adopts the server's figures and uses the endpoint origin as fallback", () => {
    recordFundResponse({
      endpoint: `${ENDPOINT}/some/path`,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
    });
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record).toMatchObject({
      creditId: "credit-1",
      remainingMicro: 200_000,
      ledgerSeq: 1,
      targetMicro: 400_000,
      status: "active",
    });
    expect(record?.provisional).toBeUndefined();
  });

  it("keeps a mutable replay projection explicitly unsequenced", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
      sequenced: false,
    });

    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      remainingMicro: 200_000,
      ledgerSeq: 1,
      unsequencedBalance: true,
    });
  });

  it("funds through one hostname and applies a draw received through another", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
    });

    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY, IDENTITY)?.creditId).toBe("credit-1");
    const applied = applyReceiptCredit({
      endpoint: ALIAS_ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      jobId: "job-alias",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-alias",
        amount: 25_000,
        balance_after: 175_000,
        ledger_seq: 2,
      },
    });
    expect(applied.credit?.remainingMicro).toBe(175_000);
    expect(listCredits()).toHaveLength(1);
    expect(rawCredit()).toMatchObject({
      endpoint: ENDPOINT,
      endpointAliases: [ALIAS_ENDPOINT],
      dvmId: DVM_ID,
      attestedBuilderPubkey: IDENTITY.builderPubkey,
    });
  });

  it("persists drain, evidence, status, and removal mutations through an alias", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
    });
    const pending = drain("drain-alias", "credit-1");

    recordPendingDrain(ALIAS_ENDPOINT, PUBKEY, pending, IDENTITY);
    recordDrainReceipts({
      endpoint: ALIAS_ENDPOINT,
      callerPubkey: PUBKEY,
      drainId: pending.drainId,
      creditId: "credit-1",
      receipts: [{ ...unsignedDrainReceipt({ drain_id: pending.drainId, credit_id: "credit-1" }), signature: "signed" }],
      read: { reachable: false },
      now: 10,
    });
    markCredit(ALIAS_ENDPOINT, PUBKEY, "drained", { ifCreditId: "credit-1" });
    settleDrainEvidence({
      endpoint: ALIAS_ENDPOINT,
      callerPubkey: PUBKEY,
      drainId: pending.drainId,
      now: 20,
    });

    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      endpointAliases: [ALIAS_ENDPOINT],
      status: "drained",
      remainingMicro: 0,
      pendingDrains: [pending],
      drainEvidence: [
        expect.objectContaining({ drainId: pending.drainId, collectedAt: 10, settledAt: 20 }),
      ],
    });

    clearPendingDrain(ALIAS_ENDPOINT, PUBKEY, pending);
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains).toBeUndefined();
    forgetCredit(ALIAS_ENDPOINT, PUBKEY);
    expect(listCredits()).toHaveLength(0);
  });

  it("keeps origin fallback records separate when no DVM identity is served", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-origin-a" }),
      targetMicro: 400_000,
    });
    recordFundResponse({
      endpoint: ALIAS_ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-origin-b" }),
      targetMicro: 400_000,
    });

    expect(loadCredit(ENDPOINT, PUBKEY)?.creditId).toBe("credit-origin-a");
    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY)?.creditId).toBe("credit-origin-b");
    expect(listCredits()).toHaveLength(2);
  });

  it("an expired wire credit records as expired", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ expired: true }),
      targetMicro: 400_000,
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.status).toBe("expired");
  });

  it("a stale response on the same credit cannot roll the sequence backwards", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ ledger_seq: 5 }),
      targetMicro: 400_000,
    });
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ ledger_seq: 3 }),
      targetMicro: 400_000,
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.ledgerSeq).toBe(5);
  });
});

describe("sibling credit reconciliation", () => {
  it("does not adopt an arbitrary zero-balance row when the server names no primary", () => {
    const implicit = wire({
      credit_id: "imp:cashu:spent",
      balance_micro: 0,
      remaining_micro: 0,
    });

    expect(
      recordBalanceResponse({
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        credits: [implicit],
      })
    ).toBeUndefined();
    expect(loadCredit(ENDPOINT, PUBKEY)).toBeUndefined();
  });

  it("persists every non-primary row from a signed balance read", () => {
    const primary = wire({ credit_id: "credit-primary", remaining_micro: 480_000 });
    const sibling = wire({ credit_id: "credit-small", remaining_micro: 5_000 });
    const expired = wire({ credit_id: "credit-old", remaining_micro: 7_000, expired: true });

    recordBalanceResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credits: [primary, sibling, expired],
      primary,
      targetMicro: 500_000,
      now: 123,
    });

    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      creditId: "credit-primary",
      remainingMicro: 480_000,
      siblingCredits: [
        expect.objectContaining({
          creditId: "credit-small",
          remainingMicro: 5_000,
          expired: false,
          observedAt: 123,
        }),
        expect.objectContaining({
          creditId: "credit-old",
          remainingMicro: 7_000,
          expired: true,
          observedAt: 123,
        }),
      ],
    });
  });

  it("replaces the sibling snapshot so a server-omitted balance does not linger", () => {
    const primary = wire({ credit_id: "credit-primary" });
    recordBalanceResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credits: [primary, wire({ credit_id: "credit-gone" })],
      primary,
    });
    recordBalanceResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credits: [primary, wire({ credit_id: "credit-still", remaining_micro: 9_000 })],
      primary,
      now: 456,
    });

    expect(loadCredit(ENDPOINT, PUBKEY)?.siblingCredits).toEqual([
      expect.objectContaining({ creditId: "credit-still", remainingMicro: 9_000, observedAt: 456 }),
    ]);
  });

  it("keeps the displaced live credit discoverable when a fund response adopts another id", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-first", remaining_micro: 25_000 }),
      targetMicro: 400_000,
      now: 100,
    });
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-second", remaining_micro: 400_000 }),
      targetMicro: 400_000,
      now: 200,
    });

    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      creditId: "credit-second",
      siblingCredits: [
        expect.objectContaining({
          creditId: "credit-first",
          remainingMicro: 25_000,
          observedAt: 100,
        }),
      ],
    });
  });

  it("drops malformed sibling rows without taking down the store", () => {
    writeStore({
      siblingCredits: [
        null,
        {},
        { creditId: "credit-bad" },
        {
          creditId: "credit-good",
          currency: "usd",
          balanceMicro: 10_000,
          remainingMicro: 9_000,
          ledgerSeq: 2,
          expiryMs: 1_000,
          expired: false,
          drainable: true,
          observedAt: 500,
        },
      ],
    });

    expect(loadCredit(ENDPOINT, PUBKEY)?.siblingCredits).toEqual([
      expect.objectContaining({ creditId: "credit-good", remainingMicro: 9_000 }),
    ]);
  });

  it("drops non-object credit and pending funding rows without taking down the store", () => {
    const validCredit = {
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      currency: "usd",
      balanceMicro: 200_000,
      remainingMicro: 200_000,
      ledgerSeq: 1,
      expiryMs: 0,
      targetMicro: 400_000,
      status: "active",
      openedAt: 0,
      updatedAt: 0,
    };
    const validFunding = {
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-opening",
      fundId: "fund-1",
      amountMicro: 100_000,
      rail: "lightning",
      targetMicro: 400_000,
      requestedAt: 0,
    };

    writeRawStore([null, 7, validCredit], [null, 7, validFunding]);

    expect(() => listCredits()).not.toThrow();
    expect(listCredits()).toMatchObject([{ creditId: "credit-1" }]);
    expect(listPendingFundings()).toMatchObject([{ fundId: "fund-1" }]);

    writeRawStore([validCredit], "not-an-array");
    expect(listPendingFundings()).toEqual([]);
  });
});

describe("hostname-keyed store migration", () => {
  const base = (overrides: Record<string, unknown>) => ({
    endpoint: ENDPOINT,
    dvmId: IDENTITY.dvmId,
    attestedBuilderPubkey: IDENTITY.builderPubkey,
    callerPubkey: PUBKEY,
    creditId: "credit-shared",
    currency: "usd",
    balanceMicro: 200_000,
    remainingMicro: 180_000,
    ledgerSeq: 2,
    expiryMs: 1000,
    targetMicro: 400_000,
    status: "active",
    openedAt: 10,
    updatedAt: 20,
    ...overrides,
  });

  it("keeps the newest projection and unions metadata, drains, evidence, and origins", () => {
    writeRawStore([
      base({
        endpoint: ENDPOINT,
        updatedAt: 20,
        rail: "x402",
        x402Instrument: "x402_channel",
        x402ChannelNetwork: "eip155:8453",
        menu: MENU,
        builderPubkey: ANCHOR.pubkey,
        pendingDrains: [drain("drain-old", "credit-shared")],
        drainEvidence: [
          {
            drainId: "drain-old",
            creditId: "credit-shared",
            receipts: [{ signature: "old" }],
            anchor: ANCHOR,
            collectedAt: 20,
          },
        ],
      }),
      base({
        endpoint: ALIAS_ENDPOINT,
        balanceMicro: 729_900,
        remainingMicro: 638_900,
        ledgerSeq: 9,
        lastPriceMicro: 24_800,
        updatedAt: 30,
        pendingDrains: [drain("drain-new", "credit-shared")],
        drainEvidence: [
          {
            drainId: "drain-new",
            creditId: "credit-shared",
            receipts: [{ signature: "new" }],
            collectedAt: 30,
          },
        ],
      }),
    ]);

    const records = listCredits();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      endpoint: ALIAS_ENDPOINT,
      endpointAliases: [ENDPOINT],
      balanceMicro: 729_900,
      remainingMicro: 638_900,
      ledgerSeq: 9,
      lastPriceMicro: 24_800,

      rail: "x402",
      x402Instrument: "x402_channel",
      x402ChannelNetwork: "eip155:8453",
      menu: MENU,
      builderPubkey: ANCHOR.pubkey,
    });
    expect(records[0]?.pendingDrains?.map((entry) => entry.drainId).sort()).toEqual([
      "drain-new",
      "drain-old",
    ]);
    expect(records[0]?.drainEvidence?.map((entry) => entry.drainId).sort()).toEqual([
      "drain-new",
      "drain-old",
    ]);
    expect(loadCredit(ENDPOINT, PUBKEY)?.creditId).toBe("credit-shared");
    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY)?.creditId).toBe("credit-shared");

    const once = readFileSync(join(TEST_DIR, "credits.json"), "utf-8");
    listCredits();
    expect(readFileSync(join(TEST_DIR, "credits.json"), "utf-8")).toBe(once);
  });

  it("does not merge records that name different credits", () => {
    writeRawStore([
      base({ endpoint: ENDPOINT, creditId: "credit-a" }),
      base({ endpoint: ALIAS_ENDPOINT, creditId: "credit-b" }),
    ]);

    expect(
      listCredits()
        .map((record) => record.creditId)
        .sort()
    ).toEqual(["credit-a", "credit-b"]);
  });

  it.each([false, true])("finds genuine aliases beyond a colliding provider (reverse=%s)", (reverse) => {
    const records = [
      base({ endpoint: IMPOSTOR_ENDPOINT, attestedBuilderPubkey: IMPOSTOR.builderPubkey }),
      base({ pendingDrains: [drain("drain-old", "credit-shared")] }),
      base({ endpoint: ALIAS_ENDPOINT, pendingDrains: [drain("drain-new", "credit-shared")] }),
    ];
    writeRawStore(reverse ? records.reverse() : records);

    expect(listCredits()).toHaveLength(2);
    const genuine = loadCredit(ENDPOINT, PUBKEY, IDENTITY);
    expect(genuine?.pendingDrains?.map((entry) => entry.drainId).sort())
      .toEqual(["drain-new", "drain-old"]);
    expect(dvmLocationOrigins(genuine!).sort()).toEqual([ENDPOINT, ALIAS_ENDPOINT].sort());
    expect(dvmLocationOrigins(loadCredit(IMPOSTOR_ENDPOINT, PUBKEY, IMPOSTOR)!))
      .toEqual([IMPOSTOR_ENDPOINT]);
  });

  it.each([false, true])("merges a learned identity across existing groups without bridging a conflict (reverse=%s)", (reverse) => {
    const records = [
      base({ dvmId: undefined, attestedBuilderPubkey: undefined, pendingDrains: [drain("drain-legacy", "credit-shared")] }),
      base({ endpoint: ALIAS_ENDPOINT, pendingDrains: [drain("drain-alias", "credit-shared")] }),
      base({ endpoint: IMPOSTOR_ENDPOINT, attestedBuilderPubkey: IMPOSTOR.builderPubkey }),
      base({ updatedAt: 30 }),
    ];
    writeRawStore(reverse ? records.reverse() : records);

    expect(listCredits()).toHaveLength(2);
    const genuine = loadCredit(ENDPOINT, PUBKEY, IDENTITY);
    expect(genuine?.pendingDrains?.map((entry) => entry.drainId).sort())
      .toEqual(["drain-alias", "drain-legacy"]);
    expect(dvmLocationOrigins(genuine!).sort()).toEqual([ENDPOINT, ALIAS_ENDPOINT].sort());
    expect(dvmLocationOrigins(loadCredit(IMPOSTOR_ENDPOINT, PUBKEY, IMPOSTOR)!))
      .toEqual([IMPOSTOR_ENDPOINT]);
  });

  it.each([
    {},
    { dvmId: DVM_ID },
    { attestedBuilderPubkey: IDENTITY.builderPubkey },
    { dvmId: DVM_ID, attestedBuilderPubkey: "not-a-key" },
  ])("does not infer cross-origin aliases from incomplete identity %j", (identity) => {
    for (const other of [identity, { dvmId: DVM_ID, attestedBuilderPubkey: IDENTITY.builderPubkey }]) {
      writeRawStore([
        base({ dvmId: undefined, attestedBuilderPubkey: undefined, ...identity }),
        base({ endpoint: ALIAS_ENDPOINT, dvmId: undefined, attestedBuilderPubkey: undefined, ...other }),
      ]);

      expect(listCredits()).toHaveLength(2);
      expect(dvmLocationOrigins(loadCredit(ENDPOINT, PUBKEY)!)).toEqual([ENDPOINT]);
      expect(dvmLocationOrigins(loadCredit(ALIAS_ENDPOINT, PUBKEY)!)).toEqual([ALIAS_ENDPOINT]);
    }
  });

  it.each([false, true])("preserves same-origin legacy upgrades and attested provenance (reverse=%s)", (reverse) => {
    const records = [
      base({ pendingDrains: [drain("drain-old", "credit-shared")] }),
      base({
        endpoint: `${ENDPOINT}/v1/`,
        dvmId: undefined,
        attestedBuilderPubkey: "not-a-key",
        updatedAt: 30,
        remainingMicro: 120_000,
        pendingDrains: [drain("drain-new", "credit-shared")],
      }),
    ];
    writeRawStore(reverse ? records.reverse() : records);

    expect(listCredits()).toHaveLength(1);
    const upgraded = loadCredit(ENDPOINT, PUBKEY, IDENTITY);
    expect(upgraded).toMatchObject({
      dvmId: DVM_ID,
      attestedBuilderPubkey: IDENTITY.builderPubkey,
      remainingMicro: 120_000,
    });
    expect(upgraded?.pendingDrains?.map((entry) => entry.drainId).sort())
      .toEqual(["drain-new", "drain-old"]);
    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY, IMPOSTOR)).toBeUndefined();
  });

  it("does not synthesize an authenticated identity from two partial legacy rows", () => {
    writeRawStore([
      base({ attestedBuilderPubkey: undefined }),
      base({ dvmId: undefined, updatedAt: 30 }),
    ]);

    expect(listCredits()).toHaveLength(1);
    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY, IDENTITY)).toBeUndefined();
    expect(listCredits()[0]?.dvmId).toBeUndefined();
  });

  it("deduplicates unknown identity only within its existing origin aliases", () => {
    writeRawStore([
      base({ dvmId: undefined, attestedBuilderPubkey: undefined, endpointAliases: [ALIAS_ENDPOINT] }),
      base({ endpoint: ALIAS_ENDPOINT, dvmId: undefined, attestedBuilderPubkey: undefined }),
    ]);

    expect(listCredits()).toHaveLength(1);
    expect(loadCredit(ENDPOINT, PUBKEY)?.creditId).toBe("credit-shared");
    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY)?.creditId).toBe("credit-shared");
  });

  it("keeps conflicting complete identities apart even at the same origin", () => {
    writeRawStore([
      base({ pendingDrains: [drain("drain-a", "credit-shared")] }),
      base({ attestedBuilderPubkey: IMPOSTOR.builderPubkey, pendingDrains: [drain("drain-b", "credit-shared")] }),
    ]);

    expect(listCredits()).toHaveLength(2);
    expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)?.pendingDrains?.map((entry) => entry.drainId))
      .toEqual(["drain-a"]);
    expect(loadCredit(ENDPOINT, PUBKEY, IMPOSTOR)?.pendingDrains?.map((entry) => entry.drainId))
      .toEqual(["drain-b"]);
  });

  it("preserves old-credit drain credentials through alias merge and retry writes", () => {
    const pending = Array.from({ length: 12 }, (_, i) => ({
      ...drain(`drain-${String(i)}`, `credit-old-${String(i)}`),
      method: "tempo",
      payout: { address: `example-payout-${String(i)}` },
      mppCredential: `Payment example-close-${String(i)}`,
    }));
    writeRawStore([
      base({ pendingDrains: pending.slice(0, 6) }),
      base({
        endpoint: ALIAS_ENDPOINT,
        updatedAt: 30,
        pendingDrains: [
          { ...pending[0], mppCredential: undefined },
          ...pending.slice(6),
        ],
      }),
    ]);

    const merged = loadCredit(ENDPOINT, PUBKEY);
    expect(merged?.pendingDrains).toEqual(pending);
    expect(merged?.endpointAliases).toContain(ENDPOINT);
    for (const entry of pending) {
      expect(pendingDrainFor(merged, entry.creditId!)).toEqual(entry);
      expect(pendingDrainById(merged, entry.drainId)).toEqual(entry);
      recordPendingDrain(ALIAS_ENDPOINT, PUBKEY, entry);
    }
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains).toEqual(pending);
    expect(rawCredit().pendingDrains).toEqual(pending);
  });
});

describe("a credit record is keyed on an attested identity", () => {
  function fundedAtEndpoint(): void {
    recordFundResponse({
      endpoint: ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
    });
    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-1", "credit-1"), IDENTITY);
  }

  it.each([
    { dvmId: "dvm-other", builderPubkey: "ef".repeat(32) },
    IMPOSTOR,
    { ...IDENTITY, dvmId: "dvm-other" },
  ])("keeps colliding provider credits and recovery evidence separate for %j", (otherIdentity) => {
    const providers = [
      { endpoint: ENDPOINT, identity: IDENTITY, drainId: "drain-a" },
      { endpoint: IMPOSTOR_ENDPOINT, identity: otherIdentity, drainId: "drain-b" },
    ];
    for (const { endpoint, identity, drainId } of providers) {
      ensureProvisionalCredit({
        endpoint,
        identity,
        callerPubkey: PUBKEY,
        creditId: "credit-1",
        currency: "usd",
        targetMicro: 400_000,
      });
      recordPendingDrain(endpoint, PUBKEY, drain(drainId, "credit-1"), identity);
      recordDrainReceipts({
        endpoint,
        identity,
        callerPubkey: PUBKEY,
        creditId: "credit-1",
        drainId,
        receipts: [{ event: "requested", drain_id: drainId }],
        read: { reachable: true, anchor: { ...ANCHOR, pubkey: identity.builderPubkey } },
      });
    }

    expect(listCredits()).toHaveLength(2);
    for (const { endpoint, identity, drainId } of providers) {
      const record = loadCredit(endpoint, PUBKEY, identity);
      expect(record).toMatchObject({
        endpoint,
        dvmId: identity.dvmId,
        attestedBuilderPubkey: identity.builderPubkey,
        pendingDrains: [drain(drainId, "credit-1")],
        drainEvidence: [{ drainId, receipts: [{ event: "requested", drain_id: drainId }] }],
      });
      expect(dvmLocationOrigins(record!)).toEqual([endpoint]);
      expect(pendingDrainById(record, drainId === "drain-a" ? "drain-b" : "drain-a"))
        .toBeUndefined();
      markCredit(endpoint, PUBKEY, "active", { identity });
    }
    expect(listCredits()).toHaveLength(2);
    const persisted = JSON.parse(readFileSync(join(TEST_DIR, "credits.json"), "utf-8")) as {
      credits: { pendingDrains: PendingDrain[] }[];
    };
    expect(persisted.credits.map((record) => record.pendingDrains[0].drainId).sort())
      .toEqual(["drain-a", "drain-b"]);
  });

  it("refuses an endpoint that serves the same dvm_id under its own builder key", () => {
    fundedAtEndpoint();

    expect(loadCredit(IMPOSTOR_ENDPOINT, PUBKEY, IMPOSTOR)).toBeUndefined();

    expect(rawCredit().endpointAliases).toBeUndefined();
  });

  it("refuses an endpoint that serves the same dvm_id under no attestation at all", () => {
    fundedAtEndpoint();

    expect(loadCredit(IMPOSTOR_ENDPOINT, PUBKEY)).toBeUndefined();
    expect(rawCredit().endpointAliases).toBeUndefined();
  });

  it("does not let an impostor advance the projection or take the drain", () => {
    fundedAtEndpoint();

    const applied = applyReceiptCredit({
      endpoint: IMPOSTOR_ENDPOINT,
      identity: IMPOSTOR,
      callerPubkey: PUBKEY,
      jobId: "job-impostor",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-impostor",
        amount: 150_000,
        balance_after: 50_000,
        ledger_seq: 2,
      },
    });

    expect(applied.credit).toBeUndefined();
    const record = loadCredit(ENDPOINT, PUBKEY, IDENTITY);
    expect(record?.remainingMicro).toBe(200_000);
    expect(record?.pendingDrains).toHaveLength(1);
    expect(listCredits()).toHaveLength(1);
  });

  it("keeps a legacy row working at the origins it already knows", () => {

    writeStore({ dvmId: DVM_ID, endpointAliases: [ALIAS_ENDPOINT] });

    expect(loadCredit(ENDPOINT, PUBKEY)?.creditId).toBe("credit-1");
    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY, IDENTITY)?.creditId).toBe("credit-1");

    expect(loadCredit(IMPOSTOR_ENDPOINT, PUBKEY, IMPOSTOR)).toBeUndefined();
  });

  it("heals a legacy row on the first attested visit to an origin it knows", () => {
    writeStore({ dvmId: DVM_ID });

    expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)?.creditId).toBe("credit-1");
    expect(rawCredit()).toMatchObject({
      dvmId: DVM_ID,
      attestedBuilderPubkey: IDENTITY.builderPubkey,
    });

    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY, IDENTITY)?.creditId).toBe("credit-1");
    expect(listCredits()).toHaveLength(1);
  });

  it("heals a legacy row that never learned an id, and refuses one naming another DVM", () => {
    writeStore({});
    expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)?.creditId).toBe("credit-1");
    expect(rawCredit()).toMatchObject({
      dvmId: DVM_ID,
      attestedBuilderPubkey: IDENTITY.builderPubkey,
    });

    writeStore({ dvmId: "dvm-someone-else" });
    expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)).toBeUndefined();
  });

  it("collapses legacy spellings after their own origins authenticate the same provider", () => {

    writeStore({ dvmId: DVM_ID, pendingDrains: [drain("drain-legacy", "credit-1")] });
    recordFundResponse({
      endpoint: ALIAS_ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      credit: wire({ remaining_micro: 140_000 }),
      targetMicro: 400_000,
    });

    expect(listCredits()).toHaveLength(2);
    loadCredit(ENDPOINT, PUBKEY, IDENTITY);
    const records = listCredits();
    expect(records).toHaveLength(1);
    expect(records[0]?.remainingMicro).toBe(140_000);
    expect(records[0]?.pendingDrains?.map((entry) => entry.drainId)).toEqual(["drain-legacy"]);
    expect(dvmLocationOrigins(records[0])).toEqual(
      expect.arrayContaining([ENDPOINT, ALIAS_ENDPOINT])
    );
  });

  it("ignores an attested pubkey that is not a pubkey", () => {

    writeStore({ dvmId: DVM_ID, attestedBuilderPubkey: "not-a-key" });

    expect(loadCredit(ALIAS_ENDPOINT, PUBKEY, IDENTITY)).toBeUndefined();
    expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)?.creditId).toBe("credit-1");
  });

  it("keeps one dvm_id's menu snapshots apart when two rows claim it", () => {

    writeRawStore(
      [
        {
          endpoint: ENDPOINT,
          callerPubkey: PUBKEY,
          creditId: "credit-legacy",
          currency: "usd",
          balanceMicro: 0,
          remainingMicro: 0,
          ledgerSeq: 0,
          expiryMs: 0,
          targetMicro: 0,
          status: "active",
          openedAt: 0,
          updatedAt: 0,
          dvmId: DVM_ID,
        },
        {
          endpoint: IMPOSTOR_ENDPOINT,
          callerPubkey: PUBKEY,
          creditId: "credit-impostor",
          currency: "usd",
          balanceMicro: 0,
          remainingMicro: 0,
          ledgerSeq: 0,
          expiryMs: 0,
          targetMicro: 0,
          status: "active",
          openedAt: 0,
          updatedAt: 0,
          dvmId: DVM_ID,
          attestedBuilderPubkey: IMPOSTOR.builderPubkey,
        },
      ],
      [],
      [
        { endpoint: ENDPOINT, callerPubkey: PUBKEY, menu: MENU, observedAt: 10 },
        {
          endpoint: IMPOSTOR_ENDPOINT,
          callerPubkey: PUBKEY,
          menu: { ...MENU, max_micro: 9_000_000 },
          observedAt: 30,
        },
      ]
    );

    expect(listFundingMenuSnapshots()).toHaveLength(2);
  });
});

describe("funding menu snapshots", () => {
  it("persists a menu without inventing a credit, keyed by the endpoint origin", () => {
    recordFundingMenuSnapshot({
      endpoint: `${ENDPOINT}/v1/credit`,
      callerPubkey: PUBKEY,
      menu: MENU,
      builderPubkey: ANCHOR.pubkey,
      now: 123,
    });

    expect(listCredits()).toEqual([]);
    expect(listFundingMenuSnapshots()).toEqual([
      {
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        menu: MENU,
        observedAt: 123,
        builderPubkey: ANCHOR.pubkey,
      },
    ]);
  });

  it("replaces a valid menu while retaining a known builder pubkey", () => {
    recordFundingMenuSnapshot({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      menu: MENU,
      builderPubkey: ANCHOR.pubkey,
      now: 123,
    });
    recordFundingMenuSnapshot({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      menu: { ...MENU, max_micro: 8_000_000 },
      now: 456,
    });

    expect(listFundingMenuSnapshots()).toEqual([
      {
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        menu: { ...MENU, max_micro: 8_000_000 },
        observedAt: 456,
        builderPubkey: ANCHOR.pubkey,
      },
    ]);
  });

  it("does not persist a malformed menu", () => {
    recordFundingMenuSnapshot({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      menu: { ...MENU, max_micro: "not a number" } as unknown as CreditMenu,
      now: 123,
    });

    expect(listFundingMenuSnapshots()).toEqual([]);
  });

  it("loads old documents unchanged and ignores malformed snapshot entries", () => {
    writeFileSync(
      join(TEST_DIR, "credits.json"),
      JSON.stringify({
        credits: [
          {
            endpoint: ENDPOINT,
            callerPubkey: PUBKEY,
            creditId: "credit-1",
            currency: "usd",
            balanceMicro: 200_000,
            remainingMicro: 200_000,
            ledgerSeq: 1,
            expiryMs: 0,
            targetMicro: 400_000,
            status: "active",
            openedAt: 0,
            updatedAt: 0,
          },
        ],
        pendingFundings: [],
        fundingMenuSnapshots: [
          { endpoint: ENDPOINT, callerPubkey: PUBKEY, menu: MENU, observedAt: 123 },
          { endpoint: ENDPOINT, callerPubkey: PUBKEY, menu: { min_micro: 1 }, observedAt: 456 },
          { endpoint: ENDPOINT, callerPubkey: PUBKEY, menu: MENU, observedAt: 1e100 },
          null,
        ],
      })
    );

    expect(loadCredit(ENDPOINT, PUBKEY)?.creditId).toBe("credit-1");
    expect(listFundingMenuSnapshots()).toEqual([
      { endpoint: ENDPOINT, callerPubkey: PUBKEY, menu: MENU, observedAt: 123 },
    ]);
  });

  it("treats a missing snapshot section as an empty migration", () => {
    writeStore({});

    expect(loadCredit(ENDPOINT, PUBKEY)?.creditId).toBe("credit-1");
    expect(listFundingMenuSnapshots()).toEqual([]);
  });
});

describe("credit id rotation", () => {
  it("a fund response naming a different credit takes its sequence verbatim", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-a", ledger_seq: 40 }),
      targetMicro: 400_000,
    });
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-b", remaining_micro: 150_000, ledger_seq: 2 }),
      targetMicro: 400_000,
    });
    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      creditId: "credit-b",
      ledgerSeq: 2,
      remainingMicro: 150_000,
    });

    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-1",
      outcome: "completed",
      credit: {
        credit_id: "credit-b",
        draw_id: "draw-1",
        amount: 10_000,
        balance_after: 140_000,
        ledger_seq: 3,
      },
    });
    expect(result.mismatch).toBeUndefined();
    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({ remainingMicro: 140_000, ledgerSeq: 3 });
  });

  it("the old credit's ledger state does not follow the record onto the new one", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-a", ledger_seq: 1 }),
      targetMicro: 400_000,
    });
    applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-a",
      outcome: "completed",
      credit: {
        credit_id: "credit-a",
        draw_id: "draw-a",
        amount: 10_000,
        balance_after: 150_000,
        ledger_seq: 2,
      },
    });
    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      discrepancy: { drawId: "draw-a" },
      lastReceiptJobId: "job-a",
    });

    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-b", ledger_seq: 1 }),
      targetMicro: 400_000,
    });
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.discrepancy).toBeUndefined();
    expect(record?.lastReceiptJobId).toBeUndefined();
  });

  it("preserves same-credit bindings and clears them when a new credit replaces it", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-a" }),
      targetMicro: 400_000,
      rail: "x402",
      x402Instrument: "x402_channel",
      x402ChannelNetwork: "eip155:8453",
    });
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-a", ledger_seq: 2 }),
      targetMicro: 400_000,
    });
    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      rail: "x402",
      x402Instrument: "x402_channel",
      x402ChannelNetwork: "eip155:8453",
    });
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-b", ledger_seq: 1 }),
      targetMicro: 400_000,
    });
    const replacement = loadCredit(ENDPOINT, PUBKEY);
    expect(replacement?.rail).toBeUndefined();
    expect(replacement?.x402Instrument).toBeUndefined();
    expect(replacement?.x402ChannelNetwork).toBeUndefined();
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-c", ledger_seq: 1 }),
      targetMicro: 400_000,
      rail: "cashu",
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.rail).toBe("cashu");
  });

  it("a provisional record re-pointed at a new credit starts from zero", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-a", ledger_seq: 40 }),
      targetMicro: 400_000,
    });
    markCredit(ENDPOINT, PUBKEY, "drained");

    ensureProvisionalCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-b",
      currency: "usd",
      targetMicro: 400_000,
    });
    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      creditId: "credit-b",
      ledgerSeq: 0,
      remainingMicro: 0,
      balanceMicro: 0,
      status: "active",
      provisional: true,
    });

    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-b",
      outcome: "completed",
      credit: {
        credit_id: "credit-b",
        draw_id: "draw-b",
        amount: 10_000,
        balance_after: 187_431,
        ledger_seq: 1,
      },
    });
    expect(result.mismatch).toBeUndefined();
    expect(loadCredit(ENDPOINT, PUBKEY)?.remainingMicro).toBe(187_431);
  });
});

describe("the x402 instrument binding", () => {
  beforeEach(() => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
      rail: "x402",
      x402Instrument: "x402_exact",
    });
  });

  it("reads back only for the credit the record actually names", () => {
    expect(loadCreditX402Binding(ENDPOINT, PUBKEY, "credit-1").instrument).toBe("x402_exact");

    expect(loadCreditX402Binding(ENDPOINT, PUBKEY, "credit-9")).toEqual({});
  });

  it("stops reading once the credit can no longer be refilled", () => {
    markCredit(ENDPOINT, PUBKEY, "drained");
    expect(loadCreditX402Binding(ENDPOINT, PUBKEY, "credit-1")).toEqual({});
  });

  it("adopts the binding a refusal names, and only for that credit", () => {
    recordCreditX402Instrument(ENDPOINT, PUBKEY, "credit-1", "x402_channel");
    expect(loadCreditX402Binding(ENDPOINT, PUBKEY, "credit-1").instrument).toBe("x402_channel");

    recordCreditX402Instrument(ENDPOINT, PUBKEY, "credit-9", "x402_exact");
    expect(loadCreditX402Binding(ENDPOINT, PUBKEY, "credit-1").instrument).toBe("x402_channel");
  });

  it("leaves the file untouched when the refusal names what is already recorded", () => {
    const before = readFileSync(join(TEST_DIR, "credits.json"), "utf-8");
    recordCreditX402Instrument(ENDPOINT, PUBKEY, "credit-1", "x402_exact");
    expect(readFileSync(join(TEST_DIR, "credits.json"), "utf-8")).toBe(before);
  });

  it("reads the chain back with the instrument, and drops it when the pin moves", () => {

    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
      rail: "x402",
      x402Instrument: "x402_channel",
      x402ChannelNetwork: "eip155:8453",
    });
    expect(loadCreditX402Binding(ENDPOINT, PUBKEY, "credit-1")).toEqual({
      instrument: "x402_channel",
      channelNetwork: "eip155:8453",
    });

    recordCreditX402Instrument(ENDPOINT, PUBKEY, "credit-1", "x402_exact");
    expect(loadCreditX402Binding(ENDPOINT, PUBKEY, "credit-1")).toEqual({
      instrument: "x402_exact",
    });
  });

  it("learns the channel chain when the instrument itself is unchanged", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
      rail: "x402",
      x402Instrument: "x402_channel",
    });

    recordCreditX402Instrument(
      ENDPOINT,
      PUBKEY,
      "credit-1",
      "x402_channel",
      undefined,
      "eip155:8453"
    );

    expect(loadCreditX402Binding(ENDPOINT, PUBKEY, "credit-1")).toEqual({
      instrument: "x402_channel",
      channelNetwork: "eip155:8453",
    });
  });
});

describe("the balances an insufficient_credit refusal stated", () => {
  it("adopts both stated figures and clears provisional", () => {
    ensureProvisionalCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      currency: "usd",
      targetMicro: 400_000,
    });

    recordRefusedDrawBalance({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      remainingMicro: 50_000,
      balanceMicro: 60_000,
    });

    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.remainingMicro).toBe(50_000);

    expect(record?.balanceMicro).toBe(60_000);
    expect(record?.provisional).toBeUndefined();

    expect(record?.ledgerSeq).toBe(0);
    expect(record?.unsequencedBalance).toBe(true);
  });

  it("leaves balanceMicro alone when the refusal omits it", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ balance_micro: 200_000, remaining_micro: 200_000 }),
      targetMicro: 400_000,
    });

    recordRefusedDrawBalance({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      remainingMicro: 50_000,
    });

    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.remainingMicro).toBe(50_000);
    expect(record?.balanceMicro).toBe(200_000);
  });

  it("changes nothing when the record has since re-pointed at another credit", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-2", remaining_micro: 200_000 }),
      targetMicro: 400_000,
    });

    recordRefusedDrawBalance({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      remainingMicro: 50_000,
    });

    expect(loadCredit(ENDPOINT, PUBKEY)?.remainingMicro).toBe(200_000);
  });

  it("leaves the file untouched when the same refusal is applied twice", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ remaining_micro: 200_000 }),
      targetMicro: 400_000,
    });
    recordRefusedDrawBalance({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      remainingMicro: 50_000,
    });
    const before = readFileSync(join(TEST_DIR, "credits.json"), "utf-8");

    recordRefusedDrawBalance({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      remainingMicro: 50_000,
    });

    expect(readFileSync(join(TEST_DIR, "credits.json"), "utf-8")).toBe(before);
  });

  it("ignores figures no balance could hold", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ balance_micro: 200_000, remaining_micro: 200_000 }),
      targetMicro: 400_000,
    });

    const original = readFileSync(join(TEST_DIR, "credits.json"), "utf8");
    for (const bad of [-1, 1.5, "50000", null, undefined]) {
      recordRefusedDrawBalance({
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        creditId: "credit-1",
        remainingMicro: bad,
      });
      expect(readFileSync(join(TEST_DIR, "credits.json"), "utf8")).toBe(original);
    }

    recordRefusedDrawBalance({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      remainingMicro: 50_000,
      balanceMicro: -1,
    });

    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.remainingMicro).toBe(50_000);
    expect(record?.balanceMicro).toBe(200_000);
  });

  // The case the sequence guard does *not* cover. `remaining_micro` is net of
  // pending holds, so a second job in flight on the same credit is what refused
  // this one — and that job's receipt lands at exactly `ledgerSeq + 1`, gap-free
  // against a mark the adopted figure never sat at. Its `balance_after` is
  // correct; comparing it to `50_000 − 350_000` is not.
  it("does not arm a false mismatch when a concurrent draw settles next", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ balance_micro: 400_000, remaining_micro: 400_000, ledger_seq: 3 }),
      targetMicro: 400_000,
    });

    recordRefusedDrawBalance({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      remainingMicro: 50_000,
      balanceMicro: 400_000,
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.ledgerSeq).toBe(3);

    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-sibling",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-sibling",
        amount: 350_000,
        balance_after: 50_000,
        ledger_seq: 4,
      },
    });

    expect(result.mismatch).toBeUndefined();
    const settled = loadCredit(ENDPOINT, PUBKEY);
    expect(settled?.discrepancy).toBeUndefined();
    expect(settled?.remainingMicro).toBe(50_000);
    expect(settled?.ledgerSeq).toBe(4);
    expect(settled?.unsequencedBalance).toBeUndefined();
  });

  it("still reports a real mismatch once the projection is re-anchored", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ balance_micro: 400_000, remaining_micro: 400_000, ledger_seq: 3 }),
      targetMicro: 400_000,
    });
    recordRefusedDrawBalance({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      remainingMicro: 50_000,
    });
    applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-sibling",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-sibling",
        amount: 350_000,
        balance_after: 50_000,
        ledger_seq: 4,
      },
    });

    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-next",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-next",
        amount: 5_000,
        balance_after: 30_000,
        ledger_seq: 5,
      },
    });

    expect(result.mismatch).toMatchObject({ expectedMicro: 45_000, reportedMicro: 30_000 });
  });
});

describe("pending Lightning fundings", () => {
  it("persists before a credit exists and enriches the same intent with its invoice", () => {
    recordPendingFunding({
      endpoint: `${ENDPOINT}/v1/credit`,
      callerPubkey: PUBKEY,
      creditId: "credit-opening",
      fundId: "fund-1",
      amountMicro: 100_000,
      rail: "lightning",
      targetMicro: 400_000,
      requestedAt: 10,
    });

    expect(loadCredit(ENDPOINT, PUBKEY)).toBeUndefined();
    const intent = loadPendingFunding(ENDPOINT, PUBKEY);
    expect(intent).toMatchObject({
      endpoint: ENDPOINT,
      creditId: "credit-opening",
      fundId: "fund-1",
      amountMicro: 100_000,
    });
    if (!intent) throw new Error("pending funding was not persisted");

    recordPendingFunding({
      ...intent,
      bolt11: "lnbcrt1pending",
      paymentHash: "ab".repeat(32),
      amountMsats: 100_000,
      expiresAtMs: 20,
    });

    expect(listPendingFundings()).toHaveLength(1);
    expect(loadPendingFunding(ENDPOINT, PUBKEY, "credit-opening")).toMatchObject({
      fundId: "fund-1",
      bolt11: "lnbcrt1pending",
      paymentHash: "ab".repeat(32),
      expiresAtMs: 20,
    });
  });

  it("clears exactly the confirmed funding and preserves other pending intents", () => {
    for (const fundId of ["fund-1", "fund-2"]) {
      recordPendingFunding({
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        creditId: `credit-${fundId}`,
        fundId,
        amountMicro: 100_000,
        rail: "lightning",
        targetMicro: 100_000,
        requestedAt: fundId === "fund-1" ? 1 : 2,
      });
    }

    clearPendingFunding(ENDPOINT, PUBKEY, "credit-fund-1", "fund-1");

    expect(listPendingFundings()).toMatchObject([{ creditId: "credit-fund-2", fundId: "fund-2" }]);
  });
});

describe("forgetCredit", () => {
  it("removes exactly the keyed record and leaves others untouched", () => {
    recordPendingFunding({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-pending",
      fundId: "fund-pending",
      amountMicro: 100_000,
      rail: "lightning",
      targetMicro: 100_000,
      requestedAt: 1,
    });
    ensureProvisionalCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-typo",
      currency: "usd",
      targetMicro: 0,
    });
    recordFundResponse({
      endpoint: "https://other.example",
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-other" }),
      targetMicro: 400_000,
    });

    forgetCredit(ENDPOINT, PUBKEY);

    expect(loadCredit(ENDPOINT, PUBKEY)).toBeUndefined();
    expect(loadCredit("https://other.example", PUBKEY)?.creditId).toBe("credit-other");
    expect(loadPendingFunding(ENDPOINT, PUBKEY)?.fundId).toBe("fund-pending");
  });

  it("does not rewrite or remove another credit when the requested origin is untracked", () => {
    recordFundResponse({
      endpoint: "https://other.example",
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-other" }),
      targetMicro: 400_000,
    });
    const original = readFileSync(join(TEST_DIR, "credits.json"), "utf8");
    expect(() => forgetCredit(ENDPOINT, PUBKEY)).not.toThrow();
    expect(readFileSync(join(TEST_DIR, "credits.json"), "utf8")).toBe(original);
    expect(loadCredit("https://other.example", PUBKEY)?.creditId).toBe("credit-other");
  });
});

describe("applyReceiptCredit", () => {
  const seeded = () =>
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ remaining_micro: 200_000, ledger_seq: 1 }),
      targetMicro: 400_000,
    });

  it("a clean sequential draw updates the projection with no mismatch", () => {
    seeded();
    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-2",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-2",
        amount: 10_000,
        balance_after: 190_000,
        ledger_seq: 2,
      },
    });
    expect(result.mismatch).toBeUndefined();
    expect(result.credit).toMatchObject({
      remainingMicro: 190_000,
      ledgerSeq: 2,
      lastPriceMicro: 10_000,
      lastReceiptJobId: "job-2",
    });
  });

  it("a misreported balance surfaces a mismatch citing both signed artifacts", () => {
    seeded();
    applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-2",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-2",
        amount: 10_000,
        balance_after: 190_000,
        ledger_seq: 2,
      },
    });
    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-3",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-3",
        amount: 10_000,

        balance_after: 150_000,
        ledger_seq: 3,
      },
    });
    expect(result.mismatch).toMatchObject({
      expectedMicro: 180_000,
      reportedMicro: 150_000,
      drawId: "draw-3",
      ledgerSeq: 3,
      priorJobId: "job-2",
      jobId: "job-3",
    });

    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      remainingMicro: 150_000,
      discrepancy: { drawId: "draw-3" },
    });
  });

  it("a sequence gap adopts without a mismatch (receipts were missed)", () => {
    seeded();
    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-9",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-9",
        amount: 10_000,
        balance_after: 120_000,
        ledger_seq: 5,
      },
    });
    expect(result.mismatch).toBeUndefined();
    expect(loadCredit(ENDPOINT, PUBKEY)?.remainingMicro).toBe(120_000);
  });

  it("a released draw (failed job) restores the balance without a mismatch", () => {
    seeded();
    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-2",
      outcome: "failed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-2",
        amount: 10_000,
        balance_after: 200_000,
        ledger_seq: 2,
      },
    });
    expect(result.mismatch).toBeUndefined();
    expect(loadCredit(ENDPOINT, PUBKEY)?.remainingMicro).toBe(200_000);

    expect(loadCredit(ENDPOINT, PUBKEY)?.lastPriceMicro).toBeUndefined();
  });

  describe("a receipt older than the stored sequence", () => {
    const receipt = (
      seq: number,
      amount: number,
      balanceAfter: number,
      overrides: Partial<Parameters<typeof applyReceiptCredit>[0]> = {}
    ): Parameters<typeof applyReceiptCredit>[0] => ({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: `job-${String(seq)}`,
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: `draw-${String(seq)}`,
        amount,
        balance_after: balanceAfter,
        ledger_seq: seq,
      },
      ...overrides,
    });

    it("leaves the newer projection untouched, including price, attribution and location", () => {
      recordFundResponse({
        endpoint: ENDPOINT,
        identity: IDENTITY,
        callerPubkey: PUBKEY,
        credit: wire({ balance_micro: 500_000, remaining_micro: 500_000, ledger_seq: 1 }),
        targetMicro: 500_000,
        now: 1_000,
      });
      applyReceiptCredit(receipt(2, 150_000, 350_000, { identity: IDENTITY, now: 2_000 }));
      applyReceiptCredit(receipt(3, 200_000, 150_000, { identity: IDENTITY, now: 3_000 }));
      const before = loadCredit(ENDPOINT, PUBKEY, IDENTITY);
      expect(before).toMatchObject({ lastPriceMicro: 200_000, lastReceiptJobId: "job-3" });

      const replay = applyReceiptCredit(
        receipt(2, 150_000, 350_000, { endpoint: ALIAS_ENDPOINT, identity: IDENTITY, now: 9_000 })
      );

      expect(replay.mismatch).toBeUndefined();
      expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)).toEqual(before);
      expect(JSON.parse(readFileSync(join(TEST_DIR, "credits.json"), "utf-8")).credits).toEqual([
        before,
      ]);
    });

    it("ignores a stale released draw and keeps projection flags and discrepancy", () => {
      writeStore({
        ledgerSeq: 3,
        remainingMicro: 150_000,
        lastPriceMicro: 200_000,
        lastReceiptJobId: "job-3",
        provisional: true,
        unsequencedBalance: true,
        discrepancy: {
          atMs: 3_000,
          expectedMicro: 160_000,
          reportedMicro: 150_000,
          drawId: "draw-3",
          ledgerSeq: 3,
          jobId: "job-3",
        },
        updatedAt: 3_000,
      });
      const before = loadCredit(ENDPOINT, PUBKEY);

      const replay = applyReceiptCredit(receipt(2, 150_000, 350_000, { outcome: "failed", now: 9_000 }));

      expect(replay.mismatch).toBeUndefined();
      expect(loadCredit(ENDPOINT, PUBKEY)).toEqual(before);
    });

    it("still anchors an unsequenced balance at an equal sequence", () => {
      writeStore({
        ledgerSeq: 3,
        remainingMicro: 150_000,
        provisional: true,
        unsequencedBalance: true,
      });

      applyReceiptCredit(receipt(3, 200_000, 140_000, { now: 9_000 }));

      const after = loadCredit(ENDPOINT, PUBKEY);
      expect(after).toMatchObject({
        remainingMicro: 140_000,
        ledgerSeq: 3,
        lastPriceMicro: 200_000,
        lastReceiptJobId: "job-3",
        updatedAt: 9_000,
      });
      expect(after?.unsequencedBalance).toBeUndefined();
      expect(after?.provisional).toBeUndefined();
    });
  });

  it("an unknown credit id is a no-op (implicit N=1 receipts never match)", () => {
    seeded();
    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-x",
      outcome: "completed",
      credit: {
        credit_id: "imp:cashu:abc",
        draw_id: "draw-x",
        amount: 10_000,
        balance_after: 0,
        ledger_seq: 1,
      },
    });
    expect(result.credit).toBeUndefined();
  });
});

describe("released implicit credits", () => {
  const released = (
    overrides: { id?: string; balance?: number; seq?: number; now?: number } = {}
  ) =>
    applyImplicitReceiptCredit({
      endpoint: ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      jobId: `job-${overrides.id ?? "one"}`,
      outcome: "failed",
      credit: {
        credit_id: `imp:cashu:${overrides.id ?? "one"}`,
        draw_id: `draw-${overrides.id ?? "one"}`,
        amount: 100_000,
        balance_after: overrides.balance ?? 100_000,
        ledger_seq: overrides.seq ?? 1,
      },
      currency: "usd",
      issuedAtMs: overrides.now ?? 1_000_000,
      now: overrides.now ?? 1_000_000,
    });

  it("does not retain ordinary one-shot receipts that settled to zero", () => {
    const result = applyImplicitReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-success",
      outcome: "completed",
      credit: {
        credit_id: "imp:cashu:success",
        draw_id: "draw-success",
        amount: 100_000,
        balance_after: 0,
        ledger_seq: 1,
      },
      currency: "usd",
      issuedAtMs: 1_000_000,
      now: 1_000_000,
    });
    expect(result).toEqual({});
    expect(listImplicitCredits(1_000_000)).toEqual([]);
  });

  it("tracks a signed release across aliases and prunes its later signed zero", () => {
    released();
    expect(loadImplicitCredits(ALIAS_ENDPOINT, PUBKEY, IDENTITY, 1_000_001)).toMatchObject([
      {
        creditId: "imp:cashu:one",
        remainingMicro: 100_000,
        status: "active",
        endpointAliases: [ALIAS_ENDPOINT],
      },
    ]);

    const settled = applyImplicitReceiptCredit({
      endpoint: ALIAS_ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      jobId: "job-reuse",
      outcome: "completed",
      credit: {
        credit_id: "imp:cashu:one",
        draw_id: "draw-reuse",
        amount: 100_000,
        balance_after: 0,
        ledger_seq: 2,
      },
      currency: "usd",
      issuedAtMs: 1_000_002,
      now: 1_000_002,
    });
    expect(settled).toEqual({ pruned: true });
    expect(listImplicitCredits(1_000_002)).toEqual([]);
  });

  it("a live balance read cannot copy a released implicit credit into the prepaid store", () => {
    released();
    const implicit = wire({
      credit_id: "imp:cashu:one",
      balance_micro: 100_000,
      remaining_micro: 100_000,
      ledger_seq: 1,
    });

    expect(
      recordBalanceResponse({
        endpoint: ENDPOINT,
        identity: IDENTITY,
        callerPubkey: PUBKEY,
        credits: [implicit],
        primary: implicit,
      })
    ).toBeUndefined();
    expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)).toBeUndefined();

    applyImplicitReceiptCredit({
      endpoint: ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      jobId: "job-reuse",
      outcome: "completed",
      credit: {
        credit_id: "imp:cashu:one",
        draw_id: "draw-reuse",
        amount: 100_000,
        balance_after: 0,
        ledger_seq: 2,
      },
      currency: "usd",
      issuedAtMs: 1_000_002,
      now: 1_000_002,
    });

    expect(listImplicitCredits(1_000_002)).toEqual([]);
    expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)).toBeUndefined();
  });

  it("detects a sequential contradiction before adopting the signed figure", () => {
    released();
    const result = applyImplicitReceiptCredit({
      endpoint: ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      jobId: "job-reuse",
      outcome: "completed",
      credit: {
        credit_id: "imp:cashu:one",
        draw_id: "draw-reuse",
        amount: 50_000,
        balance_after: 40_000,
        ledger_seq: 2,
      },
      currency: "usd",
      issuedAtMs: 1_000_002,
      now: 1_000_002,
    });
    expect(result.mismatch).toMatchObject({ expectedMicro: 50_000, reportedMicro: 40_000 });
    expect(result.credit?.remainingMicro).toBe(40_000);
  });

  it("marks expiry as lost, retains no drain fiction, and bounds loss history", () => {
    for (let i = 0; i < 10; i += 1) released({ id: String(i), now: 1_000_000 + i });
    const afterThirtyDays = listImplicitCredits(1_000_000 + 2_592_000_000);
    expect(afterThirtyDays).toHaveLength(10);
    expect(afterThirtyDays.every((credit) => credit.status === "active")).toBe(true);
    const afterExpiry = 1_000_000 + 7_776_000_000 + 20;
    const rows = listImplicitCredits(afterExpiry);
    expect(rows).toHaveLength(8);
    expect(rows.every((credit) => credit.status === "lost")).toBe(true);
    expect(rows.every((credit) => credit.lossReason === "expired")).toBe(true);
  });

  it("records a server retirement as lost instead of mutating the prepaid row", () => {
    released();
    expect(
      markImplicitCreditLost({
        endpoint: ENDPOINT,
        identity: IDENTITY,
        callerPubkey: PUBKEY,
        creditId: "imp:cashu:one",
        reason: "not_found",
        now: 2_000_000,
      })
    ).toMatchObject({ status: "lost", lossReason: "not_found" });
    expect(loadCredit(ENDPOINT, PUBKEY, IDENTITY)).toBeUndefined();
  });
});

describe("provisional records (fund-and-draw in flight)", () => {
  it("the first receipt after a fund adopts the server figure without a mismatch", () => {
    ensureProvisionalCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      creditId: "credit-1",
      currency: "usd",
      targetMicro: 400_000,
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.provisional).toBe(true);
    const result = applyReceiptCredit({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      jobId: "job-1",
      outcome: "completed",
      credit: {
        credit_id: "credit-1",
        draw_id: "draw-1",

        amount: 10_000,
        balance_after: 187_431,
        ledger_seq: 1,
      },
    });
    expect(result.mismatch).toBeUndefined();
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.remainingMicro).toBe(187_431);
    expect(record?.provisional).toBeUndefined();
  });
});

describe("markCredit / drains / listCredits", () => {
  beforeEach(() => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
    });
  });

  it("drained zeroes the projection; the drain is retired on its own", () => {
    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-1", "credit-1"));
    expect(pendingDrainFor(loadCredit(ENDPOINT, PUBKEY), "credit-1")?.drainId).toBe("drain-1");

    markCredit(ENDPOINT, PUBKEY, "drained");
    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({ status: "drained", remainingMicro: 0 });
    expect(pendingDrainFor(loadCredit(ENDPOINT, PUBKEY), "credit-1")?.drainId).toBe("drain-1");

    clearPendingDrain(ENDPOINT, PUBKEY, { drainId: "drain-1", creditId: "credit-1" });
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains).toBeUndefined();
    expect(listCredits()).toHaveLength(1);
  });

  it("ifCreditId declines to mark a record that has since re-pointed", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-2", remaining_micro: 90_000 }),
      targetMicro: 400_000,
    });
    markCredit(ENDPOINT, PUBKEY, "drained", { ifCreditId: "credit-1" });
    expect(loadCredit(ENDPOINT, PUBKEY)).toMatchObject({
      status: "active",
      remainingMicro: 90_000,
    });
  });

  it("dedupes one unavailable-rail occurrence until recovery", () => {
    expect(markRefillRailUnavailable(ENDPOINT, PUBKEY, "credit-1", "lightning")).toBe(true);
    expect(markRefillRailUnavailable(ENDPOINT, PUBKEY, "credit-1", "lightning")).toBe(false);
    expect(loadCredit(ENDPOINT, PUBKEY)?.refillUnavailableRail).toBe("lightning");

    clearRefillRailUnavailable(ENDPOINT, PUBKEY, "credit-1");
    expect(loadCredit(ENDPOINT, PUBKEY)?.refillUnavailableRail).toBeUndefined();
    expect(markRefillRailUnavailable(ENDPOINT, PUBKEY, "credit-1", "lightning")).toBe(true);

    markCredit(ENDPOINT, PUBKEY, "drained");
    expect(loadCredit(ENDPOINT, PUBKEY)?.refillUnavailableRail).toBeUndefined();
  });

  it("dedupes one refill hold per recorded drain", () => {
    expect(markRefillDrainNoticed(ENDPOINT, PUBKEY, "credit-1", "drain-1")).toBe(true);
    expect(markRefillDrainNoticed(ENDPOINT, PUBKEY, "credit-1", "drain-1")).toBe(false);
    expect(loadCredit(ENDPOINT, PUBKEY)?.refillDrainNoticed).toBe("drain-1");

    expect(markRefillDrainNoticed(ENDPOINT, PUBKEY, "credit-1", "drain-2")).toBe(true);

    expect(markRefillDrainNoticed(ENDPOINT, PUBKEY, "credit-other", "drain-3")).toBe(false);
    expect(loadCredit(ENDPOINT, PUBKEY)?.refillDrainNoticed).toBe("drain-2");

    markCredit(ENDPOINT, PUBKEY, "drained");
    expect(loadCredit(ENDPOINT, PUBKEY)?.refillDrainNoticed).toBeUndefined();
  });

  it("upserts by (drainId, creditId) — the same drain refreshes, anything else appends", () => {
    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-1", "credit-1"));
    recordPendingDrain(ENDPOINT, PUBKEY, { ...drain("drain-1", "credit-1"), requestedAt: 4_242 });
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains).toHaveLength(1);
    expect(pendingDrainFor(loadCredit(ENDPOINT, PUBKEY), "credit-1")?.requestedAt).toBe(4_242);

    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-2", "credit-2"));
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains).toHaveLength(2);
    expect(pendingDrainFor(loadCredit(ENDPOINT, PUBKEY), "credit-2")?.drainId).toBe("drain-2");
  });

  it("never drops an unfulfilled drain to make room for another on the same credit", () => {

    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-1", "credit-1"));
    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-1b", "credit-1"));
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.pendingDrains?.map((d) => d.drainId)).toEqual(["drain-1", "drain-1b"]);

    expect(pendingDrainFor(record, "credit-1")?.drainId).toBe("drain-1");
  });

  it("stamping a legacy entry replaces it rather than doubling it", () => {

    const legacy = drain("drain-legacy");
    recordPendingDrain(ENDPOINT, PUBKEY, legacy);
    clearPendingDrain(ENDPOINT, PUBKEY, legacy);
    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-legacy", "credit-1"));
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.pendingDrains).toHaveLength(1);
    expect(pendingDrainFor(record, "credit-1")?.drainId).toBe("drain-legacy");
  });

  it("keeps a drain stranded when the record re-points at another credit", () => {

    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-1", "credit-1"));
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-2" }),
      targetMicro: 400_000,
    });
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.creditId).toBe("credit-2");
    expect(pendingDrainFor(record, "credit-2")).toBeUndefined();
    expect(pendingDrainFor(record, "credit-1")?.drainId).toBe("drain-1");
    expect(pendingDrainById(record, "drain-1")?.creditId).toBe("credit-1");
  });

  it("clearPendingDrain retires only the exact pair's credentials and preserves evidence", () => {
    const retired = {
      ...drain("drain-1", "credit-1"),
      method: "tempo",
      mppCredential: "Payment example-retired-close",
    };
    const sameIdOtherCredit = {
      ...drain("drain-1", "credit-2"),
      method: "tempo",
      mppCredential: "Payment example-unresolved-close",
    };
    const sameCreditOtherId = drain("drain-2", "credit-1");
    for (const entry of [retired, sameIdOtherCredit, sameCreditOtherId]) {
      recordPendingDrain(ENDPOINT, PUBKEY, entry);
    }
    recordDrainReceipts({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      drainId: "drain-1",
      creditId: "credit-1",
      receipts: [{ event: "requested" }],
      read: { reachable: true, anchor: ANCHOR },
      now: 10,
    });
    clearPendingDrain(ENDPOINT, PUBKEY, { drainId: "drain-1", creditId: "credit-1" });
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.pendingDrains).toEqual([sameIdOtherCredit, sameCreditOtherId]);
    expect(record?.drainEvidence).toEqual([
      expect.objectContaining({ drainId: "drain-1", creditId: "credit-1" }),
    ]);
    expect(record).toMatchObject({ creditId: "credit-1", remainingMicro: 200_000 });
    expect(readFileSync(join(TEST_DIR, "credits.json"), "utf-8")).not.toContain(
      retired.mppCredential
    );
    expect(JSON.stringify(record?.drainEvidence)).not.toContain("Payment example-");
  });

  it("retains every unresolved drain across credit rollovers, reloads, and retries", () => {
    const pending: PendingDrain[] = [];
    for (let i = 1; i <= 12; i++) {
      const creditId = `credit-${String(i)}`;
      recordFundResponse({
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        credit: wire({ credit_id: creditId }),
        targetMicro: 400_000,
      });
      const entry: PendingDrain = i % 2 === 0
        ? {
            ...drain(`drain-${String(i)}`, creditId),
            method: "tempo",
            payout: { address: `example-payout-${String(i)}` },
            mppCredential: `Payment example-close-${String(i)}`,
          }
        : drain(`drain-${String(i)}`, creditId);
      recordPendingDrain(ENDPOINT, PUBKEY, entry);
      pending.push(entry);
    }
    const reloaded = loadCredit(ENDPOINT, PUBKEY);
    expect(reloaded?.creditId).toBe("credit-12");
    expect(reloaded?.pendingDrains).toEqual(pending);
    for (const entry of pending) {
      expect(pendingDrainFor(reloaded, entry.creditId!)).toEqual(entry);
      expect(pendingDrainById(reloaded, entry.drainId)).toEqual(entry);
      recordPendingDrain(ENDPOINT, PUBKEY, entry);
    }
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains).toEqual(pending);
    expect(rawCredit().pendingDrains).toEqual(pending);
  });
});

describe("pendingDrains — reading what an older CLI wrote", () => {
  it("migrates a singular pendingDrain, unstamped and never auto-reused", () => {
    writeStore({
      pendingDrain: {
        drainId: "drain-legacy",
        method: "cashu",
        payout: { refund_pubkey: "02" + "cd".repeat(32) },
        requestedAt: 5,
      },
    });
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.pendingDrains).toHaveLength(1);
    expect(record?.pendingDrains?.[0]).toMatchObject({ drainId: "drain-legacy" });

    expect(record?.pendingDrains?.[0]?.creditId).toBeUndefined();
    expect(pendingDrainFor(record, "credit-1")).toBeUndefined();
    expect(pendingDrainById(record, "drain-legacy")).toBeDefined();
  });

  it("drops the legacy key from disk on the next write", () => {
    writeStore({
      pendingDrain: { drainId: "drain-legacy", method: "cashu", payout: {}, requestedAt: 5 },
    });
    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-new", "credit-1"));
    expect(rawCredit()).not.toHaveProperty("pendingDrain");
    expect(rawCredit().pendingDrains).toHaveLength(2);
  });

  it("tolerates junk where drains should be", () => {

    writeStore({ pendingDrains: "not-an-array", pendingDrain: 42 });
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains).toBeUndefined();
    expect(listCredits()).toHaveLength(1);

    writeStore({ pendingDrains: [null, {}, { drainId: "drain-ok" }] });
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains).toHaveLength(1);
    expect(listCredits()[0]?.pendingDrains?.[0]?.drainId).toBe("drain-ok");
  });
});

describe("recordDrainReceipts", () => {
  beforeEach(() => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
    });
  });

  const bundle = (drainId: string) =>
    loadCredit(ENDPOINT, PUBKEY)?.drainEvidence?.find((e) => e.drainId === drainId);

  const record = (args: Partial<Parameters<typeof recordDrainReceipts>[0]> = {}) => {
    recordDrainReceipts({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      drainId: "drain-1",
      creditId: "credit-1",
      receipts: [{ event: "requested" }],
      read: { reachable: false },
      ...args,
    });
  };

  it("pins the anchor the receipts were collected against", () => {
    record({ read: { reachable: true, anchor: ANCHOR } });
    expect(bundle("drain-1")?.anchor).toEqual(ANCHOR);
  });

  it("keeps a pinned anchor when the anchor read couldn't reach the DVM", () => {

    record({ read: { reachable: true, anchor: ANCHOR } });
    record({ receipts: [{ event: "requested" }, { event: "parked" }] });
    expect(bundle("drain-1")?.anchor).toEqual(ANCHOR);
    expect(bundle("drain-1")?.receipts).toHaveLength(2);
  });

  it("drops a pinned anchor when the DVM itself answered without one", () => {
    record({ read: { reachable: true, anchor: ANCHOR } });
    record({ read: { reachable: true } });
    expect(bundle("drain-1")?.anchor).toBeUndefined();
  });

  it("keeps an earlier drain's evidence when a second drain is recorded", () => {

    record({ read: { reachable: true, anchor: ANCHOR } });
    record({ drainId: "drain-2", creditId: "credit-2", receipts: [{ event: "parked" }] });
    expect(loadCredit(ENDPOINT, PUBKEY)?.drainEvidence).toHaveLength(2);
    expect(bundle("drain-1")?.receipts).toEqual([{ event: "requested" }]);
    expect(bundle("drain-1")?.anchor).toEqual(ANCHOR);
    expect(bundle("drain-2")?.receipts).toEqual([{ event: "parked" }]);
  });

  it("survives the credit-id swap between the two drains, evidence intact", () => {

    record({ drainId: "drain-a", creditId: "credit-1", read: { reachable: true, anchor: ANCHOR } });
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire({ credit_id: "credit-2" }),
      targetMicro: 400_000,
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.creditId).toBe("credit-2");
    record({ drainId: "drain-b", creditId: "credit-2", receipts: [{ event: "parked" }] });

    expect(bundle("drain-a")).toMatchObject({
      creditId: "credit-1",
      receipts: [{ event: "requested" }],
      anchor: ANCHOR,
    });
    expect(bundle("drain-b")?.creditId).toBe("credit-2");
  });

  it("replaces one drain's receipts in place as later states land", () => {
    record();
    record({
      receipts: [{ event: "requested" }, { event: "parked" }, { event: "picked_up" }],
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.drainEvidence).toHaveLength(1);
    expect(bundle("drain-1")?.receipts).toHaveLength(3);
  });
});

describe("drainEvidence — settlement and the bound on the archive", () => {
  const bundle = (drainId: string) =>
    loadCredit(ENDPOINT, PUBKEY)?.drainEvidence?.find((e) => e.drainId === drainId);

  const reclaim = (drainId: string, opts: { settledAt?: number } = {}) => {
    recordDrainReceipts({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      drainId,
      creditId: `credit-${drainId}`,
      receipts: ["requested", "sent"].map((event) => ({ ...unsignedDrainReceipt({ drain_id: drainId, credit_id: `credit-${drainId}`, event: event as "requested" | "sent" }), signature: "invalid" })),
      read: { reachable: false },
    });
    if (opts.settledAt !== undefined) {
      settleDrainEvidence({
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        drainId,
        now: opts.settledAt,
      });
    }
  };

  beforeEach(() => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: wire(),
      targetMicro: 400_000,
    });
  });

  it("stamps only the drain named, and keeps the bundle", () => {
    reclaim("drain-1", { settledAt: 1_789_300_000_000 });
    reclaim("drain-2");
    expect(bundle("drain-1")?.settledAt).toBe(1_789_300_000_000);
    expect(bundle("drain-1")?.receipts).toHaveLength(2);
    expect(bundle("drain-2")?.settledAt).toBeUndefined();
  });

  it("is a no-op for a drain that served no receipts", () => {
    const before = loadCredit(ENDPOINT, PUBKEY)?.updatedAt;
    settleDrainEvidence({ endpoint: ENDPOINT, callerPubkey: PUBKEY, drainId: "drain-none" });
    expect(loadCredit(ENDPOINT, PUBKEY)?.drainEvidence).toBeUndefined();
    expect(loadCredit(ENDPOINT, PUBKEY)?.updatedAt).toBe(before);
  });

  it("trims the working projection only after archiving the oldest settlement", () => {
    for (let i = 1; i <= 9; i++) reclaim(`drain-${String(i)}`, { settledAt: 1_000 + i });
    const evidence = loadCredit(ENDPOINT, PUBKEY)?.drainEvidence ?? [];
    expect(evidence).toHaveLength(8);
    expect(evidence.map((e) => e.drainId)).not.toContain("drain-1");
    expect(evidence.map((e) => e.drainId)).toContain("drain-9");
    const history = readCompletedCreditHistory({ endpoint: ENDPOINT }).records;
    expect(history).toHaveLength(9);
    expect(history[0]).toMatchObject({ drainId: "drain-1", settledAt: 1001 });
  });

  it("never evicts a reclaim that is still owed, however old", () => {

    reclaim("drain-owed");
    for (let i = 1; i <= 9; i++) reclaim(`drain-${String(i)}`, { settledAt: 1_000 + i });
    const evidence = loadCredit(ENDPOINT, PUBKEY)?.drainEvidence ?? [];
    expect(evidence.map((e) => e.drainId)).toContain("drain-owed");
    expect(evidence.filter((e) => e.settledAt !== undefined)).toHaveLength(8);
  });
});

describe("drainEvidence — reading what is actually on disk", () => {
  it("tolerates junk where evidence should be", () => {

    writeStore({ drainEvidence: "not-an-array" });
    expect(loadCredit(ENDPOINT, PUBKEY)?.drainEvidence).toBeUndefined();
    expect(listCredits()).toHaveLength(1);

    writeStore({
      drainEvidence: [
        null,
        42,
        { drainId: "no-receipts" },
        { drainId: "drain-ok", receipts: [{ event: "requested" }], creditId: 7, settledAt: "soon" },
      ],
    });
    const evidence = loadCredit(ENDPOINT, PUBKEY)?.drainEvidence ?? [];
    expect(evidence).toHaveLength(1);

    expect(evidence[0]).toMatchObject({ drainId: "drain-ok", creditId: "", collectedAt: 0 });
    expect(evidence[0]?.settledAt).toBeUndefined();

    recordDrainReceipts({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      drainId: "drain-ok",
      creditId: "credit-1",
      receipts: [{ event: "requested" }, { event: "parked" }],
      read: { reachable: true, anchor: ANCHOR },
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.drainEvidence?.[0]).toMatchObject({
      creditId: "credit-1",
      anchor: ANCHOR,
    });
  });

  it("reads a legacy record without crashing and leaves its bytes alone", () => {
    // The record-scoped pair `drainEvidence[]` replaced. It is not migrated:
    // the shape records no drain id, and a bundle is graded against the ids it
    // is filed under, so a guessed label would read `invalid` rather than be
    // read at all. The bytes stay on disk — destroying them would close the
    // door on a migration that finds a way.
    writeStore({
      drainReceipts: [{ kind: "credit_drain", drain_id: "drain-legacy", event: "requested" }],
      drainReceiptAnchor: ANCHOR,
    });
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record).toMatchObject({ creditId: "credit-1", remainingMicro: 200_000 });
    expect(record?.drainEvidence).toBeUndefined();
    expect(listCredits()).toHaveLength(1);

    recordPendingDrain(ENDPOINT, PUBKEY, drain("drain-new", "credit-1"));
    expect(rawCredit().drainReceipts).toHaveLength(1);
    expect(rawCredit().drainReceiptAnchor).toEqual(ANCHOR);
  });
});

describe("reading a store written before the mpp → tempo rename", () => {

  it("rewrites the rail on the credit, its refill flag and its parked drains", () => {
    writeStore({
      rail: "mpp",
      refillUnavailableRail: "mpp",
      pendingDrains: [
        { drainId: "drain-mpp", method: "mpp", creditId: "credit-1", requestedAt: 5 },
        { drainId: "drain-cashu", method: "cashu", creditId: "credit-1", requestedAt: 6 },
      ],
    });
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.rail).toBe("tempo");
    expect(record?.refillUnavailableRail).toBe("tempo");
    expect(record?.pendingDrains?.map((d) => d.method)).toEqual(["tempo", "cashu"]);

    expect(record).toMatchObject({ creditId: "credit-1", remainingMicro: 200_000 });
    expect(pendingDrainById(record, "drain-mpp")?.method).toBe("tempo");
  });

  it("rewrites the singular pendingDrain an older CLI wrote, after it is merged", () => {
    // Ordering guard: the rail rewrite runs outside `normalizeDrains`, so a
    // legacy singular drain is folded into `pendingDrains` first and then
    // renamed. Swap the two and this drain keeps `mpp`.
    writeStore({
      pendingDrain: { drainId: "drain-legacy", method: "mpp", payout: {}, requestedAt: 5 },
    });
    expect(loadCredit(ENDPOINT, PUBKEY)?.pendingDrains?.[0]?.method).toBe("tempo");
  });

  it("rewrites the rail on a pending funding", () => {
    writeFileSync(
      join(TEST_DIR, "credits.json"),
      JSON.stringify({
        credits: [],
        pendingFundings: [
          {
            endpoint: ENDPOINT,
            callerPubkey: PUBKEY,
            creditId: "credit-1",
            fundId: "fund-1",
            amountMicro: 200_000,
            rail: "mpp",
            targetMicro: 400_000,
            requestedAt: 5,
          },
        ],
      })
    );
    expect(listPendingFundings({}).map((f) => f.rail)).toEqual(["tempo"]);
  });

  it("leaves a rail that was never `mpp` alone", () => {
    writeStore({ rail: "x402", pendingDrains: [{ drainId: "d", method: "x402" }] });
    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.rail).toBe("x402");
    expect(record?.pendingDrains?.[0]?.method).toBe("x402");
  });
});

describe("sibling stores under one DVM identity", () => {
  const pending = (overrides: Record<string, unknown> = {}) => ({
    endpoint: ENDPOINT,
    callerPubkey: PUBKEY,
    creditId: "credit-shared",
    fundId: "fund-1",
    amountMicro: 200_000,
    rail: "lightning",
    targetMicro: 400_000,
    requestedAt: 5,
    ...overrides,
  });
  const linkedCredit = (overrides: Record<string, unknown> = {}) => ({
    endpoint: ENDPOINT,
    endpointAliases: [ALIAS_ENDPOINT],
    dvmId: DVM_ID,
    callerPubkey: PUBKEY,
    creditId: "credit-shared",
    currency: "usd",
    balanceMicro: 200_000,
    remainingMicro: 180_000,
    ledgerSeq: 2,
    expiryMs: 1000,
    targetMicro: 400_000,
    status: "active",
    openedAt: 10,
    updatedAt: 20,
    ...overrides,
  });

  it("collapses one DVM's menu snapshots, keeping the newest and every origin", () => {
    writeRawStore(
      [linkedCredit()],
      [],
      [
        {
          endpoint: ENDPOINT,
          callerPubkey: PUBKEY,
          menu: MENU,
          observedAt: 10,
          builderPubkey: ANCHOR.pubkey,
        },
        {
          endpoint: ALIAS_ENDPOINT,
          callerPubkey: PUBKEY,
          menu: { ...MENU, max_micro: 9_000_000 },
          observedAt: 30,
        },
      ]
    );

    const snapshots = listFundingMenuSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      endpoint: ALIAS_ENDPOINT,
      endpointAliases: [ENDPOINT],
      dvmId: DVM_ID,
      observedAt: 30,

      builderPubkey: ANCHOR.pubkey,
    });
    expect(snapshots[0]?.menu.max_micro).toBe(9_000_000);

    const once = readFileSync(join(TEST_DIR, "credits.json"), "utf-8");
    listFundingMenuSnapshots();
    expect(readFileSync(join(TEST_DIR, "credits.json"), "utf-8")).toBe(once);
  });

  it("keeps snapshots apart when no credit record proves the origins are one DVM", () => {
    writeRawStore(
      [],
      [],
      [
        { endpoint: ENDPOINT, callerPubkey: PUBKEY, menu: MENU, observedAt: 10 },
        { endpoint: ALIAS_ENDPOINT, callerPubkey: PUBKEY, menu: MENU, observedAt: 30 },
      ]
    );
    expect(listFundingMenuSnapshots()).toHaveLength(2);
  });

  it("records one snapshot per DVM once its identity is known", () => {
    recordFundingMenuSnapshot({
      endpoint: ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      menu: MENU,
      builderPubkey: ANCHOR.pubkey,
      now: 10,
    });
    recordFundingMenuSnapshot({
      endpoint: ALIAS_ENDPOINT,
      identity: IDENTITY,
      callerPubkey: PUBKEY,
      menu: { ...MENU, max_micro: 9_000_000 },
      now: 30,
    });
    const snapshots = listFundingMenuSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.endpoint).toBe(ENDPOINT);
    expect(snapshots[0]?.endpointAliases).toEqual([ALIAS_ENDPOINT]);
    expect(snapshots[0]?.menu.max_micro).toBe(9_000_000);
    expect(snapshots[0]?.builderPubkey).toBe(ANCHOR.pubkey);
  });

  it("resumes a funding intent through the other hostname of the same credit", () => {
    writeRawStore([linkedCredit()], [pending()]);
    expect(loadPendingFunding(ALIAS_ENDPOINT, PUBKEY)?.fundId).toBe("fund-1");
    expect(loadPendingFunding(ENDPOINT, PUBKEY)?.fundId).toBe("fund-1");
  });

  it("leaves a funding intent where it was raised when nothing links the hostnames", () => {

    writeRawStore([], [pending()]);
    expect(loadPendingFunding(ALIAS_ENDPOINT, PUBKEY)).toBeUndefined();
    expect(loadPendingFunding(ENDPOINT, PUBKEY)?.fundId).toBe("fund-1");
  });

  it("enriches the intent through a sibling hostname without moving or duplicating it", () => {
    writeRawStore([linkedCredit()], [pending()]);
    recordPendingFunding({
      ...pending({ endpoint: ALIAS_ENDPOINT, bolt11: "lnbc1", requestedAt: 6 }),
    } as Parameters<typeof recordPendingFunding>[0]);
    const all = listPendingFundings();
    expect(all).toHaveLength(1);

    expect(all[0]?.endpoint).toBe(ENDPOINT);
    expect(all[0]?.bolt11).toBe("lnbc1");
  });

  it("clears a funding intent named through the other hostname", () => {
    writeRawStore([linkedCredit()], [pending()]);
    clearPendingFunding(ALIAS_ENDPOINT, PUBKEY, "credit-shared", "fund-1");
    expect(listPendingFundings()).toEqual([]);
  });

  it("collapses exact duplicate funding intents left by the hostname split", () => {
    writeRawStore(
      [linkedCredit()],
      [pending({ requestedAt: 5 }), pending({ endpoint: ALIAS_ENDPOINT, requestedAt: 7 })]
    );
    const all = listPendingFundings();
    expect(all).toHaveLength(1);
    expect(all[0]?.requestedAt).toBe(7);
  });

  it("keeps two genuinely different intents for one credit", () => {
    writeRawStore([linkedCredit()], [pending(), pending({ fundId: "fund-2", requestedAt: 9 })]);
    expect(listPendingFundings().map((f) => f.fundId)).toEqual(["fund-1", "fund-2"]);
  });
});

describe("pending funding provider boundaries", () => {
  const OTHER_ALIAS = "https://other-alt.example.com";
  const providers = [
    { endpoint: ENDPOINT, alias: ALIAS_ENDPOINT, identity: IDENTITY },
    { endpoint: IMPOSTOR_ENDPOINT, alias: OTHER_ALIAS, identity: IMPOSTOR },
  ];
  const intent = (endpoint: string, overrides: Partial<PendingFunding> = {}): PendingFunding => ({
    endpoint,
    callerPubkey: PUBKEY,
    creditId: "credit-shared",
    fundId: "fund-shared",
    amountMicro: 200_000,
    rail: "lightning",
    targetMicro: 400_000,
    requestedAt: 5,
    ...overrides,
  });

  function trackProviders(reverse = false): void {
    for (const { endpoint, alias, identity } of reverse ? [...providers].reverse() : providers) {
      ensureProvisionalCredit({
        endpoint, identity, callerPubkey: PUBKEY, creditId: "credit-shared",
        currency: "usd", targetMicro: 400_000,
      });
      loadCredit(alias, PUBKEY, identity);
    }
  }

  it.each([false, true])("finds only the funding origin's provider aliases (reverse=%s)", (reverse) => {
    trackProviders(reverse);
    recordPendingFunding(intent(IMPOSTOR_ENDPOINT, { bolt11: "lnbcrt1other" }));

    expect(loadPendingFunding(OTHER_ALIAS, PUBKEY, "credit-shared"))
      .toMatchObject({ endpoint: IMPOSTOR_ENDPOINT, bolt11: "lnbcrt1other" });
    expect(loadPendingFunding(IMPOSTOR_ENDPOINT, PUBKEY)?.fundId).toBe("fund-shared");
    expect(loadPendingFunding(ENDPOINT, PUBKEY)).toBeUndefined();
    expect(loadPendingFunding(ALIAS_ENDPOINT, PUBKEY)).toBeUndefined();
  });

  it.each(["lightning", "tempo"] as const)("keeps equal IDs separate through %s enrichment and clearing", (rail) => {
    trackProviders();
    const first = intent(ENDPOINT, {
      rail,
      ...(rail === "lightning"
        ? { bolt11: "lnbcrt1first", paymentHash: "11".repeat(32), amountMsats: 100_000 }
        : { mppCredential: "Payment first", authorizedMicro: 200_000 }),
    });
    const second = intent(IMPOSTOR_ENDPOINT, {
      rail, requestedAt: 7,
      ...(rail === "lightning"
        ? { bolt11: "lnbcrt1second", paymentHash: "22".repeat(32), amountMsats: 200_000 }
        : { mppCredential: "Payment second", authorizedMicro: 300_000 }),
    });
    recordPendingFunding(first);
    recordPendingFunding(second);
    expect(listPendingFundings()).toEqual([first, second]);

    const enriched = { ...second, requestedAt: 9, expiresAtMs: 1000 };
    recordPendingFunding({ ...enriched, endpoint: OTHER_ALIAS });
    expect(listPendingFundings()).toEqual([first, enriched]);
    const persisted = JSON.parse(readFileSync(join(TEST_DIR, "credits.json"), "utf8")) as {
      pendingFundings: PendingFunding[];
    };
    expect(persisted.pendingFundings).toEqual([first, enriched]);

    clearPendingFunding(ALIAS_ENDPOINT, PUBKEY, "credit-shared", "fund-shared");
    expect(listPendingFundings()).toEqual([enriched]);
    expect(loadPendingFunding(OTHER_ALIAS, PUBKEY)).toEqual(enriched);
    clearPendingFunding(OTHER_ALIAS, PUBKEY, "credit-shared", "fund-shared");
    expect(listPendingFundings()).toEqual([]);
  });

  it.each([
    { rail: "lightning", reverse: false },
    { rail: "lightning", reverse: true },
    { rail: "tempo", reverse: false },
    { rail: "tempo", reverse: true },
  ] as const)("deduplicates genuine aliases beyond a colliding intent without mixing observations ($rail, reverse=$reverse)", ({ rail, reverse }) => {
    trackProviders();
    const original = intent(IMPOSTOR_ENDPOINT, {
      rail,
      ...(rail === "lightning"
        ? { bolt11: "lnbcrt1old", paymentHash: "33".repeat(32), amountMsats: 100_000 }
        : { mppCredential: "Payment old", authorizedMicro: 200_000, budgetBtcRate: 100_000 }),
    });
    const newer = intent(OTHER_ALIAS, {
      rail, requestedAt: 9,
      ...(rail === "lightning"
        ? { bolt11: "lnbcrt1new" }
        : { mppCredential: "Payment new", authorizedMicro: 300_000 }),
    });
    const other = intent(ENDPOINT, { rail: "tempo", mppCredential: "Payment other", requestedAt: 7 });
    const credits = listCredits();
    const rows = [other, original, newer, { ...original, endpoint: OTHER_ALIAS, requestedAt: 6 }];
    writeRawStore(credits, reverse ? rows.reverse() : rows);

    expect(listPendingFundings()).toEqual([other, { ...newer, endpoint: IMPOSTOR_ENDPOINT }]);
    expect(loadPendingFunding(OTHER_ALIAS, PUBKEY)).toEqual({ ...newer, endpoint: IMPOSTOR_ENDPOINT });
    const once = readFileSync(join(TEST_DIR, "credits.json"), "utf8");
    listPendingFundings();
    expect(readFileSync(join(TEST_DIR, "credits.json"), "utf8")).toBe(once);
  });

  it("keeps unrelated legacy origins separate but deduplicates normalized copies before a credit exists", () => {
    const first = intent(ENDPOINT, { bolt11: "lnbcrt1first" });
    const second = intent(IMPOSTOR_ENDPOINT, { requestedAt: 7, mppCredential: "Payment other", rail: "tempo" });
    writeRawStore([], [first, second, { ...first, endpoint: `${ENDPOINT}/v1/`, requestedAt: 9 }]);

    expect(listPendingFundings()).toEqual([second, { ...first, requestedAt: 9 }]);
    expect(loadPendingFunding(ALIAS_ENDPOINT, PUBKEY)).toBeUndefined();
    clearPendingFunding(`${ENDPOINT}/v1/credit`, PUBKEY, "credit-shared", "fund-shared");
    expect(listPendingFundings()).toEqual([second]);
  });
});
