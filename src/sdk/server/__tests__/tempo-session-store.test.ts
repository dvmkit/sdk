import { describe, expect, it, vi } from "vitest";

import { issueUpfrontChallenges } from "../payment";
import { assertMonotonicTransition, PostgresTempoSessionStore } from "../tempo-session-store";

const BASE = {
  channelId: `0x${"11".repeat(32)}`,
  chainId: 42431,
  escrowContract: `0x${"22".repeat(20)}`,
  payee: `0x${"33".repeat(20)}`,
  payer: `0x${"44".repeat(20)}`,
  token: `0x${"55".repeat(20)}`,
  authorizedSigner: `0x${"66".repeat(20)}`,
  operator: `0x${"77".repeat(20)}`,
  highestVoucherAmount: 10n,
  settledOnChain: 0n,
  spent: 10n,
  deposit: 20n,
  closeRequestedAt: 0n,
  finalized: false,
};

function sqlEvent(sql: string): string {
  if (/FROM mpp_tempo_channel_tombstones\b/.test(sql)) return "TOMBSTONE";
  if (/FROM mpp_tempo_channels\b/.test(sql)) return "CHANNEL";
  if (/pg_advisory_xact_lock/.test(sql)) return "LOCK";
  return sql.trim().split(/\s+/, 1)[0];
}

describe("Tempo session store invariants", () => {
  it("issues credit-session challenges with request-unit accounting", async () => {
    const issueChallenge = vi.fn(() =>
      Promise.resolve({ id: "session", method: "tempo", intent: "session" })
    );
    await issueUpfrontChallenges(
      {
        methods: [{ name: "tempo", intent: "session" }],
        issueChallenge,
      } as never,
      10_000,
      "/v1/credit",
      100_000
    );
    expect(issueChallenge).toHaveBeenCalledWith(
      "tempo",
      "session",
      expect.objectContaining({ unitType: "request" })
    );
  });

  it("keeps atomic update bound when mppx captures it as a callback", async () => {
    const client = {
      query: () => Promise.resolve({ rows: [] }),
      release: () => undefined,
    };
    const store = new PostgresTempoSessionStore({
      options: {},
      connect: () => Promise.resolve(client),
    } as never);
    const update = store.update;
    await expect(
      update(BASE.channelId, () => ({ op: "set", value: BASE, result: "updated" }))
    ).resolves.toBe("updated");
  });

  // the ledger callback runs after the channel write, so a callback
  // reading the store through this transaction's own client sees the row the
  // acceptance is creating. Running it before the INSERT left a channel's first
  // voucher — mppx's `open`, which performs exactly one store update — reporting
  // no chain binding at all.
  it("commits the ledger callback after the channel write, under the same lock", async () => {
    const events: string[] = [];
    const client = {
      query: (sql: string) => {
        events.push(sqlEvent(sql));
        return Promise.resolve({ rows: [] });
      },
      release: () => undefined,
    };
    const store = new PostgresTempoSessionStore({
      connect: () => Promise.resolve(client),
    } as never);
    const next = { ...BASE, spent: 0n };
    const accepted = await store.withVoucherAcceptance(
      { channelId: BASE.channelId, cumulativeAmount: 10n },
      async (_tx, voucher) => {
        events.push("LEDGER");
        expect(voucher.cumulativeAmount).toBe(10n);
        expect(voucher.priorCumulativeAmount).toBe(0n);
        expect(voucher.delta).toBe(10n);
        return "funded";
      },
      () => store.update(BASE.channelId, () => ({ op: "set", value: next, result: "stored" }))
    );
    expect(accepted).toEqual({ value: "stored", result: "funded" });
    expect(events).toEqual(["BEGIN", "LOCK", "CHANNEL", "TOMBSTONE", "INSERT", "LEDGER", "COMMIT"]);
  });

  it("rolls channel acceptance back when the ledger commit faults", async () => {
    const events: string[] = [];
    const client = {
      query: (sql: string) => {
        events.push(sqlEvent(sql));
        return Promise.resolve({ rows: [] });
      },
      release: () => undefined,
    };
    const store = new PostgresTempoSessionStore({
      connect: () => Promise.resolve(client),
    } as never);
    await expect(
      store.withVoucherAcceptance(
        { channelId: BASE.channelId, cumulativeAmount: 10n },
        () => Promise.reject(new Error("ledger fault")),
        () =>
          store.update(BASE.channelId, () => ({
            op: "set",
            value: { ...BASE, spent: 0n },
            result: undefined,
          }))
      )
    ).rejects.toThrow("ledger fault");
    // The channel write has already run by the time the ledger leg faults
    // so the rollback is what unwinds it — not the ordering.
    expect(events).toEqual(["BEGIN", "LOCK", "CHANNEL", "TOMBSTONE", "INSERT", "ROLLBACK"]);
  });

  it("holds no pooled connection while the credential operation does its chain work", async () => {
    // `operation` is mppx's credential verification, and it does the
    // chain work — an escrow broadcast on `open`, a channel-state RPC on
    // `voucher` — before it first touches the store. A connection checked out
    // up front would be pinned across that whole window on the pool shared by
    // /v1/job, the job store, KV and the credit ledger.
    const events: string[] = [];
    const client = {
      query: (sql: string) => {
        events.push(sqlEvent(sql));
        return Promise.resolve({ rows: [] });
      },
      release: () => events.push("RELEASE"),
    };
    const connect = vi.fn(() => Promise.resolve(client));
    const store = new PostgresTempoSessionStore({ connect } as never);

    let releaseChain: (() => void) | undefined;
    const chainWork = new Promise<void>((resolve) => (releaseChain = resolve));
    const accepted = store.withVoucherAcceptance(
      { channelId: BASE.channelId, cumulativeAmount: 10n },
      () => {
        events.push("LEDGER");
        return Promise.resolve("funded");
      },
      async () => {
        await chainWork;
        return store.update(BASE.channelId, () => ({
          op: "set",
          value: { ...BASE, spent: 0n },
          result: "stored",
        }));
      }
    );

    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    releaseChain?.();
    await expect(accepted).resolves.toEqual({ value: "stored", result: "funded" });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["BEGIN", "LOCK", "CHANNEL", "TOMBSTONE", "INSERT", "LEDGER", "COMMIT", "RELEASE"]);
  });

  it("opens no transaction when the operation never mutates the store", async () => {
    const connect = vi.fn(() => Promise.reject(new Error("must not connect")));
    const store = new PostgresTempoSessionStore({ connect } as never);
    await expect(
      store.withVoucherAcceptance(
        { channelId: BASE.channelId, cumulativeAmount: 10n },
        () => Promise.resolve("funded"),
        () => Promise.resolve("verified")
      )
    ).resolves.toEqual({ value: "verified", result: undefined });
    expect(connect).not.toHaveBeenCalled();
  });

  it("serves a read from the acceptance transaction once it is open", async () => {
    // A client held from the shared pool must never acquire a second one from
    // that same pool — the self-deadlock. Before the first mutation
    // there is no transaction to read from, so the plain-pool read stands.
    const events: string[] = [];
    const client = {
      query: (sql: string) => {
        events.push(`TX:${sqlEvent(sql)}`);
        return Promise.resolve({ rows: [] });
      },
      release: () => undefined,
    };
    const store = new PostgresTempoSessionStore({
      connect: () => Promise.resolve(client),
      query: (sql: string) => {
        events.push(`POOL:${sqlEvent(sql)}`);
        return Promise.resolve({ rows: [] });
      },
    } as never);
    await store.withVoucherAcceptance(
      { channelId: BASE.channelId, cumulativeAmount: 10n },
      () => Promise.resolve("funded"),
      async () => {
        await store.get(BASE.channelId);
        await store.update(BASE.channelId, () => ({ op: "set", value: BASE, result: undefined }));
        await store.get(BASE.channelId);
      }
    );
    expect(events).toEqual([
      "POOL:CHANNEL",
      "TX:BEGIN",
      "TX:LOCK",
      "TX:CHANNEL",
      "TX:TOMBSTONE",
      "TX:INSERT",
      "TX:CHANNEL",
      "TX:COMMIT",
    ]);
  });

  it("stops serving reads from the acceptance client once it is released", async () => {
    // The other side of the reuse above: the released client goes back to the
    // pool, so a read still holding the acceptance context would interleave
    // queries on a connection someone else now owns. Unreachable through mppx
    // today — it awaits every store call — but the handle is dropped before
    // the release so a fire-and-forget read can never find it.
    const events: string[] = [];
    let released = false;
    const client = {
      query: (sql: string) => {
        if (released) return Promise.reject(new Error("query on a released client"));
        events.push(`TX:${sqlEvent(sql)}`);
        return Promise.resolve({ rows: [] });
      },
      release: () => (released = true),
    };
    const store = new PostgresTempoSessionStore({
      connect: () => Promise.resolve(client),
      query: (sql: string) => {
        events.push(`POOL:${sqlEvent(sql)}`);
        return Promise.resolve({ rows: [] });
      },
    } as never);

    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    let lateRead: Promise<unknown> | undefined;
    await store.withVoucherAcceptance(
      { channelId: BASE.channelId, cumulativeAmount: 10n },
      () => Promise.resolve("funded"),
      async () => {
        await store.update(BASE.channelId, () => ({ op: "set", value: BASE, result: undefined }));
        // Registered inside the acceptance context, so the continuation still
        // carries it — but it runs after `withVoucherAcceptance` has returned.
        lateRead = gate.then(() => store.get(BASE.channelId));
      }
    );

    expect(released).toBe(true);
    openGate?.();
    await expect(lateRead).resolves.toBeNull();
    expect(events).toEqual([
      "TX:BEGIN",
      "TX:LOCK",
      "TX:CHANNEL",
      "TX:TOMBSTONE",
      "TX:INSERT",
      "TX:COMMIT",
      "POOL:CHANNEL",
    ]);
  });

  it("rejects rollback and immutable identity changes", () => {
    expect(() => assertMonotonicTransition(BASE, { ...BASE, spent: 9n })).toThrow(
      /monotonic field decreased: spent/
    );
    expect(() =>
      assertMonotonicTransition(BASE, { ...BASE, payer: `0x${"88".repeat(20)}` })
    ).toThrow(/immutable field changed: payer/);
  });

  it("retains positive drain payment identity across supported state replacement", () => {
    const observed = { ...BASE, tempoDrainPaymentObservation: { creditId: "credit", drainId: "drain" } };
    expect(() => assertMonotonicTransition(BASE, observed)).not.toThrow();
    expect(() => assertMonotonicTransition(observed, BASE)).toThrow("cannot be erased or rebound");
    expect(() => assertMonotonicTransition(observed, { ...observed,
      tempoDrainPaymentObservation: { creditId: "other", drainId: "drain" } })).toThrow("cannot be erased or rebound");
    expect(() => assertMonotonicTransition(BASE, { ...BASE,
      tempoDrainPaymentObservation: { creditId: "credit" } })).toThrow("requires a credit and drain identity");
  });

  it("allows terminal escrow reset but never reopens a finalized channel", () => {
    const finalized = {
      ...BASE,
      deposit: 0n,
      closeRequestedAt: 0n,
      finalized: true,
    };
    expect(() => assertMonotonicTransition(BASE, finalized)).not.toThrow();
    expect(() => assertMonotonicTransition(finalized, BASE)).toThrow(/cannot be reopened/);
  });

  it("allows a failed cooperative close to clear its local pending timestamp", () => {
    expect(() =>
      assertMonotonicTransition(
        { ...BASE, closeRequestedAt: 123n },
        { ...BASE, closeRequestedAt: 0n }
      )
    ).not.toThrow();
  });
});
