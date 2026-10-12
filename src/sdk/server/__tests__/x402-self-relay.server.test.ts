import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { servedApps } from "../../../test-support/served-app";
import { X402RelaySubmissionLockError } from "../x402-channel-store";
import {
  createX402SelfRelay,
  createX402SelfRelaySigner,
  type X402SelfRelaySignerBackend,
} from "../x402-self-relay";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const CONTRACT = "0x2222222222222222222222222222222222222222" as const;
const HASH = `0x${"33".repeat(32)}` as const;

function backend(): X402SelfRelaySignerBackend {
  return {
    address: ADDRESS,
    readContract: vi.fn(async () => 7n),
    verifyTypedData: vi.fn(async () => true),
    writeContract: vi.fn(async () => HASH),
    sendTransaction: vi.fn(async () => HASH),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: "success",
      logs: []
    })),
    getCode: vi.fn(async () => "0x1234" as const)
  };
}

const servers = servedApps();

/** A stub JSON-RPC endpoint, retired with the rest of the suite's servers. */
async function rpcServer(status: number, body: string): Promise<string> {
  const server = servers.track(
    createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    })
  );
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("RPC test server has no port");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("x402 self-relay signer", () => {
  it("registers a local Base-mainnet batch facilitator without an RPC round trip", async () => {
    const relay = createX402SelfRelay({
      network: "eip155:8453",
      config: {
        privateKey: `0x${"11".repeat(32)}`,
        rpcUrl: "https://base.example.invalid"
      }
    });

    await expect(relay.client.getSupported()).resolves.toMatchObject({
      kinds: [{ x402Version: 2, scheme: "batch-settlement", network: "eip155:8453" }],
      signers: { "eip155:*": [relay.address] }
    });
    relay.stop();
  });

  it.each([
    [401, "authentication"],
    [429, "rate_limit"],
  ] as const)(
    "reports HTTP %s without logging the credential-bearing URL",
    async (status, reason) => {
      const url = await rpcServer(status, JSON.stringify({ error: reason }));
      const secret = "secret-client-key";
      const onRpcHealth = vi.fn().mockResolvedValue(undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const relay = createX402SelfRelay({
      network: "eip155:8453",
      config: {
        privateKey: `0x${"11".repeat(32)}`,
        rpcUrl: `${url}/rpc/v1/base/${secret}`,
        onRpcHealth
      }
    });

      try {
        await expect(relay.checkBalance()).rejects.toBeDefined();
        expect(onRpcHealth).toHaveBeenCalledWith(
          expect.objectContaining({ status: "failed", reason })
        );
        const logs = warn.mock.calls.flat().join("\n");
        expect(logs).toContain('"event":"x402_self_relay_rpc_failed"');
        expect(logs).not.toContain(secret);
        expect(logs).not.toContain(url);
      } finally {
        relay.stop();
        warn.mockRestore();
        await servers.closeAll();
      }
    }
  );

  it("reports a transport failure without logging the credential-bearing URL", async () => {
    const url = await rpcServer(200, "{}");
    await servers.closeAll();
    const secret = "secret-client-key";
    const onRpcHealth = vi.fn().mockResolvedValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const relay = createX402SelfRelay({
      network: "eip155:8453",
      config: {
        privateKey: `0x${"11".repeat(32)}`,
        rpcUrl: `${url}/rpc/v1/base/${secret}`,
        onRpcHealth
      }
    });

    try {
      await expect(relay.checkBalance()).rejects.toBeDefined();
      expect(onRpcHealth).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", reason: "transport" }));
      const logs = warn.mock.calls.flat().join("\n");
      expect(logs).not.toContain('"reason":"transport"');
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain(url);
    } finally {
      relay.stop();
      warn.mockRestore();
    }
  });

  it("clears an RPC alert only after a successful Base read", async () => {
    const url = await rpcServer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2" }));
    const onRpcHealth = vi.fn().mockResolvedValue(undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const relay = createX402SelfRelay({
      network: "eip155:8453",
      config: {
        privateKey: `0x${"11".repeat(32)}`,
        rpcUrl: `${url}/rpc/v1/base/secret-client-key`,
        onRpcHealth
      }
    });

    try {
      await expect(relay.checkBalance()).resolves.toMatchObject({
        balanceWei: 2n
      });
      expect(onRpcHealth).toHaveBeenCalledWith(expect.objectContaining({ status: "healthy", network: "eip155:8453" }));
    } finally {
      relay.stop();
      info.mockRestore();
      await servers.closeAll();
    }
  });

  it("delegates every facilitator operation and preserves the settlement gas limit", async () => {
    const wallet = backend();
    const signer = createX402SelfRelaySigner({
      backend: wallet,
      network: "eip155:8453"
    });
    const read = {
      address: CONTRACT,
      abi: [],
      functionName: "balanceOf",
      args: [ADDRESS]
    };
    const typed = {
      address: ADDRESS,
      domain: {},
      types: {},
      primaryType: "Voucher",
      message: {},
      signature: "0x12" as const
    };
    const write = {
      address: CONTRACT,
      abi: [],
      functionName: "settle",
      args: [],
      gas: 120_000n
    };
    const send = { to: CONTRACT, data: "0x1234" as const };

    expect(signer.getAddresses()).toEqual([ADDRESS]);
    await expect(signer.readContract(read)).resolves.toBe(7n);
    await expect(signer.verifyTypedData(typed)).resolves.toBe(true);
    await expect(signer.writeContract(write)).resolves.toBe(HASH);
    await expect(signer.sendTransaction(send)).resolves.toBe(HASH);
    await expect(signer.waitForTransactionReceipt({ hash: HASH })).resolves.toEqual({
      status: "success",
      logs: []
    });
    await expect(signer.getCode({ address: CONTRACT })).resolves.toBe("0x1234");

    expect(wallet.readContract).toHaveBeenCalledWith(read);
    expect(wallet.verifyTypedData).toHaveBeenCalledWith(typed);
    expect(wallet.writeContract).toHaveBeenCalledWith(write);
    expect(wallet.sendTransaction).toHaveBeenCalledWith(send);
    expect(wallet.waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: HASH
    });
    expect(wallet.getCode).toHaveBeenCalledWith({ address: CONTRACT });
  });

  it("serializes transaction submissions from one process", async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const wallet = backend();
    wallet.writeContract = vi.fn(async () => {
      await firstPending;
      return HASH;
    });
    const signer = createX402SelfRelaySigner({
      backend: wallet,
      network: "eip155:8453"
    });

    const first = signer.writeContract({
      address: CONTRACT,
      abi: [],
      functionName: "settle",
      args: [],
      gas: 120_000n
    });
    const second = signer.sendTransaction({ to: CONTRACT, data: "0x1234" });
    await Promise.resolve();
    await Promise.resolve();

    expect(wallet.writeContract).toHaveBeenCalledOnce();
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([HASH, HASH]);
    expect(wallet.sendTransaction).toHaveBeenCalledOnce();
  });

  // `lock_timeout` bounds one acquire, so a queue that each started a
  // fresh wait would cost N × the ceiling — with every queued caller holding a
  // host-pool client and a channel advisory lock for its whole turn.
  it("hands a lock refusal to everyone already queued instead of re-waiting", async () => {
    const wallet = backend();
    let acquires = 0;
    let refuse = true;
    const submissionLock = {
      withRelaySubmissionLock: async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
        acquires += 1;
        if (refuse) throw new X402RelaySubmissionLockError(key, 30_000, { pid: 4242 });
        return operation();
      }
    };
    const signer = createX402SelfRelaySigner({
      backend: wallet,
      network: "eip155:8453",
      submissionLock
    });

    const queued = [
      signer.sendTransaction({ to: CONTRACT, data: "0x01" }),
      signer.sendTransaction({ to: CONTRACT, data: "0x02" }),
      signer.sendTransaction({ to: CONTRACT, data: "0x03" })
    ];
    const settled = await Promise.allSettled(queued);

    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    for (const result of settled) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(X402RelaySubmissionLockError);
    }
    // One wait, not three — the two behind the refusal inherited it.
    expect(acquires).toBe(1);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();

    // A caller arriving after the refusal took its own snapshot, so the lock
    // recovers with no prober and no cooldown.
    refuse = false;
    await expect(signer.sendTransaction({ to: CONTRACT, data: "0x04" })).resolves.toBe(HASH);
    expect(acquires).toBe(2);
  });
});
