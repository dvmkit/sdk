import { randomUUID } from "node:crypto";

import { getEncodedToken, Wallet } from "@cashu/cashu-ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { LOCAL_MINT_URL, localMintAvailable, mintLocalTokens } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";
import { serve } from "../serve";

const DATABASE_URL = process.env.DATABASE_URL;
const DB_OK = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const MINT_OK = DB_OK && await localMintAvailable();
const SCHEMA = "sdk_shared_pool_cashu_boot";
const LOCK_PUBKEY = Buffer.from(secp256k1.getPublicKey(new Uint8Array(32).fill(7), true)).toString("hex");

const descriptor = configureDVM({
  name: "shared-pool-paid",
  capability: "test",
  tag: "test",
  price: "$0.016",
  onJob(ctx) { ctx.complete("paid"); },
});

const fx = {
  fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
  supportedCurrencies: () => ["usd"],
};

(DB_OK ? describe : describe.skip)("shared-pool Cashu host boot", () => {
  afterAll(async () => { await dropSchemas(SCHEMA); });

  it.skipIf(!MINT_OK)("starts concurrent services on fresh and warm schemas and accepts each P2PK payment", async () => {
    await recreateSchema(SCHEMA);
    const pool = await pinnedPool(SCHEMA);
    try {
      for (let pass = 0; pass < 2; pass++) {
        const services = await Promise.all(Array.from({ length: 2 }, (_, index) =>
          serve(descriptor, {
            pool,
            port: 0,
            devMode: true,
            env: {
              DVMKIT_DVM_ID: `shared-pool-${pass}-${index}`,
              DVMKIT_CASHU_LOCK_PUBKEY: LOCK_PUBKEY,
            },
            mints: [LOCAL_MINT_URL],
            cashuMode: "p2pk-accumulator",
            fx,
          })
        ));
        try {
          for (const service of services) {
            expect(service.paymentModes[0]?.rails.cashu.status).toBe("verifying");
            const info = await (await fetch(`${service.url}/v1/info`)).json() as {
              cashu: { lock_pubkeys: string[] };
            };
            expect(info.cashu.lock_pubkeys).toContain(LOCK_PUBKEY);

            const wallet = new Wallet(LOCAL_MINT_URL);
            await wallet.loadMint();
            const minted = wallet.decodeToken(await mintLocalTokens(64));
            const preview = await wallet.ops.send(16, minted.proofs)
              .asP2PK({ pubkey: info.cashu.lock_pubkeys[0]! }).includeFees(true).prepare();
            const swapped = await wallet.completeSwap(preview);
            const payment = getEncodedToken({ mint: LOCAL_MINT_URL, proofs: swapped.send });
            const response = await fetch(`${service.url}/v1/job`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Cashu": payment,
                "X-Cashu-Request-Id": randomUUID(),
              },
              body: JSON.stringify({ capability: "test" }),
            });
            expect(response.status, await response.text()).toBe(200);
          }
        } finally {
          await Promise.all(services.map((service) => service.close()));
        }
      }
      const table = await pool.query<{ name: string | null }>(
        "SELECT to_regclass('wallet_accumulator')::text AS name"
      );
      expect(table.rows[0].name).toBe("wallet_accumulator");
    } finally {
      await pool.end();
    }
  }, 120_000);

  it("rejects startup on Cashu storage failure and leaves an injected pool usable", async () => {
    await recreateSchema(SCHEMA);
    const pool = await pinnedPool(SCHEMA);
    const query = pool.query.bind(pool);
    const failure = new Error("accumulator storage unavailable");
    pool.query = ((sql: string, params?: unknown[]) =>
      sql.includes("CREATE TABLE IF NOT EXISTS wallet_accumulator")
        ? Promise.reject(failure)
        : query(sql, params)
    ) as Pool["query"];
    try {
      const host = createDVMHost({
        pool,
        port: 0,
        devMode: true,
        env: {
          DVMKIT_DVM_ID: "shared-pool-failed",
          DVMKIT_CASHU_LOCK_PUBKEY: LOCK_PUBKEY,
        },
        mints: [LOCAL_MINT_URL],
        cashuMode: "p2pk-accumulator",
        fx,
      });
      host.mount(descriptor);
      await expect(host.serve()).rejects.toBe(failure);
      await expect(pool.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  }, 30_000);
});
