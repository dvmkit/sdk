import { describe, expect, it } from "vitest";

import { redactPath, redactUrl, redactUrlsInText } from "../../lib/url-redact";

describe("redactUrl", () => {
  it("redacts sensitive URL components while preserving safe structure", () => {
    for (const [reason, url, expected] of [
      ["strips query strings", "https://api.example.com/users?token=secret&page=2", "https://api.example.com/users"],
      ["replaces UUID path segments", "https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000/profile", "https://api.example.com/users/:uuid/profile"],
      ["replaces long hex path segments (16+ chars)", "https://api.example.com/objects/a1b2c3d4e5f6a7b8c9d0", "https://api.example.com/objects/:hex"],
      ["replaces numeric IDs (4+ digits)", "https://api.example.com/orders/12345", "https://api.example.com/orders/:n"],
      ["does not replace short numbers (1-3 digits)", "https://api.example.com/v2/items/123", "https://api.example.com/v2/items/123"],
      ["replaces base58 strings (32+ chars)", "https://api.example.com/wallets/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa/balance", "https://api.example.com/wallets/:b58/balance"],
      ["preserves long low-entropy segments", `https://api.example.com/releases/${"ab_".repeat(11)}`, `https://api.example.com/releases/${"ab_".repeat(11)}`],
      ["handles mixed path segments", "https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000/orders/99999?session=abc", "https://api.example.com/users/:uuid/orders/:n"],
      ["preserves clean URLs with no sensitive segments", "https://api.example.com/v1/info", "https://api.example.com/v1/info"],
      ["handles URLs with no path", "https://api.example.com", "https://api.example.com/"],
      ["returns invalid URL strings as-is", "not-a-url", "not-a-url"],
      ["preserves the scheme and host", "http://localhost:8080/jobs/550e8400-e29b-41d4-a716-446655440000", "http://localhost:8080/jobs/:uuid"],
      ["handles trailing slash", "https://api.example.com/users/", "https://api.example.com/users/"],
    ] as const) {
      expect(redactUrl(url), reason).toBe(expected);
    }
  });

  it.each([
    [
      "Alchemy",
      "https://base-mainnet.g.alchemy.com/v2/aB0OcD1IeF2lgH3JkL4MnP5QrS6TuV7W",
      "https://base-mainnet.g.alchemy.com/v2/:token",
    ],
    [
      "QuickNode",
      "https://still-frosty-sun.base-mainnet.quiknode.pro/quicknode-Token-0123456789abcdef/",
      "https://still-frosty-sun.base-mainnet.quiknode.pro/:token/",
    ],
    [
      "Coinbase CDP",
      "https://api.developer.coinbase.com/rpc/v1/base/cdp_Base.Key~0123456789abcdefABCDEF",
      "https://api.developer.coinbase.com/rpc/v1/base/:token",
    ],
    [
      "Infura",
      "https://base-mainnet.infura.io/v3/0123456789abcdef0123456789abcdef",
      "https://base-mainnet.infura.io/v3/:hex",
    ],
  ])("redacts %s provider credentials carried in the path", (_provider, url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  it.each([
    ["standard base64", "aB0OcD1IeF2lgH3JkL4MnP5QrS6TuV+="],
    ["at-delimited", "tenant@aB0OcD1IeF2lgH3JkL4MnP5QrS6TuV"],
    ["percent-encoded", "aB0O%2FcD1I%2BeF2l%40gH3JkL4MnP5Q"],
  ])("redacts long varied segments using the %s path alphabet", (_shape, segment) => {
    expect(redactUrl(`https://api.example.com/rpc/${segment}`)).toBe(
      "https://api.example.com/rpc/:token"
    );
  });
});

describe("redactPath", () => {
  it("redacts UUID, hex, numeric, base58, and opaque token segments", () => {
    expect(redactPath("/v1/job/550e8400-e29b-41d4-a716-446655440000/messages")).toBe(
      "/v1/job/:uuid/messages"
    );
    expect(redactPath("/objects/a1b2c3d4e5f6a7b8c9d0")).toBe("/objects/:hex");
    expect(redactPath("/orders/12345")).toBe("/orders/:n");
    expect(redactPath("/wallets/1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa/balance")).toBe(
      "/wallets/:b58/balance"
    );
    expect(redactPath("/v2/aB0OcD1IeF2lgH3JkL4MnP5QrS6TuV7W")).toBe("/v2/:token");
  });

  it("preserves clean paths and short numbers", () => {
    expect(redactPath("/v1/info")).toBe("/v1/info");
    expect(redactPath("/v2/items/123")).toBe("/v2/items/123");
  });

  it("preserves leading slash and empty path segments", () => {
    expect(redactPath("/")).toBe("/");
    expect(redactPath("")).toBe("");
  });
});

describe("redactUrlsInText", () => {
  it("redacts every URL a library embedded in its own error text", () => {
    // The shape viem's transport errors take: the endpoint appears in a
    // labelled line the caller never passed in separately.
    const text = [
      "HTTP request failed.",
      "",
      "Status: 429",
      "URL: https://polygon-mainnet.infura.io/v3/0123456789abcdef0123456789abcdef",
      "Retry at https://api.example.com/orders/12345 later.",
    ].join("\n");

    const redacted = redactUrlsInText(text);

    expect(redacted).toContain("https://polygon-mainnet.infura.io/v3/:hex");
    expect(redacted).not.toContain("0123456789abcdef0123456789abcdef");
    // Trailing punctuation stays outside the URL rather than being eaten by it.
    expect(redacted).toContain("https://api.example.com/orders/:n later.");
    expect(redacted).toContain("Status: 429");
  });

  it("drops a query string wherever it appears in the text", () => {
    expect(redactUrlsInText("failed: https://rpc.example.com/v2?apiKey=secret")).toBe(
      "failed: https://rpc.example.com/v2"
    );
  });

  it("stops at the quoting around a URL", () => {
    expect(redactUrlsInText('{"url":"https://api.example.com/orders/12345"}')).toBe(
      '{"url":"https://api.example.com/orders/:n"}'
    );
  });

  it("leaves text with no URLs alone", () => {
    expect(redactUrlsInText("connection refused")).toBe("connection refused");
  });
});
