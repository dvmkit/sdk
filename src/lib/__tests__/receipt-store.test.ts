
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ReceiptStoreModule from "../receipt-store";
import type { StoredReceipt } from "../receipt-store";
import { attestedDvm } from "./fixtures/receipt-fixture";

let tmpConfigDir: string;
let originalConfigDir: string | undefined;

/** `defaults.ts` resolves CONFIG_DIR at import time, so the env must be set before the import. */
async function store(): Promise<typeof ReceiptStoreModule> {
  return import("../receipt-store");
}

function entry(overrides: Partial<StoredReceipt> = {}): StoredReceipt {
  const dvm = attestedDvm();
  return {
    receipt: dvm.sign(),
    endpoint: "https://wordcount.example.com",
    builder: dvm.anchor,
    verification: "verified",
    verified_at: 1789300000000,
    ...overrides,
  };
}

beforeEach(() => {
  originalConfigDir = process.env.DVM_CONFIG_DIR;
  tmpConfigDir = mkdtempSync(join(tmpdir(), "dvm-receipts-receipts-"));
  process.env.DVM_CONFIG_DIR = tmpConfigDir;
  vi.resetModules();
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
  else process.env.DVM_CONFIG_DIR = originalConfigDir;
  rmSync(tmpConfigDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("receipt store", () => {
  it("returns an empty collection before anything is stored", async () => {
    const { loadReceipt, loadReceipts } = await store();
    expect(loadReceipts()).toEqual([]);
    expect(loadReceipt("job-a7571b-1")).toBeNull();
  });

  it("appends a receipt and reads it back with its trust anchor", async () => {
    const { appendReceipt, loadReceipt, loadReceipts } = await store();
    const first = entry();
    appendReceipt(first);

    expect(loadReceipts()).toHaveLength(1);
    const loaded = loadReceipt(first.receipt.job_id);
    expect(loaded?.receipt).toEqual(first.receipt);
    expect(loaded?.builder).toEqual(first.builder);
    expect(loaded?.endpoint).toBe("https://wordcount.example.com");
  });

  it("creates the config dir on first append", async () => {
    const { appendReceipt, loadReceipts } = await store();
    rmSync(tmpConfigDir, { recursive: true, force: true });
    appendReceipt(entry());
    expect(loadReceipts()).toHaveLength(1);
  });

  it("deduplicates on job_id, not on the signature", async () => {
    const { appendReceipt, loadReceipts } = await store();
    const dvm = attestedDvm();
    const a = dvm.sign();
    const b = dvm.sign();
    expect(a.signature).not.toBe(b.signature);

    const first = entry({ receipt: a });
    appendReceipt(first);
    appendReceipt(entry({ receipt: b, verified_at: first.verified_at + 5000 }));
    const held = loadReceipts();
    expect(held).toHaveLength(1);
    expect(held[0].receipt).toEqual(a);
    expect(held[0].verified_at).toBe(first.verified_at);
  });

  it("stores receipts from different jobs side by side, in append order", async () => {
    const { appendReceipt, loadReceipts } = await store();
    const dvm = attestedDvm();
    appendReceipt(entry({ receipt: dvm.sign({ job_id: "job-1", seq: 1 }) }));
    appendReceipt(entry({ receipt: dvm.sign({ job_id: "job-2", seq: 2 }) }));

    expect(loadReceipts().map((e) => e.receipt.job_id)).toEqual(["job-1", "job-2"]);
  });

  it("skips a malformed line rather than losing the whole collection", async () => {
    const { appendReceipt, loadReceipts } = await store();
    appendReceipt(entry({ receipt: attestedDvm().sign({ job_id: "job-good" }) }));
    appendFileSync(join(tmpConfigDir, "receipts.jsonl"), "{ this is not json\n");
    appendReceipt(entry({ receipt: attestedDvm().sign({ job_id: "job-also-good" }) }));

    expect(loadReceipts().map((e) => e.receipt.job_id)).toEqual(["job-good", "job-also-good"]);
  });

  it("skips a line carrying no receipt job_id", async () => {
    const { loadReceipts } = await store();
    writeFileSync(
      join(tmpConfigDir, "receipts.jsonl"),
      `${JSON.stringify({ endpoint: "https://x" })}\n${JSON.stringify({ receipt: {} })}\n`
    );
    expect(loadReceipts()).toEqual([]);
  });

  it("skips a line whose signed body lost a field the read paths dereference", async () => {
    const { appendReceipt, loadReceipts } = await store();
    const good = attestedDvm().sign({ job_id: "job-good" });
    appendReceipt(entry({ receipt: good }));

    for (const field of ["paid", "receipt_pubkey", "dvm", "signature"] as const) {
      const { [field]: _dropped, ...body } = good;
      appendFileSync(
        join(tmpConfigDir, "receipts.jsonl"),
        `${JSON.stringify({ ...entry({ receipt: good }), receipt: { ...body, job_id: `job-no-${field}` } })}\n`
      );
    }
    appendReceipt(entry({ receipt: attestedDvm().sign({ job_id: "job-also-good" }) }));

    expect(loadReceipts().map((e) => e.receipt.job_id)).toEqual(["job-good", "job-also-good"]);
  });

  it("keeps a receipt whose signature no longer holds", async () => {
    // The other half of the same rule: a tampered *body* is dropped, a
    // tampered *signature* is kept and reported `invalid`. Refusing it here
    // would turn forgery into "this DVM issued no receipt".
    const { appendReceipt, loadReceipt } = await store();
    const receipt = attestedDvm().sign({ job_id: "job-tampered" });
    appendReceipt(entry({ receipt: { ...receipt, seq: receipt.seq + 1 } }));

    expect(loadReceipt("job-tampered")?.receipt.seq).toBe(receipt.seq + 1);
  });

  it("survives an empty file", async () => {
    const { loadReceipts } = await store();
    writeFileSync(join(tmpConfigDir, "receipts.jsonl"), "\n\n");
    expect(loadReceipts()).toEqual([]);
  });

  it("stores an unattested receipt with no anchor", async () => {
    const { appendReceipt, loadReceipt } = await store();
    const e = entry({ verification: "verified_unattested" });
    delete e.builder;
    appendReceipt(e);

    const loaded = loadReceipt(e.receipt.job_id);
    expect(loaded?.verification).toBe("verified_unattested");
    expect(loaded?.builder).toBeUndefined();
  });
});
