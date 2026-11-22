import { keccak256, toBytes } from "viem";

import type { AttestedDvmIdentity } from "../receipt-verify";
import { normalizeEndpoint } from "./channel-store";

export function deriveX402ChannelSalt(args: {
  network: string;
  payer: string;
  endpoint: string;
  identity?: AttestedDvmIdentity;
}): `0x${string}` {
  const scope = args.identity
    ? `dvm:${args.identity.builderPubkey.toLowerCase()}:${args.identity.dvmId}`
    : `origin:${normalizeEndpoint(args.endpoint)}`;
  return keccak256(toBytes(`dvmkit:x402-batch:v2:${args.network}:${args.payer.toLowerCase()}:${scope}`));
}

export function deriveLegacyX402ChannelSalt(args: {
  network: string;
  payer: string;
}): `0x${string}` {
  return keccak256(toBytes(`dvmkit:x402-batch:${args.network}:${args.payer.toLowerCase()}`));
}
