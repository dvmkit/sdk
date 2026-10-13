import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type StubChannelState, stubTempoSessionClient } from "./__helpers__/tempo-session-client";

/** viem's bundled endpoint for chain 42431, the chain every seeded channel uses. */
const MODERATO_BUNDLED = "https://rpc.moderato.tempo.xyz";
const ACCOUNT = {
  privateKey: `0x${"88".repeat(32)}` as `0x${string}`,
  address: `0x${"99".repeat(20)}` as `0x${string}`,
};

describe("tempo-session unilateral exit", () => {
  let originalConfigDir: string | undefined;
  let originalRpcUrl: string | undefined;
  let tmpConfigDir: string;

  beforeEach(() => {
    originalConfigDir = process.env.DVM_CONFIG_DIR;
    originalRpcUrl = process.env.DVM_TEMPO_RPC_URL;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dvm-tempo-exit-"));
    process.env.DVM_CONFIG_DIR = tmpConfigDir;
    delete process.env.DVM_TEMPO_RPC_URL;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigDir;
    if (originalRpcUrl === undefined) delete process.env.DVM_TEMPO_RPC_URL;
    else process.env.DVM_TEMPO_RPC_URL = originalRpcUrl;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.resetModules();
    vi.doUnmock("viem");
  });

  /**
   * Stub viem's wallet client, keeping the `http` spy so the transport's
   * endpoint is assertable. The exit builds its own client whenever the
   * `client` seam is left out, which is what these tests exercise.
   */
  function mockViem() {
    const http = vi.fn(() => "transport");
    vi.doMock("viem", async (orig) => {
      const real = (await orig()) as Record<string, unknown>;
      return {
        ...real,
        createWalletClient: () => ({ stub: true }),
        createPublicClient: () => ({ stub: true }),
        http,
      };
    });
    return { http };
  }

  /**
   * Seed one channel on moderato and hand back its association. `opened: false`
   * is the provisional entry a funding writes before its open broadcast.
   */
  async function seedChannel(opened = true, deposit = 100_000n) {
    const storeModule = await import("../tempo-channel-store");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-exit";
    await storeModule.createTempoChannelStore({ endpoint, callerPubkey, creditId }).set({
      channelId: `0x${"11".repeat(32)}`,
      cumulativeAmount: 25_000n,
      deposit,
      descriptor: {
        payee: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`,
        salt: `0x${"44".repeat(32)}`,
      },
      escrow: `0x${"55".repeat(20)}`,
      chainId: 42431,
      opened,
    } as never);
    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId);
    if (!association) expect.unreachable("seeded channel produced no association");
    return association;
  }

  /** An escrow that has never heard of the channel: the read a mid-open timeout produces. */
  function emptyChainStub(closeRequestedAt = 0, settled = 0n) {
    return {
      ...chainStub(),
      getChannelState: vi.fn(() => Promise.resolve({ deposit: 0n, settled, closeRequestedAt })),
    };
  }

  /** Does the caller still hold a local channel for the seeded credit? */
  async function associationSurvives(): Promise<boolean> {
    const storeModule = await import("../tempo-channel-store");
    return storeModule.listTempoChannelAssociations().length > 0;
  }

  /** On-chain seam that advances state without touching a network. */
  function chainStub(closeRequestedAt = 0) {
    let state = { deposit: 100_000n, settled: 25_000n, closeRequestedAt };
    return {
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
  }

  // The exit is the one command that recovers stranded escrow, so a blank
  // override must not reach `http(" ")` and strand it. `??` kept the blank;
  // resolveRpcOverride trims it away, as the balance read already did
  it.each(["   "])(
    "falls back to the bundled endpoint when the override is %j, and still exits",
    async (blank) => {
      process.env.DVM_TEMPO_RPC_URL = blank;
      const { http } = mockViem();
      const association = await seedChannel();
      const { advanceTempoChannelExit } = await import("../tempo-session");

      await expect(
        advanceTempoChannelExit({
          account: ACCOUNT,
          association,
          nowSeconds: 100,
          chain: chainStub() as never,
        })
      ).resolves.toMatchObject({ status: "close_requested" });

      expect(http).toHaveBeenCalledWith(MODERATO_BUNDLED);
    }
  );

  it("sends the exit to DVM_TEMPO_RPC_URL when one is set", async () => {
    process.env.DVM_TEMPO_RPC_URL = "https://tempo.example/rpc";
    const { http } = mockViem();
    const association = await seedChannel();
    const { advanceTempoChannelExit } = await import("../tempo-session");

    await advanceTempoChannelExit({
      account: ACCOUNT,
      association,
      nowSeconds: 100,
      chain: chainStub() as never,
    });

    expect(http).toHaveBeenCalledWith("https://tempo.example/rpc");
  });

  /** A real viem transport failure, shaped as the HTTP transport raises it. */
  async function httpRequestError(url: string, status = 429) {
    const { HttpRequestError } = await import("viem");
    return new HttpRequestError({ status, url });
  }

  /** Drive a failing on-chain step to its `DvmError`, so each case can assert on the copy. */
  async function failingExit(args: {
    method: "getChannelState" | "requestCloseOnChain" | "waitForSuccessfulReceipt";
    thrown: unknown;
  }): Promise<{ code: string; message: string; hint: string }> {
    mockViem();
    const association = await seedChannel();
    const chain = {
      ...chainStub(),
      [args.method]: vi.fn(() => Promise.reject(args.thrown)),
    };
    const { advanceTempoChannelExit } = await import("../tempo-session");
    // Rejection captured rather than caught: an `expect.unreachable` inside a
    // `catch` lands in that same `catch`, so an exit that wrongly succeeded
    // would fail on the `code` assertion instead of saying it never threw.
    const caught = await advanceTempoChannelExit({
      account: ACCOUNT,
      association,
      nowSeconds: 100,
      chain: chain as never,
    }).then(
      () => null,
      (err: unknown) => err as { code: string; message: string; hint?: string }
    );
    if (!caught) expect.unreachable("advanceTempoChannelExit resolved; expected a throw");
    return { code: caught.code, message: caught.message, hint: caught.hint ?? "" };
  }

  // Every on-chain step is wrapped, not just the first: a provider that fails
  // mid-exit leaks the same URL as one that fails on the opening read.
  it.each(["getChannelState", "requestCloseOnChain", "waitForSuccessfulReceipt"] as const)(
    "masks the API key in the endpoint when %s fails, in the hint and the message alike",
    async (method) => {
      const key = "0123456789abcdef0123456789abcdef";
      process.env.DVM_TEMPO_RPC_URL = `https://tempo-mainnet.example-provider.io/v3/${key}`;

      // viem restates the endpoint inside its own error text, so redacting only
      // the URL we resolved would leave a second copy of the key in the message.
      const err = await failingExit({
        method,
        thrown: await httpRequestError(`https://tempo-mainnet.example-provider.io/v3/${key}`),
      });

      expect(err.code).toBe("tempo_rpc_error");
      expect(err.message).toContain("https://tempo-mainnet.example-provider.io/v3/:hex");
      expect(err.message).not.toContain(key);
      expect(err.hint).toContain("https://tempo-mainnet.example-provider.io/v3/:hex");
      expect(err.hint).not.toContain(key);
    }
  );

  it("masks the endpoint when the post-grace withdrawal fails", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    process.env.DVM_TEMPO_RPC_URL = `https://tempo-mainnet.example-provider.io/v3/${key}`;
    mockViem();
    const association = await seedChannel();
    // Already past its close request, so the exit reaches the withdrawal.
    const thrown = await httpRequestError(`https://tempo-mainnet.example-provider.io/v3/${key}`);
    const chain = {
      ...chainStub(100),
      withdrawOnChain: vi.fn(() => Promise.reject(thrown)),
    };
    const { advanceTempoChannelExit } = await import("../tempo-session");

    const caught = await advanceTempoChannelExit({
      account: ACCOUNT,
      association,
      nowSeconds: 1_000,
      chain: chain as never,
    }).then(
      () => null,
      (err: unknown) => err as { code: string; message: string; hint?: string }
    );

    if (!caught) expect.unreachable("advanceTempoChannelExit resolved; expected a throw");
    expect(caught.code).toBe("tempo_rpc_error");
    expect(caught.message).not.toContain(key);
    expect(caught.hint ?? "").not.toContain(key);
  });

  // The bundled endpoint carries no key, but the caller still needs to be told
  // which knob is theirs — and it is the other one.
  it("points an unset override at the bundled endpoint in its hint", async () => {
    const err = await failingExit({
      method: "getChannelState",
      // Errno-shaped rather than viem-shaped: a connection that never got far
      // enough for the transport to wrap it is still the endpoint's failure.
      thrown: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
        code: "ECONNREFUSED",
      }),
    });

    expect(err.code).toBe("tempo_rpc_error");
    expect(err.hint).toContain(MODERATO_BUNDLED);
    expect(err.hint).toContain("DVM_TEMPO_RPC_URL");
  });

  // viem raises its transport failure underneath an action-level wrapper, so
  // the classifier has to walk the chain rather than read the outermost name.
  it("still blames the endpoint when the transport failure is a nested cause", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    process.env.DVM_TEMPO_RPC_URL = `https://tempo-mainnet.example-provider.io/v3/${key}`;
    const err = await failingExit({
      method: "requestCloseOnChain",
      thrown: new Error("An unknown RPC error occurred.", {
        cause: await httpRequestError(`https://tempo-mainnet.example-provider.io/v3/${key}`, 503),
      }),
    });

    expect(err.code).toBe("tempo_rpc_error");
    expect(err.hint).toContain("DVM_TEMPO_RPC_URL");
    expect(err.message).not.toContain(key);
  });

  // An escrow that rejects the transaction is not the endpoint's fault: sending
  // the caller off to re-point DVM_TEMPO_RPC_URL wastes the one command
  // that recovers stranded escrow. Still redacted — mppx quotes viem back.
  it("reports a reverted transaction under its own code, with no endpoint advice", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    process.env.DVM_TEMPO_RPC_URL = `https://tempo-mainnet.example-provider.io/v3/${key}`;
    const { Errors } = await import("mppx");
    const err = await failingExit({
      method: "waitForSuccessfulReceipt",
      thrown: new Errors.VerificationFailedError({
        reason: `precompile transaction reverted, see https://tempo-mainnet.example-provider.io/v3/${key}`,
      }),
    });

    expect(err.code).toBe("tempo_exit_failed");
    expect(err.message).toContain("precompile transaction reverted");
    expect(err.message).not.toContain(key);
    expect(err.hint).not.toContain("tempo-mainnet.example-provider.io");
    expect(err.hint).toContain("dvm wallet tempo-exit");
  });

  // The likelier refusal never reaches a receipt: requestClose and withdraw are
  // gas-estimated first, so an escrow that will not close comes back as a revert
  // wrapped around RpcRequestError — a transport class carrying the node's
  // considered answer. The revert has to win, or the commonest failure of this
  // command sends the caller to re-point their endpoint.
  it("reports a node-reported revert as on-chain, not as a transport failure", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    const url = `https://tempo-mainnet.example-provider.io/v3/${key}`;
    process.env.DVM_TEMPO_RPC_URL = url;
    const { RpcRequestError } = await import("viem");
    const { getEstimateGasError } = await import("viem/utils");
    const err = await failingExit({
      method: "requestCloseOnChain",
      // Built through viem's own mapper, so the nesting is the real one:
      // EstimateGasExecutionError -> ExecutionRevertedError -> RpcRequestError.
      thrown: getEstimateGasError(
        new RpcRequestError({
          body: { method: "eth_estimateGas" },
          error: { code: 3, message: "execution reverted: channel not closable" },
          url,
        }),
        {}
      ),
    });

    expect(err.code).toBe("tempo_exit_failed");
    expect(err.message).toContain("channel not closable");
    expect(err.message).not.toContain(key);
    expect(err.hint).not.toContain("tempo-mainnet.example-provider.io");
  });

  // A fee token that will not resolve is a plain Error out of mppx — no name to
  // match, and equally not something a different endpoint fixes.
  it("reports an unclassifiable failure under the same neutral code", async () => {
    const err = await failingExit({
      method: "requestCloseOnChain",
      thrown: new Error("Cannot requestClose precompile channel: no account available."),
    });

    expect(err.code).toBe("tempo_exit_failed");
    expect(err.hint).not.toContain(MODERATO_BUNDLED);
  });

  // The wrapper exists to mask viem's leaks, not to flatten errors raised on
  // purpose — those already say what they mean, and callers switch on the code.
  it("leaves a deliberate DvmError's own code intact", async () => {
    const { DvmError } = await import("../../errors");
    const err = await failingExit({
      method: "requestCloseOnChain",
      thrown: new DvmError("tempo_channel_busy", "Another exit is mid-flight."),
    });

    expect(err.code).toBe("tempo_channel_busy");
    expect(err.message).toBe("Another exit is mid-flight.");
  });

  it("rejects a channel recorded on a chain the CLI cannot reach", async () => {
    mockViem();
    const storeModule = await import("../tempo-channel-store");
    const endpoint = "https://wordcount.example";
    const callerPubkey = "aa".repeat(32);
    const creditId = "credit-unsupported";
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
      chainId: 1,
      opened: true,
    } as never);
    const association = storeModule.loadTempoChannelAssociation(endpoint, callerPubkey, creditId);
    if (!association) expect.unreachable("seeded channel produced no association");
    const { advanceTempoChannelExit } = await import("../tempo-session");

    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        nowSeconds: 100,
        chain: chainStub() as never,
      })
    ).rejects.toMatchObject({ code: "tempo_chain_unsupported" });
  });

  // A funding that timed out mid-open leaves a provisional entry, and the
  // escrow reads zero for it exactly as it does for a channel that closed and
  // paid out. Retiring on that read deleted the sole copy of the descriptor an
  // exit needs — so an open that mined a block later was unrecoverable
  it("keeps a provisional channel the escrow has no record of, and reports it unconfirmed", async () => {
    mockViem();
    const association = await seedChannel(false);
    const { advanceTempoChannelExit } = await import("../tempo-session");

    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        nowSeconds: 100,
        chain: emptyChainStub() as never,
      })
    ).resolves.toMatchObject({ status: "unconfirmed", depositMicro: 0 });

    await expect(associationSurvives()).resolves.toBe(true);
  });

  it("still retires a confirmed-open channel that reads zero", async () => {
    mockViem();
    const association = await seedChannel();
    const storeModule = await import("../tempo-channel-store");
    const entry = await storeModule.loadTempoChannelEntry(association);
    if (!entry) expect.unreachable("seeded channel produced no entry");
    await storeModule
      .createTempoChannelStore({
        endpoint: association.endpoint,
        callerPubkey: association.callerPubkey,
        creditId: "credit-exit-sibling",
      })
      .set(entry);
    const { advanceTempoChannelExit } = await import("../tempo-session");

    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        nowSeconds: 100,
        chain: emptyChainStub(0, 25_000n) as never,
      })
    ).resolves.toMatchObject({ status: "already_closed", likelyMicro: 0, guaranteedMicro: 0 });

    await expect(associationSurvives()).resolves.toBe(false);
    expect(storeModule.listTempoChannelAssociations()).toHaveLength(0);
  });

  /**
   * A record whose descriptor names another wallet.
   *
   * The escrow refunds the payer a descriptor names and nobody else, so a
   * channel opened by a key that has since been replaced is unreachable from
   * here — and it used to hold the Tempo key slot hostage anyway.
   */
  describe("a channel another Tempo key opened", () => {
    const STRANGER = `0x${"cd".repeat(20)}`;

    /** The refusal itself, so a case that wrongly resolved says so rather than asserting on null. */
    async function refusedExit(
      exit: Promise<unknown>
    ): Promise<{ code: string; message: string; hint: string; data?: Record<string, unknown> }> {
      const caught = await exit.then(
        () => null,
        (err: unknown) =>
          err as { code: string; message: string; hint?: string; data?: Record<string, unknown> }
      );
      if (!caught) expect.unreachable("advanceTempoChannelExit resolved; expected a throw");
      // Field by field: `message` is a non-enumerable own property on an Error,
      // so a spread would silently hand back an object without it.
      return {
        code: caught.code,
        message: caught.message,
        hint: caught.hint ?? "",
        data: caught.data,
      };
    }

    /** Seed one channel whose descriptor names `STRANGER` as payer and signer. */
    async function seedForeignChannel(opened = true) {
      const storeModule = await import("../tempo-channel-store");
      const context = {
        endpoint: "https://wordcount.example",
        callerPubkey: "aa".repeat(32),
        creditId: "credit-exit",
      };
      await storeModule.createTempoChannelStore(context).set({
        channelId: `0x${"11".repeat(32)}`,
        cumulativeAmount: 25_000n,
        deposit: 100_240n,
        descriptor: {
          payer: STRANGER,
          payee: `0x${"22".repeat(20)}`,
          token: `0x${"33".repeat(20)}`,
          salt: `0x${"44".repeat(32)}`,
        },
        escrow: `0x${"55".repeat(20)}`,
        chainId: 42431,
        opened,
      } as never);
      const association = storeModule.loadTempoChannelAssociation(
        context.endpoint,
        context.callerPubkey,
        context.creditId
      );
      if (!association) expect.unreachable("seeded channel produced no association");
      return association;
    }

    // Refusing is the useful answer: signing a close with the wrong key buys a
    // stablecoin fee and a reverted transaction.
    it("refuses an exit, naming both wallets and leaving the record standing", async () => {
      mockViem();
      const association = await seedForeignChannel();
      const chain = chainStub();
      const { advanceTempoChannelExit } = await import("../tempo-session");

      const caught = await refusedExit(
        advanceTempoChannelExit({ account: ACCOUNT, association, chain: chain as never })
      );

      expect(caught.code).toBe("tempo_wallet_mismatch");
      expect(caught.message).toContain(ACCOUNT.address);
      expect(caught.message).toContain(STRANGER);
      // Recovering a stranger's collateral must not start by putting the key
      // on argv, and this state has a key connected, so the reconnect that
      // replaces it needs --force to be accepted at all.
      expect(caught.hint).not.toContain("--api-key");
      expect(caught.data).toMatchObject({
        anchor: "tempo_channel_payer_mismatch",
        recorded_payer: STRANGER,
        connected_payer: ACCOUNT.address,
      });
      expect(chain.getChannelState).not.toHaveBeenCalled();
      await expect(associationSurvives()).resolves.toBe(true);
    });

    // The escape valve, and the reason it reads nothing: the one route out of a
    // stranger's record must not depend on an RPC that answers.
    it("retires the record on --abandon without reading the chain", async () => {
      mockViem();
      const association = await seedForeignChannel();
      const chain = chainStub();
      const { advanceTempoChannelExit } = await import("../tempo-session");

      await expect(
        advanceTempoChannelExit({
          account: ACCOUNT,
          association,
          abandon: true,
          chain: chain as never,
        })
      ).resolves.toEqual({
        status: "abandoned",
        foreignPayer: STRANGER,
        channelId: association.channelId,
      });

      expect(chain.getChannelState).not.toHaveBeenCalled();
      expect(chain.requestCloseOnChain).not.toHaveBeenCalled();
      await expect(associationSurvives()).resolves.toBe(false);
    });

    // With no key to compare against, every descriptor would read as a
    // stranger's — including the caller's own. A `tempo` block that is missing
    // or holds a non-key is restorable from the config backup, so the record
    // has to keep its chain protection rather than be retired on sight.
    it("falls back to the on-chain refusal when no Tempo key is connected", async () => {
      mockViem();
      const association = await seedForeignChannel();
      const chain = chainStub();
      const { advanceTempoChannelExit } = await import("../tempo-session");

      const caught = await refusedExit(
        advanceTempoChannelExit({ association, abandon: true, chain: chain as never })
      );

      expect(caught.code).toBe("tempo_channel_on_chain");
      // The remedy has to name the key, not send the caller back through the
      // same command without the flag, which would only refuse again.
      // Off argv, and without --force: nothing is configured in this state, so
      // `tempo-connect` would accept the flag and ignore it.
      expect(caught.hint).not.toContain("--api-key");
      expect(caught.hint).not.toContain("--force");
      expect(chain.getChannelState).toHaveBeenCalled();
      await expect(associationSurvives()).resolves.toBe(true);
    });

    // The escrow read is a `view` call, so a caller who has already
    // disconnected still gets a verdict — and a record the chain has never
    // heard of still retires, exactly as it does with a key connected.
    it("still abandons a record the escrow has no channel for, keylessly", async () => {
      mockViem();
      const association = await seedForeignChannel(false);
      const chain = chainStub();
      chain.getChannelState.mockResolvedValue({
        deposit: 0n,
        settled: 0n,
        closeRequestedAt: 0,
      } as never);
      const { advanceTempoChannelExit } = await import("../tempo-session");

      await expect(
        advanceTempoChannelExit({ association, abandon: true, chain: chain as never })
      ).resolves.toMatchObject({ status: "abandoned" });

      await expect(associationSurvives()).resolves.toBe(false);
    });

    // Nothing signs on this path, so the refusal is the key-missing one rather
    // than a mismatch against a wallet that is not there.
    it("refuses a keyless exit that would have to sign", async () => {
      mockViem();
      const association = await seedForeignChannel();
      const chain = chainStub();
      const { advanceTempoChannelExit } = await import("../tempo-session");

      const caught = await refusedExit(
        advanceTempoChannelExit({ association, chain: chain as never })
      );

      expect(caught.code).toBe("tempo_wallet_missing");
      expect(caught.data).toMatchObject({ anchor: "tempo_channel_key_missing" });
      expect(caught.hint).not.toContain("--api-key");
      expect(chain.requestCloseOnChain).not.toHaveBeenCalled();
      await expect(associationSurvives()).resolves.toBe(true);
    });
  });

  // The local `opened` flag is not the only evidence: a chain that has settled
  // against this channel, or recorded a close request on it, knows it existed.
  it.each([
    ["a recorded close request", 100, 0n],
    ["a settled amount", 0, 25_000n],
  ])("retires a provisional channel the chain remembers via %s", async (_label, at, settled) => {
    mockViem();
    const association = await seedChannel(false);
    const { advanceTempoChannelExit } = await import("../tempo-session");

    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        nowSeconds: 100,
        chain: emptyChainStub(at, settled) as never,
      })
    ).resolves.toMatchObject({ status: "already_closed" });

    await expect(associationSurvives()).resolves.toBe(false);
  });

  // Nothing else retires a provisional entry, and while one is here the Tempo
  // key cannot be disconnected or replaced — so an open the DVM refused
  // outright would lock the wallet permanently without this way out.
  it("retires a provisional channel on request, and reports it abandoned", async () => {
    mockViem();
    const association = await seedChannel(false);
    const { advanceTempoChannelExit } = await import("../tempo-session");

    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        nowSeconds: 100,
        abandon: true,
        chain: emptyChainStub() as never,
      })
    ).resolves.toMatchObject({ status: "abandoned" });

    await expect(associationSurvives()).resolves.toBe(false);
  });

  it("refuses to abandon a channel the escrow does know about", async () => {
    mockViem();
    const association = await seedChannel(false);
    const { advanceTempoChannelExit } = await import("../tempo-session");
    const chain = chainStub();

    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        nowSeconds: 100,
        abandon: true,
        chain: chain as never,
      })
    ).rejects.toMatchObject({ code: "tempo_channel_on_chain" });

    // Dollars, not raw micro-units: the figure is caller-facing money, and the
    // sibling refusals in this module format it that way.
    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        nowSeconds: 100,
        abandon: true,
        chain: chain as never,
      }).catch((err: unknown) => (err as Error).message)
    ).resolves.toContain("$0.1");

    // Refused before any transaction, and with the record that recovers it kept.
    expect(chain.requestCloseOnChain).not.toHaveBeenCalled();
    await expect(associationSurvives()).resolves.toBe(true);
  });

  it("floors the guarantee at zero on a channel whose whole deposit is authorized", async () => {
    mockViem();
    const association = await seedChannel();
    const { advanceTempoChannelExit } = await import("../tempo-session");
    const chain = {
      ...chainStub(),
      // Nothing settled yet, but a voucher for the full deposit is signed.
      getChannelState: vi.fn(() =>
        Promise.resolve({ deposit: 25_000n, settled: 0n, closeRequestedAt: 0 })
      ),
    };

    await expect(
      advanceTempoChannelExit({
        account: ACCOUNT,
        association,
        nowSeconds: 100,
        chain: chain as never,
      })
    ).resolves.toMatchObject({ guaranteedMicro: 0, likelyMicro: 25_000 });
  });

  describe("chain reconciliation after a cooperative close", () => {

    // One mppx payment scope can fund several credits, and a channel the escrow
    // has finished with is finished for all of them — a sibling left pointing at
    // it keeps refusing 'wallet tempo-disconnect' over money that is already home.
    it("retires every sibling credit sharing the closed channel's scope", async () => {
      const { http } = mockViem();
      const association = await seedChannel();
      const storeModule = await import("../tempo-channel-store");
      const entry = await storeModule.loadTempoChannelEntry(association);
      if (!entry) expect.unreachable("seeded channel produced no entry");
      await storeModule
        .createTempoChannelStore({
          endpoint: association.endpoint,
          callerPubkey: association.callerPubkey,
          creditId: "credit-reconcile-sibling",
        })
        .set(entry);
      const { reconcileTempoChannelOnChain } = await import("../tempo-session");

      const chain = emptyChainStub();
      await expect(
        reconcileTempoChannelOnChain({ association, chain: chain as never })
      ).resolves.toMatchObject({ status: "closed", retired: true, depositMicro: 0, settledMicro: 0, channelId: association.channelId });
      expect(http).toHaveBeenCalledWith(MODERATO_BUNDLED);
      expect(chain.requestCloseOnChain).not.toHaveBeenCalled();
      expect(chain.withdrawOnChain).not.toHaveBeenCalled();
      expect(chain.waitForSuccessfulReceipt).not.toHaveBeenCalled();

      expect(storeModule.listTempoChannelAssociations()).toHaveLength(0);
    });

    it("keeps the closed channel store byte-identical on an observation-only read", async () => {
      mockViem();
      const association = await seedChannel(true, 200_426n);
      const storePath = join(tmpConfigDir, "tempo-channels.json");
      const before = readFileSync(storePath);
      const { reconcileTempoChannelOnChain } = await import("../tempo-session");

      await reconcileTempoChannelOnChain({
        association,
        observeOnly: true,
        chain: emptyChainStub() as never,
      });

      expect(readFileSync(storePath)).toEqual(before);
      await expect(associationSurvives()).resolves.toBe(true);
    });

    it.each([
      ["collateral the escrow still holds", 0, "open"],
      ["a close already requested on-chain", 100, "closing"],
    ])("keeps the record of a channel with %s", async (_label, closeRequestedAt, status) => {
      mockViem();
      const association = await seedChannel();
      const { reconcileTempoChannelOnChain } = await import("../tempo-session");

      await expect(
        reconcileTempoChannelOnChain({
          association,
          chain: chainStub(closeRequestedAt) as never,
        })
      ).resolves.toMatchObject({
        status,
        retired: false,
        depositMicro: 100_000,
        settledMicro: 25_000,
      });

      await expect(associationSurvives()).resolves.toBe(true);
    });

    // The rule, on the read path: a zero read against a provisional
    // entry is an open that may still land, and the entry is what closes it.
    it("keeps a provisional channel the escrow has no record of", async () => {
      mockViem();
      const association = await seedChannel(false);
      const { reconcileTempoChannelOnChain } = await import("../tempo-session");

      await expect(
        reconcileTempoChannelOnChain({ association, chain: emptyChainStub() as never })
      ).resolves.toMatchObject({ status: "unconfirmed", retired: false });

      await expect(associationSurvives()).resolves.toBe(true);
    });

    // A drain that moved real money must not come back as an error because an
    // RPC was down, and the descriptor must survive to be read again later.
    it("reports an unreachable endpoint as unreadable, redacted, and keeps the record", async () => {
      const key = "0123456789abcdef0123456789abcdef";
      process.env.DVM_TEMPO_RPC_URL = `https://tempo-mainnet.example-provider.io/v3/${key}`;
      mockViem();
      const association = await seedChannel(true, 200_426n);
      const { HttpRequestError } = await import("viem");
      const chain = {
        ...emptyChainStub(),
        getChannelState: vi.fn(() =>
          Promise.reject(
            new HttpRequestError({
              status: 429,
              url: `https://tempo-mainnet.example-provider.io/v3/${key}`,
            })
          )
        ),
      };
      const { reconcileTempoChannelOnChain } = await import("../tempo-session");

      const result = await reconcileTempoChannelOnChain({ association, chain: chain as never });

      expect(result).toMatchObject({
        status: "unreadable",
        retired: false,
        // The record's own figure, which is all this run knows.
        depositMicro: 200_426,
      });
      expect(result.error?.code).toBe("tempo_rpc_error");
      expect(`${result.error?.message ?? ""} ${result.error?.hint ?? ""}`).not.toContain(key);
      expect(result.error?.hint).toContain("DVM_TEMPO_RPC_URL");
      await expect(associationSurvives()).resolves.toBe(true);
    });

    // A node that answered, and whose answer was no. Sending the caller to fix
    // an endpoint that is working is the wrong knob on either rail.
    it("does not blame the endpoint when the chain itself refused the read", async () => {
      mockViem();
      const association = await seedChannel();
      const chain = {
        ...emptyChainStub(),
        getChannelState: vi.fn(() => Promise.reject(new Error("execution reverted"))),
      };
      const { reconcileTempoChannelOnChain } = await import("../tempo-session");

      const result = await reconcileTempoChannelOnChain({ association, chain: chain as never });

      expect(result.status).toBe("unreadable");
      expect(result.error?.code).toBe("tempo_chain_read_failed");
      await expect(associationSurvives()).resolves.toBe(true);
    });
  });
});

describe("tempo session deposit ceiling", () => {
  const CHAIN_ID = 42431;
  const ESCROW = "0x0000000000000000000000000000000000000f2c" as `0x${string}`;
  const TOKEN = `0x${"33".repeat(20)}` as `0x${string}`;
  const PAYEE = `0x${"22".repeat(20)}` as `0x${string}`;
  const ENDPOINT = "https://wordcount.example";
  const CALLER = "aa".repeat(32);
  const CREDIT = "credit-cap";
  const CAP_MICRO = 250_000;

  let originalConfigDir: string | undefined;
  let tmpConfigDir: string;

  beforeEach(() => {
    originalConfigDir = process.env.DVM_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dvm-tempo-cap-"));
    process.env.DVM_CONFIG_DIR = tmpConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** A DVM's session challenge, with whatever amount and deposit hint it likes. */
  function challenge(request: { amount: string; suggestedDeposit?: string }) {
    return {
      id: "challenge-cap",
      realm: "wordcount.example",
      method: "tempo",
      intent: "session",
      request: {
        ...request,
        currency: TOKEN,
        recipient: PAYEE,
        unitType: "request",
        methodDetails: { chainId: CHAIN_ID, escrowContract: ESCROW },
      },
    };
  }

  /** The real mppx session method over an offline chain client. */
  async function session(args: { maxDepositMicro?: number; channelState?: StubChannelState } = {}) {
    const { createTempoCreditSession } = await import("../tempo-session");
    return createTempoCreditSession({
      account: ACCOUNT,
      endpoint: ENDPOINT,
      callerPubkey: CALLER,
      creditId: CREDIT,
      maxDepositMicro: args.maxDepositMicro ?? CAP_MICRO,
      topUpAmountMicro: 100_000,
      getClient: (() =>
        stubTempoSessionClient({
          privateKey: ACCOUNT.privateKey,
          chainId: CHAIN_ID,
          ...(args.channelState ? { channelState: args.channelState } : {}),
        })) as never,
    });
  }

  it("clamps a DVM's oversized deposit hint down to the caller's cap", async () => {
    const method = await session();
    const credential = await method.createCredential({
      context: undefined as never,
      challenge: challenge({ amount: "100000", suggestedDeposit: "5000000" }) as never,
    });

    const { tempoSessionCredentialDepositMicro } = await import("../tempo-session");
    expect(tempoSessionCredentialDepositMicro(credential)).toBe(CAP_MICRO);
  });

  it("refuses to sign an opening challenge whose own amount is over the cap", async () => {
    const method = await session();

    await expect(
      method.createCredential({
        context: undefined as never,
        challenge: challenge({ amount: "5000000" }) as never,
      })
    ).rejects.toThrow(/exceeds local maxDeposit/);
  });

  it("refuses to sign a voucher that would carry the channel past the cap", async () => {
    const storeModule = await import("../tempo-channel-store");
    const { Session: TempoSessionModule } = await import("mppx/tempo");
    const { privateKeyToAccount } = await import("viem/accounts");
    // mppx only reuses a channel this key can actually sign vouchers on.
    const signer = privateKeyToAccount(ACCOUNT.privateKey).address;
    const descriptor = {
      payer: signer,
      payee: PAYEE,
      operator: `0x${"00".repeat(20)}` as `0x${string}`,
      token: TOKEN,
      salt: `0x${"44".repeat(32)}` as `0x${string}`,
      authorizedSigner: signer,
      expiringNonceHash: `0x${"55".repeat(32)}` as `0x${string}`,
    };
    await storeModule
      .createTempoChannelStore({
        endpoint: ENDPOINT,
        callerPubkey: CALLER,
        creditId: CREDIT,
      })
      .set({
        channelId: TempoSessionModule.Precompile.Channel.computeId({
          ...descriptor,
          chainId: CHAIN_ID,
          escrow: ESCROW,
        }),
        cumulativeAmount: BigInt(CAP_MICRO),
        deposit: BigInt(CAP_MICRO),
        descriptor,
        escrow: ESCROW,
        chainId: CHAIN_ID,
        opened: true,
      } as never);

    const method = await session({
      channelState: { settled: 0n, deposit: BigInt(CAP_MICRO), closeRequestedAt: 0 },
    });

    await expect(
      method.createCredential({
        context: undefined as never,
        challenge: challenge({ amount: "1" }) as never,
      })
    ).rejects.toThrow(/exceeds local maxDeposit/);
  });

  /**
   * The top-up takes mppx's other sizing path: it refills the shortfall, not
   * the whole challenge, and its headroom is measured off the deposit the
   * local channel entry records — which is why that entry has to hold what the
   * opening credential actually committed rather than what the caller asked
   * for.
   */
  it("refills only the headroom left under the cap, and refuses past it", async () => {
    const { Session: TempoSessionModule } = await import("mppx/tempo");
    const { resolveAutomaticTopUp } = TempoSessionModule.Client.Machine;

    expect(
      resolveAutomaticTopUp({
        deposit: 200_000n,
        maxDeposit: BigInt(CAP_MICRO),
        requiredCumulative: 220_000n,
        suggestedDeposit: 5_000_000n,
        topUpAmount: 100_000n,
      })
    ).toBe(50_000n);

    expect(() =>
      resolveAutomaticTopUp({
        deposit: 200_000n,
        maxDeposit: BigInt(CAP_MICRO),
        requiredCumulative: 400_000n,
        topUpAmount: 100_000n,
      })
    ).toThrow(/exceeds local maxDeposit/);
  });

  it("reads back the deposit a top-up credential commits", async () => {
    const { Credential } = await import("mppx");
    const credential = Credential.serialize({
      challenge: challenge({ amount: "100000" }),
      payload: {
        action: "topUp",
        type: "transaction",
        channelId: `0x${"11".repeat(32)}`,
        transaction: `0x${"66".repeat(32)}`,
        descriptor: { payee: PAYEE, token: TOKEN, salt: `0x${"44".repeat(32)}` },
        additionalDeposit: "60000",
      },
    } as never);

    const { tempoSessionCredentialDepositMicro } = await import("../tempo-session");
    expect(tempoSessionCredentialDepositMicro(credential)).toBe(60_000);
  });

  it("moves no collateral on a voucher or a close", async () => {
    const { Credential } = await import("mppx");
    const { tempoSessionCredentialDepositMicro } = await import("../tempo-session");
    for (const action of ["voucher", "close"]) {
      const credential = Credential.serialize({
        challenge: challenge({ amount: "100000" }),
        payload: {
          action,
          channelId: `0x${"11".repeat(32)}`,
          descriptor: { payee: PAYEE, token: TOKEN, salt: `0x${"44".repeat(32)}` },
          cumulativeAmount: "100000",
          signature: `0x${"77".repeat(65)}`,
        },
      } as never);
      expect(tempoSessionCredentialDepositMicro(credential)).toBe(0);
    }
  });

  it("refuses a collateral-moving credential that will not say how much", async () => {
    const { Credential } = await import("mppx");
    const credential = Credential.serialize({
      challenge: challenge({ amount: "100000" }),
      payload: {
        action: "open",
        type: "transaction",
        channelId: `0x${"11".repeat(32)}`,
        transaction: `0x${"66".repeat(32)}`,
        signature: `0x${"77".repeat(65)}`,
        descriptor: { payee: PAYEE, token: TOKEN, salt: `0x${"44".repeat(32)}` },
        cumulativeAmount: "100000",
      },
    } as never);

    const { tempoSessionCredentialDepositMicro } = await import("../tempo-session");
    expect(() => tempoSessionCredentialDepositMicro(credential)).toThrow(
      /does not state the deposit/
    );
  });

  it("refuses a credential that would lock more than this funding authorized", async () => {
    const method = await session({ maxDepositMicro: 5_000_000 });
    const credential = await method.createCredential({
      context: undefined as never,
      challenge: challenge({ amount: "100000", suggestedDeposit: "5000000" }) as never,
    });

    const { assertTempoSessionDepositWithinCap } = await import("../tempo-session");
    expect(() =>
      assertTempoSessionDepositWithinCap({
        credential,
        endpoint: ENDPOINT,
        callerPubkey: CALLER,
        creditId: CREDIT,
        capMicro: CAP_MICRO,
      })
    ).toThrow(expect.objectContaining({ code: "tempo_session_deposit_exceeds_limit" }));
  });

  it("counts a top-up against the collateral the channel already holds", async () => {
    const storeModule = await import("../tempo-channel-store");
    await storeModule
      .createTempoChannelStore({
        endpoint: ENDPOINT,
        callerPubkey: CALLER,
        creditId: CREDIT,
      })
      .set({
        channelId: `0x${"11".repeat(32)}`,
        cumulativeAmount: 200_000n,
        deposit: 200_000n,
        descriptor: { payee: PAYEE, token: TOKEN, salt: `0x${"44".repeat(32)}` },
        escrow: ESCROW,
        chainId: CHAIN_ID,
        opened: true,
      } as never);

    const { Credential } = await import("mppx");
    const { assertTempoSessionDepositWithinCap } = await import("../tempo-session");
    const topUp = (additionalDeposit: string) =>
      Credential.serialize({
        challenge: challenge({ amount: "100000" }),
        payload: {
          action: "topUp",
          type: "transaction",
          channelId: `0x${"11".repeat(32)}`,
          transaction: `0x${"66".repeat(32)}`,
          descriptor: { payee: PAYEE, token: TOKEN, salt: `0x${"44".repeat(32)}` },
          additionalDeposit,
        },
      } as never);
    const within = (credential: string) =>
      assertTempoSessionDepositWithinCap({
        credential,
        endpoint: ENDPOINT,
        callerPubkey: CALLER,
        creditId: CREDIT,
        capMicro: CAP_MICRO,
      });

    expect(() => within(topUp("50000"))).not.toThrow();
    expect(() => within(topUp("50001"))).toThrow(
      expect.objectContaining({ code: "tempo_session_deposit_exceeds_limit" })
    );
  });
});

describe("tempo session voucher ceiling", () => {
  const CHAIN_ID = 42431;
  const ESCROW = "0x0000000000000000000000000000000000000f2c" as `0x${string}`;
  const TOKEN = `0x${"33".repeat(20)}` as `0x${string}`;
  const PAYEE = `0x${"22".repeat(20)}` as `0x${string}`;
  const ENDPOINT = "https://wordcount.example";
  const CALLER = "bb".repeat(32);
  const CREDIT = "credit-voucher";
  /** What the funding is buying: the basis every ceiling below is measured against. */
  const ASK_MICRO = 100_000;
  /** The per-channel allowance, deliberately wider than one funding. */
  const ALLOWANCE_MICRO = 5_000_000;

  let originalConfigDir: string | undefined;
  let tmpConfigDir: string;

  beforeEach(() => {
    originalConfigDir = process.env.DVM_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dvm-tempo-voucher-"));
    process.env.DVM_CONFIG_DIR = tmpConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.resetModules();
  });

  function challenge(amount: string) {
    return {
      id: "challenge-voucher",
      realm: "wordcount.example",
      method: "tempo",
      intent: "session",
      request: {
        amount,
        currency: TOKEN,
        recipient: PAYEE,
        unitType: "request",
        methodDetails: { chainId: CHAIN_ID, escrowContract: ESCROW },
      },
    };
  }

  /**
   * The real mppx session method, given the whole per-channel allowance as its
   * `maxDeposit` — the production shape, and the reason the voucher needs a
   * ceiling of its own.
   */
  async function session(channelState?: StubChannelState) {
    const { createTempoCreditSession } = await import("../tempo-session");
    return createTempoCreditSession({
      account: ACCOUNT,
      endpoint: ENDPOINT,
      callerPubkey: CALLER,
      creditId: CREDIT,
      maxDepositMicro: ALLOWANCE_MICRO,
      topUpAmountMicro: ASK_MICRO,
      getClient: (() =>
        stubTempoSessionClient({
          privateKey: ACCOUNT.privateKey,
          chainId: CHAIN_ID,
          ...(channelState ? { channelState } : {}),
        })) as never,
    });
  }

  /** Seed a reusable channel this wallet can sign vouchers on. */
  async function seedChannel(cumulativeAmount: bigint) {
    const storeModule = await import("../tempo-channel-store");
    const { Session: TempoSessionModule } = await import("mppx/tempo");
    const { privateKeyToAccount } = await import("viem/accounts");
    const signer = privateKeyToAccount(ACCOUNT.privateKey).address;
    const descriptor = {
      payer: signer,
      payee: PAYEE,
      operator: `0x${"00".repeat(20)}` as `0x${string}`,
      token: TOKEN,
      salt: `0x${"44".repeat(32)}` as `0x${string}`,
      authorizedSigner: signer,
      expiringNonceHash: `0x${"55".repeat(32)}` as `0x${string}`,
    };
    await storeModule
      .createTempoChannelStore({ endpoint: ENDPOINT, callerPubkey: CALLER, creditId: CREDIT })
      .set({
        channelId: TempoSessionModule.Precompile.Channel.computeId({
          ...descriptor,
          chainId: CHAIN_ID,
          escrow: ESCROW,
        }),
        cumulativeAmount,
        deposit: BigInt(ALLOWANCE_MICRO),
        descriptor,
        escrow: ESCROW,
        chainId: CHAIN_ID,
        opened: true,
      } as never);
  }

  it("accepts a session challenge inside the shared stablecoin tolerance", async () => {
    const { assertTempoSessionChallengeWithinAsk } = await import("../tempo-session");
    expect(() =>
      assertTempoSessionChallengeWithinAsk({
        challenges: [challenge("110000")] as never,
        basisMicro: ASK_MICRO,
      })
    ).not.toThrow();
  });

  it("refuses a session challenge naming more than the tolerance above the ask", async () => {
    const { assertTempoSessionChallengeWithinAsk } = await import("../tempo-session");
    expect(() =>
      assertTempoSessionChallengeWithinAsk({
        challenges: [challenge("110001")] as never,
        basisMicro: ASK_MICRO,
      })
    ).toThrow(expect.objectContaining({ code: "tempo_session_amount_exceeds_limit" }));
  });

  it("ignores challenges from other rails and intents", async () => {
    const { assertTempoSessionChallengeWithinAsk } = await import("../tempo-session");
    const charge = { ...challenge("5000000"), intent: "charge" };
    const otherRail = { ...challenge("5000000"), method: "stripe" };
    expect(() =>
      assertTempoSessionChallengeWithinAsk({
        challenges: [charge, otherRail] as never,
        basisMicro: ASK_MICRO,
      })
    ).not.toThrow();
  });

  it("refuses a session challenge whose amount is unreadable", async () => {
    const { assertTempoSessionChallengeWithinAsk } = await import("../tempo-session");
    expect(() =>
      assertTempoSessionChallengeWithinAsk({
        challenges: [challenge("lots")] as never,
        basisMicro: ASK_MICRO,
      })
    ).toThrow(/unreadable Tempo session amount/);
  });

  it("reads the cumulative the first voucher signs, and passes it at the ask", async () => {
    const {
      assertTempoSessionVoucherWithinAsk,
      tempoSessionCredentialCumulativeMicro,
      tempoSessionPriorCumulativeMicro,
    } = await import("../tempo-session");
    // Read before the plan runs, exactly as `fundOverMpp` hoists it: mppx
    // writes the cumulative it signs straight into the channel store, so a
    // read afterwards already contains this credential's own figure.
    const prior = tempoSessionPriorCumulativeMicro({
      endpoint: ENDPOINT,
      callerPubkey: CALLER,
      creditId: CREDIT,
    });
    expect(prior).toBe(0);

    const method = await session();
    const credential = await method.createCredential({
      context: undefined as never,
      challenge: challenge(String(ASK_MICRO)) as never,
    });

    expect(tempoSessionCredentialCumulativeMicro(credential)).toBe(ASK_MICRO);
    expect(() =>
      assertTempoSessionVoucherWithinAsk({
        authorizedMicro: (tempoSessionCredentialCumulativeMicro(credential) as number) - prior,
        basisMicro: ASK_MICRO,
      })
    ).not.toThrow();
  });

  it("refuses a first voucher the DVM sized against the whole allowance", async () => {
    const method = await session();
    // Under mppx's own `maxDeposit`, so its ceiling signs this happily.
    const credential = await method.createCredential({
      context: undefined as never,
      challenge: challenge("1000000") as never,
    });

    const { assertTempoSessionVoucherWithinAsk, tempoSessionCredentialCumulativeMicro } =
      await import("../tempo-session");
    const cumulative = tempoSessionCredentialCumulativeMicro(credential);
    expect(cumulative).toBe(1_000_000);
    expect(() =>
      assertTempoSessionVoucherWithinAsk({
        authorizedMicro: cumulative as number,
        basisMicro: ASK_MICRO,
      })
    ).toThrow(expect.objectContaining({ code: "tempo_session_amount_exceeds_limit" }));
  });

  it("measures a voucher over a reused channel on what this funding adds", async () => {
    await seedChannel(BigInt(ASK_MICRO));
    const {
      assertTempoSessionVoucherWithinAsk,
      tempoSessionCredentialCumulativeMicro,
      tempoSessionPriorCumulativeMicro,
    } = await import("../tempo-session");
    const prior = tempoSessionPriorCumulativeMicro({
      endpoint: ENDPOINT,
      callerPubkey: CALLER,
      creditId: CREDIT,
    });
    expect(prior).toBe(ASK_MICRO);

    const method = await session({
      settled: 0n,
      deposit: BigInt(ALLOWANCE_MICRO),
      closeRequestedAt: 0,
    });
    const credential = await method.createCredential({
      context: undefined as never,
      challenge: challenge(String(ASK_MICRO)) as never,
    });

    // mppx adds the challenge amount to the cumulative it already holds, so the
    // ceiling has to be measured on the delta — the whole cumulative would
    // refuse every legitimate second funding on a reused channel.
    expect(tempoSessionCredentialCumulativeMicro(credential)).toBe(2 * ASK_MICRO);
    expect(() =>
      assertTempoSessionVoucherWithinAsk({
        authorizedMicro: (tempoSessionCredentialCumulativeMicro(credential) as number) - prior,
        basisMicro: ASK_MICRO,
      })
    ).not.toThrow();
  });

  it("refuses a voucher over a reused channel whose delta is over the ask", async () => {
    await seedChannel(BigInt(ASK_MICRO));
    const {
      assertTempoSessionVoucherWithinAsk,
      tempoSessionCredentialCumulativeMicro,
      tempoSessionPriorCumulativeMicro,
    } = await import("../tempo-session");
    const prior = tempoSessionPriorCumulativeMicro({
      endpoint: ENDPOINT,
      callerPubkey: CALLER,
      creditId: CREDIT,
    });

    const method = await session({
      settled: 0n,
      deposit: BigInt(ALLOWANCE_MICRO),
      closeRequestedAt: 0,
    });
    const credential = await method.createCredential({
      context: undefined as never,
      challenge: challenge("1000000") as never,
    });

    expect(tempoSessionCredentialCumulativeMicro(credential)).toBe(1_000_000 + ASK_MICRO);
    expect(() =>
      assertTempoSessionVoucherWithinAsk({
        authorizedMicro: (tempoSessionCredentialCumulativeMicro(credential) as number) - prior,
        basisMicro: ASK_MICRO,
      })
    ).toThrow(expect.objectContaining({ code: "tempo_session_amount_exceeds_limit" }));
  });

  it("authorizes no capture on a management top-up or a header mppx never signed", async () => {
    const { Credential } = await import("mppx");
    const { tempoSessionCredentialCumulativeMicro } = await import("../tempo-session");
    const topUp = Credential.serialize({
      challenge: challenge(String(ASK_MICRO)),
      payload: {
        action: "topUp",
        type: "transaction",
        channelId: `0x${"11".repeat(32)}`,
        transaction: `0x${"66".repeat(32)}`,
        descriptor: { payee: PAYEE, token: TOKEN, salt: `0x${"44".repeat(32)}` },
        additionalDeposit: "60000",
      },
    } as never);

    expect(tempoSessionCredentialCumulativeMicro(topUp)).toBeUndefined();
    expect(tempoSessionCredentialCumulativeMicro("not-an-mppx-credential")).toBeUndefined();
  });
});
