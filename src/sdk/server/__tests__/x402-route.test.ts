/*
 * The x402 route answers "authorization lost" only when nothing can still
 * settle the payment; answering it while a settlement may land would tell a
 * caller who is about to be charged that they were not. The process serving a
 * route request holds its authorization until settlement resolves it, so no
 * request in the database suite reaches this fail-safe row; its decision is
 * tested here.
 */
import { describe, expect, it } from "vitest";

import type { Message } from "../../../lib/messages/types";
import { chargedSettleResponse, classifyX402RouteOutcome, x402FailedJobAnswer } from "../x402-route";

const completed = { status: "completed" as const, runtimeLimitExceeded: false };

describe("classifyX402RouteOutcome", () => {
  it("answers authorization lost once settlement ran and no process holds the authorization", () => {
    expect(
      classifyX402RouteOutcome({ ...completed, intent: { status: "prepared" }, heldLocally: false, terminalWorkFinished: true })
    ).toBe("authorization_lost");
    // The settler found no authorization after its expiry and released the intent unsent.
    expect(
      classifyX402RouteOutcome({
        ...completed,
        intent: { status: "released", lastOutcome: "authorization_expired_unsubmitted" },
        heldLocally: false,
        terminalWorkFinished: true,
      })
    ).toBe("authorization_lost");
  });

  it("answers unknown while the authorization may still be sent", () => {
    // Still held here: a later read settles it.
    expect(
      classifyX402RouteOutcome({ ...completed, intent: { status: "prepared" }, heldLocally: true, terminalWorkFinished: true })
    ).toBe("unknown");
    // The deadline cut the wait short, so settlement may not have started yet.
    expect(
      classifyX402RouteOutcome({ ...completed, intent: { status: "prepared" }, heldLocally: false, terminalWorkFinished: false })
    ).toBe("unknown");
  });

  it("answers runtime bound for an authorization released unsent when the settle window closed, even before the job's end is recorded", () => {
    expect(
      classifyX402RouteOutcome({
        status: "processing",
        runtimeLimitExceeded: false,
        intent: { status: "released", lastOutcome: "settle_window_closed" },
        heldLocally: false,
        terminalWorkFinished: false,
      })
    ).toBe("runtime_bound");
  });
});

describe("chargedSettleResponse", () => {
  const settled = { status: "complete" as const, transaction: "0xabc", network: "eip155:8453" };

  it("names the intent's transaction and network when no facilitator answer was stored", () => {
    expect(chargedSettleResponse(settled)).toEqual({ success: true, transaction: "0xabc", network: "eip155:8453" });
  });

  it("passes the facilitator's own answer through unchanged", () => {
    const answer = { success: true, transaction: "0xabc", network: "base", payer: "0x22" };
    expect(chargedSettleResponse({ ...settled, settleResponse: answer })).toEqual(answer);
  });
});

describe("x402FailedJobAnswer", () => {
  const cancel = (from: Message["from"], content: Record<string, unknown>, seq = 1) =>
    ({ seq, from, timestamp: 0, type: "cancel", content }) as Message;

  it("answers 422 only when the service's own cancel marks the failure as the caller's", () => {
    expect(x402FailedJobAnswer([cancel("provider", { reason: "page not found", caller_fault: true })])).toEqual({
      reason: "page not found",
      status: 422,
    });
  });

  it("ignores a caller-fault mark on a requester's cancel, which the caller writes itself", () => {
    const messages = [
      cancel("provider", { reason: "service error" }, 1),
      cancel("requester", { reason: "not my fault", caller_fault: true }, 2),
    ];
    expect(x402FailedJobAnswer(messages)).toEqual({ reason: "not my fault", status: 500 });
  });
});
