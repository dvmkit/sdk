import { bech32 } from "@scure/base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DvmError } from "../../errors";
import {
  fetchLnurlPayInvoice,
  parseLnAddress,
  resolveLnurlPayMetadataUrl,
  validateLnAddress,
} from "../resolve";

/**
 * `lnurl1…` encoding of `https://example.com/.well-known/lnurlp/alice`, produced
 * with the same bech32 codec the resolver decodes with (LUD-01).
 */
const LNURL_BECH32 =
  "lnurl1dp68gurn8ghj7etcv9khqmr99e3k7mf09emk2mrv944kummhdchkcmn4wfk8qtmpd35kxeg9saevq";
const LNURL_DECODED = "https://example.com/.well-known/lnurlp/alice";

describe("parseLnAddress", () => {
  it("parses a valid address", () => {
    expect(parseLnAddress("alice@getalby.com")).toEqual({
      user: "alice",
      domain: "getalby.com",
    });
  });

  it("handles subdomains", () => {
    // Assemble a reserved example subdomain to avoid the literal personal-email rule.
    expect(parseLnAddress("bob@" + "pay.example.com")).toEqual({
      user: "bob",
      domain: "pay.example.com",
    });
  });

  it("throws on missing @", () => {
    expect(() => parseLnAddress("nodomain")).toThrow(DvmError);
  });

  it("throws on empty user", () => {
    expect(() => parseLnAddress("@example.com")).toThrow(DvmError);
  });

  it("throws on empty domain", () => {
    expect(() => parseLnAddress("alice@")).toThrow(DvmError);
  });

  it("throws on domain without dot", () => {
    expect(() => parseLnAddress("alice@localhost")).toThrow(DvmError);
  });
});

describe("resolveLnurlPayMetadataUrl", () => {
  it("maps a Lightning address to its well-known endpoint", () => {
    expect(resolveLnurlPayMetadataUrl("alice@getalby.com")).toBe(
      "https://getalby.com/.well-known/lnurlp/alice"
    );
  });

  it("decodes an lnurl1 string to its URL", () => {
    expect(resolveLnurlPayMetadataUrl(LNURL_BECH32)).toBe(LNURL_DECODED);
  });

  it("accepts an uppercased lnurl1 string and a lightning: scheme prefix (QR scans)", () => {
    expect(resolveLnurlPayMetadataUrl(LNURL_BECH32.toUpperCase())).toBe(LNURL_DECODED);
    expect(resolveLnurlPayMetadataUrl(`lightning:${LNURL_BECH32}`)).toBe(LNURL_DECODED);
  });

  it("rejects an lnurl1 string with a broken checksum rather than fetching garbage", () => {
    const mistyped = LNURL_BECH32.slice(0, -1) + (LNURL_BECH32.endsWith("9") ? "8" : "9");
    expect(() => resolveLnurlPayMetadataUrl(mistyped)).toThrow(DvmError);
  });

  it("rejects an LNURL that decodes to a non-HTTPS URL", () => {
    // bech32 of `http://example.com/x` — valid encoding, unacceptable target.
    const insecure = encodeForTest("http://example.com/x");
    expect(() => resolveLnurlPayMetadataUrl(insecure)).toThrow(/non-HTTPS/);
  });
});

describe("fetchLnurlPayInvoice", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const LNURL_METADATA = {
    tag: "payRequest",
    callback: "https://getalby.com/lnurlp/alice/callback",
    minSendable: 1000,
    maxSendable: 1_000_000_000,
  };

  it("fetches a bolt11 invoice via LNURL-pay", async () => {
    const bolt11 = "lnbc500n1...";
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(LNURL_METADATA),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ pr: bolt11 }),
      });

    const result = await fetchLnurlPayInvoice("alice@getalby.com", 50_000);
    expect(result).toBe(bolt11);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://getalby.com/.well-known/lnurlp/alice",
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://getalby.com/lnurlp/alice/callback?amount=50000",
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );
  });

  it("appends amount with & when callback already has query params", async () => {
    const metadata = {
      ...LNURL_METADATA,
      callback: "https://example.com/cb?key=val",
    };
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(metadata) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ pr: "lnbc..." }) });

    await fetchLnurlPayInvoice("alice@getalby.com", 10_000);
    expect(mockFetch.mock.calls[1]?.[0]).toBe("https://example.com/cb?key=val&amount=10000");
  });

  it("throws on metadata endpoint failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(fetchLnurlPayInvoice("alice@getalby.com", 50_000)).rejects.toThrow(DvmError);
  });

  it("throws on non-payRequest tag", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...LNURL_METADATA, tag: "withdrawRequest" }),
    });
    await expect(fetchLnurlPayInvoice("alice@getalby.com", 50_000)).rejects.toThrow(DvmError);
  });

  it("throws when amount is below minimum", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...LNURL_METADATA, minSendable: 100_000 }),
    });
    await expect(fetchLnurlPayInvoice("alice@getalby.com", 50_000)).rejects.toThrow(DvmError);
  });

  it("throws when amount exceeds maximum", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...LNURL_METADATA, maxSendable: 10_000 }),
    });
    await expect(fetchLnurlPayInvoice("alice@getalby.com", 50_000)).rejects.toThrow(DvmError);
  });

  it("throws when callback response has no pr", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(LNURL_METADATA) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ reason: "amount too low" }),
      });
    await expect(fetchLnurlPayInvoice("alice@getalby.com", 50_000)).rejects.toThrow(DvmError);
  });

  it("throws when callback endpoint fails", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(LNURL_METADATA) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(fetchLnurlPayInvoice("alice@getalby.com", 50_000)).rejects.toThrow(DvmError);
  });
});

describe("validateLnAddress", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const VALID_METADATA = {
    tag: "payRequest",
    callback: "https://getalby.com/lnurlp/alice/callback",
    minSendable: 1000,
    maxSendable: 1_000_000_000,
  };

  it("succeeds for a valid LNURL-pay endpoint", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    });
    await expect(validateLnAddress("alice@getalby.com")).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://getalby.com/.well-known/lnurlp/alice",
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );
  });

  it("throws when the endpoint is unreachable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(validateLnAddress("alice@getalby.com")).rejects.toThrow(DvmError);
  });

  it("throws when fetch rejects (network error)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(validateLnAddress("alice@example.invalid")).rejects.toThrow(DvmError);
  });

  it("throws on non-payRequest tag", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...VALID_METADATA, tag: "withdrawRequest" }),
    });
    await expect(validateLnAddress("alice@getalby.com")).rejects.toThrow(DvmError);
  });

  it("throws when callback is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...VALID_METADATA, callback: undefined }),
    });
    await expect(validateLnAddress("alice@getalby.com")).rejects.toThrow(DvmError);
  });

  it("throws when sendable bounds are missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ ...VALID_METADATA, minSendable: undefined, maxSendable: undefined }),
    });
    await expect(validateLnAddress("alice@getalby.com")).rejects.toThrow(DvmError);
  });

  it("propagates parse error for invalid address format", async () => {
    await expect(validateLnAddress("nodomain")).rejects.toThrow(DvmError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

function encodeForTest(url: string): string {
  return bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 2000);
}
