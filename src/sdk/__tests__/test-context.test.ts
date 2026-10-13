import { describe, expect, it } from "vitest";

import { configureDVM } from "../configure";
import { createTestContext } from "../testing/test-context";
import type { SDKJobContext } from "../types";

describe("createTestContext", () => {
  it("provides default values", () => {
    const ctx = createTestContext();
    expect(ctx.jobId).toBe("test-job-1");
    expect(ctx.tags).toEqual([]);
    expect(ctx.input).toBe("");
    expect(ctx.completed).toBe(false);
    expect(ctx.failed).toBe(false);
  });

  it("accepts custom identity fields", () => {
    const ctx = createTestContext({
      jobId: "j-99",
      tags: ["web"],
      input: "hello",
      params: { lang: "en" },
      requesterId: "abc123",
      paidMsats: 5000,
    });
    expect(ctx.jobId).toBe("j-99");
    expect(ctx.tags).toEqual(["web"]);
    expect(ctx.input).toBe("hello");
    expect(ctx.params).toEqual({ lang: "en" });
    expect(ctx.requesterId).toBe("abc123");
    expect(ctx.paidMsats).toBe(5000);
  });

  it("records text messages", () => {
    const ctx = createTestContext();
    ctx.text("Processing...");
    expect(ctx.messages).toEqual([{ type: "text", content: { text: "Processing..." } }]);
  });

  it("records artifact messages", () => {
    const ctx = createTestContext();
    ctx.artifact({ data: "hello", mime_type: "text/plain" });
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].type).toBe("artifact");
  });

  it("records sendMessage calls", () => {
    const ctx = createTestContext();
    ctx.sendMessage("text", { text: "raw" });
    expect(ctx.messages).toEqual([{ type: "text", content: { text: "raw" } }]);
  });

  it("complete sets completed and summary", () => {
    const ctx = createTestContext();
    ctx.complete("done");
    expect(ctx.completed).toBe(true);
    expect(ctx.summary).toBe("done");
    expect(ctx.messages).toContainEqual({
      type: "complete",
      content: { summary: "done" },
    });
  });

  it("fail sets failed and failError", () => {
    const ctx = createTestContext();
    ctx.fail("bad input");
    expect(ctx.failed).toBe(true);
    expect(ctx.failError).toBe("bad input");
    expect(ctx.messages).toContainEqual({
      type: "cancel",
      content: { reason: "bad input" },
    });
  });

  it("prompt with pre-programmed response resolves", async () => {
    const ctx = createTestContext({
      responses: {
        lang: { prompt_id: "lang", text: "Spanish" },
      },
    });
    const response = await ctx.prompt("lang", "What language?");
    expect(response.text).toBe("Spanish");
    expect(ctx.messages).toContainEqual(expect.objectContaining({ type: "prompt" }));
  });

  it("prompt without response rejects", async () => {
    const ctx = createTestContext();
    await expect(ctx.prompt("unknown", "Question")).rejects.toThrow(
      'no pre-programmed response for prompt "unknown"'
    );
  });

  it("requestPayment with pre-programmed payment resolves", async () => {
    const ctx = createTestContext({
      payment: { amount_msats: 5000 },
    });
    const payment = await ctx.requestPayment(5000, "Fee");
    expect(payment.amount_msats).toBe(5000);
    expect(ctx.messages).toEqual([{ type: "payment-request", content: { amount: 5000, reason: "Fee" } }]);
  });

  it("requestPayment without payment rejects", async () => {
    const ctx = createTestContext();
    await expect(ctx.requestPayment(5000, "Fee")).rejects.toThrow("no pre-programmed payment");
  });

  it("step calls the function and returns result", async () => {
    const ctx = createTestContext();
    const result = await ctx.step("compute", async () => 42);
    expect(result).toBe(42);
  });

  it("state is cloned from opts (no pollution)", () => {
    const original = { count: 0 };
    const ctx = createTestContext({ state: original });
    ctx.state.count = 99;
    expect(original.count).toBe(0);
  });

  it("store works in-memory", async () => {
    const ctx = createTestContext();
    await ctx.store.set("key", "value");
    const next = createTestContext({ store: ctx.store });
    expect(await next.store.get("key")).toBe("value");
    await next.store.delete("key");
    expect(await ctx.store.get("key")).toBeUndefined();
  });

  it("env provides configured values", () => {
    const ctx = createTestContext({ env: { API_KEY: "secret" } });
    expect(ctx.env.API_KEY).toBe("secret");
  });

  it("working records message", () => {
    const ctx = createTestContext();
    ctx.working(30, "Processing");
    expect(ctx.messages).toContainEqual({
      type: "working",
      content: { estimate_seconds: 30, hint: "Processing" },
    });
  });

  it("progress records a heartbeat with phase and hint", () => {
    const ctx = createTestContext();
    ctx.progress(50, "transcribing", "halfway through Whisper");
    expect(ctx.messages).toContainEqual({
      type: "progress",
      content: {
        percent_complete: 50,
        current_phase: "transcribing",
        hint: "halfway through Whisper",
      },
    });
  });

  it("progress works without optional phase or hint", () => {
    const ctx = createTestContext();
    ctx.progress(25);
    expect(ctx.messages).toContainEqual({
      type: "progress",
      content: { percent_complete: 25 },
    });
  });

  it("progress clamps percent to [0, 100]", () => {
    const ctx = createTestContext();
    ctx.progress(-5);
    ctx.progress(150);
    const progressMsgs = ctx.messages.filter((m) => m.type === "progress");
    expect(progressMsgs).toHaveLength(2);
    expect(progressMsgs[0].content).toEqual({ percent_complete: 0 });
    expect(progressMsgs[1].content).toEqual({ percent_complete: 100 });
  });

  it("cancel() mirrors the runtime's post-terminal guard", async () => {
    const ctx = createTestContext({ responses: { q1: { prompt_id: "q1", text: "yes" } } });
    ctx.cancel("caller cancelled");

    expect(ctx.signal.aborted).toBe(true);

    ctx.text("still going");
    ctx.artifact({ mime_type: "text/plain", data: "x" });
    ctx.sendMessage("text", { text: "sneaky" });
    ctx.working(5);
    ctx.progress(50);
    ctx.complete("resurrect");
    ctx.fail("boom");

    expect(ctx.messages).toEqual([]);
    expect(ctx.completed).toBe(false);
    expect(ctx.failed).toBe(false);
    expect(ctx.summary).toBeUndefined();

    // Yields reject rather than hang — a no-op would leave the handler awaiting
    // a promise nothing can settle.
    await expect(ctx.prompt("q1", "still there?")).rejects.toThrow(/cancel/i);
    await expect(ctx.requestPayment(1000, "more work")).rejects.toThrow(/cancel/i);
  });

  it("reports no cost until the handler declares one", () => {
    const ctx = createTestContext();
    // Absent, not zero — the same distinction the runtime and the board make.
    expect(ctx.reportedCost).toBeUndefined();
  });

  it("sums what the handler declared, in millionths", () => {
    const ctx = createTestContext();
    ctx.cost({ amount: 0.0004, currency: "usd" });
    ctx.cost({ amount: 0.02, currency: "usd" });
    expect(ctx.reportedCost).toEqual({ amountMicro: 20_400, currency: "usd" });
  });

  it("sums sub-millionth declarations the way the runtime does", () => {
    const ctx = createTestContext();
    // The test double has to round the same way as `buildContext`, or a handler
    // unit test passes on costs the real runtime would report differently.
    for (let i = 0; i < 1000; i++) ctx.cost({ amount: 0.0000003, currency: "usd" });
    expect(ctx.reportedCost).toEqual({ amountMicro: 300, currency: "usd" });
  });

  it("keeps a declared zero distinguishable from no declaration", () => {
    const ctx = createTestContext();
    ctx.cost({ amount: 0, currency: "usd" });
    expect(ctx.reportedCost).toEqual({ amountMicro: 0, currency: "usd" });
  });

  it("reports nothing when a handler names two currencies", () => {
    const ctx = createTestContext();
    ctx.cost({ amount: 0.5, currency: "usd" });
    ctx.cost({ amount: 0.4, currency: "eur" });
    expect(ctx.reportedCost).toBeUndefined();
  });

  it("accepts a declaration inside a step body, as the runtime does", async () => {
    const ctx = createTestContext();
    await ctx.step("vendor", async () => {
      ctx.cost({ amount: 0.0004, currency: "usd" });
      return 1;
    });
    expect(ctx.reportedCost).toEqual({ amountMicro: 400, currency: "usd" });
  });

  it("runs a configured handler and records its ordered messages", async () => {
    const dvm = configureDVM({
      name: "Echo",
      capability: "test",
      tag: "web",
      onJob(ctx: SDKJobContext) {
        ctx.text("Echoing...");
        ctx.artifact({ data: "# Output", mime_type: "text/markdown" });
        ctx.complete(ctx.input);
      },
    });

    const ctx = createTestContext({ input: "hello world" });
    await Object.values(dvm.capabilities)[0].onJob(ctx);

    expect(ctx.completed).toBe(true);
    expect(ctx.summary).toBe("hello world");
    expect(ctx.messages).toEqual([
      { type: "text", content: { text: "Echoing..." } },
      { type: "artifact", content: { data: "# Output", mime_type: "text/markdown" } },
      { type: "complete", content: { summary: "hello world" } },
    ]);
  });
});
