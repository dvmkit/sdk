/**
 * A viem client that answers just enough JSON-RPC for mppx's real TIP-1034
 * session plan to run offline.
 *
 * The plan signs locally off the fixture key, so the only chain reads it needs
 * are the fee/nonce preamble and the escrow's channel state. Driving the real
 * plan is the point: `maxDeposit` is mppx's ceiling on how much collateral a
 * DVM's session challenge can make the caller's wallet commit, and a stubbed
 * plan would pin dvmkit's idea of that ceiling rather than mppx's.
 */

import { Session as TempoSession } from "mppx/tempo";
import { type Client, createClient, custom, encodeFunctionResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** On-chain channel state the stub escrow reports back. */
export interface StubChannelState {
  settled: bigint;
  deposit: bigint;
  closeRequestedAt: number;
}

/** Build the offline chain client mppx's session plan reads through. */
export function stubTempoSessionClient(args: {
  privateKey: `0x${string}`;
  chainId: number;
  channelState?: StubChannelState;
}): Client {
  const state = args.channelState ?? { settled: 0n, deposit: 0n, closeRequestedAt: 0 };
  return createClient({
    account: privateKeyToAccount(args.privateKey),
    chain: { id: args.chainId } as never,
    transport: custom({
      async request({ method }) {
        switch (method) {
          case "eth_chainId":
            return `0x${args.chainId.toString(16)}`;
          case "eth_getTransactionCount":
            return "0x0";
          case "eth_estimateGas":
            return "0x5208";
          case "eth_maxPriorityFeePerGas":
            return "0x1";
          case "eth_gasPrice":
            return "0x1";
          case "eth_blockNumber":
            return "0x1";
          case "eth_getBlockByNumber":
            return { baseFeePerGas: "0x1", number: "0x1", timestamp: "0x1" };
          case "eth_call":
            return encodeFunctionResult({
              abi: TempoSession.Precompile.escrowAbi,
              functionName: "getChannelState",
              result: state,
            });
          default:
            throw new Error(`unexpected rpc request: ${method}`);
        }
      },
    }),
  });
}
