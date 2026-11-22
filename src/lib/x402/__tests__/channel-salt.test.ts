import { describe, expect, it } from "vitest";

import { deriveLegacyX402ChannelSalt, deriveX402ChannelSalt } from "../channel-salt";

describe("x402 channel salt vectors", () => {
  const network = "eip155:84532";
  const payer = `0x${"Ab".repeat(20)}`;
  const endpoint = "https://EXAMPLE.com:443/v1/credit?test=1";

  it("hashes the attested identity with lowercase keys and the original DVM id", () => {
    expect(deriveX402ChannelSalt({
      network,
      payer,
      endpoint,
      identity: { builderPubkey: "Cd".repeat(32), dvmId: "Dvm-1" },
    })).toBe("0x4bddaaa8a4783f174601d1eef01502a6c3195017c45dd00f8cae90932716eba8");
  });

  it("hashes the normalized origin without an attestation", () => {
    expect(deriveX402ChannelSalt({ network, payer, endpoint }))
      .toBe("0x63123df2e68e6be6106585ad229e5575444633f4e0e0bc680fd55825a1eda253");
  });

  it("preserves the legacy salt", () => {
    expect(deriveLegacyX402ChannelSalt({ network, payer }))
      .toBe("0xd7226a47e4fc506b238a57390d76794077599dad2a40d3c0d263a29d142c137a");
  });
});
