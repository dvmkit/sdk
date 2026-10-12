import { describe, expect, it } from "vitest";

import { NwcError, parseNwcUri } from "../nwc";

describe("parseNwcUri", () => {
  const testSecret = "aabbccdd".repeat(8);
  const validUri = `nostr+walletconnect://abcd1234?relay=wss%3A%2F%2Frelay.example.com&secret=${testSecret}`;

  it("parses a valid NWC URI", () => {
    const conn = parseNwcUri(validUri);
    expect(conn.walletPubkey).toBe("abcd1234");
    expect(conn.relays).toEqual(["wss://relay.example.com"]);
    expect(Array.from(conn.secret)).toEqual([
      170, 187, 204, 221, 170, 187, 204, 221,
      170, 187, 204, 221, 170, 187, 204, 221,
      170, 187, 204, 221, 170, 187, 204, 221,
      170, 187, 204, 221, 170, 187, 204, 221,
    ]);
    expect(conn.clientPubkey).toBeTruthy();
  });

  it("keeps every relay when the URI lists more than one", () => {
    // NIP-47 allows `relay` to repeat; a wallet that lists two expects both to
    // be tried, so dropping all but the first would silently halve its uptime.
    const conn = parseNwcUri(
      "nostr+walletconnect://abcd1234?relay=wss%3A%2F%2Fone.example.com&relay=wss%3A%2F%2Ftwo.example.com" +
        `&secret=${testSecret}`
    );
    expect(conn.relays).toEqual(["wss://one.example.com", "wss://two.example.com"]);
  });

  it("rejects a secret that is not 32 bytes of hex", () => {
    // Without this the short secret reaches @noble and throws a raw curve error
    // instead of a connection-string diagnosis the user can act on.
    expect(() =>
      parseNwcUri("nostr+walletconnect://abcd1234?relay=wss%3A%2F%2Fr.example.com&secret=abcd")
    ).toThrow("64 hex characters");
  });

  it("throws on missing scheme", () => {
    expect(() => parseNwcUri("wss://bad")).toThrow(NwcError);
  });

  it("throws on missing relay", () => {
    expect(() =>
      parseNwcUri(
        `nostr+walletconnect://abcd1234?secret=${testSecret}`
      )
    ).toThrow("missing relay");
  });

  it("throws on missing secret", () => {
    expect(() =>
      parseNwcUri("nostr+walletconnect://abcd1234?relay=wss%3A%2F%2Frelay.example.com")
    ).toThrow("missing secret");
  });
});
