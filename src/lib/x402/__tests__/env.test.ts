import { describe, expect, it } from "vitest";

import {
  validateX402Env,
  X402_RECEIVER_AUTHORIZER_KEY,
  X402_SELF_RELAY_KEY,
  X402EnvValidationError,
} from "../env";

const RELAY_KEY = `0x${"01".padStart(64, "0")}`;
const AUTHORIZER_KEY = `0x${"02".padStart(64, "0")}`;

describe("validateX402Env", () => {
  it("derives public addresses for a complete self-relay bundle", () => {
    const result = validateX402Env({
      [X402_SELF_RELAY_KEY]: RELAY_KEY,
      [X402_RECEIVER_AUTHORIZER_KEY]: AUTHORIZER_KEY,
      DVMKIT_X402_BATCH_SETTLEMENT: "true",
      DVMKIT_X402_RPC_URL: "https://rpc.example",
    });

    expect(result.relay).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(result.authorizer).toBe("0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF");
  });

  it("rejects a partial rotation even when the counterpart exists remotely", () => {
    expect(() =>
      validateX402Env(
        {
          [X402_SELF_RELAY_KEY]: RELAY_KEY,
          DVMKIT_X402_BATCH_SETTLEMENT: "true",
          DVMKIT_X402_RPC_URL: "https://rpc.example",
        },
        { requireCompleteBundle: true }
      )
    ).toThrow(/requires both/);
  });

  it("keeps a full SDK environment's signing-only authorizer valid", () => {
    expect(() => validateX402Env({ [X402_RECEIVER_AUTHORIZER_KEY]: AUTHORIZER_KEY })).not.toThrow();
  });

  it("rejects malformed keys without including their value", () => {
    const malformed = "0xprivate-material-must-not-leak";
    try {
      validateX402Env({ [X402_SELF_RELAY_KEY]: malformed });
      throw new Error("expected validation failure");
    } catch (err) {
      expect(err).toBeInstanceOf(X402EnvValidationError);
      expect(String(err)).not.toContain(malformed);
    }
  });

  it("rejects an incomplete or key-reused self-relay bundle", () => {
    expect(() => validateX402Env({ [X402_SELF_RELAY_KEY]: RELAY_KEY })).toThrow(
      /BATCH_SETTLEMENT=true/
    );
    expect(() =>
      validateX402Env({
        [X402_SELF_RELAY_KEY]: RELAY_KEY,
        [X402_RECEIVER_AUTHORIZER_KEY]: RELAY_KEY,
        DVMKIT_X402_BATCH_SETTLEMENT: "true",
        DVMKIT_X402_RPC_URL: "https://rpc.example",
      })
    ).toThrow(/must use different private keys/);
  });

  it("refuses an expectation mismatch using public addresses only", () => {
    expect(() =>
      validateX402Env(
        {
          [X402_SELF_RELAY_KEY]: RELAY_KEY,
          [X402_RECEIVER_AUTHORIZER_KEY]: AUTHORIZER_KEY,
          DVMKIT_X402_BATCH_SETTLEMENT: "true",
          DVMKIT_X402_RPC_URL: "https://rpc.example",
        },
        { expectedAuthorizer: "0x0000000000000000000000000000000000000001" }
      )
    ).toThrow(/different public address/);
  });
});
