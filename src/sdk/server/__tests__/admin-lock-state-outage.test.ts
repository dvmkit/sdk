import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildAdminAuthHeader } from "../../../lib/cashu/admin-auth";
import { applyRetryToPool } from "../../../lib/pg-retry";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";

const PRIVKEY = "11".repeat(32);
const LOCK_PUBKEY = `02${Buffer.from(schnorr.getPublicKey(Buffer.from(PRIVKEY, "hex"))).toString("hex")}`;
const DVM_ID = "dvm-lock-state-outage";
const MINT = "https://mint.example";

describe("admin lock-state outage", () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
  });

  it("keeps info fallback read-only and accepts the same admin nonce after recovery", async () => {
    let unavailable = true;
    let staleClients = 0;
    const query = vi.fn((text: string) => {
      if (text.includes("FROM dvm_lock_pubkeys")) {
        if (unavailable || staleClients-- > 0) {
          return Promise.reject(new Error("Connection terminated unexpectedly"));
        }
        return Promise.resolve({
          rows: [{ pubkey: LOCK_PUBKEY, retired_at_ms: null }],
          rowCount: 1,
        });
      }
      if (text.includes("FROM wallet_accumulator")) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const nonceStore = {
      has: vi.fn(() => Promise.resolve(false)),
      mark: vi.fn(() => Promise.resolve()),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pool = { query, connect: vi.fn(), on: vi.fn(), options: { max: 3 } };
    applyRetryToPool(pool as never, "test");
    const dvm = configureDVM({
      name: "admin-lock-state-outage",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });
    const built = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      mints: [MINT],
      cashuMode: "p2pk-accumulator",
      lockPubkey: LOCK_PUBKEY,
      dvmId: DVM_ID,
      db: pool as never,
      adminCashuNonceStore: nonceStore,
    });
    shutdown = built.shutdown;

    const infoResponse = await built.app.request("/v1/info");
    expect(infoResponse.status).toBe(200);
    const info = (await infoResponse.json()) as { cashu?: { lock_pubkeys?: string[] } };
    expect(info.cashu?.lock_pubkeys).toEqual([LOCK_PUBKEY]);

    const path = "/admin/cashu/pending-batches";
    const { header } = buildAdminAuthHeader({
      method: "GET",
      path,
      dvmId: DVM_ID,
      privkeyHex: PRIVKEY,
    });
    const refused = await built.app.request(path, { headers: { Authorization: header } });
    expect(refused.status).toBe(503);
    await expect(refused.json()).resolves.toMatchObject({ error: "admin_state_unavailable" });
    expect(nonceStore.has).not.toHaveBeenCalled();
    expect(nonceStore.mark).not.toHaveBeenCalled();

    unavailable = false;
    staleClients = 3;
    const recovered = await built.app.request(path, { headers: { Authorization: header } });
    expect(recovered.status).toBe(200);
    expect(nonceStore.has).toHaveBeenCalledOnce();
    expect(nonceStore.mark).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("admin_lock_state_unavailable"));
  });
});
