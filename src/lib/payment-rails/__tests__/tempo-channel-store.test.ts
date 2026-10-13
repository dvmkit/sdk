import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Credential } from "mppx";
import { Session as TempoSession } from "mppx/tempo";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PendingTempoChargeFunding } from "../tempo-channel-store";
import { stubTempoSessionClient } from "./__helpers__/tempo-session-client";

describe("tempo-channel-store", () => {
  let originalConfigDir: string | undefined;
  let tmpConfigDir: string;

  beforeEach(() => {
    originalConfigDir = process.env.DVM_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dvm-tempo-channels-"));
    process.env.DVM_CONFIG_DIR = tmpConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("namespaces identical payment scopes by caller identity", async () => {
    const module = await import("../tempo-channel-store");
    const endpoint = "https://wordcount.example";
    const channel = {
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 0n,
      deposit: 10n,
      descriptor: {
        payee: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`,
        salt: `0x${"44".repeat(32)}`,
      },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 4217,
      opened: true,
    };
    await module
      .createTempoChannelStore({ endpoint, callerPubkey: "aa".repeat(32), creditId: "credit-a" })
      .set(channel as never);
    expect(
      module.loadTempoChannelAssociation(endpoint, "bb".repeat(32), "credit-a")
    ).toBeUndefined();
    const key = `${channel.descriptor.payee}:${channel.descriptor.token}:${channel.escrow}:4217`;
    expect(await module.createTempoChannelStore({ endpoint, callerPubkey: "aa".repeat(32), operator: `0x${"00".repeat(20)}` }).get(key)).toBeDefined();
    expect(await module.createTempoChannelStore({ endpoint, callerPubkey: "bb".repeat(32), operator: `0x${"00".repeat(20)}` }).get(key)).toBeUndefined();
  });

  it("retires one credit without deleting a sibling association on the same scope", async () => {
    const module = await import("../tempo-channel-store");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const channel = {
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 25_000n,
      deposit: 100_000n,
      descriptor: {
        payee: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`,
        salt: `0x${"44".repeat(32)}`,
      },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened: true,
    };
    await module
      .createTempoChannelStore({ endpoint, callerPubkey, creditId: "credit-a" })
      .set(channel as never);
    await module
      .createTempoChannelStore({ endpoint, callerPubkey, creditId: "credit-b" })
      .set(channel as never);
    const first = module.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-a");
    const sibling = module.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-b");
    expect(first).toBeDefined();
    expect(sibling).toBeDefined();
    if (!first || !sibling) return;

    await module.retireTempoChannel(first);

    expect(module.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-a")).toBeUndefined();
    expect(module.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-b")).toEqual(sibling);
    await expect(module.loadTempoChannelEntry(sibling)).resolves.toMatchObject({
      channelId: channel.channelId,
      deposit: 100_000n,
    });
  });

  it("keeps every credit association on a shared payment scope current", async () => {
    const module = await import("../tempo-channel-store");
    const firstEndpoint = "https://wordcount.example";
    const secondEndpoint = "https://summarize.example";
    const callerPubkey = "aa".repeat(32);
    const descriptor = {
      payee: `0x${"22".repeat(20)}`,
      token: `0x${"33".repeat(20)}`,
      salt: `0x${"44".repeat(32)}`,
    };
    const escrow = `0x${"55".repeat(20)}`;
    const initial = {
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 25_000n,
      deposit: 100_000n,
      descriptor,
      escrow,
      chainId: 42431,
      opened: true,
    };
    await module
      .createTempoChannelStore({ endpoint: firstEndpoint, callerPubkey, creditId: "credit-a" })
      .set(initial as never);
    await module
      .createTempoChannelStore({ endpoint: secondEndpoint, callerPubkey, creditId: "credit-b" })
      .set({ ...initial, cumulativeAmount: 50_000n, deposit: 200_000n } as never);

    const first = module.loadTempoChannelAssociation(firstEndpoint, callerPubkey, "credit-a");
    const sibling = module.loadTempoChannelAssociation(secondEndpoint, callerPubkey, "credit-b");
    expect(first).toMatchObject({ cumulativeAmount: "50000", deposit: "200000" });
    expect(sibling).toMatchObject({ cumulativeAmount: "50000", deposit: "200000" });
    expect(
      module.loadTempoChannelAssociationByKey(
        callerPubkey,
        `0x${"00".repeat(20)}`,
        `${descriptor.payee}:${descriptor.token}:${escrow}:42431`
      )
    ).toMatchObject({ creditId: "credit-a" });
  });

  it("isolates the same mppx payment scope by DVM operator", async () => {
    const module = await import("../tempo-channel-store");
    const callerPubkey = "aa".repeat(32);
    const operatorA = `0x${"66".repeat(20)}`;
    const operatorB = `0x${"77".repeat(20)}`;
    const descriptor = {
      payee: `0x${"22".repeat(20)}`,
      token: `0x${"33".repeat(20)}`,
      salt: `0x${"44".repeat(32)}`,
    };
    const escrow = `0x${"55".repeat(20)}`;
    const entry = {
      cumulativeAmount: 25_000n,
      deposit: 100_000n,
      escrow,
      chainId: 42431,
      opened: true,
    };
    await module
      .createTempoChannelStore({
        endpoint: "https://wordcount.example",
        callerPubkey,
        creditId: "credit-a",
        operator: operatorA,
      })
      .set({
        ...entry,
        channelId: `0x${"11".repeat(32)}`,
        descriptor: { ...descriptor, operator: operatorA },
      } as never);
    await module
      .createTempoChannelStore({
        endpoint: "https://summarize.example",
        callerPubkey,
        creditId: "credit-b",
        operator: operatorB,
      })
      .set({
        ...entry,
        channelId: `0x${"88".repeat(32)}`,
        cumulativeAmount: 50_000n,
        descriptor: { ...descriptor, operator: operatorB },
      } as never);

    const channelKey = `${descriptor.payee}:${descriptor.token}:${escrow}:42431`;
    expect(
      module.loadTempoChannelAssociationByKey(callerPubkey, operatorA, channelKey)
    ).toMatchObject({ creditId: "credit-a", cumulativeAmount: "25000", operator: operatorA });
    expect(
      module.loadTempoChannelAssociationByKey(callerPubkey, operatorB, channelKey)
    ).toMatchObject({ creditId: "credit-b", cumulativeAmount: "50000", operator: operatorB });
  });

  it("migrates caller-only v1 channel keys into their descriptor operator scope", async () => {
    const callerPubkey = "aa".repeat(32);
    const operator = `0x${"66".repeat(20)}`;
    const channelKey = `${`0x${"22".repeat(20)}`}:${`0x${"33".repeat(20)}`}:${`0x${"55".repeat(20)}`}:42431`;
    const channelId = `0x${"11".repeat(32)}`;
    const serialized = JSON.stringify({
      channelId,
      cumulativeAmount: "25000",
      deposit: "100000",
      descriptor: {
        payee: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`,
        operator,
        salt: `0x${"44".repeat(32)}`,
      },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened: true,
    });
    const file = join(tmpConfigDir, "tempo-channels.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        values: { [`${callerPubkey}:chan:${channelKey}`]: serialized },
        associations: [
          {
            endpoint: "https://wordcount.example",
            callerPubkey,
            creditId: "credit-a",
            channelKey,
            channelId,
            cumulativeAmount: "25000",
            deposit: "100000",
            chainId: 42431,
            opened: true,
            updatedAt: 1,
          },
        ],
      })
    );
    const module = await import("../tempo-channel-store");

    const association = module.loadTempoChannelAssociationByKey(callerPubkey, operator, channelKey);
    expect(association).toMatchObject({ creditId: "credit-a", operator,
      endpoint: "https://wordcount.example", deposit: "100000", cumulativeAmount: "25000", chainId: 42431 });
    expect(module.loadTempoChannelAssociation("https://wordcount.example/path", callerPubkey, "credit-a"))
      .toEqual(association);
    expect(association && (await module.loadTempoChannelEntry(association))).toMatchObject({
      channelId,
      deposit: 100_000n, cumulativeAmount: 25_000n,
    });
    if (!association) return;
    await module
      .createTempoChannelStore({
        endpoint: association.endpoint,
        callerPubkey,
        creditId: association.creditId,
        operator,
      })
      .set(JSON.parse(serialized) as never);
    const migrated = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      values: Record<string, string>;
    };
    expect(migrated.version).toBe(2);
    expect(migrated.values[`${callerPubkey}:${operator}:chan:${channelKey}`]).toBe(serialized);
    expect(migrated.values[`${callerPubkey}:chan:${channelKey}`]).toBeUndefined();
  });

  it("refuses a second channel id on an occupied scope without orphaning the first", async () => {
    const storeModule = await import("../tempo-channel-store");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const operator = `0x${"66".repeat(20)}`;
    const descriptor = {
      payee: `0x${"22".repeat(20)}`,
      token: `0x${"33".repeat(20)}`,
      operator,
      salt: `0x${"44".repeat(32)}`,
    };
    const escrow = `0x${"55".repeat(20)}`;
    const displaced = {
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 25_000n,
      deposit: 100_000n,
      descriptor,
      escrow,
      chainId: 42431,
      opened: false,
    };
    await storeModule
      .createTempoChannelStore({ endpoint, callerPubkey, creditId: "credit-a", operator })
      .set(displaced as never);

    await expect(
      storeModule
        .createTempoChannelStore({ endpoint, callerPubkey, creditId: "credit-b", operator })
        .set({
          ...displaced,
          channelId: `0x${"77".repeat(32)}`,
          descriptor: { ...descriptor, salt: `0x${"88".repeat(32)}` },
        } as never)
    ).rejects.toMatchObject({ code: "tempo_channel_scope_occupied" });

    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-a");
    expect(association).toMatchObject({ channelId: displaced.channelId, opened: false });
    expect(
      storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-b")
    ).toBeUndefined();
    expect(association).toBeDefined();
    if (!association) return;
    await expect(storeModule.loadTempoChannelEntry(association)).resolves.toMatchObject({
      channelId: displaced.channelId,
      descriptor,
    });

    let state = { deposit: 100_000n, settled: 25_000n, closeRequestedAt: 100 };
    const chain = {
      getChannelState: vi.fn(() => Promise.resolve(state)),
      requestCloseOnChain: vi.fn(),
      waitForSuccessfulReceipt: vi.fn(() => Promise.resolve({ status: "success" })),
      withdrawOnChain: vi.fn(() => {
        state = { ...state, deposit: 0n };
        return Promise.resolve(`0x${"99".repeat(32)}`);
      }),
    };
    const { advanceTempoChannelExit } = await import("../tempo-session");
    await expect(
      advanceTempoChannelExit({
        account: {
          privateKey: `0x${"aa".repeat(32)}`,
          address: `0x${"aa".repeat(20)}`,
        },
        association,
        nowSeconds: 1_000,
        client: {} as never,
        chain: chain as never,
      })
    ).resolves.toMatchObject({ status: "withdrawn", channelId: displaced.channelId });
  });

  it("serializes concurrent set and delete lifecycles without losing the surviving credit", async () => {
    const module = await import("../tempo-channel-store");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const entry = (marker: string) => ({
      channelId: `0x${marker.repeat(64)}`,
      cumulativeAmount: 0n,
      deposit: 10n,
      descriptor: {
        payee: `0x${marker.repeat(40)}`,
        token: `0x${"3".repeat(40)}`,
        salt: `0x${marker.repeat(64)}`,
      },
      escrow: `0x${"5".repeat(40)}`,
      chainId: 42431,
      opened: true,
    });
    const oldStore = module.createTempoChannelStore({
      endpoint,
      callerPubkey,
      creditId: "credit-old",
    });
    await oldStore.set(entry("1") as never);
    const oldAssociation = module.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-old");
    expect(oldAssociation).toBeDefined();
    if (!oldAssociation) return;
    let active = 0;
    let overlapped = false;

    await Promise.all([
      module.withTempoChannelLock(async () => {
        active += 1;
        overlapped ||= active > 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await module
          .createTempoChannelStore({ endpoint, callerPubkey, creditId: "credit-new" })
          .set(entry("2") as never);
        active -= 1;
      }),
      module.withTempoChannelLock(async () => {
        active += 1;
        overlapped ||= active > 1;
        await module.retireTempoChannel(oldAssociation);
        active -= 1;
      }),
    ]);

    expect(overlapped).toBe(false);
    expect(
      module.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-old")
    ).toBeUndefined();
    expect(module.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-new")).toBeDefined();
  });

  it("fails closed without overwriting a corrupt channel journal", async () => {
    const file = join(tmpConfigDir, "tempo-channels.json");
    writeFileSync(file, "not-json\n", { mode: 0o600 });
    const module = await import("../tempo-channel-store");

    expect(() => module.listTempoChannelAssociations()).toThrowError(
      expect.objectContaining({
        code: "tempo_channel_store_invalid",
        hint: expect.stringContaining("Do not delete"),
      })
    );
    await expect(
      module
        .createTempoChannelStore({
          endpoint: "https://wordcount.example",
          callerPubkey: "aa".repeat(32),
          creditId: "credit-1",
        })
        .set({
          channelId: `0x${"11".repeat(32)}`,
          cumulativeAmount: 0n,
          deposit: 10n,
          descriptor: {
            payee: `0x${"22".repeat(20)}`,
            token: `0x${"33".repeat(20)}`,
            salt: `0x${"44".repeat(32)}`,
          },
          escrow: `0x${"55".repeat(20)}`,
          chainId: 42431,
          opened: true,
        } as never)
    ).rejects.toMatchObject({ code: "tempo_channel_store_invalid" });
    expect(readFileSync(file, "utf8")).toBe("not-json\n");
  });

  it("persists a provisional opening before broadcast and promotes the same channel", async () => {
    const storeModule = await import("../tempo-channel-store");
    const sessionModule = await import("../tempo-session");
    const privateKey =
      "0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-provisional";
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    const token = `0x${"33".repeat(20)}` as `0x${string}`;
    const payee = `0x${"22".repeat(20)}` as `0x${string}`;
    // A real mppx open, so the persisted deposit is read off the signed escrow
    // call rather than taken on trust: the DVM's `suggestedDeposit` opened this
    // channel above the funding ask, and that larger figure is the collateral
    // every later top-up sizes its headroom against.
    // Minted under a throwaway caller namespace: calling `createCredential`
    // outside mppx's fetch lifecycle stores the open immediately, and this test
    // is about the provisional entry dvmkit writes ahead of the broadcast.
    const credential = await sessionModule
      .createTempoCreditSession({
        account: { privateKey, address: account.address },
        endpoint,
        callerPubkey: "bb".repeat(32),
        creditId,
        maxDepositMicro: 250_000,
        topUpAmountMicro: 100_000,
        getClient: (() => stubTempoSessionClient({ privateKey, chainId: 42431 })) as never,
      })
      .createCredential({
        context: undefined as never,
        challenge: {
          id: "open-1",
          realm: "wordcount.example",
          method: "tempo",
          intent: "session",
          request: {
            amount: "100000",
            suggestedDeposit: "180000",
            currency: token,
            recipient: payee,
            unitType: "request",
            methodDetails: { chainId: 42431, escrowContract: escrow },
          },
        } as never,
      });
    const channelId = (Credential.deserialize(credential).payload as { channelId: string })
      .channelId;

    await expect(
      sessionModule.persistTempoOpenCredential({
        credential,
        endpoint,
        callerPubkey,
        creditId,
        opened: false,
      })
    ).resolves.toBe(true);
    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId);
    expect(association).toMatchObject({
      channelId,
      opened: false,
      cumulativeAmount: "100000",
      deposit: "180000",
    });
    expect(storeModule.listTempoChannelAssociations().length).toBeGreaterThan(0);

    await expect(
      sessionModule.persistTempoOpenCredential({
        credential,
        endpoint,
        callerPubkey,
        creditId,
        opened: true,
      })
    ).resolves.toBe(true);
    expect(storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId)).toMatchObject(
      { channelId, opened: true }
    );
  });

  it("rebases the tolerated refill ask over the durable cumulative amount", async () => {
    const module = await import("../tempo-channel-store");
    const sessionModule = await import("../tempo-session");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-refill-cap";
    await module.createTempoChannelStore({ endpoint, callerPubkey, creditId }).set({
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 100_000n,
      deposit: 100_000n,
      descriptor: {
        payee: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`,
        salt: `0x${"44".repeat(32)}`,
      },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened: true,
    } as never);

    expect(
      sessionModule.tempoSessionCumulativeCapMicro({
        endpoint,
        callerPubkey,
        creditId,
        allowanceMicro: 250_000,
        amountMicro: 250_000,
      })
    ).toBe(375_000);
    expect(
      sessionModule.tempoSessionCumulativeCapMicro({
        endpoint,
        callerPubkey,
        creditId,
        allowanceMicro: 250_000,
        amountMicro: 100_000,
      })
    ).toBe(350_000);
  });

  it("keeps the unilateral-exit record after signing a cooperative close", async () => {
    const storeModule = await import("../tempo-channel-store");
    const sessionModule = await import("../tempo-session");
    const privateKey =
      "0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-close";
    const descriptor = {
      payer: account.address,
      payee: `0x${"22".repeat(20)}` as `0x${string}`,
      operator: `0x${"00".repeat(20)}` as `0x${string}`,
      token: `0x${"33".repeat(20)}` as `0x${string}`,
      salt: `0x${"44".repeat(32)}` as `0x${string}`,
      authorizedSigner: account.address,
      expiringNonceHash: `0x${"55".repeat(32)}` as `0x${string}`,
    };
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    const channelId = TempoSession.Precompile.Channel.computeId({
      ...descriptor,
      chainId: 42431,
      escrow,
    });
    await storeModule.createTempoChannelStore({ endpoint, callerPubkey, creditId }).set({
      channelId,
      cumulativeAmount: 25_000n,
      deposit: 100_000n,
      descriptor,
      escrow,
      chainId: 42431,
      opened: true,
    });
    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId);
    expect(association).toBeDefined();
    if (!association) return;

    await sessionModule.createTempoCloseCredential({
      account: { privateKey, address: account.address },
      association,
      cumulativeAmountMicro: 25_000,
      challenge: {
        id: "close-1",
        realm: "wordcount.example",
        method: "tempo",
        intent: "session",
        request: {
          amount: "25000",
          currency: descriptor.token,
          recipient: descriptor.payee,
          unitType: "request",
          methodDetails: { chainId: 42431, escrowContract: escrow },
        },
      } as never,
      getClient: () => ({ chain: { id: 42431 } }) as never,
    });

    expect(storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId)).toBeDefined();
    await expect(storeModule.loadTempoChannelEntry(association)).resolves.toMatchObject({
      opened: true,
      cumulativeAmount: 25_000n,
    });
  });

  it("advances request-close, wait, and post-grace withdrawal without sleeping", async () => {
    const storeModule = await import("../tempo-channel-store");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-exit";
    await storeModule.createTempoChannelStore({ endpoint, callerPubkey, creditId }).set({
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 25_000n,
      deposit: 100_000n,
      descriptor: {
        payee: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`,
        salt: `0x${"44".repeat(32)}`,
      },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened: true,
    } as never);
    await storeModule
      .createTempoChannelStore({ endpoint, callerPubkey, creditId: "credit-exit-sibling" })
      .set({
        channelId: `0x${"11".repeat(32)}`,
        cumulativeAmount: 25_000n,
        deposit: 100_000n,
        descriptor: {
          payee: `0x${"22".repeat(20)}`,
          token: `0x${"33".repeat(20)}`,
          salt: `0x${"44".repeat(32)}`,
        },
        escrow: `0x${"55".repeat(20)}`,
        chainId: 42431,
        opened: true,
      } as never);
    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId);
    expect(association).toBeDefined();
    if (!association) return;
    let state = { deposit: 100_000n, settled: 25_000n, closeRequestedAt: 0 };
    const chain = {
      getChannelState: vi.fn(() => Promise.resolve(state)),
      requestCloseOnChain: vi.fn(() => {
        state = { ...state, closeRequestedAt: 100 };
        return Promise.resolve(`0x${"66".repeat(32)}`);
      }),
      waitForSuccessfulReceipt: vi.fn(() => Promise.resolve({ status: "success" })),
      withdrawOnChain: vi.fn(() => {
        state = { ...state, deposit: 0n };
        return Promise.resolve(`0x${"77".repeat(32)}`);
      }),
    };
    const account = {
      privateKey: `0x${"88".repeat(32)}` as `0x${string}`,
      address: `0x${"99".repeat(20)}` as `0x${string}`,
    };
    const { advanceTempoChannelExit } = await import("../tempo-session");

    await expect(
      advanceTempoChannelExit({
        account,
        association,
        nowSeconds: 100,
        client: {} as never,
        chain: chain as never,
      })
    ).resolves.toMatchObject({ status: "close_requested", withdrawAvailableAt: 1_000_000,
      depositMicro: 100_000, settledMicro: 25_000, guaranteedMicro: 75_000, likelyMicro: 75_000 });
    await expect(
      advanceTempoChannelExit({
        account,
        association,
        nowSeconds: 999,
        client: {} as never,
        chain: chain as never,
      })
    ).resolves.toMatchObject({ status: "waiting", likelyMicro: 75_000 });
    await expect(
      advanceTempoChannelExit({
        account,
        association,
        nowSeconds: 1_000,
        client: {} as never,
        chain: chain as never,
      })
    ).resolves.toMatchObject({ status: "withdrawn", likelyMicro: 75_000 });
    expect(
      storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId)
    ).toBeUndefined();
    expect(
      storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, "credit-exit-sibling")
    ).toBeUndefined();
    expect(storeModule.listTempoChannelAssociations()).toHaveLength(0);
  });

  it("sponsors its own exit transactions so the channel token is a live fee candidate", async () => {
    const storeModule = await import("../tempo-channel-store");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-fee-token";
    const token = `0x${"33".repeat(20)}`;
    await storeModule.createTempoChannelStore({ endpoint, callerPubkey, creditId }).set({
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 25_000n,
      deposit: 100_000n,
      descriptor: { payee: `0x${"22".repeat(20)}`, token, salt: `0x${"44".repeat(32)}` },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened: true,
    } as never);
    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId);
    expect(association).toBeDefined();
    if (!association) return;
    let state = { deposit: 100_000n, settled: 25_000n, closeRequestedAt: 0 };
    const chain = {
      getChannelState: vi.fn(() => Promise.resolve(state)),
      requestCloseOnChain: vi.fn(() => {
        state = { ...state, closeRequestedAt: 100 };
        return Promise.resolve(`0x${"66".repeat(32)}`);
      }),
      waitForSuccessfulReceipt: vi.fn(() => Promise.resolve({ status: "success" })),
      withdrawOnChain: vi.fn(() => {
        state = { ...state, deposit: 0n };
        return Promise.resolve(`0x${"77".repeat(32)}`);
      }),
    };
    const privateKey = `0x${"88".repeat(32)}` as `0x${string}`;
    const account = { privateKey, address: privateKeyToAccount(privateKey).address };
    const { advanceTempoChannelExit } = await import("../tempo-session");

    const requested = await advanceTempoChannelExit({
      account,
      association,
      nowSeconds: 100,
      client: {} as never,
      chain: chain as never,
    });
    expect(requested).toMatchObject({ status: "close_requested", channelToken: token });
    await advanceTempoChannelExit({
      account,
      association,
      nowSeconds: 1_000,
      client: {} as never,
      chain: chain as never,
    });

    // mppx resolves a funded fee token only for a sponsored transaction or one
    // the sender sponsors itself; without the self-referential feePayer the
    // candidate list is never consulted and the chain default decides.
    for (const send of [chain.requestCloseOnChain, chain.withdrawOnChain]) {
      const options = (send.mock.calls[0] as unknown as unknown[])[3] as {
        account: { address: string };
        feePayer: { address: string };
        candidateFeeTokens: string[];
      };
      expect(options.candidateFeeTokens).toEqual([token]);
      expect(options.feePayer.address).toBe(account.address);
      expect(options.account.address).toBe(options.feePayer.address);
    }
  });

  it("refuses a close the DVM names above the cumulative this wallet authorized", async () => {
    const storeModule = await import("../tempo-channel-store");
    const sessionModule = await import("../tempo-session");
    const privateKey =
      "0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-close-cap";
    const descriptor = {
      payer: account.address,
      payee: `0x${"22".repeat(20)}` as `0x${string}`,
      operator: `0x${"00".repeat(20)}` as `0x${string}`,
      token: `0x${"33".repeat(20)}` as `0x${string}`,
      salt: `0x${"44".repeat(32)}` as `0x${string}`,
      authorizedSigner: account.address,
      expiringNonceHash: `0x${"55".repeat(32)}` as `0x${string}`,
    };
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    const channelId = TempoSession.Precompile.Channel.computeId({
      ...descriptor,
      chainId: 42431,
      escrow,
    });
    await storeModule.createTempoChannelStore({ endpoint, callerPubkey, creditId }).set({
      channelId,
      cumulativeAmount: 25_000n,
      // A deposit above the authorized cumulative is the gap mppx supports and
      // an inflated close would reach into.
      deposit: 100_000n,
      descriptor,
      escrow,
      chainId: 42431,
      opened: true,
    });
    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId);
    expect(association).toBeDefined();
    if (!association) return;
    const close = (cumulativeAmountMicro: number) =>
      sessionModule.createTempoCloseCredential({
        account: { privateKey, address: account.address },
        association,
        cumulativeAmountMicro,
        challenge: {
          id: "close-cap",
          realm: "wordcount.example",
          method: "tempo",
          intent: "session",
          request: {
            amount: String(cumulativeAmountMicro),
            currency: descriptor.token,
            recipient: descriptor.payee,
            unitType: "request",
            methodDetails: { chainId: 42431, escrowContract: escrow },
          },
        } as never,
        getClient: () => ({ chain: { id: 42431 } }) as never,
      });

    await expect(close(25_001)).rejects.toMatchObject({
      code: "tempo_close_amount_unauthorized",
      message: expect.stringContaining("$0.025001"),
    });
    await expect(close(25_000)).resolves.toEqual(expect.any(String));
  });
});

describe("the one-shot charge journal", () => {
  let originalConfigDir: string | undefined;
  let tmpConfigDir: string;
  const endpoint = "https://wordcount.example";
  const aliasEndpoint = "https://wordcount-alt.example";
  const callerPubkey = "aa".repeat(32);

  function linkCreditOrigins(): void {
    writeFileSync(
      join(tmpConfigDir, "credits.json"),
      `${JSON.stringify({
        credits: [
          {
            endpoint,
            endpointAliases: [aliasEndpoint],
            callerPubkey,
            creditId: "credit-1",
            updatedAt: 1,
          },
        ],
        pendingFundings: [],
      })}\n`
    );
  }

  const entry = (over: Record<string, unknown> = {}) => ({
    endpoint: `${endpoint}/path`,
    callerPubkey,
    creditId: "credit-1",
    fundId: "fund-1",
    amountMicro: 100_000,
    targetMicro: 100_000,
    credential: "Payment abc",
    signedMicro: 100_000,
    amountMsats: 100_000,
    btcRate: 100_000,
    requestedAt: 1_000,
    credentialValidBefore: 2,
    ...over,
  });

  beforeEach(() => {
    originalConfigDir = process.env.DVM_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dvm-tempo-charges-"));
    process.env.DVM_CONFIG_DIR = tmpConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("round-trips one entry per credit, keyed on the normalised origin", async () => {
    const module = await import("../tempo-channel-store");
    module.recordPendingTempoChargeFunding(entry());
    // The same credit, re-signed under a new fund id: one entry survives, and it
    // is the latest — a journal that accumulated would let a sweep present a
    // charge the caller has already replaced.
    module.recordPendingTempoChargeFunding(entry({ fundId: "fund-2", requestedAt: 2_000 }));
    module.recordPendingTempoChargeFunding(entry({ creditId: "credit-2", fundId: "fund-3" }));

    // Looked up through an origin the record has never been written under.
    const found = module.loadResumableTempoChargeFunding({
      endpoint: "https://wordcount.example/other",
      callerPubkey: "aa".repeat(32),
      creditId: "credit-1",
      now: 1_000,
    });
    expect(found?.fundId).toBe("fund-2");
    expect(
      module.listResumableTempoChargeFundings({ callerPubkey: "aa".repeat(32), now: 1_000 })
    ).toHaveLength(2);
  });

  it("resumes a charge through a linked hostname while keeping its origin", async () => {
    linkCreditOrigins();
    const module = await import("../tempo-channel-store");
    module.recordPendingTempoChargeFunding(entry());

    expect(
      module.loadResumableTempoChargeFunding({
        endpoint: aliasEndpoint,
        callerPubkey,
        creditId: "credit-1",
        now: 1_000,
      })
    ).toMatchObject({ endpoint, fundId: "fund-1" });
    expect(
      module.listResumableTempoChargeFundings({ endpoint: aliasEndpoint, now: 1_000 })
    ).toHaveLength(1);
    await expect(
      module.withTempoChannelLock(async () =>
        module.loadResumableTempoChargeFunding({
          endpoint: aliasEndpoint,
          callerPubkey,
          creditId: "credit-1",
          now: 1_000,
        })
      )
    ).resolves.toMatchObject({ fundId: "fund-1" });
  });

  it("keeps ordinary charge reads non-blocking while an async channel lock is held", async () => {
    linkCreditOrigins();
    const module = await import("../tempo-channel-store");
    module.recordPendingTempoChargeFunding(entry());

    let enteredLock!: () => void;
    let releaseLock!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredLock = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = module.withTempoChannelLock(async () => {
      enteredLock();
      await released;
    });
    await entered;

    try {
      const startedAt = Date.now();
      expect(
        module.loadResumableTempoChargeFunding({
          endpoint: aliasEndpoint,
          callerPubkey,
          creditId: "credit-1",
          now: 1_000,
        })
      ).toMatchObject({ fundId: "fund-1" });
      expect(Date.now() - startedAt).toBeLessThan(250);
    } finally {
      releaseLock();
      await holder;
    }
  });

  it("returns a collapsed charge snapshot without waiting when migration persistence is busy", async () => {
    linkCreditOrigins();
    writeFileSync(
      join(tmpConfigDir, "tempo-channels.json"),
      `${JSON.stringify({
        version: 2,
        values: {},
        associations: [],
        charges: [
          entry({ requestedAt: 1 }),
          entry({ endpoint: aliasEndpoint, fundId: "fund-newer", requestedAt: 2 }),
        ],
      })}\n`
    );
    const module = await import("../tempo-channel-store");

    let enteredLock!: () => void;
    let releaseLock!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredLock = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = module.withTempoChannelLock(async () => {
      enteredLock();
      await released;
    });
    await entered;

    try {
      const startedAt = Date.now();
      expect(
        module.loadResumableTempoChargeFunding({
          endpoint,
          callerPubkey,
          creditId: "credit-1",
          now: 2,
        })
      ).toMatchObject({ endpoint: aliasEndpoint, fundId: "fund-newer" });
      expect(Date.now() - startedAt).toBeLessThan(250);
      const busyFile = JSON.parse(
        readFileSync(join(tmpConfigDir, "tempo-channels.json"), "utf8")
      ) as { charges: PendingTempoChargeFunding[] };
      expect(busyFile.charges).toHaveLength(2);
    } finally {
      releaseLock();
      await holder;
    }

    expect(module.listResumableTempoChargeFundings({ now: 2 })).toHaveLength(1);
    const healedFile = JSON.parse(
      readFileSync(join(tmpConfigDir, "tempo-channels.json"), "utf8")
    ) as { charges: PendingTempoChargeFunding[] };
    expect(healedFile.charges).toHaveLength(1);
  });

  it("keeps a charge at its origin without a linking credit", async () => {
    const module = await import("../tempo-channel-store");
    module.recordPendingTempoChargeFunding(entry());

    expect(
      module.loadResumableTempoChargeFunding({
        endpoint: aliasEndpoint,
        callerPubkey,
        creditId: "credit-1",
        now: 1_000,
      })
    ).toBeUndefined();
    expect(
      module.loadResumableTempoChargeFunding({
        endpoint,
        callerPubkey,
        creditId: "credit-1",
        now: 1_000,
      })
    ).toBeDefined();
  });

  it("collapses alias-split charges without merging credential fields", async () => {
    linkCreditOrigins();
    writeFileSync(
      join(tmpConfigDir, "tempo-channels.json"),
      `${JSON.stringify({
        version: 2,
        values: {},
        associations: [],
        charges: [
          entry({ credential: "Payment older", credentialValidBefore: 99, requestedAt: 1 }),
          entry({
            endpoint: aliasEndpoint,
            fundId: "fund-newer",
            credential: "Payment newer",
            credentialValidBefore: undefined,
            signedMicro: 110_000,
            requestedAt: 2,
          }),
        ],
      })}\n`
    );

    const module = await import("../tempo-channel-store");
    expect(
      module.loadResumableTempoChargeFunding({
        endpoint,
        callerPubkey,
        creditId: "credit-1",
        now: 2,
      })
    ).toMatchObject({
      endpoint: aliasEndpoint,
      fundId: "fund-newer",
      credential: "Payment newer",
      signedMicro: 110_000,
    });
    const migrated = module.listResumableTempoChargeFundings({ now: 2 });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).not.toHaveProperty("credentialValidBefore");

    writeFileSync(
      join(tmpConfigDir, "credits.json"),
      `${JSON.stringify({ credits: [], pendingFundings: [] })}\n`
    );
    expect(
      module.loadResumableTempoChargeFunding({
        endpoint,
        callerPubkey,
        creditId: "credit-1",
        now: 2,
      })
    ).toBeUndefined();
    expect(
      module.loadResumableTempoChargeFunding({
        endpoint: aliasEndpoint,
        callerPubkey,
        creditId: "credit-1",
        now: 2,
      })
    ).toMatchObject({ fundId: "fund-newer" });
    const healed = JSON.parse(readFileSync(join(tmpConfigDir, "tempo-channels.json"), "utf8")) as {
      charges: PendingTempoChargeFunding[];
    };
    expect(healed.charges).toHaveLength(1);
    expect(healed.charges[0]?.fundId).toBe("fund-newer");
  });

  it("stops resuming an entry past the staleness line, and never on the credential's own deadline", async () => {
    const module = await import("../tempo-channel-store");
    const stale = entry({ requestedAt: 0 });
    module.recordPendingTempoChargeFunding(stale);

    // Twenty-six seconds on: the credential can no longer settle, but the fund
    // id it was signed under is the thing that stops the retry paying twice, so
    // the entry is still resumable. This is the whole difference from the x402
    // exact journal, whose record dies with its authorization.
    expect(module.tempoChargeCredentialSettleable(stale, 26_000)).toBe(false);
    expect(
      module.loadResumableTempoChargeFunding({
        endpoint: stale.endpoint,
        callerPubkey: stale.callerPubkey,
        creditId: stale.creditId,
        now: 26_000,
      })
    ).toBeDefined();

    expect(module.tempoChargeFundingStale(stale, 86_400_000)).toBe(true);
    expect(
      module.listResumableTempoChargeFundings({ now: 86_400_000 })
    ).toEqual([]);
  });

  it("treats an unreadable credential deadline as spent rather than inventing a window", async () => {
    const module = await import("../tempo-channel-store");
    const undated = entry({ credentialValidBefore: undefined });
    expect(module.tempoChargeCredentialSettleable(undated, 0)).toBe(false);
  });

  it("clears on the fund id too, so a sweep cannot drop a sibling's fresher entry", async () => {
    const module = await import("../tempo-channel-store");
    const first = entry();
    module.recordPendingTempoChargeFunding(first);
    module.recordPendingTempoChargeFunding(entry({ fundId: "fund-2" }));

    module.clearPendingTempoChargeFunding(first);
    expect(module.listResumableTempoChargeFundings({ now: 1_000 })).toHaveLength(1);

    module.clearPendingTempoChargeFunding(entry({ fundId: "fund-2" }));
    expect(module.listResumableTempoChargeFundings({ now: 1_000 })).toEqual([]);
  });

  it("reads a store written before the journal existed, and drops a half-written entry", async () => {
    const module = await import("../tempo-channel-store");
    const file = join(tmpConfigDir, "tempo-channels.json");
    // No `charges` key at all — every file written before . Failing
    // closed on it would read as a corrupt journal on an intact store.
    writeFileSync(file, JSON.stringify({ version: 1, values: {}, associations: [] }));
    expect(module.listResumableTempoChargeFundings()).toEqual([]);

    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        values: {},
        associations: [],
        charges: [entry(), { endpoint: "https://wordcount.example", fundId: "half" }],
      })
    );
    expect(module.listResumableTempoChargeFundings({ now: 1_000 }).map((e) => e.fundId)).toEqual([
      "fund-1",
    ]);
  });
});

describe("tempo channel ownership", () => {
  let originalConfigDir: string | undefined;
  let tmpConfigDir: string;

  const PAYER = `0x${"ab".repeat(20)}`;
  /** The same address as the store holds it: mixed case, unlike the association fields. */
  const PAYER_MIXED = `0x${"AB".repeat(20)}`;
  const SIGNER = `0x${"cd".repeat(20)}`;

  beforeEach(() => {
    originalConfigDir = process.env.DVM_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dvm-tempo-owner-"));
    process.env.DVM_CONFIG_DIR = tmpConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Seed one channel whose descriptor names these two roles. */
  async function seed(descriptor: Record<string, unknown>) {
    const module = await import("../tempo-channel-store");
    const context = {
      endpoint: "https://wordcount.example",
      callerPubkey: "aa".repeat(32),
      creditId: "credit-1",
    };
    await module.createTempoChannelStore(context).set({
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 0n,
      deposit: 100_240n,
      descriptor: {
        payee: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`,
        salt: `0x${"44".repeat(32)}`,
        ...descriptor,
      },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened: true,
    } as never);
    const association = module.loadTempoChannelAssociation(
      context.endpoint,
      context.callerPubkey,
      context.creditId
    );
    if (!association) expect.unreachable("seeded channel produced no association");
    return { module, association };
  }

  it("reads the payer back out of the descriptor, folded to one case", async () => {
    const { module, association } = await seed({ payer: PAYER_MIXED });

    const controller = await module.loadTempoChannelController(association);

    expect(controller).toEqual({ payer: PAYER, authorizedSigner: PAYER });
    expect(module.tempoChannelControlledBy(controller, PAYER_MIXED)).toBe(true);
    expect(module.tempoChannelControlledBy(controller, SIGNER)).toBe(false);
  });

  // A zero signer delegates to the payer; a real one is a second key that can
  // still commit the deposit, so both count as control.
  it("follows the descriptor's voucher-signer delegation", async () => {
    const { module, association } = await seed({ payer: PAYER, authorizedSigner: SIGNER });

    const controller = await module.loadTempoChannelController(association);

    expect(controller).toEqual({ payer: PAYER, authorizedSigner: SIGNER });
    expect(module.tempoChannelControlledBy(controller, SIGNER)).toBe(true);
    expect(module.tempoChannelControlledBy(controller, PAYER)).toBe(true);
  });

  // Unknowable ownership is not the same as someone else's: guessing "a
  // stranger's" would let the key be replaced over a channel it may well own.
  it("claims nothing about a descriptor that names no payer", async () => {
    const { module, association } = await seed({});

    expect(await module.loadTempoChannelController(association)).toBeUndefined();
    expect(module.tempoChannelControlledBy(undefined, PAYER)).toBe(true);
  });

  it("reports no controller once the descriptor itself is gone", async () => {
    const { module, association } = await seed({ payer: PAYER });
    const file = join(tmpConfigDir, "tempo-channels.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { values: Record<string, string> };
    stored.values = {};
    writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);

    expect(await module.loadTempoChannelController(association)).toBeUndefined();
  });

  // A machine with no Tempo key configured controls nothing — the opposite
  // default from an unattributable record, and for the same reason: no key here
  // can sign for that channel.
  it("gives a machine with no connected key control of nothing", async () => {
    const module = await import("../tempo-channel-store");

    expect(
      module.tempoChannelControlledBy({ payer: PAYER, authorizedSigner: PAYER }, undefined)
    ).toBe(false);
  });
});
