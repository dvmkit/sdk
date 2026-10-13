import { schnorr } from "@noble/curves/secp256k1.js";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { buildAdminAuthHeader } from "../../../lib/cashu/admin-auth";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";

const PRIVKEY_HEX = "11".repeat(32);
const LOCK_PUBKEY = `02${Buffer.from(
  schnorr.getPublicKey(Uint8Array.from(Buffer.from(PRIVKEY_HEX, "hex")))
).toString("hex")}`;
const DVM_ID = "dvm-admin-mount";

const DVM = configureDVM({
  name: "admin-mount",
  capability: "test",
  tag: "test",
  onJob(ctx) {
    ctx.complete("ok");
  },
});

function fakePool(): Pool {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("SELECT pubkey, retired_at_ms")) {
        return {
          rows: [{ pubkey: LOCK_PUBKEY, retired_at_ms: null }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
}

function authorization(method: string, path: string): string {
  return buildAdminAuthHeader({
    method,
    path,
    dvmId: DVM_ID,
    privkeyHex: PRIVKEY_HEX,
  }).header;
}

describe("builder admin route mounting", () => {
  it("serves authenticated credit repair routes without Cashu", async () => {
    const { app, shutdown } = await createDVMServer(DVM, {
      env: {},
      store: new MemoryKVStore(),
      db: fakePool(),
      dvmId: DVM_ID,
      lockPubkey: LOCK_PUBKEY,
    });

    try {
      const path = "/admin/credit/blocked-invoices";
      const response = await app.request(path, {
        headers: { Authorization: authorization("GET", path) },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ invoices: [] });
      expect((await app.request("/admin/cashu/pending-batches")).status).toBe(404);
    } finally {
      await shutdown();
    }
  });

  it("keeps park-drain mounted but refuses it cleanly without an accumulator", async () => {
    const { app, shutdown } = await createDVMServer(DVM, {
      env: {},
      store: new MemoryKVStore(),
      db: fakePool(),
      dvmId: DVM_ID,
      lockPubkey: LOCK_PUBKEY,
    });

    try {
      const path = "/admin/credit/park-drain";
      const response = await app.request(path, {
        method: "POST",
        headers: {
          Authorization: authorization("POST", path),
          "Content-Type": "application/json",
        },
        body: "{}",
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: "accumulator_not_wired" });
    } finally {
      await shutdown();
    }
  });

  it("retains Cashu routes and the accumulator park path in dual-rail mode", async () => {
    const { app, shutdown } = await createDVMServer(DVM, {
      env: {},
      store: new MemoryKVStore(),
      db: fakePool(),
      dvmId: DVM_ID,
      lockPubkey: LOCK_PUBKEY,
      cashuMode: "p2pk-accumulator",
    });

    try {
      expect((await app.request("/admin/cashu/pending-batches")).status).toBe(401);

      const path = "/admin/credit/park-drain";
      const response = await app.request(path, {
        method: "POST",
        headers: {
          Authorization: authorization("POST", path),
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_body" });
    } finally {
      await shutdown();
    }
  });
});
