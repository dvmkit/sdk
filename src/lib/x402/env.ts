import { isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const X402_SELF_RELAY_KEY = "DVMKIT_X402_SELF_RELAY_KEY";
export const X402_RECEIVER_AUTHORIZER_KEY = "DVMKIT_X402_RECEIVER_AUTHORIZER_KEY";
export const X402_BATCH_SETTLEMENT_KEY = "DVMKIT_X402_BATCH_SETTLEMENT";
export const X402_RPC_URL_KEY = "DVMKIT_X402_RPC_URL";
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** Public addresses derived from x402 private keys present in an environment patch. */
export interface X402DerivedAddresses {
  relay?: `0x${string}`;
  authorizer?: `0x${string}`;
}

export interface X402EnvValidationOptions {
  /** Require a key-rotation patch to carry every value needed for proof. */
  requireCompleteBundle?: boolean;
  /** Expected public relay address supplied by the operator's credential record. */
  expectedRelay?: string;
  /** Expected public receiver-authorizer address supplied by the operator's credential record. */
  expectedAuthorizer?: string;
}

/** Safe validation failure which names variables and public addresses, never private values. */
export class X402EnvValidationError extends Error {
  constructor(

    public readonly code: string,
    /** Environment variable whose value or dependency failed validation. */
    public readonly variable: string,
    message: string,
    /** Expected public address, when the failure was an address mismatch. */
    public readonly expectedAddress?: string
  ) {
    super(message);
    this.name = "X402EnvValidationError";
  }
}

/**
 * Validate the x402 private-key and self-relay environment contract.
 *
 * `env` may be the complete SDK environment or a write-only CLI patch. A patch
 * that rotates either private key must include the complete bundle: remote
 * secret names cannot prove boolean values or key distinctness.
 */
export function validateX402Env(
  env: Record<string, string | undefined>,
  opts: X402EnvValidationOptions = {}
): X402DerivedAddresses {
  const relayKey = env[X402_SELF_RELAY_KEY];
  const authorizerKey = env[X402_RECEIVER_AUTHORIZER_KEY];
  const hasRelayKey = relayKey !== undefined;
  const hasAuthorizerKey = authorizerKey !== undefined;
  const relay = hasRelayKey ? derive(X402_SELF_RELAY_KEY, relayKey) : undefined;
  const authorizer = hasAuthorizerKey
    ? derive(X402_RECEIVER_AUTHORIZER_KEY, authorizerKey)
    : undefined;

  const completeWrite = opts.requireCompleteBundle === true && (hasRelayKey || hasAuthorizerKey);
  if (hasRelayKey || completeWrite) {
    if (env[X402_BATCH_SETTLEMENT_KEY] !== "true") {
      fail(
        "x402_bundle_incomplete",
        hasRelayKey ? X402_SELF_RELAY_KEY : X402_RECEIVER_AUTHORIZER_KEY,
        `Changing either x402 private key requires ${X402_BATCH_SETTLEMENT_KEY}=true in the same write.`
      );
    }
    if (!env[X402_RPC_URL_KEY]?.trim()) {
      fail(
        "x402_bundle_incomplete",
        hasRelayKey ? X402_SELF_RELAY_KEY : X402_RECEIVER_AUTHORIZER_KEY,
        `Changing either x402 private key requires an explicit ${X402_RPC_URL_KEY} in the same write.`
      );
    }
    if (!hasAuthorizerKey || (completeWrite && !hasRelayKey)) {
      if (!completeWrite && !hasAuthorizerKey) {
        fail(
          "x402_bundle_incomplete",
          X402_RECEIVER_AUTHORIZER_KEY,
          `${X402_SELF_RELAY_KEY} requires ${X402_RECEIVER_AUTHORIZER_KEY}.`
        );
      }
      fail(
        "x402_bundle_incomplete",
        hasRelayKey ? X402_RECEIVER_AUTHORIZER_KEY : X402_SELF_RELAY_KEY,
        `Changing either x402 private key requires both ${X402_SELF_RELAY_KEY} and ${X402_RECEIVER_AUTHORIZER_KEY} in the same write.`
      );
    }
  }

  if (hasRelayKey && relayKey.toLowerCase() === authorizerKey?.toLowerCase()) {
    fail(
      "x402_key_reuse",
      X402_SELF_RELAY_KEY,
      `${X402_SELF_RELAY_KEY} and ${X402_RECEIVER_AUTHORIZER_KEY} must use different private keys.`
    );
  }

  assertExpectation(X402_SELF_RELAY_KEY, relay, opts.expectedRelay);
  assertExpectation(X402_RECEIVER_AUTHORIZER_KEY, authorizer, opts.expectedAuthorizer);
  return { ...(relay ? { relay } : {}), ...(authorizer ? { authorizer } : {}) };
}

function derive(variable: string, key: string): `0x${string}` {
  if (!PRIVATE_KEY_RE.test(key)) {
    fail(
      "invalid_x402_private_key",
      variable,
      `${variable} must be a 0x-prefixed 32-byte hex secp256k1 private key.`
    );
  }
  try {
    return privateKeyToAccount(key as `0x${string}`).address;
  } catch {
    fail(
      "invalid_x402_private_key",
      variable,
      `${variable} must be a valid secp256k1 private key.`
    );
  }
}

function assertExpectation(
  variable: string,
  actual: string | undefined,
  expected: string | undefined
): void {
  if (expected === undefined) return;
  if (!isAddress(expected, { strict: false })) {
    fail(
      "invalid_x402_expected_address",
      variable,
      `Expected address for ${variable} must be a 0x-prefixed 20-byte EVM address.`
    );
  }
  if (actual?.toLowerCase() !== expected.toLowerCase()) {
    fail(
      "x402_address_mismatch",
      variable,
      `${variable} derives to a different public address than expected ${expected}.`,
      expected
    );
  }
}

function fail(code: string, variable: string, message: string, expectedAddress?: string): never {
  throw new X402EnvValidationError(code, variable, message, expectedAddress);
}
