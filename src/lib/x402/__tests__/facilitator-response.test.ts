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

/** The diagnostic records the facilitator calls logged, as they reach the log after projection. */
function loggedRecords(): Record<string, unknown>[] {
  const lines = [console.log, console.info, console.warn, console.error].flatMap((sink) =>
    vi.mocked(sink).mock.calls.map(([line]) => String(line))
  );
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function extensionResponses(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("x402 facilitator diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  function silenceConsole() {
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(() => undefined);
    }
  }

  it("logs each extension's status and rejection reason from EXTENSION-RESPONSES on verify and settle", async () => {
    silenceConsole();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/verify")
          ? Response.json({ isValid: true }, {
              headers: { "EXTENSION-RESPONSES": extensionResponses({ bazaar: { status: "processing" } }) },
            })
          : Response.json({ success: true, transaction: "0x1", network: REQUIREMENTS.network }, {
              headers: {
                "EXTENSION-RESPONSES": extensionResponses({
                  bazaar: { status: "rejected", rejectedReason: "description too long" },
                }),
              },
            })
      )
    );

    await expect(verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({ isValid: true });
    await expect(settleWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toMatchObject({ success: true });

    const logged = loggedRecords().filter((record) => record.event === "x402_facilitator_extension_response");
    expect(logged).toEqual([
      expect.objectContaining({ failure_stage: "verifier", extension: "bazaar", extension_status: "processing" }),
      expect.objectContaining({
        failure_stage: "broadcast",
        extension: "bazaar",
        extension_status: "rejected",
        extension_rejected_reason: "description too long",
      }),
    ]);
  });

  it("logs at most eight EXTENSION-RESPONSES entries and counts the rest on one truncation line", async () => {
    silenceConsole();
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`ext${index}`, { status: "processing" }]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ isValid: true }, { headers: { "EXTENSION-RESPONSES": extensionResponses(many) } }))
    );

    await expect(verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({ isValid: true });
    const records = loggedRecords();
    expect(records.filter((record) => record.event === "x402_facilitator_extension_response")).toHaveLength(8);
    expect(records.filter((record) => record.event === "x402_facilitator_extension_responses_truncated")).toEqual([
      expect.objectContaining({ failure_stage: "verifier", count: 42 }),
    ]);
  });

  it("ignores an EXTENSION-RESPONSES header that is not base64 JSON, without changing the answer", async () => {
    silenceConsole();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ isValid: true }, { headers: { "EXTENSION-RESPONSES": "%%%not-base64" } }))
    );

    await expect(verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({ isValid: true });
    expect(loggedRecords().filter((record) => record.event === "x402_facilitator_extension_response")).toEqual([]);
  });

  it.each(["verify", "settle"] as const)(
    "logs the facilitator's errorMessage on an opaque %s refusal, bounded, while the answer stays the status code",
    async (operation) => {
      silenceConsole();
      const errorMessage = `resource.description is too long ${"x".repeat(1000)}\u0007`;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ errorType: "invalid_request", errorMessage }, { status: 400 }))
      );

      const answer =
        operation === "verify"
          ? await verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)
          : await settleWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG);
      expect(answer).toEqual(
        operation === "verify"
          ? { isValid: false, invalidReason: "facilitator_status_400" }
          : { success: false, errorReason: "facilitator_status_400" }
      );
      const refused = loggedRecords().filter((record) => record.event === "x402_facilitator_request_refused");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ status_code: 400, failure_stage: operation === "verify" ? "verifier" : "broadcast" });
      const message = refused[0]!.facilitator_message as string;
      expect(message.startsWith("resource.description is too long xxx")).toBe(true);
      expect(message.length).toBeLessThanOrEqual(256);
      expect(message).not.toMatch(/[\x00-\x1f\x7f]/);
    }
  );
});
