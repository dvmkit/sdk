import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import { Credential } from "mppx";
import { expect, it, vi } from "vitest";

import contract from "../../../../protocol-fixtures/tempo-close-terminal.json";
import type { AppEnv } from "../app";
import { CREDIT_REQUEST_SCHEMA, handleCreditRequest } from "../credit-routes";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { TempoCloseDescriptorError, type MppxServer } from "../mpp-setup";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { fundCredit } from "./__helpers__/credit-fixtures";

const KEY = new Uint8Array(32).fill(3);
const CALLER = Buffer.from(schnorr.getPublicKey(KEY)).toString("hex");
const CHANNEL = `0x${"33".repeat(32)}`;
const TX = `0x${"44".repeat(32)}`;
const signer = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

it.each([true, false])("describes a refused Tempo drain truthfully with terminal persistence=%s", async (persistent) => {
  const ledger = new MemoryCreditLedger();
  await fundCredit(ledger, { creditId: "credit", callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
    expiryMs: Date.now() + 86_400_000, basis: { rail: "tempo", paidMsats: 0, nativeAmount: 100_000,
      nativeAsset: "usdc", tempoSession: { channelId: CHANNEL, cumulativeAmount: "110000" } } });
  await ledger.requestDrain({ creditId: "credit", drainId: "d1", callerPubkey: CALLER,
    method: "tempo", payout: { channel_id: CHANNEL } });
  const routeLedger = new Proxy(ledger, {
    get(target, key) {
      if (key === "requireTempoDrainExit" && !persistent) return undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const broadcast = vi.fn((credential: Credential.Credential) => {
    if (!(credential.payload as { descriptor?: unknown }).descriptor) {
      return Promise.reject(new TempoCloseDescriptorError({ reason: "Missing channel descriptor" }));
    }
    return Promise.resolve({ reference: TX } as never);
  });
  const mpp = { broadcastCredential: broadcast, beginTempoSessionClose: async () => {},
    confirmTempoSessionClose: (_channel: string, _drain: string, reference: string) => Promise.resolve(reference),
    getTempoSessionCloseAmounts: () => Promise.resolve({ refundedToPayer: 100_000n, settledToPayee: 10_000n }),
  } as unknown as MppxServer;
  const app = new Hono<AppEnv>();
  app.post("/v1/credit", (c) => handleCreditRequest(c, {
    menu: () => Promise.resolve({ min_micro: 100_000, max_micro: 5_000_000, ttl_ms: 86_400_000,
      currency: "usd", funding: ["tempo"] }),
    creditConfig: undefined, auth: secp256k1Auth(), ledger: routeLedger,
    fxFetcher: { fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-10-16T00:00:00Z" }),
      supportedCurrencies: () => ["usd"] },
    railOpts: () => Promise.resolve({ mpp, mppCredential: c.req.header("Authorization") }),
    onDeposit: () => {}, drainReport: {}, receiptIssuer: undefined, lightning: undefined,
    settleLightning: async () => {},
  }));
  const call = (corrected: boolean) => app.request("/v1/credit", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: Credential.serialize({
      challenge: { id: "close", realm: "example.com", method: "tempo", intent: "session",
        request: { amount: "10000" } },
      payload: { action: "close", channelId: CHANNEL, cumulativeAmount: "10000",
        ...(corrected && { descriptor: { channelId: CHANNEL } }) },
    }) },
    body: JSON.stringify(signer.signRequest(KEY, { op: "drain", credit_id: "credit",
      drain: { drain_id: "d1", method: "tempo" } })),
  });
  const refused = await call(false);
  const expected = persistent ? contract : contract.nonPersisted;
  expect(refused.status).toBe(expected.status);
  expect(await refused.json()).toMatchObject({ ...expected.body, drain_id: "d1", channel_id: CHANNEL });
  const corrected = await call(true);
  expect(corrected.status).toBe(persistent ? 409 : 200);
  expect(broadcast).toHaveBeenCalledTimes(persistent ? 1 : 2);
  expect(await ledger.getDrain({ creditId: "credit", drainId: "d1" }))
    .toMatchObject({ status: persistent ? "exit_required" : "sent" });
  expect(await ledger.get("credit")).toMatchObject({ balanceMicro: 0 });
});
