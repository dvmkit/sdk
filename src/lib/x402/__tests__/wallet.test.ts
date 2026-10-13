import { polygon } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DvmError } from "../../errors";
import { redactUrl } from "../../url-redact";
import { ensureAddress, getX402Balance } from "../wallet";

const GOOD_KEY = "0x" + "1".repeat(64);
const ADDR = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";

describe("ensureAddress", () => {
  it("refuses an out-of-range stored scalar before viem sees it", async () => {
    await expect(
      ensureAddress({
        privateKey: `0x${"0".repeat(64)}`,
        address: "",
        network: "eip155:8453",
      })
    ).rejects.toMatchObject({ code: "invalid_key" });
  });
});

describe("getX402Balance", () => {
  /** Stub viem, keeping the `http` spy so the transport's endpoint is assertable. */
  function mockViem(readContract: ReturnType<typeof vi.fn>) {
    const http = vi.fn(() => "transport");
    const createPublicClient = vi.fn().mockReturnValue({ readContract });
    vi.doMock("viem", () => ({ createPublicClient, http, erc20Abi: ["abi"] }));
    return { http, createPublicClient };
  }

  const savedRpcUrl = process.env.DVM_X402_RPC_URL;

  beforeEach(() => {
    delete process.env.DVM_X402_RPC_URL;
  });

  afterEach(() => {
    vi.doUnmock("viem");
    if (savedRpcUrl === undefined) delete process.env.DVM_X402_RPC_URL;
    else process.env.DVM_X402_RPC_URL = savedRpcUrl;
  });

  it("reads the configured chain's own contract, not Base's", async () => {
    const readContract = vi.fn().mockResolvedValue(2_500_000n);
    const { createPublicClient } = mockViem(readContract);

    const balance = await getX402Balance({
      privateKey: GOOD_KEY,
      address: ADDR,
      network: "eip155:137",
    });

    expect(balance.usdc).toBe(2.5);
    // Polygon's chain object and Polygon's USDC — the legacy code had no
    // Polygon chain at all and threw before it got here.
    expect(createPublicClient).toHaveBeenCalledWith(
      expect.objectContaining({ chain: expect.objectContaining({ id: 137 }) })
    );
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        args: [ADDR],
      })
    );
  });

  // viem's bundled defaults are shared and rate-limited, so a caller
  // who gets 429'd needs somewhere else to point the read.
  it("sends the read to DVM_X402_RPC_URL when one is set", async () => {
    process.env.DVM_X402_RPC_URL = "https://polygon.example/rpc";
    const { http } = mockViem(vi.fn().mockResolvedValue(1_000_000n));

    const balance = await getX402Balance({
      privateKey: GOOD_KEY,
      address: ADDR,
      network: "eip155:137",
    });

    expect(http).toHaveBeenCalledWith("https://polygon.example/rpc");
    // the success path carries the endpoint out too, so a balance
    // surface can say where a plausible number actually came from.
    expect(balance.rpcUrlRedacted).toBe("https://polygon.example/rpc");
    expect(balance.rpcSource).toBe("override");
  });

  it("treats an empty override as unset rather than an unusable endpoint", async () => {
    process.env.DVM_X402_RPC_URL = "   ";
    const { http } = mockViem(vi.fn().mockResolvedValue(1_000_000n));

    const balance = await getX402Balance({
      privateKey: GOOD_KEY,
      address: ADDR,
      network: "eip155:137",
    });

    expect(http).toHaveBeenCalledWith(polygon.rpcUrls.default.http[0]);
    // And it reports as the bundled default it is — an agent that read
    // "override" here would send the caller to fix a variable they never set.
    expect(balance.rpcSource).toBe("bundled");
    expect(balance.rpcUrlRedacted).toBe(redactUrl(polygon.rpcUrls.default.http[0]));
    expect(balance.network).toBe("eip155:137");
    expect(balance.tokenAddress).toBe("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
  });

  it("hands the success path a masked endpoint, never the caller's key", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    process.env.DVM_X402_RPC_URL = `https://polygon-mainnet.infura.io/v3/${key}`;
    mockViem(vi.fn().mockResolvedValue(1_000_000n));

    const balance = await getX402Balance({
      privateKey: GOOD_KEY,
      address: ADDR,
      network: "eip155:137",
    });

    expect(balance.rpcUrlRedacted).toBe("https://polygon-mainnet.infura.io/v3/:hex");
    expect(balance.rpcUrlRedacted).not.toContain(key);
  });

  /** Drive a failing read to its `DvmError`, so each case can assert on the copy. */
  async function failingRead(message: string): Promise<DvmError> {
    mockViem(vi.fn().mockRejectedValue(new Error(message)));
    try {
      await getX402Balance({ privateKey: GOOD_KEY, address: ADDR, network: "eip155:137" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DvmError);
      return err as DvmError;
    }
  }

  it("tells a caller who set the override to correct it, not to set it again", async () => {
    process.env.DVM_X402_RPC_URL = "https://polygon.example/rpc";

    const err = await failingRead("HTTP request failed: 429 Too Many Requests");

    // A distinct code is what keeps the doctor row off the "reinstall viem"
    // remedy — the rail is fine, the endpoint we picked isn't.
    expect(err.code).toBe("x402_rpc_error");
    expect(err.message).toContain("429 Too Many Requests");
    expect(err.message).toContain("Polygon");
    expect(err.hint).toContain("https://polygon.example/rpc");
    expect(err.hint).toContain("Correct it, or unset it");
  });

  it("tells a caller who set no override where the read went and how to move it", async () => {
    const err = await failingRead("HTTP request failed: 429 Too Many Requests");

    expect(err.code).toBe("x402_rpc_error");
    expect(err.hint).toContain("bundled endpoint");
    expect(err.hint).toContain("DVM_X402_RPC_URL");
    expect(err.hint).not.toContain("Correct it");
  });

  // The output exists to be relayed onward by an agent, and provider RPC URLs
  // put the API key in the path — so neither half may carry one.
  it("masks the API key in a provider endpoint, in the hint and the message alike", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    process.env.DVM_X402_RPC_URL = `https://polygon-mainnet.infura.io/v3/${key}`;

    // viem restates the endpoint inside its own error text, so redacting only
    // the URL we resolved would leave a second copy of the key in the message.
    const err = await failingRead(
      `HTTP request failed.\n\nStatus: 429\nURL: https://polygon-mainnet.infura.io/v3/${key}`
    );

    expect(err.hint).toContain("https://polygon-mainnet.infura.io/v3/:hex");
    expect(err.hint).not.toContain(key);
    expect(err.message).toContain("https://polygon-mainnet.infura.io/v3/:hex");
    expect(err.message).not.toContain(key);
  });

  it("throws a diagnosable error on a chain outside the table", async () => {
    try {
      await getX402Balance({ privateKey: GOOD_KEY, address: ADDR, network: "eip155:1" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DvmError);
      // The code is what lets `dvm doctor` say "this chain isn't supported"
      // rather than "the RPC didn't answer".
      expect((err as DvmError).code).toBe("x402_unsupported_network");
      expect((err as DvmError).message).toContain("eip155:1");
      expect((err as DvmError).hint).toContain("eip155:8453 (Base)");
      expect((err as DvmError).hint).toContain("dvm wallet x402-network eip155:8453");
      expect((err as DvmError).hint).not.toContain("--key-file");
    }
  });
});
