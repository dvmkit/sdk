/**
 * Key replacement and disconnect require chain proof that every owned channel
 * has neither collateral nor a pending withdrawal. Local metadata survives
 * drainage, so its presence alone cannot block key rotation. Pending signed
 * vouchers are guarded separately: a chain read cannot revoke their authority.
 *
 * Exits and reports follow each channel's recorded chain. Guards fail closed
 * when reads fail; reports retain the failure and continue with other rails.
 */

import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";

import { DvmError } from "../errors";
import { resolveRpcHttpTransportOptions, type RpcSource } from "../payment-rails/rpc";
import { redactUrl, redactUrlsInText } from "../url-redact";
import { X402_BATCH_CHANNEL_ABI } from "./batch-abi";
import { resolveX402ChannelRpc } from "./channel-rpc";
import {
  DvmX402ChannelStorage,
  type StoredX402ChannelMetadata,
  x402ChannelBalanceUnreconciledAt,
} from "./channel-store";
import { x402NetworkByCaip2, x402SupportedNetworksHint } from "./networks";

/**
 * Read authoritative collateral and withdrawal facts for a key-mutation guard.
 * Unsupported recorded chains and failed RPC reads throw; local projection
 * reconciliation remains best effort. Hold the channel lock across this read
 * and the config write it guards.
 */
export async function readX402ChannelGuardFacts(args: {
  channel: StoredX402ChannelMetadata;
  configuredNetwork: string;
  clients?: Map<string, X402ChannelClient>;
}): Promise<{ balance: bigint; pendingWithdrawal: bigint }> {
  const state = await readChannelState(
    args.channel,
    args.configuredNetwork,
    args.clients ?? new Map<string, X402ChannelClient>(),
    "guard"
  );
  return { balance: state.balance, pendingWithdrawal: state.pendingWithdrawal };
}

/**
 * Refuse a channel operation the connected key provably cannot perform.
 *
 * A batch channel pays out to the payer that opened it and to nobody else, so a
 * reconnect — `dvm wallet x402-connect` mints a fresh key when given no key
 * source — leaves every earlier channel controlled by a key the
 * config no longer holds. Naming that is the whole job: the alternative is a
 * derived channel id that never existed, which reads back as an empty channel
 * and gets reported as money the DVM already took.
 */
export function assertX402ChannelPayer(channel: StoredX402ChannelMetadata, address: string): void {
  if (channel.config.payer.toLowerCase() === address.toLowerCase()) return;
  throw new DvmError(
    "x402_wallet_mismatch",
    `The connected x402 wallet ${address} is not the payer recorded for the channel with ${channel.endpoint} — that channel was opened by ${channel.config.payer}.`,
    `Reconnect that exact key ('dvm wallet x402-connect --key-file <path>', or DVM_X402_KEY=<key> dvm wallet x402-connect), then retry. Nothing was signed or moved, and the channel's balance is untouched — only ${channel.config.payer} can move it.`,
    {
      anchor: "x402_channel_payer_mismatch",
      channel_id: channel.channelId,
      endpoint: channel.endpoint,
      network: channel.network,
      recorded_payer: channel.config.payer,
      connected_payer: address,
    }
  );
}

/**
 * What the settlement contract says about one recorded channel. `unreadable` is
 * this machine's own failure to ask, never the chain's answer.
 *
 * Deliberately the same five words the Tempo rail publishes for the same
 * question: an agent reading either rail's channel rows generically
 * must not need two vocabularies. What each word rests on differs, because the
 * two contracts account differently — see {@link readX402ChannelOnChain}.
 */
export type X402ChannelChainStatus = "open" | "closing" | "closed" | "unconfirmed" | "unreadable";

/**
 * A chain verdict on one recorded x402 channel, and the figures that go with
 * it.
 *
 * Every figure is USDC microunits as a `number` rather than the contract's
 * `uint128`, because these land straight in JSON output beside the Tempo rows'
 * own micro figures. Which of them are present depends on how much the chain
 * actually answered — see {@link readX402ChannelOnChain}.
 */
export interface X402ChannelChainReport {
  /** How the settlement contract classifies the channel this record names. */
  status: X402ChannelChainStatus;
  /** The channel the verdict is about. */
  channelId: string;
  /**
   * Escrow held against this channel: the contract's own figure, or under
   * `unconfirmed` / `unreadable` the caller's stored one. Absent only when
   * neither exists.
   */
  depositMicro?: number;
  /** Cumulative value the DVM has claimed out of that escrow. Absent under `unreadable`. */
  settledMicro?: number;
  /** Escrow no claim has reached yet, before any voucher already signed. Absent under `unreadable`. */
  uncommittedMicro?: number;
  /** Value in an initiated but unfinalized timed withdrawal. Absent under `unreadable`. */
  pendingWithdrawalMicro?: number;
  /**
   * When the stored figure this row fell back to last took a local or
   * DVM-reported balance that the chain has not confirmed since. Present only
   * when the reported deposit came from the record
   * rather than the contract, because a successful chain read settles the
   * question and clears the stamp.
   */
  balanceUnreconciledAt?: number;
  /** Why the chain could not be read — redacted, and present only on `unreadable`. */
  error?: DvmError;
}

/** The three contract views this module reads, narrowed so no caller can grow a broadcast. */
export interface X402ChannelClient {
  readContract: (args: {
    address: `0x${string}`;
    abi: typeof X402_BATCH_CHANNEL_ABI;
    functionName: "channels" | "pendingWithdrawals" | "refundNonce";
    args: [`0x${string}`];
    // `channels` and `pendingWithdrawals` answer a pair; `refundNonce` a single
    // counter. Narrowed back at each call site, which knows which it asked for.
  }) => Promise<readonly [bigint, number | bigint] | bigint>;
}

/**
 * Report contract views without broadcasting. Successful views attempt to write
 * authoritative balance and claimed total locally; failed reads use available local
 * fallback figures and retain their unreconciled provenance stamp. For all-zero
 * views, refundNonce distinguishes a refunded channel when readable; otherwise
 * unconfirmed means the contract cannot establish its history. Keep config for
 * timed exits even after a terminal observation.
 */
export async function readX402ChannelOnChain(args: {
  channel: StoredX402ChannelMetadata;
  /** CAIP-2 chain the configured wallet is pinned to, which is what scopes `DVM_X402_RPC_URL`. */
  configuredNetwork: string;
  /** Clients to reuse across rows on the same chain. Best-effort: concurrent rows may each build one. */
  clients?: Map<string, X402ChannelClient>;
}): Promise<X402ChannelChainReport> {
  const { channel } = args;
  // One map for both reads: without it a caller that passes none would build a
  // second client for the conditional third call it just built one for.
  const clients = args.clients ?? new Map<string, X402ChannelClient>();
  let state: X402ChannelState | undefined;
  let error: DvmError | undefined;
  try {
    state = await readChannelState(channel, args.configuredNetwork, clients, "report");
  } catch (err) {
    error =
      err instanceof DvmError
        ? err
        : new DvmError(
            "x402_chain_read_failed",
            `Reading the x402 channel with ${channel.endpoint} on ${channel.network} failed: ${redactUrlsInText(err instanceof Error ? err.message : String(err))}`
          );
  }
  let status: X402ChannelChainStatus = state ? classifyX402ChannelState(state) : "unreadable";
  // Only now, and only where the first two views left it ambiguous, is the
  // third one worth a round trip: a non-zero refund counter is proof the
  // contract has seen this channel, which turns "never heard of it" into "it
  // ran its course". A failure here is not fatal — the pair already answered,
  // and `unconfirmed` is the conservative reading of that answer.
  if (state && status === "unconfirmed") {
    const refunds = await readChannelRefundNonce(channel, args.configuredNetwork, clients).catch(
      () => 0n
    );
    if (refunds > 0n) status = "closed";
  }
  // The contract knows this channel only where it accounted for something. On
  // the other two the record is the better answer, and its provenance travels
  // with it.
  const accounted = status === "unconfirmed" ? undefined : state;
  const stored = accounted ? undefined : await storedChannelBalance(channel.channelId);
  const depositMicro = accounted ? Number(accounted.balance) : stored?.balanceMicro;
  return {
    status,
    channelId: channel.channelId,
    ...(depositMicro !== undefined ? { depositMicro } : {}),
    ...(state
      ? {
          settledMicro: Number(state.totalClaimed),
          ...(depositMicro !== undefined
            ? { uncommittedMicro: Math.max(depositMicro - Number(state.totalClaimed), 0) }
            : {}),
          pendingWithdrawalMicro: Number(state.pendingWithdrawal),
        }
      : {}),
    ...(depositMicro !== undefined && stored?.unreconciledAt !== undefined
      ? { balanceUnreconciledAt: stored.unreconciledAt }
      : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * Whether the connected x402 key is the payer one recorded channel pays out to.
 *
 * Simpler than the Tempo twin and for a structural reason: every x402 record
 * carries `config.payer` as channel-id material, so ownership is always
 * answerable from the record alone — no descriptor read, and no unattributable
 * case to pick a safe default for. With no key connected the answer is `false`,
 * which is the literal truth: nothing on this machine can move that channel.
 */
export function x402ChannelControlledBy(
  channel: StoredX402ChannelMetadata,
  address: string | null | undefined
): boolean {
  if (!address) return false;
  // Both sides folded: the store holds checksummed config addresses, and a
  // comparison that is only half case-insensitive reads a wallet as a stranger
  // to itself.
  return channel.config.payer.toLowerCase() === address.toLowerCase();
}

/** What one channel currently holds onchain, in USDC microunits. */
interface X402ChannelState {
  /** Deposited value the contract still holds for this channel. */
  balance: bigint;
  /** Cumulative value the receiver has claimed out of that balance. */
  totalClaimed: bigint;
  /** Value in an initiated-but-unfinalized timed withdrawal. */
  pendingWithdrawal: bigint;
}

/**
 * The caller's own last figure for one channel, and whether it is an
 * observation. Never throws: a store this can't read leaves the row with no
 * deposit at all, which is the honest shape and not a failed command.
 */
async function storedChannelBalance(
  channelId: string
): Promise<{ balanceMicro?: number; unreconciledAt?: number } | undefined> {
  try {
    const balance = (await new DvmX402ChannelStorage().get(channelId))?.balance;
    const unreconciledAt = x402ChannelBalanceUnreconciledAt(channelId);
    return {
      ...(balance !== undefined ? { balanceMicro: Number(balance) } : {}),
      ...(unreconciledAt !== undefined ? { unreconciledAt } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Pending withdrawal takes priority; moved counters distinguish closure from unknown history. */
function classifyX402ChannelState(
  state: X402ChannelState
): Exclude<X402ChannelChainStatus, "unreadable"> {
  if (state.pendingWithdrawal > 0n) return "closing";
  if (state.balance > 0n) return "open";
  return state.totalClaimed > 0n ? "closed" : "unconfirmed";
}

/**
 * The client one channel is read through, and everything its failure copy needs
 * to name the endpoint that did not answer.
 *
 * Split out of {@link readChannelState} because the reporting read makes a
 * second, conditional call on the same chain (see {@link readChannelRefundNonce})
 * and must reach it through the same resolved endpoint and the same cached
 * client rather than re-deriving either.
 */
interface ResolvedX402ChannelRead {
  client: X402ChannelClient;
  label: string;
  url: string | undefined;
  source: RpcSource;
  overrideOutOfScope: boolean;
}

async function resolveChannelRead(
  channel: StoredX402ChannelMetadata,
  configuredNetwork: string,
  clients: Map<string, X402ChannelClient>,
  posture: X402ReadPosture
): Promise<ResolvedX402ChannelRead> {
  const spec = x402NetworkByCaip2(channel.network);
  if (!spec) {
    throw new DvmError(
      "x402_unsupported_network",
      `The channel with ${channel.endpoint} is recorded on ${channel.network}, a chain this rail can't read.`,
      posture === "guard"
        ? `${x402SupportedNetworksHint()} The key stays connected: with no way to read that channel, there is no way to show it is empty.`
        : `${x402SupportedNetworksHint()} The local channel record is kept: with no way to read that chain, there is no way to show what the contract holds for it.`,
      { channel_id: channel.channelId, endpoint: channel.endpoint, network: channel.network }
    );
  }
  // Both imports stay outside the try, as in `getX402Balance`: a missing
  // optional viem has to keep reaching its own remedy rather than being
  // relabelled as an endpoint that didn't answer.
  const chains = (await import("viem/chains")) as unknown as Record<string, unknown>;
  const { createPublicClient, http } = await import("viem");
  const bundled = (
    chains[spec.viemChain] as { rpcUrls?: { default: { http: string[] } } } | undefined
  )?.rpcUrls?.default.http[0];
  const { url, source, overrideOutOfScope } = resolveX402ChannelRpc(
    channel.network,
    configuredNetwork,
    bundled
  );
  let client = clients.get(channel.network);
  if (!client) {
    const transportOptions = resolveRpcHttpTransportOptions(
      source,
      process.env.DVM_X402_RPC_HEADERS_JSON
    );
    client = createPublicClient({
      chain: chains[spec.viemChain] as Parameters<typeof createPublicClient>[0]["chain"],
      transport: transportOptions ? http(url, transportOptions) : http(url),
    }) as unknown as X402ChannelClient;
    clients.set(channel.network, client);
  }
  return { client, label: spec.label, url, source, overrideOutOfScope };
}

async function readChannelState(
  channel: StoredX402ChannelMetadata,
  configuredNetwork: string,
  clients: Map<string, X402ChannelClient>,
  posture: X402ReadPosture
): Promise<X402ChannelState> {
  const read = await resolveChannelRead(channel, configuredNetwork, clients, posture);
  let onchain: readonly [bigint, number | bigint];
  let pending: readonly [bigint, number | bigint];
  try {
    [onchain, pending] = (await Promise.all([
      read.client.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "channels",
        args: [channel.channelId],
      }),
      read.client.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "pendingWithdrawals",
        args: [channel.channelId],
      }),
    ])) as [readonly [bigint, number | bigint], readonly [bigint, number | bigint]];
  } catch (err) {
    throw rpcError(err, channel, read, posture);
  }
  // A corrupt or unwritable local projection must not relabel a successful
  // chain read as an RPC failure or hide the row. The next read retries the
  // same write-back; the chain figures returned this run remain authoritative.
  await new DvmX402ChannelStorage()
    .reconcileChainState(channel.channelId, {
      balance: onchain[0].toString(),
      totalClaimed: BigInt(onchain[1]).toString(),
    })
    .catch(() => undefined);
  return {
    balance: onchain[0],
    totalClaimed: BigInt(onchain[1]),
    pendingWithdrawal: pending[0],
  };
}

/**
 * How many cooperative refunds this channel has ever taken.
 *
 * The one signal that survives a channel emptying itself. `finalizeWithdraw`
 * zeroes `pendingWithdrawals` outright (`ws.amount = 0; ws.initiatedAt = 0`)
 * and nothing ever resets `totalClaimed`, so a funded channel that was never
 * claimed and then drained answers `(0, 0)` on both other views — the same
 * thing a channel that never existed answers. `refundNonce` only ever
 * increments, so a non-zero one is proof the contract has seen this channel
 *
 * Read lazily, and only when the other two views left the verdict ambiguous, so
 * the common row still costs exactly two calls.
 */
async function readChannelRefundNonce(
  channel: StoredX402ChannelMetadata,
  configuredNetwork: string,
  clients: Map<string, X402ChannelClient>
): Promise<bigint> {
  const read = await resolveChannelRead(channel, configuredNetwork, clients, "report");
  try {
    return (await read.client.readContract({
      address: BATCH_SETTLEMENT_ADDRESS,
      abi: X402_BATCH_CHANNEL_ABI,
      functionName: "refundNonce",
      args: [channel.channelId],
    })) as bigint;
  } catch (err) {
    throw rpcError(err, channel, read, "report");
  }
}

/**
 * Which caller the failure copy is written for.
 *
 * The two postures make different promises and must not borrow each other's
 * words. `guard` is the key-rotation preflight: it refused, so its copy says the
 * wallet is untouched and the key stays connected. `report` is
 * {@link readX402ChannelOnChain}, reached from `dvm wallet balance`, where the
 * caller attempted no such thing — telling them their key "stays connected"
 * asserts a disconnect that never happened, and `hint` is text an agent relays
 * to a human verbatim. The endpoint diagnosis is the half both
 * genuinely share, so only that half is common.
 */
type X402ReadPosture = "guard" | "report";

/**
 * An endpoint that didn't answer is not evidence the channel is empty, so this
 * names the knob the caller can turn, in the posture's own voice. Every URL is
 * redacted the same way `getX402Balance` redacts its own: the
 * providers callers reach for put an API key in the path, and viem prints its
 * own `URL:` line into the message this text carries.
 */
function rpcError(
  err: unknown,
  channel: StoredX402ChannelMetadata,
  read: Pick<ResolvedX402ChannelRead, "label" | "url" | "source" | "overrideOutOfScope">,
  posture: X402ReadPosture
): DvmError {
  const { label, url, source, overrideOutOfScope } = read;
  const cause = redactUrlsInText(err instanceof Error ? err.message : String(err));
  // What each posture says before and after the shared endpoint diagnosis.
  const opening =
    posture === "guard" ? "The x402 wallet is untouched. " : "Nothing was read or changed. ";
  const closing =
    posture === "guard"
      ? " then retry — until the channel reads as empty the key stays connected."
      : " then re-run 'dvm wallet balance'. The local channel record is kept until the chain can be read, because it is the only route back to any collateral the contract does hold.";
  const scopeClause = overrideOutOfScope
    ? `This channel is on ${label}, not the chain the wallet is pinned to, so DVM_X402_RPC_URL did not apply to it — it stays scoped to the pinned chain, because the settlement contract shares one address across chains and a cross-chain read would answer "empty" for a channel that isn't. Verify connectivity to ${label}'s bundled endpoint${url ? ` (${redactUrl(url)})` : ""},`
    : `Verify connectivity to ${label}'s bundled endpoint${url ? ` (${redactUrl(url)})` : ""}, or send the read somewhere else with DVM_X402_RPC_URL,`;
  const diagnosis =
    source === "override"
      ? `DVM_X402_RPC_URL sent this read to ${redactUrl(url ?? "")}. Correct it, or unset it to fall back to ${label}'s bundled endpoint,`
      : scopeClause;
  return new DvmError(
    "x402_rpc_error",
    `Reading the x402 channel with ${channel.endpoint} on ${label} failed: ${cause}`,
    `${opening}${diagnosis}${closing}`,
    { channel_id: channel.channelId, endpoint: channel.endpoint, network: channel.network }
  );
}
