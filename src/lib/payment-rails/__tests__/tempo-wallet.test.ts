import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { redactUrl } from "../../url-redact";

// Sandbox `config.json` to a fresh dir per test by redirecting
// `DVM_CONFIG_DIR` and re-importing the modules that resolve it at module-eval
// time. `DVM_CONFIG_DIR` rather than HOME: the whole run already has
// a `DVM_CONFIG_DIR` sandbox, and the more specific var wins over `homedir()` —
// so overriding HOME alone would silently land every test in the shared
// run-level dir, and the "no config exists" cases would see a neighbouring
// suite's leftovers.
describe("tempo-wallet", () => {
  let originalConfigDir: string | undefined;
  let tmpConfigDir: string;

  beforeEach(() => {
    originalConfigDir = process.env.DVM_CONFIG_DIR;
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dvm-tempo-wallet-tempo-"));
    process.env.DVM_CONFIG_DIR = tmpConfigDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.DVM_CONFIG_DIR;
    else process.env.DVM_CONFIG_DIR = originalConfigDir;
    rmSync(tmpConfigDir, { recursive: true, force: true });
    vi.resetModules();
    // Unconditional, so a failed assertion in a gate case can't leak its
    // `tempo-lifecycle` stand-in into the tests after it. `resetModules` clears
    // the module registry but leaves `doMock` registrations standing.
    vi.doUnmock("../tempo-lifecycle");
  });

  it("deriveTempoAddress is deterministic for a known key", async () => {
    const { deriveTempoAddress } = await import("../tempo-wallet");
    const pk = ("0x" + "a".repeat(64)) as `0x${string}`;
    expect(await deriveTempoAddress(pk)).toBe("0x8fd379246834eac74b8419ffda202cf8051f7a03");
  });

  it("refuses an out-of-range scalar before deriving an address", async () => {
    const { deriveTempoAddress } = await import("../tempo-wallet");

    await expect(deriveTempoAddress(`0x${"0".repeat(64)}` as `0x${string}`)).rejects.toMatchObject({
      code: "invalid_api_key",
    });
  });
});

// every surface that names the Tempo settlement asset resolves it
// here, so a caller running with DVM_TEMPO_CURRENCY set never reads copy
// that contradicts the contract their wallet is pointed at.
describe("resolveTempoAsset", () => {

  it("refuses to call a caller override USDC.e", async () => {
    const { resolveTempoAsset } = await import("../tempo-wallet");
    const other = "0x" + "1".repeat(40);
    const asset = resolveTempoAsset({ DVM_TEMPO_CURRENCY: other });
    expect(asset.symbol).toBeNull();
    expect(asset.address).toBe(other);
    expect(asset.label).toContain("0x1111…1111");
    expect(asset.label).not.toContain("USDC");
    expect(asset.unit).not.toContain("USDC");
  });

  // the server's DVMKIT_TEMPO_CURRENCY is a different audience's
  // variable and was cut over with no alias, so it must not be read here — a
  // re-introduced fallback would silently point a caller at a DVM's asset.
  it("ignores the server-side DVMKIT_TEMPO_CURRENCY", async () => {
    const { resolveTempoAsset } = await import("../tempo-wallet");
    const asset = resolveTempoAsset({ DVMKIT_TEMPO_CURRENCY: "0x" + "3".repeat(40) });
    expect(asset.symbol).toBe("USDC.e");
    expect(asset.label).toBe("USDC.e");
    expect(asset.unit).toBe("USDC.e");
    expect(asset.address.toLowerCase()).toBe("0x20c000000000000000000000b9537d11c60e8b50");
  });

  it("rejects a non-address override", async () => {
    const { resolveTempoAsset } = await import("../tempo-wallet");
    expect(() => resolveTempoAsset({ DVM_TEMPO_CURRENCY: "USDT0" })).toThrow(
      expect.objectContaining({ code: "tempo_config_invalid" })
    );
  });

  it("tryResolveTempoAsset returns null on a bad override instead of throwing", async () => {
    const { tryResolveTempoAsset } = await import("../tempo-wallet");
    expect(tryResolveTempoAsset({ DVM_TEMPO_CURRENCY: "USDT0" })).toBeNull();
    expect(tryResolveTempoAsset({})?.symbol).toBe("USDC.e");
  });
});

describe("getTempoUsdcBalance", () => {
  const ACCOUNT = {
    address: ("0x" + "9".repeat(40)) as `0x${string}`,
    privateKey: ("0x" + "a".repeat(64)) as `0x${string}`,
  };
  const savedRpcUrl = process.env.DVM_TEMPO_RPC_URL;

  /** Stub viem's client, keeping the `http` spy so the transport's endpoint is assertable. */
  function mockViem(readContract: () => Promise<bigint>) {
    const http = vi.fn(() => "transport");
    vi.doMock("viem", async (orig) => {
      const real = (await orig()) as Record<string, unknown>;
      return { ...real, createPublicClient: () => ({ readContract }), http };
    });
    return { http };
  }

  /** Drive a failing read to its `DvmError`, so each case can assert on the copy. */
  async function failingRead(
    message: string
  ): Promise<{ code: string; message: string; hint: string }> {
    mockViem(async () => {
      throw new Error(message);
    });
    const { getTempoUsdcBalance } = await import("../tempo-wallet");
    // Rejection captured rather than caught: an `expect.unreachable` inside a
    // `catch` lands in that same `catch`, so a read that wrongly succeeded
    // would fail on the `code` assertion instead of saying it never threw.
    const caught = await getTempoUsdcBalance(ACCOUNT).then(
      () => null,
      (err: unknown) => err as { code: string; message: string; hint?: string }
    );
    if (!caught) expect.unreachable("getTempoUsdcBalance resolved; expected a tempo_rpc_error");
    expect(caught.code).toBe("tempo_rpc_error");
    return { code: caught.code, message: caught.message, hint: caught.hint ?? "" };
  }

  beforeEach(() => {
    delete process.env.DVM_TEMPO_RPC_URL;
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("viem");
    if (savedRpcUrl === undefined) delete process.env.DVM_TEMPO_RPC_URL;
    else process.env.DVM_TEMPO_RPC_URL = savedRpcUrl;
  });

  it("converts raw base units to USDC and returns chain metadata", async () => {
    const readContract = vi.fn().mockResolvedValue(1_500_000n);
    mockViem(readContract);
    const { getTempoUsdcBalance } = await import("../tempo-wallet");
    const { tempo } = await import("viem/chains");
    const balance = await getTempoUsdcBalance(ACCOUNT);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: "0x20C000000000000000000000b9537d11c60E8b50",
      functionName: "balanceOf", args: [ACCOUNT.address],
    }));
    expect(balance.rawBaseUnits).toBe(1_500_000n);
    expect(balance.usdc).toBe(1.5);
    expect(balance.chainId).toBe(4217);
    expect(balance.tokenAddress.toLowerCase()).toBe("0x20c000000000000000000000b9537d11c60e8b50");
    // the endpoint travels with the number, so a balance surface can
    // say where it came from rather than leaving a wrong-endpoint read to pass
    // as a plausible $0.00.
    expect(balance.rpcUrlRedacted).toBe(redactUrl(tempo.rpcUrls.default.http[0]));
    expect(balance.rpcSource).toBe("bundled");
  });

  it("hands the success path a masked endpoint, never the caller's key", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    process.env.DVM_TEMPO_RPC_URL = `https://tempo-mainnet.example-provider.io/v3/${key}`;
    mockViem(async () => 1_000_000n);
    const { getTempoUsdcBalance } = await import("../tempo-wallet");

    const balance = await getTempoUsdcBalance(ACCOUNT);

    expect(balance.rpcUrlRedacted).toBe("https://tempo-mainnet.example-provider.io/v3/:hex");
    expect(balance.rpcUrlRedacted).not.toContain(key);
  });

  it("sends the read to DVM_TEMPO_RPC_URL when one is set", async () => {
    process.env.DVM_TEMPO_RPC_URL = "https://tempo.example/rpc";
    const { http } = mockViem(async () => 1_000_000n);
    const { getTempoUsdcBalance } = await import("../tempo-wallet");

    const balance = await getTempoUsdcBalance(ACCOUNT);

    expect(http).toHaveBeenCalledWith("https://tempo.example/rpc");
    expect(balance.rpcUrlRedacted).toBe("https://tempo.example/rpc");
    expect(balance.rpcSource).toBe("override");
  });

  it("treats an empty override as unset rather than an unusable endpoint", async () => {
    process.env.DVM_TEMPO_RPC_URL = "   ";
    const { http } = mockViem(async () => 1_000_000n);
    const { tempo } = await import("viem/chains");
    const { getTempoUsdcBalance } = await import("../tempo-wallet");

    const balance = await getTempoUsdcBalance(ACCOUNT);

    expect(http).toHaveBeenCalledWith(tempo.rpcUrls.default.http[0]);
    expect(balance.rpcSource).toBe("bundled");
  });

  // The output exists to be relayed onward by an agent, and provider RPC URLs
  // put the API key in the path — so neither half may carry one.
  it("masks the API key in a provider endpoint, in the hint and the message alike", async () => {
    const key = "0123456789abcdef0123456789abcdef";
    process.env.DVM_TEMPO_RPC_URL = `https://tempo-mainnet.example-provider.io/v3/${key}`;

    // viem restates the endpoint inside its own error text, so redacting only
    // the URL we resolved would leave a second copy of the key in the message.
    const err = await failingRead(
      `HTTP request failed.\n\nStatus: 429\nURL: https://tempo-mainnet.example-provider.io/v3/${key}`
    );

    expect(err.hint).toContain("https://tempo-mainnet.example-provider.io/v3/:hex");
    expect(err.hint).not.toContain(key);
    expect(err.message).toContain("https://tempo-mainnet.example-provider.io/v3/:hex");
    expect(err.message).not.toContain(key);
  });

  it("tells a caller who set the override to correct it, not to set it again", async () => {
    process.env.DVM_TEMPO_RPC_URL = "https://tempo.example/rpc";

    const err = await failingRead("HTTP request failed: 429 Too Many Requests");

    expect(err.hint).toContain("https://tempo.example/rpc");
    expect(err.hint).toContain("Correct it, or unset it");
  });

  it("tells a caller who set no override where the read went and how to move it", async () => {
    const { tempo } = await import("viem/chains");

    const err = await failingRead("network down");

    expect(err.message).toContain("network down");
    expect(err.hint).toContain("bundled endpoint");
    expect(err.hint).toContain(new URL(tempo.rpcUrls.default.http[0]).origin);
    expect(err.hint).toContain("DVM_TEMPO_RPC_URL");
    expect(err.hint).not.toContain("Correct it");
  });
});
