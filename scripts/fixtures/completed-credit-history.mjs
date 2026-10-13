import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "packed-credit-history-"));
process.env.DVM_CONFIG_DIR = dir;
const sdk = await import("@dvmkit/sdk/internal");
const identity = sdk.generateIdentity();
const dvmId = "dvm-example";
const receiptKey = sdk.deriveReceiptKeypair(identity.secret, dvmId);
const attestation = sdk.buildAttestation({
  dvmId,
  slug: "example",
  capabilities: ["count"],
  builderPubkey: identity.pubkey,
  receiptPubkey: receiptKey.pubkey,
  deployedAt: 1789200000,
});
const anchor = {
  pubkey: identity.pubkey,
  attestation: { ...attestation },
  signature: sdk.signAttestation(attestation, identity.secret),
};
const endpoint = "https://example.com";
const caller = "bb".repeat(32);
/** @type {NonNullable<import("@dvmkit/sdk/internal").StoredCredit["drainEvidence"]>} */
const evidence = Array.from({ length: 12 }, (_, i) => ({
  drainId: `refund-${i}`,
  creditId: "credit",
  collectedAt: 250,
  settledAt: 300 + i,
  settlement: { rail: "cashu", currency: "usd", amountMicro: 321, feeMicro: 7 },
  anchor,
  receipts: [
    sdk.signDrainReceipt(
      {
        v: 1,
        kind: "credit_drain",
        credit_id: "credit",
        drain_id: `refund-${i}`,
        event: "sent",
        method: "cashu",
        amount_micro: 321,
        balance_after_micro: 0,
        ledger_seq: i + 1,
        issued_at: 1789300000,
        caller_pubkey: caller,
        dvm_id: dvmId,
        dvm: "example",
        receipt_pubkey: receiptKey.pubkey,
      },
      receiptKey.secret,
    ),
  ],
}));
const credential = "example-recovery-credential";
evidence.push({
  drainId: "unresolved",
  creditId: "credit",
  collectedAt: 1,
  receipts: [{ mppCredential: credential }],
});
const pending = {
  drainId: "unresolved",
  creditId: "credit",
  method: "tempo",
  payout: {},
  requestedAt: 1,
  mppCredential: credential,
};
const credit = {
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
  drainEvidence: evidence,
};
const losses = Array.from({ length: 12 }, (_, i) => ({
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
}));
writeFileSync(
  join(dir, "credits.json"),
  JSON.stringify({ credits: [credit], implicitCredits: losses }),
);
/** @param {"asc" | "desc" | undefined} order */
function readPages(order) {
  const query = {
    limit: 5,
    endpoint,
    callerPubkey: caller,
    ...(order ? { order } : {}),
  };
  let page = sdk.readCompletedCreditHistory(query);
  let pages = 1;
  const records = [...page.records];
  while (page.nextCursor) {
    page = sdk.readCompletedCreditHistory({
      ...query,
      cursor: page.nextCursor,
    });
    records.push(...page.records);
    pages++;
  }
  return { records, pages };
}
const defaultAscending = readPages(undefined);
const explicitAscending = readPages("asc");
const { records, pages } = readPages("desc");
const expectedAscending = [
  ...Array.from({ length: 12 }, (_, i) => `imp:cashu:payment-${i}`),
  ...Array.from({ length: 12 }, (_, i) => `refund-${i}`),
];
/** @param {import("@dvmkit/sdk/internal").CompletedCreditHistoryRecord} record */
const completionKey = (record) =>
  record.kind === "completed_refund" ? record.drainId : record.creditId;
assert.deepEqual(
  defaultAscending.records.map(completionKey),
  expectedAscending,
);
assert.deepEqual(
  explicitAscending.records.map(completionKey),
  expectedAscending,
);
assert.deepEqual(records.map(completionKey), [...expectedAscending].reverse());
assert.deepEqual(defaultAscending.records, explicitAscending.records);
assert.deepEqual(records, [...defaultAscending.records].reverse());
assert.equal(defaultAscending.pages, 5);
assert.equal(explicitAscending.pages, 5);
assert.equal(records.length, 24);
assert.equal(new Set(records.map((row) => row.id)).size, 24);
let verified = 0;
for (const record of records) {
  if (record.kind !== "completed_refund") continue;
  assert.equal(record.feeMicro, 7);
  assert.equal(record.currency, "usd");
  assert.equal(record.settledAt, 300 + Number(record.drainId.split("-")[1]));
  assert.equal(
    sdk.verifyDrainReceiptChain({
      receipt: record.receipts[0],
      builder: record.anchor,
      expectedCreditId: record.creditId,
      expectedDrainId: record.drainId,
    }).status,
    "verified",
  );
  verified++;
}
const stored = sdk.loadCredit(endpoint, caller);
assert.ok(stored);
assert.ok(stored.drainEvidence);
assert.deepEqual(stored.pendingDrains, [pending]);
assert.equal(stored.drainEvidence.length, 9);
assert.equal(
  stored.drainEvidence.filter((row) => row.settledAt !== undefined).length,
  8,
);
assert.equal(sdk.listImplicitCredits().length, 8);
const journal = readFileSync(join(dir, "credits-history.jsonl"), "utf8");
assert.ok(!journal.includes(credential));
assert.ok(!journal.includes("mppCredential"));
assert.equal(statSync(join(dir, "credits-history.jsonl")).mode & 0o777, 0o600);
console.log(
  JSON.stringify({
    result: "PASS",
    reader: "readCompletedCreditHistory",
    records: records.length,
    pages,
    order: "desc",
    ordersVerified: ["default asc", "asc", "desc"],
    verifiedRefunds: verified,
    refundProjection: 8,
    lossProjection: 8,
    unresolvedEvidenceRetained: true,
    credentialsExcluded: true,
    journalMode: "0600",
  }),
);
rmSync(dir, { recursive: true, force: true });
