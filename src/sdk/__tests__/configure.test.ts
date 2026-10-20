import { describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../configure";
import type { SDKJobContext } from "../types";
import { DEFAULT_CREDIT_TTL_SECONDS, DEFAULT_JOB_RETENTION_DAYS } from "../types";

describe("configureDVM", () => {
  const noop = (_ctx: SDKJobContext): void => {};

  it("resolves and freezes the default descriptor", () => {
    const dvm = configureDVM({ name: "X", onJob: noop });
    expect(dvm).toMatchObject({
      name: "X", description: "", tags: [], idleTimeout: 3600,
      jobRetentionDays: 730, state: {}, currency: "usd",
    });
    expect(DEFAULT_JOB_RETENTION_DAYS).toBe(730);
    expect(dvm.price).toBeUndefined();
    expect(Object.isFrozen(dvm)).toBe(true);
    expect(dvm.config.onJob).toBe(noop);
  });

  it("returns a descriptor with resolved tags", () => {
    const dvm = configureDVM({
      name: "Echo",
      capability: "test",
      tag: "web",
      onJob: noop,
    });
    expect(dvm.name).toBe("Echo");
    expect(dvm.tags).toEqual(["web"]);
  });

  it("accepts plural tags", () => {
    const dvm = configureDVM({
      name: "Multi",
      capability: "test",
      tags: ["web", "extraction"],
      onJob: noop,
    });
    expect(dvm.tags).toEqual(["web", "extraction"]);
  });

  it("deduplicates tags from tag and tags", () => {
    const dvm = configureDVM({
      name: "Dedup",
      capability: "test",
      tag: "web",
      tags: ["web", "api"],
      onJob: noop,
    });
    expect(dvm.tags).toEqual(["web", "api"]);
  });

  it("accepts custom idleTimeout", () => {
    const dvm = configureDVM({
      name: "X",
      capability: "test",
      tag: "test",
      idleTimeout: 7200,
      onJob: noop,
    });
    expect(dvm.idleTimeout).toBe(7200);
  });

  it("accepts a per-DVM retention override and zero opt-out", () => {
    expect(
      configureDVM({ name: "X", capability: "test", jobRetentionDays: 30, onJob: noop })
        .jobRetentionDays
    ).toBe(30);
    expect(
      configureDVM({ name: "X", capability: "test", jobRetentionDays: 0, onJob: noop })
        .jobRetentionDays
    ).toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid job retention days (%s)",
    (jobRetentionDays) => {
      expect(() =>
        configureDVM({ name: "X", capability: "test", jobRetentionDays, onJob: noop })
      ).toThrow(/jobRetentionDays must be a non-negative whole number/);
    }
  );

  it("preserves typed state", () => {
    const dvm = configureDVM({
      name: "X",
      capability: "test",
      tag: "test",
      state: { count: 0, label: "" },
      onJob: noop,
    });
    expect(dvm.state).toEqual({ count: 0, label: "" });
  });

  it("resolves price", () => {
    const dvm = configureDVM({
      name: "X",
      capability: "test",
      tag: "test",
      price: "$0.01",
      onJob: noop,
    });
    expect(dvm.price).toBe("$0.01");
  });

  describe("price validation", () => {
    const withPrice = (price: unknown) => () =>
      configureDVM({
        name: "X",
        capability: "count",
        price: price as string,
        onJob: noop,
      });

    it("rejects a numeric (msats) price and names the fiat form", () => {
      // Reject numeric msats prices at construction: their fiat denomination depends
      // on a rate lookup, whereas every paid draw needs a durable fiat amount.
      expect(withPrice(10_000)).toThrow(/is a number \(10000\)/);
      expect(withPrice(10_000)).toThrow(/price: "\$0\.01"/);
    });

    it("rejects a price that isn't a USD literal", () => {
      expect(withPrice("10000")).toThrow(/not a USD price literal/);
      expect(withPrice("0.01 USD")).toThrow(/not a USD price literal/);
      expect(withPrice("$1abc")).toThrow(/not a USD price literal/);
    });

    it("rejects a price no advertisement surface can express", () => {
      // Every fiat surface (`/v1/info` pricing ceiling, `/v1/quote` upfront,
      // the isolate re-emit) rounds to 4 dp, so anything under $0.0001
      // advertises as $0 and then gates the job anyway — advertised paid,
      // apparently free while still charging the job.
      expect(withPrice("$0.00001")).toThrow(/below "\$0\.0001"/);
      expect(withPrice("$0")).toThrow(/below "\$0\.0001"/);
    });

    it("rejects a price finer than the wire's 4 decimals", () => {
      // Advertised and charged would differ: $0.00125 advertises as $0.0013.
      expect(withPrice("$0.00125")).toThrow(/more than four decimal places/);
    });

    it("accepts sub-cent USD literals down to the wire's floor", () => {
      expect(configureDVM({ name: "X", capability: "c", price: "$0.005", onJob: noop }).price).toBe(
        "$0.005"
      );
      expect(
        configureDVM({ name: "X", capability: "c", price: "$0.0001", onJob: noop }).price
      ).toBe("$0.0001");
    });

    it("validates every capability in the explicit block, not just the first", () => {
      const capJob = (_ctx: SDKJobContext<Record<string, unknown>, unknown>): void => {};
      expect(() =>
        configureDVM({
          name: "X",
          capabilities: {
            free: { onJob: capJob },
            paid: { price: 5000 as unknown as string, onJob: capJob },
          },
        })
      ).toThrow(/capability "paid" price is a number/);
    });

    it("rejects a numeric credit bound the same way", () => {
      expect(() =>
        configureDVM({
          name: "X",
          capability: "c",
          credit: { min: 100_000 as unknown as string },
          onJob: noop,
        })
      ).toThrow(/credit\.min is a number/);
    });
  });

  it("defaults credit lifetime to 90 days and preserves explicit overrides", () => {
    expect(DEFAULT_CREDIT_TTL_SECONDS).toBe(7_776_000);
    expect(configureDVM({ name: "X", credit: {}, onJob: noop }).credit?.ttlSeconds).toBe(7_776_000);
    expect(configureDVM({ name: "X", credit: { ttl: 604_800 }, onJob: noop }).credit?.ttlSeconds).toBe(604_800);
  });

  describe("stablecoin credit policy", () => {
    it("defaults one-payment stablecoin top-ups off", () => {
      const dvm = configureDVM({
        name: "X",
        capability: "c",
        credit: {},
        onJob: noop,
      });
      expect(dvm.credit?.allowOneShotStablecoin).toBe(false);
    });

    it("admits one-payment top-ups only for a literal true opt-in", () => {
      const optedIn = configureDVM({
        name: "X",
        capability: "c",
        credit: { allowOneShotStablecoin: true },
        onJob: noop,
      });
      const malformed = configureDVM({
        name: "X",
        capability: "c",
        credit: { allowOneShotStablecoin: "true" as unknown as boolean },
        onJob: noop,
      });
      expect(optedIn.credit?.allowOneShotStablecoin).toBe(true);
      expect(malformed.credit?.allowOneShotStablecoin).toBe(false);
    });
  });

  // Funding menus and ledger amounts must use the DVM's declared denomination.
  describe("pricing currency", () => {

    it("resolves a declared currency onto the descriptor", () => {
      const dvm = configureDVM({
        name: "X",
        capability: "c",
        currency: "eur",
        onQuote: {
          schema: z.object({}),
          handler: () =>
            Promise.resolve({ upfront: { amount: 1, currency: "eur" }, description: "" }),
        },
        onJob: noop,
      });
      expect(dvm.currency).toBe("eur");
    });

    it("rejects a currency that isn't an ISO 4217 lowercase code", () => {
      const withCurrency = (currency: unknown) => () =>
        configureDVM({ name: "X", capability: "c", currency: currency as string, onJob: noop });
      // Uppercase included deliberately: the ledger compares codes verbatim, so
      // "EUR" would sit alongside "eur" as a second, silently-unreachable
      // denomination rather than the same one.
      expect(withCurrency("EUR")).toThrow(/is not an ISO 4217 lowercase code/);
      expect(withCurrency("euro")).toThrow(/is not an ISO 4217 lowercase code/);
      expect(withCurrency("")).toThrow(/is not an ISO 4217 lowercase code/);
    });

    it("rejects a static price on a non-USD DVM and names onQuote as the fix", () => {
      // A static price is a USD literal — `"$0.05"` is the whole grammar — so a
      // EUR DVM cannot express one. Reading it as €0.05 reinterprets what the
      // builder wrote; leaving it USD puts a USD-priced job on a EUR ledger.
      expect(() =>
        configureDVM({ name: "X", capability: "c", currency: "eur", price: "$0.05", onJob: noop })
      ).toThrow(/declares a static price \("\$0\.05"\) but this DVM prices in eur/);
      expect(() =>
        configureDVM({ name: "X", capability: "c", currency: "eur", price: "$0.05", onJob: noop })
      ).toThrow(/onQuote/);
    });

    it("rejects a static price in the explicit capabilities block too", () => {
      const capJob = (_ctx: SDKJobContext<Record<string, unknown>, unknown>): void => {};
      expect(() =>
        configureDVM({
          name: "X",
          currency: "gbp",
          capabilities: {
            free: { onJob: capJob },
            paid: { price: "$0.05", onJob: capJob },
          },
        })
      ).toThrow(/capability "paid" declares a static price/);
    });

    it("accepts a free capability on a non-USD DVM — there is no price to disagree", () => {
      const dvm = configureDVM({ name: "X", capability: "c", currency: "jpy", onJob: noop });
      expect(dvm.currency).toBe("jpy");
      expect(dvm.price).toBeUndefined();
    });
  });

  // Validate builder examples at descriptor construction, before advertising
  // an input that violates the capability schema.
  describe("example validation", () => {
    const narrateSchema = z
      .object({
        text: z.string().optional(),
        dialogue: z.array(z.string()).optional(),
      })
      .refine((v) => Boolean(v.text) !== Boolean(v.dialogue?.length), {
        message: "Provide either 'text' or 'dialogue', not both",
      });

    // Local opaque handler — typed `(ctx: SDKJobContext<any, any>) => void` so
    // it satisfies every Zod-narrowed ctx shape these tests construct.
    const onJob = (_ctx: SDKJobContext<Record<string, unknown>, unknown>): void => {};

    it("accepts an example that satisfies the schema (including refinements)", () => {
      expect(() =>
        configureDVM({
          name: "narrate",
          capability: "synthesise",
          input: narrateSchema,
          example: { text: "hello world" },
          onJob,
        })
      ).not.toThrow();
    });

    it("throws when the example fails the schema's `.refine()` check", () => {
      expect(() =>
        configureDVM({
          name: "narrate",
          capability: "synthesise",
          input: narrateSchema,
          example: {},
          onJob,
        })
      ).toThrow(/capability "synthesise" example does not satisfy its input schema/);
    });

    it("throws when the example has wrong types for declared fields", () => {
      expect(() =>
        configureDVM({
          name: "narrate",
          capability: "synthesise",
          input: narrateSchema,
          example: { text: 42 } as unknown as { text: string },
          onJob,
        })
      ).toThrow(/capability "synthesise" example does not satisfy/);
    });

    it("validates per-capability examples in the explicit `capabilities` shape", () => {
      expect(() =>
        configureDVM({
          name: "cast",
          capabilities: {
            "add-episode": {
              input: z.object({ feed_slug: z.string() }),
              example: { feed_slug: 99 } as unknown as { feed_slug: string },
              onJob,
            },
          },
        })
      ).toThrow(/capability "add-episode" example does not satisfy/);
    });

    it("no-ops when `input` is a plain JSON Schema object (not a Zod schema)", () => {
      expect(() =>
        configureDVM({
          name: "x",
          capability: "test",
          // Plain JSON Schema can't validate — guard short-circuits, no throw.
          input: { type: "object", properties: { foo: { type: "string" } } } as never,
          example: { foo: "ok" },
          onJob,
        })
      ).not.toThrow();
    });

    it("no-ops when `example` is absent", () => {
      expect(() =>
        configureDVM({
          name: "narrate",
          capability: "synthesise",
          input: narrateSchema,
          onJob,
        })
      ).not.toThrow();
    });

    // compile-time narrowing — `example` narrows to the schema's
    // output type when `input` is a Zod schema. The `@ts-expect-error`
    // directives are the assertion: `tsc --noEmit` fails if the marked line
    // ever compiles cleanly again (i.e. the narrowing regresses).
    describe("compile-time narrowing", () => {
      it("rejects an example with a field not in the Zod schema", () => {
        expect(() =>
          configureDVM({
            name: "narrate",
            capability: "synthesise",
            input: z.object({ text: z.string() }),
            // @ts-expect-error — `wrongField` is not in the schema's output type
            example: { wrongField: 1 },
            onJob,
          })
        ).toThrow(/example does not satisfy/);
      });

      it("accepts an arbitrary record when no input schema is declared", () => {
        expect(() =>
          configureDVM({
            name: "x",
            capability: "test",
            example: { anything: 1, goes: "here" },
            onJob,
          })
        ).not.toThrow();
      });
    });
  });
});
