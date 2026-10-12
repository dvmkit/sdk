/* Real Postgres and Nutshell exercise P2PK witness spending, NUT-7 and the two-store park transaction.
 * The caller redeems the parked token with a refund key distinct from its signing key.
 * Infrastructure absence skips this integration; the required database gate supplies it. */
import { Amount, getEncodedToken, getTokenMetadata, type Proof, type Token } from "@cashu/cashu-ts";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildAdminAuthHeader } from "../../../lib/cashu/admin-auth";
import {
  localMintAvailable,
  LOCAL_MINT_URL,
  mintLocalTokens,
} from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";
import { getWallet } from "../../../lib/cashu/wallet";
import { type DrainReceipt, verifyDrainReceipt } from "../../../lib/receipt";
import { servedApps } from "../../../test-support/served-app";
import { announceTier } from "../../../test-support/tier-announce";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { fundCredit } from "./__helpers__/credit-fixtures";
import { CreditLedger } from "../credit-ledger";
import { DRAIN_DELIVERY_RESERVE_SATS } from "../credit-lots";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { initLockPubkeyTable, seedLockPubkeyState } from "../lock-pubkey-store";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { initWalletAccumulatorTable, insertAccumulatorRows } from "../wallet-accumulator-store";

const DATABASE_URL = process.env.DATABASE_URL;
const DB_OK = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const MINT_OK = DB_OK && (await localMintAvailable());

if (DB_OK) {
  announceTier(
    "credit-drain-park mint",
    MINT_OK ? "ran" : "skipped",
    MINT_OK
      ? `mint reachable at ${LOCAL_MINT_URL}`
      : `DATABASE_URL is set but the mint is unreachable at ${LOCAL_MINT_URL}`
  );
}

const DVM_ID = "dvm-drain-park-e2e";
const RECEIPT_KEY = "77".repeat(32);

// Caller's request-signing key (x-only, BIP-340) — deliberately unrelated to
// the refund key: the auth key cannot witness-spend NUT-11 notes.
const CALLER_PRIVKEY = new Uint8Array(32).fill(7);
const CALLER = hex(schnorr.getPublicKey(CALLER_PRIVKEY));

const REFUND_PRIVKEY = "71".repeat(32);
const REFUND_PUBKEY = hex(secp256k1.getPublicKey(hexToBytes(REFUND_PRIVKEY), true));

const BUILDER_PRIVKEY = "55".repeat(32);
const LOCK_PUBKEY = hex(secp256k1.getPublicKey(hexToBytes(BUILDER_PRIVKEY), true));

const OWED_SATS = 400 - DRAIN_DELIVERY_RESERVE_SATS;

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h, "hex"));
}

describe.skipIf(!DB_OK || !MINT_OK)("cashu drain loop vs the real mint", () => {
  let pool: pg.Pool;
  let ledger: CreditLedger;
  const servers = servedApps({ teardown: "all" });
  let url: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    ledger = new CreditLedger(pool);
    await ledger.init();
    await initWalletAccumulatorTable(pool);
    await initLockPubkeyTable(pool);
    // Own rows only for the DVM-scoped tables; the ledger tables are cleaned
    // wholesale like credit-ledger.db.test.ts does (the runner is serial).
    await pool.query("DELETE FROM credit_drains");
    await pool.query("DELETE FROM credit_draws");
    await pool.query("DELETE FROM credit_fundings");
    await pool.query("DELETE FROM credits");
    await pool.query("DELETE FROM wallet_accumulator WHERE dvm_id = $1", [DVM_ID]);
    await pool.query("DELETE FROM dvm_lock_pubkeys WHERE dvm_id = $1", [DVM_ID]);
    await seedLockPubkeyState(pool, DVM_ID, LOCK_PUBKEY);

    const dvm = configureDVM({
      name: "drain-park-e2e",
      capability: "do",
      input: signedSchema,
      price: "$0.10",
      onJob(ctx) {
        ctx.complete("done");
      },
      credit: { min: "$0.10", max: "$5.00" },
      auth: secp256k1Auth(),
    });
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      fxFetcher: stubFx,
      creditLedger: ledger,
      receiptKey: RECEIPT_KEY,
      cashuMode: "p2pk-accumulator",
      db: pool,
      dvmId: DVM_ID,
      lockPubkey: LOCK_PUBKEY,
    });
    url = await servers.serve(app);
  }, 30_000);

  afterAll(async () => {
    await servers.closeAll();
    await pool.query("DELETE FROM credit_drains");
    await pool.query("DELETE FROM credit_draws");
    await pool.query("DELETE FROM credit_fundings");
    await pool.query("DELETE FROM credits");
    await pool.query("DELETE FROM wallet_accumulator WHERE dvm_id = $1", [DVM_ID]);
    await pool.query("DELETE FROM dvm_lock_pubkeys WHERE dvm_id = $1", [DVM_ID]);
    await pool.end();
  });

  function creditCall(fields: Record<string, unknown>): Promise<Response> {
    return fetch(`${url}/v1/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(creditSigner.signRequest(CALLER_PRIVKEY, fields)),
    });
  }

  async function adminCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { header } = buildAdminAuthHeader({
      method,
      path,
      dvmId: DVM_ID,
      privkeyHex: BUILDER_PRIVKEY,
    });
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: header,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  it("request → swap at the mint → park → poll/pickup → caller redeems the refund", async () => {
    // Mirrors the receive path's end state: the mint swap re-locks the
    // caller's payment to the builder's NUT-11 pubkey before rows persist.
    const wallet = await getWallet(LOCAL_MINT_URL);
    const funding = await mintLocalTokens(1024);
    const seeded = await wallet.ops.receive(funding).asP2PK({ pubkey: LOCK_PUBKEY }).run();
    await insertAccumulatorRows(pool, {
      dvmId: DVM_ID,
      lockPubkeyByIndex: seeded.map(() => toLockPubkey(LOCK_PUBKEY)),
      mintUrl: LOCAL_MINT_URL,
      proofs: seeded,
      requestId: "drain-e2e-seed",
      receivedAt: Date.now(),
    });

    await fundCredit(ledger, {
      creditId: "ce1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 500_000,
      expiryMs: Date.now() + 60 * 60 * 1000,
    });
    await ledger.draw({ creditId: "ce1", drawId: "w1", amountMicro: 100_000 });

    const requested = await creditCall({
      op: "drain",
      credit_id: "ce1",
      drain: {
        drain_id: "de1",
        method: "cashu",
        payout: { refund_pubkey: REFUND_PUBKEY },
      },
    });
    expect(requested.status).toBe(200);
    const requestedBody = (await requested.json()) as {
      drain: { status: string; amount_micro: number; receipts: DrainReceipt[] };
    };
    expect(requestedBody.drain).toMatchObject({ status: "pending", amount_micro: 400_000 });
    expect(requestedBody.drain.receipts[0]).toMatchObject({
      event: "requested",
      balance_after_micro: 100_000,
    });

    const pendingBefore = await adminCall<{
      drains: { credit_id: string; drain_id: string; amount_sats: number }[];
      liability: { cashu_sats: number };
    }>("GET", "/admin/credit/pending-drains");

    expect(pendingBefore.liability).toMatchObject({ cashu_sats: OWED_SATS });

    expect(pendingBefore.drains).toHaveLength(1);
    const batches = await adminCall<{
      batches: {
        mint_url: string;
        lock_pubkey: string;
        row_ids: string[];
        proofs: Proof[];
      }[];
    }>("GET", "/admin/cashu/pending-batches");
    const batch = batches.batches[0];
    expect(batch).toBeDefined();
    const swapped = await wallet.ops
      .send(OWED_SATS, batch.proofs)
      .asP2PK({ pubkey: REFUND_PUBKEY })
      .keepAsP2PK({ pubkey: batch.lock_pubkey })
      .privkey(BUILDER_PRIVKEY)
      .includeFees(false)
      .run();
    const inputIndexBySecret = new Map(batch.proofs.map((proof, index) => [proof.secret, index]));
    const untouchedInputs = new Set<number>();
    const changeProofs: Proof[] = [];
    for (const proof of swapped.keep) {
      const index = inputIndexBySecret.get(proof.secret);
      if (index === undefined) changeProofs.push(proof);
      else untouchedInputs.add(index);
    }
    const consumedRowIds = batch.row_ids.filter((_, index) => !untouchedInputs.has(index));
    const keepProofs = changeProofs.map((proof) => ({
      id: proof.id,
      amount: typeof proof.amount === "number" ? proof.amount : Amount.from(proof.amount).toNumber(),
      secret: proof.secret,
      C: proof.C,
      ...(proof.dleq ? { dleq: { ...proof.dleq } } : {}),
    }));
    const token = getEncodedToken({ mint: batch.mint_url, proofs: swapped.send } satisfies Token);
    await adminCall("POST", "/admin/credit/park-drain", {
      credit_id: "ce1",
      drain_id: "de1",
      token,
      consumed_row_ids: consumedRowIds,
      keep_proofs: keepProofs,
    });
    const pendingAfter = await adminCall<{ liability: { cashu_sats: number } }>(
      "GET",
      "/admin/credit/pending-drains"
    );
    expect(pendingAfter.liability.cashu_sats).toBe(0);

    const consumed = await pool.query<{ melt_status: string; melt_quote_id: string }>(
      "SELECT melt_status, melt_quote_id FROM wallet_accumulator WHERE dvm_id = $1 AND request_id = $2",
      [DVM_ID, "drain-e2e-seed"]
    );
    expect(consumed.rows.length).toBeGreaterThan(0);
    expect(consumed.rows.every((r) => r.melt_status === "drained")).toBe(true);
    expect(consumed.rows.every((r) => r.melt_quote_id === "drain:de1")).toBe(true);
    const change = await pool.query<{ proof_amount: number; lock_pubkey: string }>(
      "SELECT proof_amount, lock_pubkey FROM wallet_accumulator WHERE dvm_id = $1 AND request_id = $2",
      [DVM_ID, "drain:de1"]
    );
    // 1024 seeded − the parked face value (mint fee 0) re-enters builder-locked.
    expect(change.rows.reduce((sum, r) => sum + r.proof_amount, 0)).toBe(1_024 - OWED_SATS);
    expect(change.rows.every((r) => r.lock_pubkey === LOCK_PUBKEY)).toBe(true);

    const poll = await creditCall({ op: "drain", credit_id: "ce1", drain: { drain_id: "de1" } });
    expect(poll.status).toBe(200);
    const pollBody = (await poll.json()) as {
      drain: { status: string; token: string; receipts: DrainReceipt[] };
    };
    expect(pollBody.drain.status).toBe("picked_up");
    expect(pollBody.drain.receipts.map((r) => r.event)).toEqual([
      "requested",
      "parked",
      "picked_up",
    ]);
    expect(pollBody.drain.receipts.every((r) => r.balance_after_micro === 100_000)).toBe(true);
    expect(pollBody.drain.receipts.every((r) => verifyDrainReceipt(r))).toBe(true);

    expect(getTokenMetadata(pollBody.drain.token).mint).toBe(LOCAL_MINT_URL);
    const redeemed = await wallet.receive(pollBody.drain.token, { privkey: REFUND_PRIVKEY });
    const redeemedSats = redeemed.reduce((sum, p) => sum + Number(p.amount), 0);
    expect(redeemedSats).toBe(OWED_SATS);

    const again = await creditCall({ op: "drain", credit_id: "ce1", drain: { drain_id: "de1" } });
    const againBody = (await again.json()) as { drain: { status: string; token: string } };
    expect(againBody.drain).toMatchObject({
      status: "picked_up",
      token: pollBody.drain.token,
    });
  }, 60_000);
});
