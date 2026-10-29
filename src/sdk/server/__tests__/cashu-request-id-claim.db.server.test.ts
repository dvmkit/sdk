/*
 * A Cashu request id belongs to the first proof set banked under it, on every
 * banking path of a Postgres-backed host. Real Postgres stores, real local
 * mint, no mocked payment layer.
 */
import { randomUUID } from "node:crypto";

import { getEncodedToken, type Proof, Wallet } from "@cashu/cashu-ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { fundingCommitment } from "../funding";
import { initLockPubkeyTable, seedLockPubkeyState } from "../lock-pubkey-store";
import { PostgresJobStore } from "../postgres-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { initWalletAccumulatorTable } from "../wallet-accumulator-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const live = RUN && (await localMintAvailable());

const fx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
  supportedCurrencies: () => ["usd"],
};
const LOCK = Buffer.from(secp256k1.getPublicKey(Buffer.from("55".repeat(32), "hex"), true)).toString("hex");
const SECOND_KEY = new Uint8Array(32).fill(8);
const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  text: z.string().min(1),
});

describe.skipIf(!live)("a Cashu request id is claimed by its first proof set on a Postgres host", () => {
  const schema = `cashu_claim_${randomUUID().replaceAll("-", "")}`;
  const servers = servedApps();
  let admin: pg.Pool;
  let pool: pg.Pool;
  let ledger: CreditLedger;
  let jobStore: PostgresJobStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 16 });
    ledger = new CreditLedger(pool);
    await ledger.init();
    jobStore = new PostgresJobStore(pool);
    await jobStore.init();
    await initWalletAccumulatorTable(pool);
    await initLockPubkeyTable(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function startHost(signed: boolean): Promise<{ url: string; dvmId: string }> {
    const dvmId = `cashu-claim-${randomUUID()}`;
    await seedLockPubkeyState(pool, dvmId, LOCK);
    const dvm = configureDVM({
      name: "cashu-claim",
      capabilities: {
        paid: {
          input: signed ? signedSchema : z.object({ text: z.string().min(1) }),
          price: "$0.016",
          onJob(ctx) {
            ctx.complete(`result:${(ctx.input as { text: string }).text}`);
          },
        },
        metered: {
          input: signed ? signedSchema : z.object({ text: z.string().min(1) }),
          async onJob(ctx) {
            await ctx.requestPayment({ amount: 0.016, currency: "usd" }, "next step");
            ctx.complete("metered");
          },
        },
      },
      ...(signed ? { credit: { min: "$0.01", max: "$5.00" }, auth: secp256k1Auth({ allowUnsignedPaid: true }) } : {}),
    });
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      fxFetcher: fx,
      creditLedger: ledger,
      receiptKey: "77".repeat(32),
      cashuMode: "p2pk-accumulator",
      db: pool,
      dvmId,
      lockPubkey: LOCK,
      mints: [LOCAL_MINT_URL],
    });
    return { url: await servers.serve(app), dvmId };
  }

  async function lockedProofs(count: number): Promise<Proof[][]> {
    const wallet = new Wallet(LOCAL_MINT_URL);
    await wallet.loadMint();
    const quote = await wallet.createMintQuoteBolt11(32 * count);
    let paid = await wallet.checkMintQuoteBolt11(quote.quote);
    for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      paid = await wallet.checkMintQuoteBolt11(quote.quote);
    }
    let proofs: Proof[] = await wallet.mintProofsBolt11(32 * count, paid);
    const sets: Proof[][] = [];
    for (let n = 0; n < count; n++) {
      const preview = await wallet.ops.send(16, proofs).asP2PK({ pubkey: LOCK }).includeFees(true).prepare();
      const swapped = await wallet.completeSwap(preview);
      sets.push(swapped.send);
      proofs = swapped.keep;
    }
    return sets;
  }

  const token = (proofs: Proof[]) => getEncodedToken({ mint: LOCAL_MINT_URL, proofs });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const cashu = (proofs: Proof[], requestId: string) => ({ "X-Cashu": token(proofs), "X-Cashu-Request-Id": requestId });

  async function rowsUnder(dvmId: string, requestId: string): Promise<number> {
    const { rows } = await pool.query("SELECT 1 FROM wallet_accumulator WHERE dvm_id = $1 AND request_id = $2", [dvmId, requestId]);
    return rows.length;
  }

  async function paidJob(url: string, proofs: Proof[], requestId: string) {
    const res = await post(`${url}/v1/job`, { capability: "paid", data: { text: "first" } }, cashu(proofs, requestId));
    expect(res.status).toBe(200);
    return (await res.json()) as { job_id: string; job_token: string };
  }

  /** The first job's body and request id with other proofs: refused, nothing banked, no handle. */
  async function expectNoRecoveryFor(url: string, dvmId: string, proofs: Proof[], requestId: string, first: { job_id: string; job_token: string }) {
    const res = await post(`${url}/v1/job`, { capability: "paid", data: { text: "first" } }, cashu(proofs, requestId));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect((JSON.parse(text) as { error: string }).error).toBe("request_id_reused");
    expect(text).not.toContain(first.job_token);
    expect(text).not.toContain(first.job_id);
    expect(await rowsUnder(dvmId, requestId)).toBe(1);
  }

  /** Start a job that asks for payment mid-job, and wait for the ask. */
  async function awaitingPayment(url: string, data: unknown) {
    const res = await post(`${url}/v1/job`, { capability: "metered", data });
    expect(res.status).toBeLessThan(300);
    const job = (await res.json()) as { job_id: string; job_token: string };
    for (let n = 0; n < 100; n++) {
      const status = (await (await fetch(`${url}/v1/job/${job.job_id}`, { headers: { "X-Job-Token": job.job_token } })).json()) as { status: string };
      if (status.status === "awaiting-input") return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("job never asked for payment");
  }

  it("recovers the first job for its own proofs and request id", async () => {
    const host = await startHost(true);
    const [proofs] = await lockedProofs(1);
    const requestId = randomUUID();
    const first = await paidJob(host.url, proofs!, requestId);
    const retry = await post(`${host.url}/v1/job`, { capability: "paid", data: { text: "first" } }, cashu(proofs!, requestId));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ job_id: first.job_id, job_token: first.job_token });
  }, 30_000);

  it("banks a payment sent without a request id under its proof set's id, and recovers it on retry", async () => {
    const host = await startHost(false);
    const [proofs] = await lockedProofs(1);
    const body = { capability: "paid", data: { text: "first" } };
    const first = await post(`${host.url}/v1/job`, body, { "X-Cashu": token(proofs!) });
    expect(first.status).toBe(200);
    const job = (await first.json()) as { job_id: string; job_token: string };
    const { rows } = await pool.query<{ request_id: string }>(
      "SELECT DISTINCT request_id FROM wallet_accumulator WHERE dvm_id = $1",
      [host.dvmId]
    );
    expect(rows).toEqual([{ request_id: expect.stringMatching(/^nut24-[0-9a-f]{64}$/) }]);
    const banked = await rowsUnder(host.dvmId, rows[0]!.request_id);
    expect(banked).toBe(proofs!.length);

    const retry = await post(`${host.url}/v1/job`, body, { "X-Cashu": token(proofs!) });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ job_id: job.job_id, job_token: job.job_token });
    expect(await rowsUnder(host.dvmId, rows[0]!.request_id)).toBe(banked);
  }, 30_000);

  it("refuses POST /v1/credit funding with other proofs under a used request id", async () => {
    const host = await startHost(true);
    const [firstProofs, otherProofs] = await lockedProofs(2);
    const requestId = randomUUID();
    const first = await paidJob(host.url, firstProofs!, requestId);

    const fund = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA).signRequest(SECOND_KEY, {
      op: "fund",
      fund: { amount_micro: 16_000, fund_id: `f-${randomUUID()}`, commitment: fundingCommitment(token(otherProofs!)) },
    });
    const funded = await post(`${host.url}/v1/credit`, fund, cashu(otherProofs!, requestId));
    expect(funded.status).toBe(409);
    expect(((await funded.json()) as { error: string }).error).toBe("request_id_reused");
    expect(await rowsUnder(host.dvmId, requestId)).toBe(1);

    await expectNoRecoveryFor(host.url, host.dvmId, otherProofs!, requestId, first);
  }, 30_000);

  for (const signed of [true, false]) {
    it(`refuses a mid-job payment with other proofs under a used request id (${signed ? "signed-request" : "no-auth"} DVM)`, async () => {
      const host = await startHost(signed);
      const [firstProofs, otherProofs] = await lockedProofs(2);
      const requestId = randomUUID();
      const first = await paidJob(host.url, firstProofs!, requestId);

      const data = signed
        ? createSignedRequestVerifier(signedSchema).signRequest(SECOND_KEY, { text: "second" })
        : { text: "second" };
      const job = await awaitingPayment(host.url, data);
      const paid = await post(
        `${host.url}/v1/job/${job.job_id}/messages`,
        { type: "payment", content: { cashu_token: token(otherProofs!), cashu_request_id: requestId } },
        { "X-Job-Token": job.job_token }
      );
      expect(paid.status).toBe(409);
      expect(JSON.stringify(await paid.json())).toContain("request_id_reused");
      expect(await rowsUnder(host.dvmId, requestId)).toBe(1);

      await expectNoRecoveryFor(host.url, host.dvmId, otherProofs!, requestId, first);
    }, 30_000);
  }
});
