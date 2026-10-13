/**
 * the SDK must hand `tempo.charge` a durable replay store.
 *
 * mppx defaults the charge replay guard to `Store.memory()` when no `store` is
 * passed, so the whole bug is one missing option — which is exactly what a
 * refactor drops silently. This pins that the option is threaded; the store's
 * own behaviour is covered by `tempo-charge-store{,.db}.test.ts`.
 */
import type { Store } from "mppx";
import type * as MppxServer from "mppx/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chargeParams: Record<string, unknown>[] = [];

vi.mock("mppx/server", async (importOriginal) => {
  const actual = await importOriginal<typeof MppxServer>();
  return {
    ...actual,
    tempo: {
      ...actual.tempo,
      charge: (params: Record<string, unknown>) => {
        chargeParams.push(params);
        return actual.tempo.charge(params as never);
      },
    },
  };
});

const { createMppFromOpts } = await import("../server/mpp-setup");

const RECIPIENT = `0x${"11".repeat(20)}`;
const ENV = { DVMKIT_TEMPO_SECRET_KEY: "ab".repeat(32) } as NodeJS.ProcessEnv;

/** Minimal `Store.AtomicStore` — identity is all this test reads off it. */
function fakeStore(): Store.AtomicStore {
  return {
    get: () => Promise.resolve(null as never),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    update: ((_key: string, fn: (current: unknown) => { result: unknown }) =>
      Promise.resolve(fn(null).result)) as never,
  };
}

describe("tempo/charge replay store wiring", () => {
  beforeEach(() => {
    chargeParams.length = 0;
  });

  it("passes the configured store through to tempo.charge", () => {
    const store = fakeStore();
    createMppFromOpts({ tempoRecipient: RECIPIENT, tempoCharge: { store } }, ENV);
    expect(chargeParams).toHaveLength(1);
    expect(chargeParams[0]?.store).toBe(store);
  });

  it("omits store when none is configured, leaving mppx's in-process default", () => {
    // The pool-less boot (`dvmctl dev`, an explicit jobStore) — still has to
    // work, just without the cross-machine guard.
    createMppFromOpts({ tempoRecipient: RECIPIENT }, ENV);
    expect(chargeParams).toHaveLength(1);
    expect(chargeParams[0]).not.toHaveProperty("store");
  });
});
