import { configureDVM, defineCapability, type CapabilityConfig } from "@dvmkit/sdk";
import { createTestContext, StepCache, type StepRecord } from "@dvmkit/sdk/testing";
import { z } from "zod";

const textInput = z.object({ text: z.string() });
const countInput = z.object({ count: z.number() });

export const typedCapabilities = configureDVM({
  name: "example-capabilities",
  capabilities: {
    text: defineCapability({
      input: textInput,
      state: { seen: 0 },
      onJob(ctx) {
        const text: string = ctx.input.text;
        ctx.state.seen += text.length;
        // @ts-expect-error The text capability has no count input.
        ctx.input.count;
        // @ts-expect-error State must retain its declared number type.
        ctx.state.seen = "wrong";
        ctx.complete(text);
      },
      onResponse(ctx) {
        ctx.text(ctx.input.text);
        // @ts-expect-error Message handlers retain the input schema.
        ctx.input.count;
      },
      onQuote: {
        schema: z.object({ characters: z.number() }),
        async handler(ctx) {
          const characters: number = ctx.data.characters;
          // @ts-expect-error Quote data comes from its own schema.
          ctx.data.text;
          return { upfront: { amount: characters * 0.01, currency: "usd" }, description: "Text" };
        },
      },
    }),
    count: defineCapability({
      input: countInput,
      onJob(ctx) {
        const count: number = ctx.input.count;
        // @ts-expect-error The count capability has no text input.
        ctx.input.text;
        ctx.complete(String(count));
      },
      onQuote: {
        schema: z.object({ batches: z.number().transform(String) }),
        async handler(ctx) {
          const batches: string = ctx.data.batches;
          // @ts-expect-error A transformed quote value is a string.
          const _numeric: number = ctx.data.batches;
          return { upfront: { amount: Number(batches), currency: "usd" }, description: "Count" };
        },
      },
    }),
    transformed: defineCapability({
      input: countInput,
      onJob(ctx) { ctx.complete(String(ctx.input.count)); },
      onQuote: {
        schema: z.object({ count: z.number() }).transform((value) => value.count),
        async handler(ctx) {
          const count: number = ctx.data;
          // @ts-expect-error Whole-schema transforms change the quote data itself.
          ctx.data.count;
          // @ts-expect-error The inferred quote output must not become any.
          const _text: string = ctx.data;
          return { upfront: { amount: count * 0.01, currency: "usd" }, description: "Transformed" };
        },
      },
    }),
    raw: defineCapability({
      onJob(ctx) { ctx.complete(ctx.input.toUpperCase()); },
      onQuote: {
        schema: { type: "object" },
        async handler(ctx) {
          const value: unknown = ctx.data.anything;
          // @ts-expect-error JSON Schema carries no inferred output type.
          const _text: string = ctx.data.anything;
          return { upfront: { amount: Number(value), currency: "usd" }, description: "Raw" };
        },
      },
    }),
    legacy: { onJob(ctx) { ctx.complete(String(ctx.input)); } },
  },
});

export const annotated: CapabilityConfig<{ seen: number }, typeof textInput, { length: number }> = {
  input: textInput,
  state: { seen: 0 },
  onJob(ctx) { ctx.complete(ctx.input.text); },
  onQuote: {
    schema: z.object({ length: z.number() }),
    async handler(ctx) {
      return { upfront: { amount: ctx.data.length, currency: "usd" }, description: "Annotated" };
    },
  },
};

const stepCache = new StepCache();
export const records: StepRecord[] = stepCache.serialize();
export const authenticatedContext = createTestContext({
  stepCache: StepCache.deserialize(records),
  auth: {
    pubkey: "11".repeat(32),
    envelope: { pubkey: "11".repeat(32), signature: "22".repeat(64), timestamp: 1700000000, nonce: "example-nonce" },
  },
});
