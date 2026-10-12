import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";

const EVM_PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/** Return whether a value is a 0x-prefixed 32-byte secp256k1 secret scalar. */
export function isValidEvmPrivateKey(value: string): value is `0x${string}` {
  return (
    EVM_PRIVATE_KEY_RE.test(value) && secp256k1.utils.isValidSecretKey(hexToBytes(value.slice(2)))
  );
}
