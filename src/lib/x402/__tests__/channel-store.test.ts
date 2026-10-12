import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingX402ExactFunding, PendingX402Funding } from "../channel-store";

let dir: string;
const ENDPOINT = "https://dvm.example";
const ALIAS_ENDPOINT = "https://dvm-alias.example";
const CALLER_PUBKEY = "aa".repeat(32);

function linkCreditOrigins(): void {
  writeFileSync(
    join(dir, "credits.json"),
    `${JSON.stringify({
      credits: [
        {
          endpoint: ENDPOINT,
          endpointAliases: [ALIAS_ENDPOINT],
          callerPubkey: CALLER_PUBKEY,
          creditId: "credit-1",
          updatedAt: 1,
        },
      ],
      pendingFundings: [],
    })}\n`
  );
}

/** One journalled funding, as `fundOverX402` writes it before its POST. */
function pending(overrides: Partial<PendingX402Funding> = {}): PendingX402Funding {
  return {
    endpoint: ENDPOINT,
    callerPubkey: CALLER_PUBKEY,
    creditId: "credit-1",
    fundId: "fund-1",
    amountMicro: 10_000,
    targetMicro: 40_000,
    paymentHeader: "verbatim-header",
    channelId: `0x${"11".repeat(32)}`,
    requestedAt: 1,
    ...overrides,
  };
}

/** One journalled exact authorization, as `fundOverX402Exact` writes it. */
function exact(overrides: Partial<PendingX402ExactFunding> = {}): PendingX402ExactFunding {
  return {
    endpoint: ENDPOINT,
    callerPubkey: CALLER_PUBKEY,
    creditId: "credit-1",
    fundId: "fund-exact",
    amountMicro: 10_000,
    targetMicro: 40_000,
    paymentHeader: "exact-header",
    x402Version: 2,
    amountMsats: 1_000_000,
    btcRate: 100_000,
    requestedAt: Date.now(),
    authorizationValidBefore: "1900000000",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dvm-x402-channel-"));
  process.env.DVM_CONFIG_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.DVM_CONFIG_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("DvmX402ChannelStorage", () => {
  it("implements upstream storage durably and keeps voucher authority mode 0600", async () => {
    const store = await import("../channel-store");
    const storage = new store.DvmX402ChannelStorage();
    const channelId = `0x${"11".repeat(32)}` as `0x${string}`;
    await storage.set(channelId, {
      chargedCumulativeAmount: "10000",
      balance: "50000",
      totalClaimed: "0",
    });
    store.recordPendingX402Funding({
      endpoint: "https://dvm.example/extra",
      callerPubkey: "aa".repeat(32),
      creditId: "credit-1",
      fundId: "fund-1",
      amountMicro: 10_000,
      targetMicro: 40_000,
      paymentHeader: "verbatim-header",
      channelId,
      requestedAt: 1,
    });

    const restarted = new store.DvmX402ChannelStorage();
    await expect(restarted.get(channelId.toUpperCase())).resolves.toMatchObject({
      chargedCumulativeAmount: "10000",
    });
    expect(
      store.loadResumableX402Funding({
        endpoint: "https://dvm.example",
        callerPubkey: "aa".repeat(32),
        creditId: "credit-1",
      })
    ).toMatchObject({ paymentHeader: "verbatim-header", fundId: "fund-1" });
    expect(statSync(join(dir, "x402-channels.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "x402-channels.json"), "utf8")).toContain("verbatim-header");
  });

  it("retains withdrawal metadata when upstream deletes a fully-refunded context", async () => {
    const store = await import("../channel-store");
    const channelId = `0x${"22".repeat(32)}` as `0x${string}`;
    store.recordX402ChannelMetadata({
      channelId,
      endpoint: "https://dvm.example",
      callerPubkey: "aa".repeat(32),
      creditId: "credit-1",
      network: "eip155:84532",
      config: {
        payer: `0x${"01".repeat(20)}`,
        payerAuthorizer: `0x${"01".repeat(20)}`,
        receiver: `0x${"02".repeat(20)}`,
        receiverAuthorizer: `0x${"03".repeat(20)}`,
        token: `0x${"04".repeat(20)}`,
        withdrawDelay: 86_400,
        salt: `0x${"05".repeat(32)}`,
      },
      updatedAt: 1,
    });
    const storage = new store.DvmX402ChannelStorage();
    await storage.set(channelId, { balance: "1" });
    await storage.delete(channelId);

    await expect(storage.get(channelId)).resolves.toBeUndefined();
    expect(store.findX402Channel({ endpoint: "https://dvm.example" })?.channelId).toBe(channelId);
  });

  it("preserves an acknowledged owner while staging, then adopts an accepted owner", async () => {
    const store = await import("../channel-store");
    const channelId = `0x${"24".repeat(32)}` as `0x${string}`;
    const config = {
      payer: `0x${"01".repeat(20)}` as `0x${string}`,
      payerAuthorizer: `0x${"01".repeat(20)}` as `0x${string}`,
      receiver: `0x${"02".repeat(20)}` as `0x${string}`,
      receiverAuthorizer: `0x${"03".repeat(20)}` as `0x${string}`,
      token: `0x${"04".repeat(20)}` as `0x${string}`,
      withdrawDelay: 86_400,
      salt: `0x${"05".repeat(32)}` as `0x${string}`,
    };
    store.recordX402ChannelMetadata({
      channelId,
      endpoint: "https://dvm.example",
      callerPubkey: "aa".repeat(32),
      creditId: "credit-a",
      network: "eip155:84532",
      config,
      updatedAt: 1,
    });

    store.recordX402ChannelMetadata({
      channelId,
      endpoint: "https://dvm.example/new-path",
      callerPubkey: "bb".repeat(32),
      creditId: "credit-b",
      network: "eip155:84532",
      config,
      updatedAt: 2,
    });

    expect(store.findX402Channel({ channelId })).toMatchObject({
      creditId: "credit-a",
      endpoint: "https://dvm.example",
      callerPubkey: "aa".repeat(32),
      updatedAt: 1,
    });
    expect(store.findX402Channel({ creditId: "credit-b" })).toBeUndefined();

    store.acknowledgeX402ChannelOwner({
      channelId,
      endpoint: "https://dvm.example/new-path",
      callerPubkey: "bb".repeat(32),
      creditId: "credit-b",
    });

    expect(store.findX402Channel({ channelId })).toMatchObject({
      endpoint: "https://dvm.example/new-path",
      callerPubkey: "bb".repeat(32),
      creditId: "credit-b",
    });
    expect(store.findX402Channel({ creditId: "credit-a" })).toBeUndefined();

    store.recordX402ChannelMetadata({
      channelId,
      endpoint: "https://dvm.example/new-path",
      callerPubkey: "bb".repeat(32),
      creditId: "credit-b",
      network: "eip155:84532",
      config,
      updatedAt: 4,
    });
    expect(store.findX402Channel({ channelId })).toMatchObject({ updatedAt: 4 });
  });

  it("keeps the acknowledged base monotonic while a refund probe uses the contract floor", async () => {
    const store = await import("../channel-store");
    const channelId = `0x${"23".repeat(32)}` as `0x${string}`;
    writeFileSync(
      join(dir, "x402-channels.json"),
      `${JSON.stringify(
        {
          version: 1,
          channels: {
            [channelId]: {
              context: {
                balance: "500000",
                totalClaimed: "100000",
                chargedCumulativeAmount: "300000",
              },
            },
          },
          pending: [],
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    const storage = new store.DvmX402ChannelStorage();
    await expect(storage.getAcknowledgedCumulativeAmount(channelId)).resolves.toBe("300000");

    await storage.setRefundProbe(channelId, {
      balance: "500000",
      totalClaimed: "100000",
      chargedCumulativeAmount: "100000",
    });

    const restarted = new store.DvmX402ChannelStorage();
    await expect(restarted.get(channelId)).resolves.toMatchObject({
      chargedCumulativeAmount: "100000",
    });
    await expect(restarted.getAcknowledgedCumulativeAmount(channelId)).resolves.toBe("300000");

    await restarted.set(channelId, { chargedCumulativeAmount: "200000" });
    await expect(restarted.getAcknowledgedCumulativeAmount(channelId)).resolves.toBe("300000");
  });

  // A journalled header is spend authority for one credit, and the
  // resume that reads it must not be able to reach anybody else's.
  it("scopes a pending lookup to the exact credit, not to the DVM", async () => {
    const store = await import("../channel-store");
    store.recordPendingX402Funding(pending({ creditId: "credit-1" }));

    expect(
      store.loadResumableX402Funding({
        endpoint: "https://dvm.example",
        callerPubkey: "aa".repeat(32),
        creditId: "credit-2",
      })
    ).toBeUndefined();
  });

  it("resumes channel and exact fundings through a linked hostname", async () => {
    linkCreditOrigins();
    const store = await import("../channel-store");
    store.recordPendingX402Funding(pending());
    store.recordPendingX402ExactFunding(exact());

    expect(
      store.loadResumableX402Funding({
        endpoint: ALIAS_ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toMatchObject({ endpoint: ENDPOINT, fundId: "fund-1" });
    expect(
      store.loadResumableX402ExactFunding({
        endpoint: ALIAS_ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toMatchObject({ endpoint: ENDPOINT, fundId: "fund-exact" });
    expect(store.listResumableX402Fundings({ endpoint: ALIAS_ENDPOINT })).toHaveLength(1);
    expect(store.listResumableX402ExactFundings({ endpoint: ALIAS_ENDPOINT })).toHaveLength(1);
    await expect(
      store.withX402ChannelLock(async () =>
        store.loadResumableX402Funding({
          endpoint: ALIAS_ENDPOINT,
          callerPubkey: CALLER_PUBKEY,
          creditId: "credit-1",
        })
      )
    ).resolves.toMatchObject({ fundId: "fund-1" });
  });

  it("keeps ordinary funding reads non-blocking while an async channel lock is held", async () => {
    linkCreditOrigins();
    const store = await import("../channel-store");
    store.recordPendingX402Funding(pending());

    let enteredLock!: () => void;
    let releaseLock!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredLock = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = store.withX402ChannelLock(async () => {
      enteredLock();
      await released;
    });
    await entered;

    try {
      const startedAt = Date.now();
      expect(
        store.loadResumableX402Funding({
          endpoint: ALIAS_ENDPOINT,
          callerPubkey: CALLER_PUBKEY,
          creditId: "credit-1",
        })
      ).toMatchObject({ fundId: "fund-1" });
      expect(Date.now() - startedAt).toBeLessThan(250);
    } finally {
      releaseLock();
      await holder;
    }
  });

  it("returns a collapsed snapshot without waiting when migration persistence is busy", async () => {
    linkCreditOrigins();
    writeFileSync(
      join(dir, "x402-channels.json"),
      `${JSON.stringify({
        version: 1,
        channels: {},
        pending: [],
        exact: [
          exact({ requestedAt: 1 }),
          exact({ endpoint: ALIAS_ENDPOINT, fundId: "fund-newer", requestedAt: 2 }),
        ],
      })}\n`,
      { mode: 0o600 }
    );
    const store = await import("../channel-store");

    let enteredLock!: () => void;
    let releaseLock!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredLock = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = store.withX402ChannelLock(async () => {
      enteredLock();
      await released;
    });
    await entered;

    try {
      const startedAt = Date.now();
      expect(
        store.loadResumableX402ExactFunding({
          endpoint: ENDPOINT,
          callerPubkey: CALLER_PUBKEY,
          creditId: "credit-1",
        })
      ).toMatchObject({ endpoint: ALIAS_ENDPOINT, fundId: "fund-newer" });
      expect(Date.now() - startedAt).toBeLessThan(250);
      const busyFile = JSON.parse(readFileSync(join(dir, "x402-channels.json"), "utf8")) as {
        exact: PendingX402ExactFunding[];
      };
      expect(busyFile.exact).toHaveLength(2);
    } finally {
      releaseLock();
      await holder;
    }

    expect(store.listResumableX402ExactFundings()).toHaveLength(1);
    const healedFile = JSON.parse(readFileSync(join(dir, "x402-channels.json"), "utf8")) as {
      exact: PendingX402ExactFunding[];
    };
    expect(healedFile.exact).toHaveLength(1);
  });

  it("keeps channel and exact fundings at their origin without a linking credit", async () => {
    const store = await import("../channel-store");
    store.recordPendingX402Funding(pending());
    store.recordPendingX402ExactFunding(exact());

    expect(
      store.loadResumableX402Funding({
        endpoint: ALIAS_ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toBeUndefined();
    expect(
      store.loadResumableX402ExactFunding({
        endpoint: ALIAS_ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toBeUndefined();
    expect(
      store.loadResumableX402Funding({
        endpoint: ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toBeDefined();
    expect(
      store.loadResumableX402ExactFunding({
        endpoint: ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toBeDefined();
  });

  it("collapses alias-split live rows without merging their signed fields", async () => {
    linkCreditOrigins();
    const retired = pending({ fundId: "fund-retired", requestedAt: 3, refusedAt: 4 });
    writeFileSync(
      join(dir, "x402-channels.json"),
      `${JSON.stringify({
        version: 1,
        channels: {},
        pending: [
          pending({ paymentHeader: "older-channel", depositMicro: "90000", requestedAt: 1 }),
          pending({
            endpoint: ALIAS_ENDPOINT,
            fundId: "newer-channel",
            paymentHeader: "newer-channel",
            requestedAt: 2,
          }),
          retired,
        ],
        exact: [
          exact({ paymentHeader: "older-exact", amountMsats: 900_000, requestedAt: 1 }),
          exact({
            endpoint: ALIAS_ENDPOINT,
            fundId: "newer-exact",
            paymentHeader: "newer-exact",
            amountMsats: 1_100_000,
            requestedAt: 2,
          }),
        ],
      })}\n`,
      { mode: 0o600 }
    );

    const store = await import("../channel-store");
    expect(
      store.loadResumableX402Funding({
        endpoint: ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toMatchObject({
      endpoint: ALIAS_ENDPOINT,
      fundId: "newer-channel",
      paymentHeader: "newer-channel",
    });
    expect(
      store.loadResumableX402ExactFunding({
        endpoint: ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toMatchObject({
      endpoint: ALIAS_ENDPOINT,
      fundId: "newer-exact",
      paymentHeader: "newer-exact",
      amountMsats: 1_100_000,
    });

    const migratedPending = store.listPendingX402Fundings();
    expect(migratedPending).toHaveLength(3);
    expect(migratedPending.find((entry) => entry.fundId === "newer-channel")?.depositMicro).toBe(
      undefined
    );
    expect(migratedPending).toContainEqual(
      expect.objectContaining({ paymentHeader: "older-channel", supersededAt: expect.any(Number) })
    );
    expect(migratedPending).toContainEqual(expect.objectContaining({ fundId: "fund-retired" }));
    expect(store.listResumableX402ExactFundings()).toHaveLength(1);

    writeFileSync(
      join(dir, "credits.json"),
      `${JSON.stringify({ credits: [], pendingFundings: [] })}\n`
    );
    expect(
      store.loadResumableX402Funding({
        endpoint: ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toBeUndefined();
    expect(
      store.loadResumableX402ExactFunding({
        endpoint: ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toBeUndefined();
    expect(
      store.loadResumableX402Funding({
        endpoint: ALIAS_ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toMatchObject({ fundId: "newer-channel" });
    expect(
      store.loadResumableX402ExactFunding({
        endpoint: ALIAS_ENDPOINT,
        callerPubkey: CALLER_PUBKEY,
        creditId: "credit-1",
      })
    ).toMatchObject({ fundId: "newer-exact" });

    const healed = JSON.parse(readFileSync(join(dir, "x402-channels.json"), "utf8")) as {
      pending: PendingX402Funding[];
      exact: PendingX402ExactFunding[];
    };
    expect(healed.pending).toHaveLength(3);
    expect(healed.pending).toContainEqual(
      expect.objectContaining({ paymentHeader: "older-channel", supersededAt: 2 })
    );
    expect(healed.exact).toHaveLength(1);
    expect(healed.exact[0]?.fundId).toBe("newer-exact");
  });

  // The channel tuple names neither the credit, the endpoint nor the caller
  // identity, so everything that reasons about what a channel still owes —
  // the exit's guarantee, the duplicate-deposit gate — has to see all of them.
  it("collects every voucher on one channel across credits, endpoints and identities", async () => {
    const store = await import("../channel-store");
    const channelId = `0x${"77".repeat(32)}` as `0x${string}`;
    store.recordPendingX402Funding(pending({ creditId: "credit-1", channelId }));
    store.recordPendingX402Funding(
      pending({
        creditId: "credit-2",
        channelId,
        endpoint: "https://other.example",
        callerPubkey: "bb".repeat(32),
      })
    );

    expect(store.listPendingX402FundingsForChannel(channelId.toUpperCase())).toHaveLength(2);
    expect(store.listPendingX402FundingsForChannel(`0x${"99".repeat(32)}`)).toHaveLength(0);
  });

  it("calls an entry stale only once it has gone a full day unacknowledged", async () => {
    const store = await import("../channel-store");
    const entry = pending({ requestedAt: 1_000_000 });

    expect(store.x402PendingStale(entry, 1_000_000 + 86_400_000 - 1)).toBe(false);
    expect(store.x402PendingStale(entry, 1_000_000 + 86_400_000)).toBe(true);
  });

  // The deposit-shaped gates release on the authorization's own clock; the
  // holdback that reserves the claim voucher has no clock to release on.
  it("releases a refused entry's funding block at its authorization, and never by age", async () => {
    const store = await import("../channel-store");
    const refused = { ...pending({ authorizationValidBefore: "1900" }), refusedAt: 5 };

    expect(store.x402PendingBlockExpiresAt(refused)).toBe(1_900_000);
    expect(store.x402PendingUnsettled(refused, 1_900_000)).toBe(true);
    expect(store.x402PendingUnsettled(refused, 1_900_001)).toBe(false);
    // Age retires nothing: the entry is still there to be reserved.
    expect(store.x402PendingStale(refused, 1_900_001 + 86_400_000)).toBe(true);
    expect(store.x402PendingRetired(refused)).toBe(true);
  });

  // Written before the field existed, or carrying a voucher-only payload, or
  // simply unreadable — all three get the conservative answer, not an
  // immediate release.
  it("falls back to the stale threshold when no authorization expiry is readable", async () => {
    const store = await import("../channel-store");
    const base = pending({ requestedAt: 1_000_000 });
    const legacy = { ...base, refusedAt: 5 };
    const garbled = { ...base, refusedAt: 5, authorizationValidBefore: "not-a-number" };

    for (const entry of [legacy, garbled]) {
      expect(store.x402PendingBlockExpiresAt(entry)).toBe(1_000_000 + 86_400_000);
      expect(store.x402PendingUnsettled(entry, 1_000_000)).toBe(true);
      expect(store.x402PendingUnsettled(entry, 1_000_001 + 86_400_000)).toBe(
        false
      );
    }
  });

  // A retired entry and a live one can share the credit key, and the key alone
  // cannot tell them apart — so neither write may take the other's row.
  it("keeps a refused entry when the same credit signs again, and clears only one", async () => {
    const store = await import("../channel-store");
    const scope = { endpoint: "https://dvm.example", callerPubkey: "aa".repeat(32) };
    const refused = pending({ fundId: "fund-refused" });
    store.recordPendingX402Funding(refused);
    store.retirePendingX402Funding(refused);
    expect(store.loadResumableX402Funding({ ...scope, creditId: "credit-1" })).toBeUndefined();
    expect(store.listResumableX402Fundings(scope)).toHaveLength(0);
    expect(store.listPendingX402Fundings(scope)).toHaveLength(1);
    const held = store.listPendingX402FundingsForChannel(refused.channelId);
    expect(held).toHaveLength(1);
    expect(store.x402PendingRetired(held[0])).toBe(true);
    expect(held[0].paymentHeader).toBe("verbatim-header");
    const fresh = pending({ fundId: "fund-fresh" });
    store.recordPendingX402Funding(fresh);

    expect(store.listPendingX402Fundings(scope)).toHaveLength(2);
    expect(store.loadResumableX402Funding({ ...scope, creditId: "credit-1" })?.fundId).toBe(
      "fund-fresh"
    );

    store.clearPendingX402Funding(fresh);
    const left = store.listPendingX402Fundings(scope);
    expect(left).toHaveLength(1);
    expect(left[0].fundId).toBe("fund-refused");
  });

  it("round-trips the signed figures, and still loads an entry written without them", async () => {
    const store = await import("../channel-store");
    store.recordPendingX402Funding(
      pending({
        creditId: "signed",
        maxClaimableMicro: "400000",
        depositMicro: "400000",
        authorizationValidBefore: "1900000000",
      })
    );
    store.recordPendingX402Funding(pending({ creditId: "legacy" }));

    const lookup = (creditId: string) =>
      store.loadResumableX402Funding({
        endpoint: "https://dvm.example",
        callerPubkey: "aa".repeat(32),
        creditId,
      });
    expect(lookup("signed")).toMatchObject({
      maxClaimableMicro: "400000",
      depositMicro: "400000",
      authorizationValidBefore: "1900000000",
    });
    expect(lookup("legacy")?.maxClaimableMicro).toBeUndefined();
  });

  // `--force` decides whether to forget an authorization that can
  // still pull money, and the deposit's value is the figure that decision is
  // about — it can exceed the amount the funding was for.
  it("puts the deposit an authorization can still pull on the wire", async () => {
    const store = await import("../channel-store");

    expect(store.x402PendingFundingJson(pending({ depositMicro: "400000" }))).toMatchObject({
      amount_micro: 10_000,
      deposit_micro: "400000",
    });
    // A voucher-only payload authorizes no deposit at all; the field is present
    // and null rather than absent, so an agent can branch on it either way.
    expect(store.x402PendingFundingJson(pending())).toMatchObject({ deposit_micro: null });
  });

  // the wallet-lifecycle preflight needs every channel one payer
  // controls, not the single best match `findX402Channel` returns.
  it("enumerates channels newest first, scoped to one payer", async () => {
    const store = await import("../channel-store");
    const mine = `0x${"01".repeat(20)}` as `0x${string}`;
    const theirs = `0x${"09".repeat(20)}` as `0x${string}`;
    const record = (channelId: string, payer: `0x${string}`, updatedAt: number): void => {
      store.recordX402ChannelMetadata({
        channelId: channelId as `0x${string}`,
        endpoint: "https://dvm.example",
        callerPubkey: "aa".repeat(32),
        creditId: `credit-${updatedAt}`,
        network: "eip155:84532",
        config: {
          payer,
          payerAuthorizer: payer,
          receiver: `0x${"02".repeat(20)}`,
          receiverAuthorizer: `0x${"03".repeat(20)}`,
          token: `0x${"04".repeat(20)}`,
          withdrawDelay: 86_400,
          salt: `0x${"05".repeat(32)}`,
        },
        updatedAt,
      });
    };
    record(`0x${"31".repeat(32)}`, mine, 1);
    record(`0x${"32".repeat(32)}`, mine, 2);
    record(`0x${"33".repeat(32)}`, theirs, 3);

    expect(store.listX402Channels()).toHaveLength(3);
    // Checksummed on the way in, lowercased on the way out of a derived address:
    // the payer filter has to match either way.
    expect(store.listX402Channels({ payer: mine.toUpperCase() }).map((c) => c.updatedAt)).toEqual([
      2, 1,
    ]);
  });

  // The exact journal shares this file, this lock and this mode, but
  // none of the channel gates: an exact authorization belongs to no channel.
  it("keeps exact authorizations durable and apart from the channel journal", async () => {
    const store = await import("../channel-store");
    const scope = { endpoint: "https://dvm.example", callerPubkey: "aa".repeat(32) };
    const exact = {
      ...scope,
      creditId: "credit-1",
      fundId: "fund-1",
      amountMicro: 10_000,
      targetMicro: 40_000,
      paymentHeader: "exact-header",
      x402Version: 1 as const,
      amountMsats: 1_000_000,
      btcRate: 100_000,
      requestedAt: Date.now(),
      authorizationValidBefore: String(Math.floor(Date.now() / 1000) + 600),
    };
    store.recordPendingX402ExactFunding(exact);

    expect(store.loadResumableX402ExactFunding({ ...scope, creditId: "credit-1" })).toMatchObject({
      fundId: "fund-1",
      paymentHeader: "exact-header",
      amountMsats: 1_000_000,
    });
    expect(store.listResumableX402ExactFundings(scope)).toHaveLength(1);
    // Invisible to the channel side, which reasons about cumulative vouchers.
    expect(store.listPendingX402Fundings(scope)).toEqual([]);
    expect(statSync(join(dir, "x402-channels.json")).mode & 0o777).toBe(0o600);

    store.clearPendingX402ExactFunding(exact);
    expect(store.loadResumableX402ExactFunding({ ...scope, creditId: "credit-1" })).toBeUndefined();
  });

  // Nothing replays a header past its own deadline, so the entry stops being
  // resumable on its own — which is what saves it needing an operator verb.
  it("hides an exact authorization that can no longer settle", async () => {
    const store = await import("../channel-store");
    const scope = { endpoint: "https://dvm.example", callerPubkey: "aa".repeat(32) };
    store.recordPendingX402ExactFunding({
      ...scope,
      creditId: "credit-1",
      fundId: "fund-1",
      amountMicro: 10_000,
      targetMicro: 40_000,
      paymentHeader: "exact-header",
      x402Version: 1,
      amountMsats: 1_000_000,
      btcRate: 100_000,
      requestedAt: Date.now() - 60_000,
      authorizationValidBefore: String(Math.floor(Date.now() / 1000) - 1),
    });

    expect(store.loadResumableX402ExactFunding({ ...scope, creditId: "credit-1" })).toBeUndefined();
    expect(store.listResumableX402ExactFundings(scope)).toEqual([]);
  });

  // An unreadable header leaves `requestedAt` as the only clock, and the entry
  // blocks every other rail for this credit while it stands. So the fallback is
  // the signer's own ~10-minute window rather than the channel side's 24 hours:
  // a credit stuck behind one clears itself minutes later, not a day later.
  it("expires an exact authorization with no readable deadline on the signer's window", async () => {
    const store = await import("../channel-store");
    const scope = { endpoint: "https://dvm.example", callerPubkey: "aa".repeat(32) };
    const entry = {
      ...scope,
      creditId: "credit-1",
      fundId: "fund-1",
      amountMicro: 10_000,
      targetMicro: 40_000,
      paymentHeader: "unreadable-header",
      x402Version: 1 as const,
      amountMsats: 1_000_000,
      btcRate: 100_000,
      requestedAt: Date.now(),
    };
    store.recordPendingX402ExactFunding(entry);

    const ttlMs = 600_000;
    expect(store.x402ExactFundingDead(entry, entry.requestedAt + ttlMs - 1)).toBe(false);
    expect(store.x402ExactFundingDead(entry, entry.requestedAt + ttlMs)).toBe(true);
    expect(
      store.loadResumableX402ExactFunding({
        ...scope,
        creditId: "credit-1",
        now: entry.requestedAt + ttlMs,
      })
    ).toBeUndefined();
  });

  // Older journals omit the exact-authorization list; absence is not corruption.
  it("reads a journal written before exact authorizations were kept", async () => {
    writeFileSync(
      join(dir, "x402-channels.json"),
      `${JSON.stringify({ version: 1, channels: {}, pending: [pending()] })}\n`,
      { mode: 0o600 }
    );
    const store = await import("../channel-store");
    const scope = { endpoint: "https://dvm.example", callerPubkey: "aa".repeat(32) };

    expect(store.listPendingX402Fundings(scope)).toHaveLength(1);
    expect(store.listResumableX402ExactFundings(scope)).toEqual([]);
  });

  // Both the local accumulator and a DVM report are weaker
  // than the contract. The same marker covers them until `channels()` replaces
  // the projection, without lowering the DVM-acknowledged voucher base.
  it("keeps non-chain balances stamped until a chain reconciliation", async () => {
    const store = await import("../channel-store");
    const storage = new store.DvmX402ChannelStorage();
    const channelId = `0x${"11".repeat(32)}` as `0x${string}`;

    await storage.set(channelId, { balance: "9000", chargedCumulativeAmount: "9000" });
    expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeUndefined();

    await storage.setLocallyAppliedDeposit(channelId, {
      balance: "109000",
      chargedCumulativeAmount: "109000",
    });
    expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeGreaterThan(0);
    // The stamp rides beside the context rather than inside it, so upstream's
    // own record shape is untouched.
    await expect(storage.get(channelId)).resolves.toEqual({
      balance: "109000",
      chargedCumulativeAmount: "109000",
    });

    const clearProvenance = storage.stageNextUnobservedBalanceProvenance("unreconciled");
    try {
      await storage.set(channelId, { balance: "99000", chargedCumulativeAmount: "109000" });
    } finally {
      clearProvenance();
    }
    expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeGreaterThan(0);

    await storage.reconcileChainState(channelId, { balance: "9000", totalClaimed: "1000" });
    expect(store.x402ChannelBalanceUnreconciledAt(channelId)).toBeUndefined();
    await expect(storage.get(channelId)).resolves.toMatchObject({
      balance: "9000",
      totalClaimed: "1000",
      chargedCumulativeAmount: "109000",
    });
    // The chain write still holds the acknowledged base apart from its own
    // claimed figure.
    await expect(storage.getAcknowledgedCumulativeAmount(channelId)).resolves.toBe("109000");
  });

  // The probe's `chargedCumulativeAmount` is a seed rather than an
  // acknowledgement: it is the contract's claimed floor,
  // written only so upstream's own `balance <= charged` guard lets the refund
  // request out. It must never feed the acknowledged sibling, which records the
  // highest voucher a DVM actually acknowledged.
  //
  // A seed BELOW the stored base cannot show that, because holding and taking
  // the higher of the two agree there. Only a seed above it separates them, and
  // without this case a one-word edit to the probe's write semantics passes
  // every other test in the suite.
  it("holds the acknowledged base when a refund probe seeds a higher floor", async () => {
    const store = await import("../channel-store");
    const storage = new store.DvmX402ChannelStorage();
    const channelId = `0x${"22".repeat(32)}` as `0x${string}`;

    await storage.set(channelId, { balance: "120000", chargedCumulativeAmount: "50000" });
    await expect(storage.getAcknowledgedCumulativeAmount(channelId)).resolves.toBe("50000");

    await storage.setRefundProbe(channelId, {
      balance: "120000",
      totalClaimed: "90000",
      chargedCumulativeAmount: "90000",
    });

    await expect(storage.getAcknowledgedCumulativeAmount(channelId)).resolves.toBe("50000");
    // The context itself does take the seed; only the sibling holds.
    await expect(storage.get(channelId)).resolves.toMatchObject({
      chargedCumulativeAmount: "90000",
    });
  });

  it("fails closed when the spend-authority journal is corrupt", async () => {
    writeFileSync(join(dir, "x402-channels.json"), "not-json", { mode: 0o600 });
    const store = await import("../channel-store");

    await expect(new store.DvmX402ChannelStorage().get("0x01")).rejects.toMatchObject({
      code: "x402_channel_store_invalid",
      hint: expect.stringContaining("Do not delete"),
    });
  });
});
