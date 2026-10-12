import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The stored context is only ever read here, and only on a row the chain
// could not account for. `DvmX402ChannelStorage` is a class the real module
// builds over a file, so the seam is the whole store rather than the file.
vi.mock("../channel-store", () => ({
  DvmX402ChannelStorage: class {
    get = storedContext;
    reconcileChainState = storedReconcile;
  },
  x402ChannelBalanceUnreconciledAt: vi.fn(() => undefined),
}));

import type { DvmError } from "../../errors";
import {
  type StoredX402ChannelMetadata,
  x402ChannelBalanceUnreconciledAt,
} from "../channel-store";
import {
  assertX402ChannelPayer,
  readX402ChannelGuardFacts,
  readX402ChannelOnChain,
  x402ChannelControlledBy,
} from "../lifecycle";

const { storedContext, storedReconcile } = vi.hoisted(() => ({
  storedContext: vi.fn(() => Promise.resolve<{ balance?: string } | undefined>(undefined)),
  storedReconcile: vi.fn((_channelId: string, _state: { balance: string; totalClaimed: string }) =>
    Promise.resolve()
  ),
}));

const PAYER = "0x1111111111111111111111111111111111111111";
const OTHER_PAYER = "0x2222222222222222222222222222222222222222";
const CHANNEL_ID = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const WALLET = { address: PAYER, network: "eip155:8453" };

function channel(overrides: Partial<StoredX402ChannelMetadata> = {}): StoredX402ChannelMetadata {
  return {
    channelId: CHANNEL_ID,
    endpoint: "https://dvm.example",
    callerPubkey: "caller-pub",
    creditId: "credit-1",
    network: "eip155:8453",
    updatedAt: 1,
    ...overrides,
    config: {
      payer: PAYER,
      payerAuthorizer: PAYER,
      receiver: "0x3333333333333333333333333333333333333333",
      receiverAuthorizer: "0x3333333333333333333333333333333333333333",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      withdrawDelay: 86_400,
      salt: "0xbbbb000000000000000000000000000000000000000000000000000000000001",
      ...overrides.config,
    },
  };
}

/** Stub viem's public client, returning one `(value, timestamp)` pair per view. */
function mockChainState(state: {
  channels?: readonly [bigint, bigint];
  pendingWithdrawals?: readonly [bigint, number];
  /** The contract's monotonic cooperative-refund counter. */
  refundNonce?: bigint;
  throws?: Error;
}) {
  const readContract = vi.fn(({ functionName }: { functionName: string }) => {
    if (state.throws) return Promise.reject(state.throws);
    if (functionName === "refundNonce") return Promise.resolve(state.refundNonce ?? 0n);
    return Promise.resolve(
      functionName === "channels"
        ? (state.channels ?? [0n, 0n])
        : (state.pendingWithdrawals ?? [0n, 0])
    );
  });
  const http = vi.fn((_url?: string) => "transport");
  const createPublicClient = vi.fn().mockReturnValue({ readContract });
  vi.doMock("viem", () => ({ createPublicClient, http }));
  return { readContract, http, createPublicClient };
}

const savedRpcUrl = process.env.DVM_X402_RPC_URL;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.DVM_X402_RPC_URL;
  storedContext.mockResolvedValue(undefined);
  storedReconcile.mockImplementation((_channelId, state) => {
    storedContext.mockResolvedValue({ balance: state.balance });
    return Promise.resolve();
  });
  vi.mocked(x402ChannelBalanceUnreconciledAt).mockReturnValue(undefined);
});

afterEach(() => {
  vi.doUnmock("viem");
  if (savedRpcUrl === undefined) delete process.env.DVM_X402_RPC_URL;
  else process.env.DVM_X402_RPC_URL = savedRpcUrl;
});

describe("readX402ChannelGuardFacts", () => {
  it("returns bigint chain facts and reconciles the stored projection", async () => {
    mockChainState({ channels: [9_007_199_254_740_993n, 17n], pendingWithdrawals: [23n, 1] });
    await expect(readX402ChannelGuardFacts({ channel: channel(), configuredNetwork: WALLET.network }))
      .resolves.toEqual({ balance: 9_007_199_254_740_993n, pendingWithdrawal: 23n });
    expect(storedReconcile).toHaveBeenCalledWith(CHANNEL_ID, {
      balance: "9007199254740993", totalClaimed: "17",
    });
  });

  it("returns authoritative facts even when the projection cannot be written", async () => {
    mockChainState({ channels: [31n, 0n] });
    storedReconcile.mockRejectedValueOnce(new Error("unwritable projection"));
    await expect(readX402ChannelGuardFacts({ channel: channel(), configuredNetwork: WALLET.network }))
      .resolves.toEqual({ balance: 31n, pendingWithdrawal: 0n });
  });

  it("rejects unsupported recorded chains rather than returning empty facts", async () => {
    await expect(readX402ChannelGuardFacts({ channel: channel({ network: "eip155:1" }), configuredNetwork: WALLET.network }))
      .rejects.toMatchObject({ code: "x402_unsupported_network" });
  });

  it("rejects failed reads even when a stored balance is available", async () => {
    mockChainState({ throws: new Error("timeout") });
    storedContext.mockResolvedValue({ balance: "0" });
    await expect(readX402ChannelGuardFacts({ channel: channel(), configuredNetwork: WALLET.network }))
      .rejects.toMatchObject({ code: "x402_rpc_error" });
    expect(storedReconcile).not.toHaveBeenCalled();
  });

  it("uses the recorded chain and scopes the wallet RPC override", async () => {
    process.env.DVM_X402_RPC_URL = "https://base.example/rpc";
    const { http, createPublicClient } = mockChainState({});
    await readX402ChannelGuardFacts({ channel: channel({ network: "eip155:137" }), configuredNetwork: WALLET.network });
    expect(createPublicClient).toHaveBeenCalledWith(expect.objectContaining({ chain: expect.objectContaining({ id: 137 }) }));
    expect(http).not.toHaveBeenCalledWith("https://base.example/rpc");
  });
});

describe("assertX402ChannelPayer", () => {
  it("passes the channel its own payer, case-insensitively", () => {
    expect(() => assertX402ChannelPayer(channel(), PAYER.toUpperCase())).not.toThrow();
  });

  it("names both payers and the channel when the connected key is a stranger", () => {
    const err = catchError(() => assertX402ChannelPayer(channel(), OTHER_PAYER));

    expect(err.code).toBe("x402_wallet_mismatch");
    expect(err.message).toContain(PAYER);
    expect(err.message).toContain(OTHER_PAYER);
    expect(err.hint).toContain("x402-connect");
    expect(err.data).toMatchObject({
      channel_id: CHANNEL_ID,
      endpoint: "https://dvm.example",
      recorded_payer: PAYER,
      connected_payer: OTHER_PAYER,
    });
  });
});

/** Run a synchronous assertion expected to refuse, and hand back the refusal. */
function catchError(operation: () => void): DvmError {
  try {
    operation();
  } catch (err) {
    return err as DvmError;
  }
  throw new Error("expected a refusal");
}

describe("readX402ChannelOnChain", () => {
  const read = (overrides: Partial<StoredX402ChannelMetadata> = {}) =>
    readX402ChannelOnChain({ channel: channel(overrides), configuredNetwork: "eip155:8453" });

  it("calls escrow the contract still holds open, with the DVM's take beside it", async () => {
    const { readContract } = mockChainState({
      channels: [5_000_000n, 2_000_000n], pendingWithdrawals: [0n, 0],
    });

    await expect(read()).resolves.toMatchObject({
      status: "open",
      channelId: CHANNEL_ID,
      depositMicro: 5_000_000,
      settledMicro: 2_000_000,
      uncommittedMicro: 3_000_000,
      pendingWithdrawalMicro: 0,
    });
    expect(storedReconcile).toHaveBeenCalledWith(CHANNEL_ID, {
      balance: "5000000",
      totalClaimed: "2000000",
    });
    expect(readContract.mock.calls.map(([a]) => (a as { functionName: string }).functionName))
      .not.toContain("refundNonce");
  });

  // A timed exit inside its delay window is the one state the caller has an
  // unfinished action in, so it outranks the balance still sitting behind it.
  it("calls a channel with a timed exit in flight closing", async () => {
    mockChainState({ channels: [5_000_000n, 0n], pendingWithdrawals: [4_000_000n, 1_700_000_000] });

    await expect(read()).resolves.toMatchObject({
      status: "closing",
      pendingWithdrawalMicro: 4_000_000,
    });
  });

  it("calls a channel the contract has emptied closed", async () => {
    mockChainState({ channels: [0n, 4_000_000n], pendingWithdrawals: [0n, 0] });

    await expect(read()).resolves.toMatchObject({
      status: "closed",
      depositMicro: 0,
      settledMicro: 4_000_000,
      uncommittedMicro: 0,
    });
  });

  // Nothing deposited and nothing claimed leaves the history ambiguous, but
  // the current chain figure is still authoritative: nothing is held now, so
  // the successful read takes a stale local deposit back to zero.
  it("reconciles a stale stored figure when the contract holds nothing", async () => {
    mockChainState({ channels: [0n, 0n], pendingWithdrawals: [0n, 0] });
    storedContext.mockResolvedValue({ balance: "1500000" });

    const report = await read();

    expect(report).toMatchObject({
      status: "unconfirmed",
      depositMicro: 0,
      settledMicro: 0,
      uncommittedMicro: 0,
    });
    expect(storedReconcile).toHaveBeenCalledWith(CHANNEL_ID, {
      balance: "0",
      totalClaimed: "0",
    });
  });

  it("reports unreadable rather than throwing on a chain this rail cannot read", async () => {
    mockChainState({});

    const report = await read({ network: "eip155:1" });

    expect(report.status).toBe("unreadable");
    expect(report.error?.code).toBe("x402_unsupported_network");
    expect(report).not.toHaveProperty("depositMicro");
    expect(report.error?.hint).toContain("The local channel record is kept");
    expect(report.error?.hint).not.toContain("the key stays connected");
  });

  // stamps a record whose balance counts a deposit this machine added
  // on its own authority. Reporting that silently, in the one case the chain
  // cannot correct it, is the dishonesty the stamp exists to remove.
  it("marks a fallback figure the store says nothing has confirmed", async () => {
    mockChainState({ throws: new Error("timeout") });
    storedContext.mockResolvedValue({ balance: "109000" });
    vi.mocked(x402ChannelBalanceUnreconciledAt).mockReturnValue(1_760_000_000_000);

    const report = await read();
    expect(report).toMatchObject({
      status: "unreadable",
      depositMicro: 109_000,
      balanceUnreconciledAt: 1_760_000_000_000,
    });
    expect(report.error?.code).toBe("x402_rpc_error");
    expect(report).not.toHaveProperty("settledMicro");
    expect(report).not.toHaveProperty("pendingWithdrawalMicro");
    expect(report).not.toHaveProperty("uncommittedMicro");
    expect(storedReconcile).not.toHaveBeenCalled();
  });

  it("never carries the stamp on a figure the contract itself supplied", async () => {
    mockChainState({ channels: [9_000n, 0n], pendingWithdrawals: [0n, 0] });
    vi.mocked(x402ChannelBalanceUnreconciledAt).mockReturnValue(1_760_000_000_000);

    const report = await read();

    expect(report).toMatchObject({ status: "open", depositMicro: 9_000 });
    expect(report).not.toHaveProperty("balanceUnreconciledAt");
    expect(storedContext).not.toHaveBeenCalled();
  });

  it("reads each channel on the network it was recorded on", async () => {
    const { createPublicClient } = mockChainState({ channels: [1n, 0n] });

    await read({ network: "eip155:137" });

    expect(createPublicClient).toHaveBeenCalledWith(
      expect.objectContaining({ chain: expect.objectContaining({ id: 137 }) })
    );
  });

  it("survives a channel store it cannot read, reporting no deposit at all", async () => {
    mockChainState({ throws: new Error("timeout") });
    storedContext.mockRejectedValue(new Error("x402-channels.json is not JSON"));

    const report = await read();

    expect(report.status).toBe("unreadable");
    expect(report).not.toHaveProperty("depositMicro");
  });
});

describe("x402ChannelControlledBy", () => {
  it("claims a channel the connected key opened, whatever the recorded case", () => {
    expect(x402ChannelControlledBy(channel(), PAYER.toUpperCase())).toBe(true);
  });

  it("disowns a channel another key opened", () => {
    expect(x402ChannelControlledBy(channel(), OTHER_PAYER)).toBe(false);
  });

  // Literally true, and the answer the row copy rests on: with no key here,
  // nothing on this machine can withdraw that channel.
  it("disowns every channel when no key is connected", () => {
    expect(x402ChannelControlledBy(channel(), null)).toBe(false);
    expect(x402ChannelControlledBy(channel(), undefined)).toBe(false);
  });
});

/**
 * The contract's third view, and the reporting posture's own copy. Both exist
 * because `finalizeWithdraw` sets `ws.amount = 0; ws.initiatedAt = 0` and
 * nothing resets `totalClaimed`, so the first two views cannot always say
 * whether a channel ever existed.
 */
describe("readX402ChannelOnChain — the refund counter and the read's own voice", () => {
  const read = (overrides: Partial<StoredX402ChannelMetadata> = {}) =>
    readX402ChannelOnChain({ channel: channel(overrides), configuredNetwork: "eip155:8453" });

  // A channel funded, never claimed, then cooperatively drained answers (0,0)
  // on both other views. The refund counter is the only surviving evidence the
  // contract ever held it, and it is what keeps that row off `unconfirmed`.
  it("calls a drained-but-never-claimed channel closed on the refund counter alone", async () => {
    mockChainState({ channels: [0n, 0n], pendingWithdrawals: [0n, 0], refundNonce: 3n });

    await expect(read()).resolves.toMatchObject({ status: "closed" });
  });

  // The pair already answered; a counter read that fails cannot unsay it, and
  // `unconfirmed` is the conservative reading of what they said.
  it("keeps the pair's verdict when the counter read itself fails", async () => {
    const readContract = vi.fn(({ functionName }: { functionName: string }) =>
      functionName === "refundNonce"
        ? Promise.reject(new Error("timeout"))
        : Promise.resolve(functionName === "channels" ? [0n, 0n] : [0n, 0])
    );
    vi.doMock("viem", () => ({
      createPublicClient: vi.fn().mockReturnValue({ readContract }),
      http: vi.fn(),
    }));

    const report = await read();

    expect(report.status).toBe("unconfirmed");
    expect(report).not.toHaveProperty("error");
  });

  // `hint` is text an agent relays to a human verbatim. The guard's copy tells
  // them their key "stays connected", which asserts a disconnect that a plain
  // `wallet balance` never attempted.
  it("never speaks in the disconnect guard's voice", async () => {
    mockChainState({ throws: new Error("timeout") });

    const report = await read();

    expect(report.error?.code).toBe("x402_rpc_error");
    const hint = report.error?.hint ?? "";
    expect(hint).not.toContain("the key stays connected");
    expect(hint).not.toContain("The x402 wallet is untouched");
    expect(hint).toContain("Nothing was read or changed.");
    expect(hint).toContain("The local channel record is kept");
    // The half both postures genuinely share survives.
    expect(hint).toContain("DVM_X402_RPC_URL");
  });
});
