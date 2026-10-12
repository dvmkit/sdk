import { decrypt, encrypt } from "nostr-tools/nip04";
import type { SimplePool } from "nostr-tools/pool";
import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { sha256hex } from "../src/lib/hash";
import {
  listTransactions,
  type NwcConnection,
  payInvoiceReconciling,
} from "../src/lib/nwc";

const INVOICE = "lnbc-authoritative-wallet-debit-fixture";
const PREIMAGE = "ab".repeat(32);

describe("NWC payment identity and transaction redaction", () => {

  it("does not republish when lookup returns a different invoice", async () => {
    let payRequests = 0;
    const { conn, pool } = fakeNwcPool(({ method }) => {
      if (method === "pay_invoice") {
        payRequests += 1;
        return undefined;
      }
      return {
        type: "outgoing",
        invoice: "lnbc-a-different-invoice",
        amount: 8_000,
        fees_paid: 1_000,
        created_at: 100,
        settled_at: 101,
        preimage: PREIMAGE,
      };
    });

    await expect(
      payInvoiceReconciling(conn, INVOICE, { pool, timeoutMs: 2, dedupWindowMs: 1_000 })
    ).rejects.toMatchObject({ code: "payment_unknown" });
    expect(payRequests).toBe(1);
  });

  it("returns only digests and accounting fields from list_transactions", async () => {
    const rawInvoice = "lnbc-private-invoice";
    const rawPaymentHash = "private-payment-hash";
    const rawPreimage = "private-preimage";
    const { conn, pool } = fakeNwcPool(({ method, params }) => {
      expect(method).toBe("list_transactions");
      expect(params).toEqual({ from: 90, limit: 101 });
      return {
        transactions: [
          {
            type: "outgoing",
            invoice: rawInvoice,
            payment_hash: rawPaymentHash,
            preimage: rawPreimage,
            amount: 8_000,
            fees_paid: 1_000,
            created_at: 100,
            settled_at: 101,
          },
        ],
      };
    });

    const transactions = await listTransactions(conn, { from: 90, limit: 101 }, { pool });
    expect(transactions).toEqual([
      {
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        invoiceHash: sha256hex(rawInvoice),
        type: "outgoing",
        amountMsats: 8_000,
        feesPaidMsats: 1_000,
        createdAt: 100,
        settledAt: 101,
      },
    ]);
    const serialized = JSON.stringify(transactions);
    expect(serialized).not.toContain(rawInvoice);
    expect(serialized).not.toContain(rawPaymentHash);
    expect(serialized).not.toContain(rawPreimage);
  });
});

function fakeNwcPool(
  respond: (request: {
    method: string;
    params: Record<string, unknown>;
    eventId: string;
  }) => Record<string, unknown> | undefined
): { conn: NwcConnection; pool: SimplePool } {
  const clientSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const walletSecret = Uint8Array.from({ length: 32 }, (_, index) => 32 - index);
  const clientPubkey = getPublicKey(clientSecret);
  const walletPubkey = getPublicKey(walletSecret);
  const conn: NwcConnection = {
    walletPubkey,
    relays: ["wss://relay.example"],
    secret: clientSecret,
    clientPubkey,
  };
  let onevent: ((event: { content: string }) => void) | undefined;
  const relay = {
    publish: async (event: { content: string; id: string }) => {
      const request = JSON.parse(
        decrypt(walletSecret, clientPubkey, event.content)
      ) as { method: string; params: Record<string, unknown> };
      const result = respond({ ...request, eventId: event.id });
      if (result !== undefined) {
        const content = encrypt(walletSecret, clientPubkey, JSON.stringify({ result }));
        queueMicrotask(() => onevent?.({ content }));
      }
      return "ok";
    },
  };
  const pool = {
    subscribeMany: (
      _relays: string[],
      _filter: unknown,
      handlers: { onevent(event: { content: string }): void }
    ) => {
      onevent = handlers.onevent;
      return { close: () => undefined };
    },
    ensureRelay: async () => relay,
    close: () => undefined,
  } as unknown as SimplePool;
  return { conn, pool };
}
