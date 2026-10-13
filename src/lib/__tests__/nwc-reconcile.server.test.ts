/**
 * No-double-pay discipline for the NWC float, driven against the
 * in-process NIP-47 stub over real WebSockets.
 *
 * NIP-47 has no `pay_invoice` idempotency key, so every assertion here is about
 * `stub.payments.length` — success alone proves nothing. The stub only settles
 * once per event id inside its dedup window, exactly as a real wallet does, so
 * a client that re-signed instead of re-publishing would show up as 2.
 */

import { afterEach, describe, expect, it } from "vitest";

import { type Nip47Stub, startNip47Stub } from "../../test-support/nip47-stub";
import { NwcError, parseNwcUri, payInvoiceReconciling } from "../nwc";

const TIMEOUT_MS = 4_000;
const INVOICE = "lnbc100n1pjfloatinvoice";

let stub: Nip47Stub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function connect(...args: Parameters<typeof startNip47Stub>) {
  stub = await startNip47Stub(...args);
  return { stub, conn: parseNwcUri(stub.uri) };
}

// Real WebSocket drop faults consume a request timeout per lost leg.
describe("payInvoiceReconciling", { timeout: 20_000 }, () => {
  it("pays once on the happy path", async () => {
    const { stub: s, conn } = await connect({
      balanceMsats: 500_000,
      routingFeeMsats: 5_000,
    });

    const result = await payInvoiceReconciling(conn, INVOICE, { timeoutMs: TIMEOUT_MS });

    expect(result.outcome).toBe("paid");
    expect(result.feesPaidMsats).toBe(5_000);
    expect(result.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(s.payments).toHaveLength(1);
    expect(s.payments[0].bolt11).toBe(INVOICE);
    // lnbc100n = 100 × 1e2 msats = 10 sats.
    expect(s.payments[0].amountMsats).toBe(10_000);
  });

  it("reconciles a lost response instead of paying again", async () => {
    const { stub: s, conn } = await connect({
      balanceMsats: 500_000,
      routingFeeMsats: 5_000,
    });
    // The wallet acts — money moves — but the reply never reaches us.
    s.setFault({ mode: "drop-response", once: true });

    const result = await payInvoiceReconciling(conn, INVOICE, { timeoutMs: 800 });

    expect(result.outcome).toBe("reconciled");
    expect(result.feesPaidMsats).toBe(5_000);
    expect(result.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(s.payments).toHaveLength(1);
    // Reconcile-first means nothing was re-sent at all.
    expect(s.requests.filter((r) => r.method === "pay_invoice")).toHaveLength(1);
    expect(s.requests.some((r) => r.method === "lookup_invoice")).toBe(true);
  });

  it("keeps an omitted wallet fee unknown instead of inventing zero", async () => {
    const { conn } = await connect({ balanceMsats: 500_000, omitFeesPaid: true });

    const result = await payInvoiceReconciling(conn, INVOICE, { timeoutMs: TIMEOUT_MS });

    expect(result).not.toHaveProperty("feesPaidMsats");
  });

  it("re-publishes the byte-identical event when the wallet provably never saw it", async () => {
    const { stub: s, conn } = await connect({ balanceMsats: 500_000, routingFeeMsats: 5_000 });
    s.setFault({ mode: "drop-request", once: true });

    const result = await payInvoiceReconciling(conn, INVOICE, { timeoutMs: 800 });

    expect(result.outcome).toBe("republished");
    expect(result.feesPaidMsats).toBe(5_000);
    expect(s.payments).toHaveLength(1);

    const payRequests = s.requests.filter((r) => r.method === "pay_invoice");
    expect(payRequests).toHaveLength(2);
    // Same event id both times — the signature was never regenerated, which is
    // the only thing that makes wallet-side dedup meaningful.
    expect(payRequests[0].eventId).toBe(payRequests[1].eventId);
    expect(payRequests[0].dropped).toBe(true);
  });

  it("reports an unknown payment rather than paying twice when reconcile is also lost", async () => {
    const { stub: s, conn } = await connect({ balanceMsats: 500_000 });
    // Every response is lost, including `lookup_invoice`'s — so the wallet pays
    // and the client has no way to learn that it did. The only safe move is to
    // surface the uncertainty; re-publishing blind here is a second payment.
    s.setFault({ mode: "drop-response" });

    await expect(payInvoiceReconciling(conn, INVOICE, { timeoutMs: 800 })).rejects.toMatchObject({
      code: "payment_unknown",
    });

    expect(s.payments).toHaveLength(1);
    expect(s.requests.filter((r) => r.method === "pay_invoice")).toHaveLength(1);
  });

  it("refuses to retry once the wallet's dedup window has passed", async () => {
    const { stub: s, conn } = await connect({ balanceMsats: 500_000 });
    s.setFault({ mode: "drop-request" });

    // Two dropped legs — the payment and the reconcile — so the wall clock is
    // twice the request timeout. 800ms each, matching the case above.
    await expect(
      payInvoiceReconciling(conn, INVOICE, { timeoutMs: 800, dedupWindowMs: 0 })
    ).rejects.toMatchObject({ code: "payment_unknown" });

    // An unknown payment is surfaced, never retried into a possible double-pay.
    expect(s.payments).toHaveLength(0);
    expect(s.requests.filter((r) => r.method === "pay_invoice")).toHaveLength(1);
  });

  it("surfaces a wallet budget refusal without retrying", async () => {
    const { stub: s, conn } = await connect({ balanceMsats: 500_000, budgetMsats: 5_000 });

    const err = await payInvoiceReconciling(conn, INVOICE, { timeoutMs: TIMEOUT_MS }).catch(
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(NwcError);
    expect((err as NwcError).code).toBe("QUOTA_EXCEEDED");
    expect(s.payments).toHaveLength(0);
    expect(s.requests.filter((r) => r.method === "pay_invoice")).toHaveLength(1);
  });

  it("succeeds after the wallet's budget window renews", async () => {
    const { stub: s, conn } = await connect({ balanceMsats: 500_000, budgetMsats: 10_000 });

    await payInvoiceReconciling(conn, INVOICE, { timeoutMs: TIMEOUT_MS });
    await expect(
      payInvoiceReconciling(conn, "lnbc100n1pjsecond", { timeoutMs: TIMEOUT_MS })
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });

    s.renewBudget();
    await expect(
      payInvoiceReconciling(conn, "lnbc100n1pjthird", { timeoutMs: TIMEOUT_MS })
    ).resolves.toMatchObject({ outcome: "paid" });
    expect(s.payments).toHaveLength(2);
  });

  it("times out cleanly against an offline wallet, paying nothing", async () => {
    const { stub: s, conn } = await connect({ balanceMsats: 500_000 });
    s.setFault({ mode: "offline" });

    await expect(
      payInvoiceReconciling(conn, INVOICE, { timeoutMs: 800, dedupWindowMs: 0 })
    ).rejects.toMatchObject({ code: "payment_unknown" });
    expect(s.payments).toHaveLength(0);
  });

  it("reports an unreachable relay as a network failure, not an unknown payment", async () => {
    const { stub: s, conn } = await connect({ balanceMsats: 500_000 });
    s.setFault({ mode: "relay-down" });

    // No socket ever opened, so the request never left this process. Reporting
    // `payment_unknown` here would tell the user to go audit their wallet
    // history over an ordinary network outage.
    await expect(
      payInvoiceReconciling(conn, INVOICE, { timeoutMs: 800, dedupWindowMs: 0 })
    ).rejects.toMatchObject({ code: "relay_unreachable" });
    expect(s.payments).toHaveLength(0);
    expect(s.requests).toHaveLength(0);
  });
});
