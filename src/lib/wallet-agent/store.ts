import type { SerializedDLEQ } from "@cashu/cashu-ts";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import lockfile from "proper-lockfile";

import { WALLET_FILE } from "../../defaults";
import { ensureConfigDir } from "../config-dir";
import { DvmError } from "../errors";
import type { JobPolicy } from "../submission-policy";
import type { ReceiptTrustAnchor } from "../receipt-contracts";
import type { SignedRequestDomain } from "../signed-request-statement";

const LOCK_FILE = `${WALLET_FILE}.lock`;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 30;
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 1_000;

/** Current on-disk wallet schema version. Bumping requires a migration path. */
export const WALLET_VERSION = 9 as const;

/** Cap on the number of recent-spends entries persisted to the wallet. */
export const RECENT_SPENDS_CAP = 10;

/** Used when wallet.mints is empty; configured alternatives remain available. */
export const DEFAULT_AGENT_MINT_URL = "https://mint.coinos.io" as const;

/** Persisted proof with issuing mint and independent NUT-11 lock authority. */
export interface AgentProof {
  mint: string;
  /** Per-proof secret string (NUT-00 / NUT-11 envelope). */
  secret: string;
  /** Unblinded signature point in compressed form. */
  C: string;
  /** Denomination, in sats. */
  amount: number;
  id: string;
  /** Optional NUT-12 proof, including the blinding factor needed by enforcing mints. */
  dleq?: SerializedDLEQ;
  /**
   * Compressed secp256k1 pubkey the NUT-11 P2PK lock binds to, or `null`
   * for explicitly-unlocked proofs (anyone-can-spend). Free-balance proofs
   * from the default fund flow always carry the wallet's master pubkey.
   * Reserve proofs carry the builder's lock pubkey. `null` only
   * appears on outputs from `dvm wallet release --output unlocked`.
   */
  locked_to_pubkey: string | null;
  /** Stale in_flight proofs become sweep candidates, except those committed to
   * pending melts or prepared swaps, whose outcomes require mint evidence. */
  status: "valid" | "in_flight";
  /**
   * Wall-clock millis at which an `in_flight` proof becomes eligible for
   * sweep back to `valid`. Set when the proof is first marked in-flight;
   * only meaningful when `status === "in_flight"`.
   */
  in_flight_until_ms?: number;
  /**
   * Per-builder reserve marker. Set on proofs minted by
   * `dvm wallet reserve --builder <handle>`: locked to the builder's lock
   * pubkey with a NUT-11 `locktime` + `refund` tag. Format is
   * `builder/<handle>` where `<handle>` is the hostname extracted from the
   * DVM endpoint. Free-balance proofs (default fund flow) leave this unset.
   *
   * Spend-time selection in `prepareAgentSpend` prefers an unexpired
   * matching reserve over a per-call swap; post-`t_expire`,
   * `dvm wallet release` swaps unshipped reserve proofs back to free
   * balance via the NUT-11 refund path.
   */
  reserved_for?: string;
  /**
   * NUT-11 locktime expiry as wall-clock millis. Set in lockstep
   * with {@link reserved_for}: before `t_expire`, only the builder's lock
   * key spends; after, the agent's per-DVM refund subkey also spends. Used
   * by `dvm wallet release` to identify reclaim-eligible proofs and by
   * spend selection to skip expired entries.
   */
  t_expire?: number;
}

/**
 * One entry in the recent-spends ring buffer surfaced by `dvm wallet show`
 * Capped to the most-recent {@link RECENT_SPENDS_CAP} entries on
 * every write so the wallet file stays bounded across long-lived agents.
 */
export interface AgentRecentSpend {
  /** UUIDv4 used as the per-call replay key (`X-Cashu-Request-Id`). */
  request_id: string;
  dvm_endpoint: string;
  mint: string;
  /** Total spend amount, in sats. */
  amount_sats: number;
  /** Wall-clock millis when the spend was authorised + transmitted. */
  signed_at_ms: number;
}

/**
 * One pre-built blinded output, persisted before the mint signs it so a
 * crash between mint-side issuance and disk flush can be recovered via the
 * NUT-09 `/v1/restore` endpoint on the next sweep. Field shapes
 * mirror cashu-ts's `OutputDataLike`, with bigint/Uint8Array values encoded
 * as lowercase hex for JSON safety.
 */
export interface PersistedOutputData {
  /** SerializedBlindedMessage: amount in sats, B_ as compressed point hex, keyset id. */
  blinded_message: { amount: number; B_: string; id: string };
  /** Blinding factor (bigint) as lowercase hex, no `0x` prefix. */
  blinding_factor: string;
  /** Secret bytes (the NUT-11 P2PK envelope, UTF-8) as lowercase hex. */
  secret: string;
  /** Optional NUT-12 ephemeral E component, when DLEQ proofs are required. */
  ephemeral_e?: string;
}

/**
 * In-flight mint state captured between `prepareMint` and `completeMint`.
 * Lets the next-run sweep call NUT-09 restore against the same blinded
 * outputs when the mint quote has progressed to `ISSUED` but the proofs
 * never made it to disk.
 */
export interface PendingMintMintingState {
  /** Keyset ID the outputs were created against; needed to unblind sigs. */
  keyset_id: string;
  /** Blinded outputs sent to the mint, one per denomination split entry. */
  outputs: PersistedOutputData[];
}

/**
 * A mint quote awaiting Lightning settlement. Persisted to
 * `wallet.pending_mints[]` immediately after invoice display so a CLI crash
 * between display and confirmation can be recovered on the next
 * `dvm wallet ...` invocation. The optional `minting` sub-state
 * is added once `prepareMint` has produced blinded outputs and
 * cleared once those outputs have been signed and persisted as proofs.
 */
export interface PendingMint {
  mint: string;
  /** Quote ID returned by the mint; passed to `checkMintQuoteBolt11`. */
  quote_id: string;
  /** Amount the user asked for, in sats. */
  amount_sats: number;
  /** ISO-8601 timestamp of the original `createMintQuote` call. */
  requested_at: string;
  /** Quote expiry as unix seconds, when the mint supplied one. */
  expires_at?: number;
  /** Pre-built blinded outputs, present only between `prepareMint` and `completeMint`. */
  minting?: PendingMintMintingState;
}

/**
 * In-flight melt state captured between `prepareMelt` and `completeMelt`
 * The NUT-08 blank outputs the mint signs change onto are
 * persisted here before the melt request goes out, so a crash mid-melt can
 * NUT-09-restore the change instead of burning it — the melt-side twin of
 * {@link PendingMintMintingState}.
 */
export interface PendingMeltMeltingState {
  /** Keyset ID the blank outputs were created against; needed to unblind sigs. */
  keyset_id: string;
  /** Blank (amount-0) blinded outputs sent to the mint to receive change on. */
  outputs: PersistedOutputData[];
}

/**
 * One in-flight cash-out: a melt quote the wallet has committed proofs to
 * Persisted — with the input proofs marked `in_flight` — before
 * the mint's melt call, because a melt that pays the invoice and loses its
 * local record is unrecoverable loss. The ordering mirrors what
 * `prepareAgentSpend` does with `pending_submissions`.
 *
 * Lifecycle:
 * - Created after `prepareMelt` and before `completeMelt`, carrying the
 * quote id, the exact inputs committed, and the blank outputs.
 * - Cleared on a successful melt, with the inputs removed from the wallet
 * and the returned change re-locked to the wallet's own pubkey.
 * - On failure or crash, reconciled by `sweepPendingMelts` against the
 * mint's own quote state: `PAID` settles (restoring change via NUT-09),
 * `UNPAID` returns the inputs to spendable, `PENDING` waits.
 *
 * The entry is never dropped on a state the mint hasn't confirmed — an unpaired
 * entry is the only local record that these proofs may already be spent, and
 * deleting it would silently unaccount for the balance.
 */
export interface PendingMelt {
  /** Mint URL the melt quote was issued at. */
  mint: string;
  /** Melt quote ID; passed to `checkMeltQuoteBolt11` on recovery. */
  quote_id: string;
  /** The bolt11 invoice being paid. Recorded so a recovery never fetches a second one. */
  bolt11: string;
  /** Payee as the operator typed it — a Lightning address or `lnurl1…` string. */
  destination: string;
  /** Invoice amount, in sats. What actually arrives at the destination. */
  amount_sats: number;
  /** Mint-reserved Lightning routing buffer, in sats. Unused remainder returns as change. */
  fee_reserve_sats: number;
  /** NUT-12 per-input fee the mint charges for the committed proofs, in sats. */
  input_fee_sats: number;
  /** The exact proofs committed to this melt, so a `UNPAID` recovery can hand them back. */
  input_proofs: AgentProof[];
  /** Blank outputs for the mint's change, present between `prepareMelt` and settlement. */
  melting?: PendingMeltMeltingState;
  /** ISO-8601 timestamp of the melt commitment. */
  created_at: string;
  /** Quote expiry as unix seconds, when the mint supplied one. */
  expires_at?: number;
}

/**
 * The submit context a resume needs to re-POST the original call.
 * Without it the sweep can only replay the payment headers, and a DVM rejects
 * a bodyless `POST /v1/job` at input validation long before it looks at the
 * payment — so the entry can never clear. Absent on entries written by a CLI
 * predating which are therefore unresumable and only surfaceable.
 */
export interface PendingSubmissionContext {
  /**
   * `POST /v1/job` wire body of the original submit (`envelopeToPayload`), with
   * one deliberate difference: against a descriptor-auth DVM, `data` holds the
   * **unsigned** body, not the signed envelope that went on the wire. A
   * signature is only good for ~5 minutes (`createSignedRequestVerifier` rejects
   * on timestamp drift), so replaying the original envelope would 401 for the
   * entire life of the entry. The resume re-signs at send time instead — see
   * `signing_pubkey`.
   */
  submit_body: Record<string, unknown>;
  /**
   * Caller pubkey the original submit was signed with, when the DVM advertises
   * `secp256k1-schnorr-v2`. The resume re-signs `submit_body.data` as
   * this identity; if the key is no longer configured the entry is unresumable,
   * because signing as anyone else would file the job under the wrong caller.
   */
  signing_pubkey?: string;
  /** Exact v2 audience/operation domain used to re-sign a recovered submission. */
  auth_domain?: SignedRequestDomain;
  /** `/v1/info#builder` snapshot used to verify a recovered funding receipt offline. */
  builder?: ReceiptTrustAnchor;
  /** Canonical DVM name, for the `JobRecord` a successful resume writes. */
  dvm_id?: string;
  /** Capability dispatched against the DVM, for the same `JobRecord`. */
  capability?: string;
  /** Caller-pinned Cashu spend mint, carried onto the `JobRecord`. */
  pinned_mint?: string;
  /** Budget/auto-pay policy for the job, carried onto the `JobRecord`. */
  policy?: JobPolicy;
  /** Strict direct-Cashu mode: no credit, fallback rail, reserve, or broad recovery. */
  strict_per_call?: true;
  /** Job-wide Cashu swap-fee ceiling, enforced again by every later payment/recovery swap. */
  max_cashu_fee_sats?: number;
  /**
   * Cashu fee charged to the initial swap. Required when this context carries
   * `max_cashu_fee_sats`; a reclaim may spend only the remaining allowance.
   */
  initial_cashu_fee_sats?: number;
  /** Credential-free hash binding the exact DVM, body, mint, signer, capability, and policy. */
  binding_fingerprint?: string;
  /**
   * Which route the resume re-POSTs. Absent or `"job"` —
   * `POST /v1/job` with `submit_body`. `"credit"` — `POST /v1/credit` with
   * `credit_body`: a standalone top-up whose idempotency key is the signed
   * `(credit_id, fund_id)`, not the Cashu request id.
   */
  route?: "job" | "credit";
  /**
   * Unsigned `/v1/credit` op body for a `route: "credit"` entry — same
   * re-sign-at-send-time discipline as `submit_body.data`. Carries
   * `{op: "fund", credit_id, fund: {amount_micro, fund_id, commitment}}`;
   * the commitment covers the persisted token, not the signature, so a
   * re-signed replay still verifies.
   */
  credit_body?: Record<string, unknown>;
}

/**
 * Terminal state of a submission a DVM or router accepted whose job identity the
 * caller could not settle: the response-head job ID disagreed with the body's,
 * the body could not be read, or the router reported a conflicting accepted
 * job. The payment may have landed, so the entry must never be re-paid; the
 * job-ID strings are what was observed, kept for the operator's evidence.
 */
export interface PendingSubmissionAcceptedUnresolved {
  /**
   * Adding a kind requires a {@link WALLET_VERSION} bump: an older reader
   * cannot know what a new kind means, and a version it does not understand
   * is the wallet's existing refusal path.
   */
  kind: "identity_mismatch" | "body_unreadable" | "router_identity_conflict";
  /** ISO-8601 timestamp of the observation, like `created_at`. */
  observed_at: string;
  /** Must satisfy {@link isStorableJobId}. */
  header_job_id?: string;
  /** Must satisfy {@link isStorableJobId}. */
  body_job_id?: string;
  /** Must satisfy {@link isStorableJobId}. */
  accepted_job_id?: string;
  /** Request-scoped key of the caller's evidence record; must satisfy {@link isStorableJobId}. */
  ambiguity_id: string;
}

/** Maximum length of a stored observed job ID, in UTF-16 code units (`String#length`). */
export const MAX_STORABLE_JOB_ID_LENGTH = 512;

/**
 * True when a string may be stored in an `accepted_unresolved` record: non-empty,
 * at most {@link MAX_STORABLE_JOB_ID_LENGTH} UTF-16 code units, and free of
 * control characters — C0 (U+0000–U+001F, including TAB), DEL (U+007F) and C1
 * (U+0080–U+009F, which `Headers.get` yields for obs-text bytes 0x80–0x9F).
 * Writers omit or clean a value that fails, since the save refuses it.
 */
export function isStorableJobId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_STORABLE_JOB_ID_LENGTH &&
    // eslint-disable-next-line no-control-regex -- control characters are what this rejects
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

/** Persisted preview for a per-call swap whose mint outcome is not yet durable. */
export interface PendingSubmissionSwappingState {
  /** Keyset whose amount key unblinds the restored signatures. */
  keyset_id: string;
  /** Inputs the prepared swap will present to the mint. */
  input_proofs: AgentProof[];
  /** Selected proofs the prepared swap did not need and must return unchanged. */
  unselected_proofs: AgentProof[];
  /** Blinded outputs that become the DVM-bound token. */
  send_outputs: PersistedOutputData[];
  /** Blinded outputs that become caller-held change. */
  keep_outputs: PersistedOutputData[];
}

/**
 * One in-flight per-call swap-and-ship to a DVM. Persisted before
 * the mint `/v1/swap` round-trip so a CLI crash anywhere between proof
 * selection and DVM 2xx is recoverable: on next run, the resume sweep
 * re-ships the same `request_id` (idempotent at the DVM via
 * `UNIQUE(dvm_id, request_id)`).
 *
 * Lifecycle:
 * - Created with `output_proofs: []` immediately after the wallet
 * marks its input proofs `in_flight` and before the mint swap call.
 * A crash here leaves the input proofs `in_flight`; the in-flight
 * sweep recovers them after the timeout.
 * - Once the swap returns, `output_proofs` is rewritten with the
 * DVM-locked proofs and the (now SPENT) input proofs are removed
 * from the wallet. A crash here leaves the submission re-shippable
 * by the next sweep.
 * - Cleared on DVM 2xx, or on operator abandon.
 *
 * Entries written from on carry a refund clause: `output_proofs` are
 * P2PK-locked to the DVM with a NUT-11 `locktime` and the agent's per-DVM
 * refund pubkey, so once {@link PendingSubmission.t_expire} passes the wallet
 * can swap them back to spendable itself (`sweepPendingSubmissions`). Older
 * entries — and any written against a DVM that advertises no `canonical_id`, or
 * from a wallet with no mnemonic — carry no clause and remain capital the agent
 * can only recover by getting the DVM to accept the token. Either way the entry
 * is surfaced (`dvm wallet show`, `dvm doctor`) rather than dropped; deleting a
 * clause-less one would erase the only record of the loss.
 */
export interface PendingSubmission {
  /** DVM endpoint the token will be shipped to. */
  endpoint: string;
  /** UUIDv4 used as the per-call replay key (`X-Cashu-Request-Id`). */
  request_id: string;
  /** The DVM's `cashu.lock_pubkeys[0]` at swap time. */
  intended_lock_pubkey: string;
  /** Mint URL the swap was performed at. */
  mint: string;
  /** Output value, in sats. Mint outputs sum exactly to this. */
  amount_sats: number;
  /** Job-wide Cashu fee ceiling copied onto the money journal for every recovery swap. */
  max_cashu_fee_sats?: number;
  /**
   * Exact reserve consumed by the initial swap. Required on capped entries;
   * recovery fails closed rather than treating a missing value as zero.
   */
  initial_cashu_fee_sats?: number;
  /**
   * DVM-locked output proofs ready to (re)ship. Empty between
   * persist-before-swap and the post-swap update; populated for the
   * lifetime of an unshipped submission after the mint signed.
   */
  output_proofs: AgentProof[];
  /**
   * NUT-09 material persisted before `/v1/swap`. Present until the signed
   * outputs and change have reached their durable destinations.
   */
  swapping?: PendingSubmissionSwappingState;
  /** ISO-8601 timestamp of the original prepare call. */
  created_at: string;
  /**
   * What the resume sweep needs to re-POST the original call.
   * Optional: entries written before and the caller CLI's mid-job
   * `payment` spends (which ship over `sendMessage`, not `POST /v1/job`, and so
   * can't be resumed by this sweep), carry none.
   */
  context?: PendingSubmissionContext;
  /** Resume attempts made by the sweep so far. Absent means zero. */
  attempts?: number;
  /** ISO-8601 timestamp of the most recent resume attempt. */
  last_attempt_at?: string;
  /**
   * Verbatim encoded token string as originally shipped. A
   * fund-and-draw's signed `fund.commitment` is sha256 over exactly these
   * bytes, so the resume must re-ship them — re-encoding from
   * `output_proofs` is byte-identical today but that is a library-behavior
   * assumption, and a divergence would strand the entry as
   * `funding_commitment_mismatch`. Absent on legacy entries, where the
   * sweep falls back to re-encoding.
   */
  cashu_token?: string;
  /**
   * The DVM's `cashu.canonical_id` at swap time. Re-derives the
   * per-DVM refund subkey that signs the reclaim witness — the privkey itself
   * is never persisted. Absent when the DVM advertised none, which is also when
   * no refund clause was attached.
   */
  canonical_id?: string;
  /**
   * The agent refund pubkey named in the outputs' NUT-11 `refund` tag
   * Recorded so a reclaim can assert it re-derived the same key
   * before signing, rather than failing opaquely at the mint.
   */
  refund_pubkey?: string;
  /**
   * Wall-clock ms at which the refund path opens — the NUT-11
   * `locktime` tag, which is in unix *seconds*, times 1000. Before it, only the
   * DVM can spend `output_proofs`; after it, the refund key can too. Absent on
   * entries with no refund clause.
   */
  t_expire?: number;
  /**
   * Why the most recent reclaim attempt didn't go through — a mint
   * that stayed down, a missing or mismatched mnemonic, proofs still in flight,
   * or a swap fee worth more than the value itself. Written only once
   * {@link PendingSubmission.t_expire} has passed and a reclaim was actually
   * attempted, so its presence is what separates "waiting to self-heal" from
   * "the self-heal is failing". Never cleared explicitly — a reclaim that
   * succeeds drops the entry. Without it every failure would go on reading as a
   * payment quietly on its way back.
   */
  reclaim_error?: string;
  /**
   * Whether {@link PendingSubmission.reclaim_error} is a standing fact rather
   * than a bad moment. A mint outage or a missing mnemonic clears
   * when the cause does, and retrying every sweep is exactly right. A payment
   * worth less than the mint's swap fee does not: no number of retries makes
   * the arithmetic work, so telling the caller to wait would be a lie and
   * `--forget` is the honest exit. The read side splits `reclaim_failed` from
   * `unreclaimable` on this flag alone.
   */
  reclaim_terminal?: boolean;
  /**
   * Set when the submission was accepted but its job identity could not be
   * settled. Its presence forbids paying for this request again.
   */
  accepted_unresolved?: PendingSubmissionAcceptedUnresolved;
}

/**
 * Persistent state for the agent wallet — the lock keypair plus the Cashu
 * holdings (mints, locked proofs, in-flight mint operations) owned by it. This
 * file lives at `~/.dvm/wallet.json` with mode 0600 and is the single source of
 * truth for the agent wallet across CLI runs.
 */
export interface AgentWallet {
  /** On-disk schema version. Loader rejects unknown values. */
  version: typeof WALLET_VERSION;
  /** 32-byte secp256k1 private key, lowercase hex. Never sent to any server. */
  lock_privkey: string;
  /** 33-byte compressed secp256k1 public key, lowercase hex. */
  lock_pubkey: string;
  /**
   * `sha256(bip39 entropy)` lowercase hex for the mnemonic stored at
   * `~/.dvm/wallet.mnemonic`. `null` when no mnemonic is on
   * disk — the wallet still works (lock_privkey alone is enough to spend
   * existing proofs), but NUT-13 deterministic secrets are inactive
   * because `getWallet` has no seed to pass to cashu-ts. The fingerprint
   * is the integrity check that the sibling mnemonic file matches this
   * wallet: a mismatch throws at `getWallet` time. See §4.6 of the
   * cashu-from-first-principles design note.
   */
  mnemonic_fingerprint: string | null;
  /** Cashu mint URLs the wallet trusts, in selection order. */
  mints: string[];
  /** Locally held proofs, with each proof recording its own lock authority. */
  proofs: AgentProof[];
  /**
   * NUT-13 deterministic-secret counters per `(mint_url, keyset_id)`
   * `nut13_counters[mint][keyset]` holds the **next** counter
   * to reserve for that pair. Persistence is transactional under
   * {@link withWalletLock} via `PersistentCounterSource` so a CLI crash
   * mid-mint cannot regress a counter. Empty on a v5 → v6 migration; the
   * mint round-trip primes the entries on first use. The inner / outer
   * `| undefined` is intentional — accessing a not-yet-primed mint or
   * keyset must return `undefined` so callers fall back to counter 0.
   */
  nut13_counters: Record<string, Record<string, number | undefined> | undefined>;
  /** Mint quotes awaiting Lightning settlement before proofs can be issued. */
  pending_mints: PendingMint[];
  /**
   * In-flight cash-outs — melt quotes the wallet has committed
   * proofs to, persisted before the mint's melt call and reconciled by
   * `sweepPendingMelts` on the next wallet-touching command.
   */
  pending_melts: PendingMelt[];
  /**
   * In-flight per-call swap-and-ship submissions to DVMs.
   * Persisted before the mint `/v1/swap` round-trip and rewritten with
   * the DVM-locked output proofs once the swap returns; cleared on DVM
   * 2xx or operator abandon.
   */
  pending_submissions: PendingSubmission[];
  /**
   * Most-recent per-call spends, capped at {@link RECENT_SPENDS_CAP}.
   * Surfaced by `dvm wallet show` so an agent has an immediate ledger of
   * what its wallet just paid for.
   */
  recent_spends: AgentRecentSpend[];
  /** ISO-8601 wallet creation timestamp. */
  created_at: string;
}

/** Reads configured mints without migrating legacy caller configuration or choosing a fallback. */
export function loadWalletConfiguredMints(): string[] {
  return loadAgentWallet()?.mints ?? [];
}

/** Missing files return null; earlier supported schemas migrate in memory to v9.
 * Populated v1 legacy state is refused. Wallets without a bound mnemonic stay
 * NUT-13 inactive; old pending mints retain missing expiry for recovery fallback.
 * Unknown versions fail instead of being interpreted as the current schema. */
export function loadAgentWallet(): AgentWallet | null {
  const wallet = parseAgentWallet();
  if (wallet) normalizeAcceptedUnresolved(wallet);
  return wallet;
}

function parseAgentWallet(): AgentWallet | null {
  if (!existsSync(WALLET_FILE)) return null;

  const raw = readFileSync(WALLET_FILE, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DvmError(
      "wallet_corrupt",
      `Wallet file at ${WALLET_FILE} is not valid JSON.`,
      `Restore a backup or delete the file. Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new DvmError(
      "wallet_corrupt",
      `Wallet file at ${WALLET_FILE} is missing a version field.`,
      "Restore a backup or run: dvm wallet init --force"
    );
  }

  const version = (parsed as { version: unknown }).version;
  if (version === 1) {
    return migrateV8ToV9(
      migrateV7ToV8(
        migrateV6ToV7(
          migrateV5ToV6(migrateV4ToV5(migrateV1ToV4(parsed as Record<string, unknown>)))
        )
      )
    );
  }
  if (version === 2) {
    return migrateV8ToV9(
      migrateV7ToV8(
        migrateV6ToV7(
          migrateV5ToV6(
            migrateV4ToV5(migrateV3ToV4(migrateV2ToV3(parsed as Record<string, unknown>)))
          )
        )
      )
    );
  }
  if (version === 3) {
    return migrateV8ToV9(
      migrateV7ToV8(
        migrateV6ToV7(
          migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(parsed as Record<string, unknown>)))
        )
      )
    );
  }
  if (version === 4) {
    return migrateV8ToV9(
      migrateV7ToV8(
        migrateV6ToV7(migrateV5ToV6(migrateV4ToV5(parsed as Record<string, unknown>)))
      )
    );
  }
  if (version === 5) {
    return migrateV8ToV9(
      migrateV7ToV8(migrateV6ToV7(migrateV5ToV6(parsed as Record<string, unknown>)))
    );
  }
  if (version === 6) {
    return migrateV8ToV9(migrateV7ToV8(migrateV6ToV7(parsed as Record<string, unknown>)));
  }
  if (version === 7) {
    return migrateV8ToV9(migrateV7ToV8(parsed as Record<string, unknown>));
  }
  if (version === 8) {
    return migrateV8ToV9(parsed as Record<string, unknown>);
  }
  if (version !== WALLET_VERSION) {
    throw new DvmError(
      "wallet_unknown_version",
      `Unknown wallet version ${String(version)} (this CLI understands version ${String(WALLET_VERSION)}).`,
      "Upgrade dvm CLI: a newer version wrote this wallet."
    );
  }

  return parsed as AgentWallet;
}

/**
 * Atomically write the wallet to `~/.dvm/wallet.json` with mode 0600. The
 * write goes to a sibling `.tmp` file first, then `fs.renameSync` swaps it
 * into place — POSIX guarantees rename atomicity within a filesystem, so a
 * crash mid-write leaves either the previous file or the new one, never a
 * truncated mix.
 */
export function saveAgentWallet(wallet: AgentWallet): void {
  assertAcceptedUnresolvedStorable(wallet);
  ensureConfigDir();
  const tmp = `${WALLET_FILE}.tmp`;
  const data = JSON.stringify(wallet, null, 2) + "\n";
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    renameSync(tmp, WALLET_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup; leftover .tmp is harmless next run
    }
    throw err;
  }
}

/** Whether `~/.dvm/wallet.json` exists. Cheap presence check; does not parse. */
export function walletExists(): boolean {
  return existsSync(WALLET_FILE);
}

/**
 * Internal options for {@link withWalletLock}. Defaults match production needs;
 * tests override `stale` / `retries` / `retryIntervalMs` to keep contention
 * tests fast. Not part of any caller's public surface — the fund/sweep
 * critical sections don't pass options.
 */
export interface WithWalletLockOptions {
  /** Stale-lock threshold in ms. A lock whose mtime is older than this is reclaimed. Default 30_000. */
  stale?: number;
  /** Number of acquisition retries before failing. Default 30. */
  retries?: number;
  /** Milliseconds between retries. Default 1_000. */
  retryIntervalMs?: number;
}

/**
 * Run `fn` while holding an OS-level exclusive lock on the agent wallet, so
 * concurrent `dvm wallet …` invocations serialise their read-modify-write
 * cycles instead of clobbering each other. The lock file lives at
 * `~/.dvm/wallet.json.lock` and is reclaimed automatically if a previous
 * holder died without releasing (proper-lockfile compares the lockfile mtime
 * against the configured stale threshold).
 *
 * Holds the lock only for the duration of `fn` — long-running network I/O
 * (Lightning polling, mint requests) must run outside the lock so a stuck
 * fund flow doesn't block `dvm wallet show`.
 *
 * Throws `DvmError("wallet_locked", …)` when the lock can't be acquired
 * within the retry budget (~30s by default).
 */
export async function withWalletLock<T>(
  fn: () => Promise<T> | T,
  opts: WithWalletLockOptions = {}
): Promise<T> {
  ensureConfigDir();

  const stale = opts.stale ?? DEFAULT_LOCK_STALE_MS;
  const retries = opts.retries ?? DEFAULT_LOCK_RETRIES;
  const interval = opts.retryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS;

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(WALLET_FILE, {
      lockfilePath: LOCK_FILE,
      stale,
      realpath: false,
      retries: { retries, factor: 1, minTimeout: interval, maxTimeout: interval },
    });
  } catch (err) {
    throw new DvmError(
      "wallet_locked",
      `Could not acquire the agent wallet lock at ${LOCK_FILE} within the retry budget.`,
      `Another dvm CLI may be writing to ${WALLET_FILE}. Wait a moment and retry. If no other dvm CLI is running, remove ${LOCK_FILE} and try again.`,
      { lock_file: LOCK_FILE, underlying: err instanceof Error ? err.message : String(err) }
    );
  }

  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // best-effort: lock may have been auto-reclaimed as stale, or already released
    }
  }
}

/**
 * Mints the wallet should consult, in selection order. Falls back to a
 * single-element list of {@link DEFAULT_AGENT_MINT_URL} when the wallet has
 * no configured mints — keeps `dvm wallet fund` working on a fresh
 * `dvm wallet init` without an extra setup step.
 */
export function effectiveMints(wallet: Pick<AgentWallet, "mints">): string[] {
  return wallet.mints.length > 0 ? wallet.mints : [DEFAULT_AGENT_MINT_URL];
}

/**
 * The mint `dvm wallet fund` targets when `--mint` is omitted, plus where it
 * came from: the first configured mint (`configured`) or the built-in
 * {@link DEFAULT_AGENT_MINT_URL} when none are configured (`fallback`). Pairs
 * with {@link effectiveMints} — this is `effectiveMints(wallet)[0]` with its
 * provenance attached, so callers can describe the funding default coherently
 * instead of conflating it with the static fallback constant.
 * Health-based substitution happens later in `resolveFundMint`.
 */
export function effectiveFundingMint(mints: string[]): {
  url: string;
  source: "configured" | "fallback";
} {
  return mints.length > 0
    ? { url: mints[0], source: "configured" }
    : { url: DEFAULT_AGENT_MINT_URL, source: "fallback" };
}

function migrateV1ToV4(parsed: Record<string, unknown>): Record<string, unknown> {
  const proofs = Array.isArray(parsed.proofs) ? parsed.proofs : [];
  const pending = Array.isArray(parsed.pending_mints) ? parsed.pending_mints : [];
  if (proofs.length > 0 || pending.length > 0) {
    throw new DvmError(
      "wallet_unknown_version",
      `Cannot migrate v1 wallet at ${WALLET_FILE}: contains ${proofs.length} proofs and ${pending.length} pending mints under the legacy schema.`,
      "v1 wallets predate the fund flow and are expected to be empty. If this wallet was somehow populated, restore a backup or run: dvm wallet init --force"
    );
  }
  return {
    version: 4,
    lock_privkey: String(parsed.recovery_privkey ?? parsed.lock_privkey),
    lock_pubkey: String(parsed.recovery_pubkey ?? parsed.lock_pubkey),
    mints: Array.isArray(parsed.mints) ? parsed.mints : [],
    proofs: [],
    pending_mints: [],
    recent_spends: [],
    created_at:
      typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
  };
}

function migrateV2ToV3(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    ...parsed,
    version: 3,
    recent_spends: [],
  };
}

function migrateV3ToV4(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 4,
    lock_privkey: String(parsed.recovery_privkey ?? parsed.lock_privkey),
    lock_pubkey: String(parsed.recovery_pubkey ?? parsed.lock_pubkey),
    mints: Array.isArray(parsed.mints) ? parsed.mints : [],
    proofs: Array.isArray(parsed.proofs) ? parsed.proofs : [],
    pending_mints: Array.isArray(parsed.pending_mints) ? parsed.pending_mints : [],
    recent_spends: Array.isArray(parsed.recent_spends) ? parsed.recent_spends : [],
    created_at:
      typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
  };
}

function migrateV4ToV5(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 5,
    lock_privkey: String(parsed.lock_privkey),
    lock_pubkey: String(parsed.lock_pubkey),
    mints: Array.isArray(parsed.mints) ? parsed.mints : [],
    proofs: Array.isArray(parsed.proofs) ? parsed.proofs : [],
    pending_mints: Array.isArray(parsed.pending_mints) ? parsed.pending_mints : [],
    pending_submissions: Array.isArray(parsed.pending_submissions)
      ? parsed.pending_submissions
      : [],
    recent_spends: Array.isArray(parsed.recent_spends) ? parsed.recent_spends : [],
    created_at:
      typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
  };
}

function migrateV5ToV6(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 6,
    lock_privkey: String(parsed.lock_privkey),
    lock_pubkey: String(parsed.lock_pubkey),
    mnemonic_fingerprint:
      typeof parsed.mnemonic_fingerprint === "string" ? parsed.mnemonic_fingerprint : null,
    mints: Array.isArray(parsed.mints) ? parsed.mints : [],
    proofs: Array.isArray(parsed.proofs) ? parsed.proofs : [],
    nut13_counters: isCounterMap(parsed.nut13_counters) ? parsed.nut13_counters : {},
    pending_mints: Array.isArray(parsed.pending_mints) ? parsed.pending_mints : [],
    pending_submissions: Array.isArray(parsed.pending_submissions)
      ? parsed.pending_submissions
      : [],
    recent_spends: Array.isArray(parsed.recent_spends) ? parsed.recent_spends : [],
    created_at:
      typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
  };
}

function migrateV6ToV7(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 7,
    lock_privkey: String(parsed.lock_privkey),
    lock_pubkey: String(parsed.lock_pubkey),
    mnemonic_fingerprint:
      typeof parsed.mnemonic_fingerprint === "string" ? parsed.mnemonic_fingerprint : null,
    mints: Array.isArray(parsed.mints) ? (parsed.mints as string[]) : [],
    proofs: Array.isArray(parsed.proofs) ? (parsed.proofs as AgentProof[]) : [],
    nut13_counters: isCounterMap(parsed.nut13_counters) ? parsed.nut13_counters : {},
    pending_mints: Array.isArray(parsed.pending_mints)
      ? (parsed.pending_mints as PendingMint[])
      : [],
    pending_submissions: Array.isArray(parsed.pending_submissions)
      ? (parsed.pending_submissions as PendingSubmission[])
      : [],
    recent_spends: Array.isArray(parsed.recent_spends)
      ? (parsed.recent_spends as AgentRecentSpend[])
      : [],
    created_at:
      typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
  };
}

function migrateV7ToV8(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 8,
    lock_privkey: String(parsed.lock_privkey),
    lock_pubkey: String(parsed.lock_pubkey),
    mnemonic_fingerprint:
      typeof parsed.mnemonic_fingerprint === "string" ? parsed.mnemonic_fingerprint : null,
    mints: Array.isArray(parsed.mints) ? (parsed.mints as string[]) : [],
    proofs: Array.isArray(parsed.proofs) ? (parsed.proofs as AgentProof[]) : [],
    nut13_counters: isCounterMap(parsed.nut13_counters) ? parsed.nut13_counters : {},
    pending_mints: Array.isArray(parsed.pending_mints)
      ? (parsed.pending_mints as PendingMint[])
      : [],
    pending_melts: Array.isArray(parsed.pending_melts)
      ? (parsed.pending_melts as PendingMelt[])
      : [],
    pending_submissions: Array.isArray(parsed.pending_submissions)
      ? (parsed.pending_submissions as PendingSubmission[])
      : [],
    recent_spends: Array.isArray(parsed.recent_spends)
      ? (parsed.recent_spends as AgentRecentSpend[])
      : [],
    created_at:
      typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
  };
}

function migrateV8ToV9(parsed: Record<string, unknown>): AgentWallet {
  return {
    version: WALLET_VERSION,
    lock_privkey: String(parsed.lock_privkey),
    lock_pubkey: String(parsed.lock_pubkey),
    mnemonic_fingerprint:
      typeof parsed.mnemonic_fingerprint === "string" ? parsed.mnemonic_fingerprint : null,
    mints: Array.isArray(parsed.mints) ? (parsed.mints as string[]) : [],
    proofs: Array.isArray(parsed.proofs) ? (parsed.proofs as AgentProof[]) : [],
    nut13_counters: isCounterMap(parsed.nut13_counters) ? parsed.nut13_counters : {},
    pending_mints: Array.isArray(parsed.pending_mints)
      ? (parsed.pending_mints as PendingMint[])
      : [],
    pending_melts: Array.isArray(parsed.pending_melts)
      ? (parsed.pending_melts as PendingMelt[])
      : [],
    pending_submissions: Array.isArray(parsed.pending_submissions)
      ? (parsed.pending_submissions as PendingSubmission[])
      : [],
    recent_spends: Array.isArray(parsed.recent_spends)
      ? (parsed.recent_spends as AgentRecentSpend[])
      : [],
    created_at:
      typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString(),
  };
}

const ACCEPTED_UNRESOLVED_KINDS: ReadonlySet<unknown> = new Set([
  "identity_mismatch",
  "body_unreadable",
  "router_identity_conflict",
]);
const OBSERVED_JOB_ID_FIELDS = ["header_job_id", "body_job_id", "accepted_job_id"] as const;
const PLACEHOLDER_KIND = "body_unreadable";
const PLACEHOLDER_OBSERVED_AT = new Date(0).toISOString();

/**
 * Refuse, before anything is written, a record a later load would have to
 * repair: the writer still holds the observed values and can clean them.
 */
function assertAcceptedUnresolvedStorable(wallet: AgentWallet): void {
  const entries: unknown = wallet.pending_submissions;
  if (!Array.isArray(entries)) return;
  for (const entry of entries as (Partial<PendingSubmission> | null)[]) {
    const record = entry?.accepted_unresolved;
    if (record === undefined || isStorableAcceptedUnresolved(record)) continue;
    throw new DvmError(
      "accepted_unresolved_invalid",
      `Refusing to save pending submission ${String(entry?.request_id)}: its accepted_unresolved record is outside the stored contract.`,
      "Use one of the three kinds, an ISO-8601 observed_at, and job IDs and ambiguity_id that pass isStorableJobId; omit an observed ID that does not. The wallet file was not changed."
    );
  }
}

function isStorableAcceptedUnresolved(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return (
    ACCEPTED_UNRESOLVED_KINDS.has(value.kind) &&
    isIsoTimestamp(value.observed_at) &&
    isStorableJobId(value.ambiguity_id) &&
    OBSERVED_JOB_ID_FIELDS.every((field) => value[field] === undefined || isStorableJobId(value[field]))
  );
}

/**
 * Repair a malformed `accepted_unresolved` in memory instead of refusing the
 * wallet: the record must survive, because its presence is what forbids paying
 * for the request again, and the wallet's proofs must stay reachable. Offending
 * observed job IDs are dropped (dvm-cli's evidence record keeps the full
 * values). A missing or malformed `kind` becomes `body_unreadable`, the kind
 * that asserts nothing about either ID; `observed_at` falls back to the Unix
 * epoch, which no real observation carries; `ambiguity_id` falls back to the
 * entry's `request_id` (the key dvm-cli files Cashu evidence under) when that
 * is storable, else `missing-ambiguity`. A record that is not an object is replaced
 * by one built from those placeholders.
 */
function normalizeAcceptedUnresolved(wallet: AgentWallet): void {
  const entries: unknown = wallet.pending_submissions;
  if (!Array.isArray(entries)) return;
  for (const entry of entries as (Partial<PendingSubmission> | null)[]) {
    if (!entry || entry.accepted_unresolved === undefined) continue;
    const stored: unknown = entry.accepted_unresolved;
    if (isStorableAcceptedUnresolved(stored)) continue;
    const record: Record<string, unknown> = isPlainRecord(stored) ? { ...stored } : {};
    if (!ACCEPTED_UNRESOLVED_KINDS.has(record.kind)) record.kind = PLACEHOLDER_KIND;
    if (!isIsoTimestamp(record.observed_at)) record.observed_at = PLACEHOLDER_OBSERVED_AT;
    if (!isStorableJobId(record.ambiguity_id)) {
      record.ambiguity_id = isStorableJobId(entry.request_id) ? entry.request_id : "missing-ambiguity";
    }
    for (const field of OBSERVED_JOB_ID_FIELDS) {
      if (record[field] !== undefined && !isStorableJobId(record[field])) delete record[field];
    }
    entry.accepted_unresolved = record as unknown as PendingSubmissionAcceptedUnresolved;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * An RFC 3339 / ISO-8601 date-time with seconds and an explicit offset, as
 * `toISOString()` writes, on a real calendar day. `Date.parse` alone accepts
 * free-form strings and rolls 30 February over to March.
 */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isCounterMap(
  value: unknown
): value is Record<string, Record<string, number | undefined> | undefined> {
  if (typeof value !== "object" || value === null) return false;
  for (const inner of Object.values(value as Record<string, unknown>)) {
    if (typeof inner !== "object" || inner === null) return false;
    for (const n of Object.values(inner as Record<string, unknown>)) {
      if (typeof n !== "number" || !Number.isFinite(n)) return false;
    }
  }
  return true;
}
