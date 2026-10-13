/**
 * The slice of the batch-settlement contract the caller side reads and writes.
 *
 * Upstream `@x402/evm` exports the deployment address but not an ABI for these
 * five entry points, so dvmkit declares them. They live here rather than beside
 * one caller because two surfaces read the same views: the caller CLI's
 * withdrawal verbs, which live in its own repository, and `lifecycle.ts`, which
 * both proves a channel is empty before the key that controls it can be replaced
 * or removed and reports what the contract holds for it to
 * `dvm wallet balance`.
 * Two copies of a `channels` tuple is exactly the drift that would let the
 * preflight read a stale shape and clear a channel that still holds funds.
 */

/** The immutable channel tuple, as the contract's function inputs spell it. */
export const X402_CHANNEL_CONFIG_COMPONENTS = [
  { name: "payer", type: "address" },
  { name: "payerAuthorizer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "receiverAuthorizer", type: "address" },
  { name: "token", type: "address" },
  { name: "withdrawDelay", type: "uint40" },
  { name: "salt", type: "bytes32" },
] as const;

/**
 * The payer's two timed-exit calls, their exact-result events, and the three
 * views that say what a channel currently holds: `channels` → `(balance,
 * totalClaimed)`, `pendingWithdrawals` → `(amount, initiatedAt)`, and
 * `refundNonce` → the monotonic count of cooperative refunds.
 *
 * `refundNonce` is here for the reporting read alone. The contract
 * zeroes `pendingWithdrawals` on `finalizeWithdraw` and never resets
 * `totalClaimed`, so a channel that was funded, never claimed, and then
 * cooperatively drained reads `(0, 0)` on both other views — identical to one
 * that never existed. The refund counter is the surviving evidence that it did.
 */
export const X402_BATCH_CHANNEL_ABI = [
  {
    type: "function",
    name: "initiateWithdraw",
    inputs: [
      { name: "config", type: "tuple", components: X402_CHANNEL_CONFIG_COMPONENTS },
      { name: "amount", type: "uint128" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "finalizeWithdraw",
    inputs: [{ name: "config", type: "tuple", components: X402_CHANNEL_CONFIG_COMPONENTS }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "channels",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      { name: "balance", type: "uint128" },
      { name: "totalClaimed", type: "uint128" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingWithdrawals",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      { name: "amount", type: "uint128" },
      { name: "initiatedAt", type: "uint40" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "refundNonce",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "WithdrawInitiated",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
      { name: "finalizeAfter", type: "uint40", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WithdrawFinalized",
    inputs: [
      { name: "channelId", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount", type: "uint128", indexed: false },
    ],
  },
] as const;
