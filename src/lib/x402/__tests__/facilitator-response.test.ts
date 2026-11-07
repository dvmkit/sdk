import { afterEach, describe, expect, it, vi } from "vitest";

import {
  settleWithFacilitator,
  verifyWithFacilitator,
  X402FacilitatorTimeoutError,
} from "../facilitator-request";
import type { PaymentPayloadV2, PaymentRequirementsV2 } from "../spec";

const REQUIREMENTS: PaymentRequirementsV2 = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x1111111111111111111111111111111111111111",
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
};
const PAYLOAD: PaymentPayloadV2 = {
  x402Version: 2,
  accepted: REQUIREMENTS,
  payload: {
    signature: "0xsig",
    authorization: {
      from: "0x3333333333333333333333333333333333333333",
      to: REQUIREMENTS.payTo,
      value: REQUIREMENTS.amount,
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0xnonce",
    },
  },
};
const CONFIG = { facilitator: "https://facilitator.example" };

afterEach(() => vi.unstubAllGlobals());

describe("x402 facilitator rejection responses", () => {
  it("preserves a structured verify rejection carried by HTTP 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }), {
            status: 400,
          })
      )
    );

    await expect(verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({
      isValid: false,
      invalidReason: "insufficient_funds",
    });
  });

  it("preserves a structured settle rejection carried by HTTP 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), {
            status: 400,
          })
      )
    );

    await expect(settleWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({
      success: false,
      errorReason: "insufficient_funds",
    });
  });

  it.each([
    { status: 400, body: "not json", expected: "facilitator_status_400" },
    {
      status: 401,
      body: JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }),
      expected: "facilitator_status_401",
    },
  ])(
    "retains HTTP $status when no trustworthy rejection exists",
    async ({ status, body, expected }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status }))
      );

      await expect(verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({
        isValid: false,
        invalidReason: expected,
      });
    }
  );

  it("keeps the transaction hash of a settlement CDP reports as pending on HTTP 500", async () => {
    const transaction = `0x${"ab".repeat(32)}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              errorReason: "settlement_pending",
              transaction,
              network: REQUIREMENTS.network,
            }),
            { status: 500 }
          )
      )
    );

    await expect(settleWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toMatchObject({
      success: false,
      errorReason: "settlement_pending",
      transaction,
    });
  });

  it("does not trust the body of any other HTTP 500 settle failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, errorReason: "boom", transaction: "0x1" }), {
            status: 500,
          })
      )
    );

    await expect(settleWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({
      success: false,
      errorReason: "facilitator_status_500",
    });
  });
});

describe("x402 facilitator call timeout", () => {
  /** A fetch that never answers but, like the real one, rejects once aborted. */
  function hangingFetch() {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signals.push(signal);
            signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
          })
      )
    );
    return signals;
  }

  it("refuses a verify the facilitator does not answer, and aborts the request", async () => {
    const signals = hangingFetch();

    await expect(
      verifyWithFacilitator(PAYLOAD, REQUIREMENTS, { ...CONFIG, facilitatorTimeoutMs: 20 })
    ).resolves.toEqual({ isValid: false, invalidReason: "facilitator_timeout" });
    expect(signals[0]?.aborted).toBe(true);
  });

  it("surfaces a settle the facilitator does not answer as a timeout, never as a rejection", async () => {
    hangingFetch();

    await expect(
      settleWithFacilitator(PAYLOAD, REQUIREMENTS, { ...CONFIG, facilitatorTimeoutMs: 20 })
    ).rejects.toBeInstanceOf(X402FacilitatorTimeoutError);
  });

  it("also bounds a body that stalls after the headers arrive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream({ start: () => undefined });
        return new Response(body, { status: 200 });
      })
    );

    await expect(
      settleWithFacilitator(PAYLOAD, REQUIREMENTS, { ...CONFIG, facilitatorTimeoutMs: 20 })
    ).rejects.toBeInstanceOf(X402FacilitatorTimeoutError);
  });

  it("defaults to ten seconds", async () => {
    vi.useFakeTimers();
    try {
      hangingFetch();
      let outcome = "pending";
      const call = verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG).then(() => {
        outcome = "refused";
      });

      await vi.advanceTimersByTimeAsync(9_999);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(outcome).toBe("refused");
    } finally {
      vi.useRealTimers();
    }
  });
});
