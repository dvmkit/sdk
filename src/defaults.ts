import { homedir } from "os";
import { join } from "path";

/**
 * Caller state defaults to ~/.dvm; DVM_CONFIG_DIR redirects it at import time.
 * Builder state is independently redirected, so the two identities stay separate.
 */
export const CONFIG_DIR = process.env.DVM_CONFIG_DIR ?? join(homedir(), ".dvm");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
/**
 * The single rollback generation retained before a caller-config mutation
 * mode 0600 like the config itself.
 *
 * Exactly one, never a timestamped series: the file holds the same plaintext
 * `x402.privateKey`, `tempo.apiKey` and `nwcUri` as the live config, so an
 * accumulating set of them would quietly multiply the credential's footprint on
 * disk. A mutation that deliberately removes a credential writes this copy with
 * that field already stripped, so a rollback cannot resurrect a secret the
 * caller just asked to be rid of.
 */
export const CONFIG_BACKUP_FILE = join(CONFIG_DIR, "config.json.bak");
/**
 * Append-only record of which caller-config fields changed, when, and under
 * which command. Mode 0600, JSONL, and deliberately value-free —
 * field *paths* and metadata only, so the trail can never become a second copy
 * of the credentials the config holds.
 */
export const CONFIG_AUDIT_FILE = join(CONFIG_DIR, "config-audit.jsonl");
/**
 * The pinned snapshot slot: a second, *non-rolling* copy taken
 * before a deliberate whole-config replacement — `dvm init` over a configured
 * machine, and later an explicit config reset.
 *
 * It exists because {@link CONFIG_BACKUP_FILE} rolls: the very next ordinary
 * field change overwrites it, so a rollback generation taken by a replacement
 * would be gone within seconds of the script that ran the replacement carrying
 * on. Nothing but an explicit pin or an explicit retirement ever touches this
 * file, and a pin refuses to overwrite an existing one — the older snapshot is
 * the one worth keeping when a destructive command runs twice. Mode 0600.
 */
export const CONFIG_PINNED_FILE = join(CONFIG_DIR, "config.json.pinned");
export const JOBS_FILE = join(CONFIG_DIR, "jobs.json");
/** Owner-only caller request intents used by `dvm request-result`. */
export const REQUEST_INTENTS_DIR = join(CONFIG_DIR, "request-intents");
export const FAVORITES_FILE = join(CONFIG_DIR, "favorites.json");
export const MESSAGES_DIR = join(CONFIG_DIR, "messages");
/**
 * Append-only collection of the DVM-signed job receipts this caller has
 * verified. JSONL rather than JSON because it is the long-lived,
 * exportable record — `jobs.json` is a rewrite-in-place working set that
 * carries the same receipt only for as long as the job record lives here.
 */
export const RECEIPTS_FILE = join(CONFIG_DIR, "receipts.jsonl");
/**
 * Per-DVM prepaid-credit working record: the caller's expected
 * balance, ledger sequence, refill target, and pending-drain bookkeeping for
 * every credit it holds. Mutable JSON keyed by endpoint origin + caller
 * pubkey — the `budget.json` shape, not the receipts collection; the signed
 * evidence lives in `receipts.jsonl`.
 */
export const CREDITS_FILE = join(CONFIG_DIR, "credits.json");
/**
 * Durable caller-side x402 batch-channel state and in-flight signed vouchers.
 * The file is mode 0600 because a persisted voucher is spend authority until
 * the DVM has acknowledged it.
 */
export const X402_CHANNELS_FILE = join(CONFIG_DIR, "x402-channels.json");
/** Durable caller-side TIP-1034 channels and their prepaid-credit bindings. */
export const TEMPO_CHANNELS_FILE = join(CONFIG_DIR, "tempo-channels.json");
/**
 * Cooldown state for caller-side feedback nudges: per-DVM stamps
 * for the last nudge, the last recorded send, and the once-ever first-success
 * nudge, plus the first-run intro stamp. Mode 0600 like the credit store —
 * the caller's own behavioural record, not shared state.
 */
export const FEEDBACK_NUDGES_FILE = join(CONFIG_DIR, "feedback-nudges.json");
export const RECOVERY_MNEMONIC_FILE = join(CONFIG_DIR, "recovery.mnemonic");
export const WALLET_FILE = join(CONFIG_DIR, "wallet.json");
/**
 * Agent BIP-39 mnemonic, mode 0600. Kept outside wallet.json so resetting
 * proof state does not discard the recovery identity.
 */
export const AGENT_MNEMONIC_FILE = join(CONFIG_DIR, "wallet.mnemonic");
/**
 * Caller signing identities for descriptor-auth DVMs (mode 0600).
 * Stores one or more named secp256k1 keypairs the CLI uses to auto-sign
 * `/v1/job` / `/v1/quote` envelopes for DVMs that advertise
 * `auth: ["secp256k1-schnorr-v2"]` on `/v1/info`.
 */
export const IDENTITIES_FILE = join(CONFIG_DIR, "identities.json");
/** Short-lived encrypted remote-wallet pairing state (mode 0700 directory). */
export const PAIRINGS_DIR = join(CONFIG_DIR, "pairings");
export const BUDGET_FILE = join(CONFIG_DIR, "budget.json");
/**
 * Disk cache for the BTC/USD spot rate. Used by `fetchBtcUsdRate` to amortise
 * the upstream API call across CLI invocations within the 5-minute TTL, and
 * by `dvm doctor` to surface cache freshness.
 */
export const BTC_RATE_FILE = join(CONFIG_DIR, "btc-rate.json");
export const ADMIN_DIR = join(CONFIG_DIR, "admin");
export const PROXY_STATE_FILE = join(ADMIN_DIR, "proxy.json");

// `dvm` is the consumer CLI (state under ~/.dvm/); `dvmctl` is the builder
// CLI (state under ~/.dvmkit/). Keeping the two trees separate avoids one
// CLI's state leaking into the other's flows.

/**
 * Builder state defaults to ~/.dvmkit; DVMKIT_CONFIG_DIR redirects it at
 * import time independently of caller state.
 */
export const BUILDER_CONFIG_DIR = process.env.DVMKIT_CONFIG_DIR ?? join(homedir(), ".dvmkit");
export const BUILDER_FILE = join(BUILDER_CONFIG_DIR, "builder.json");
export const BUILDER_MNEMONIC_FILE = join(BUILDER_CONFIG_DIR, "recovery.mnemonic");
/**
 * Builder identity secp256k1 secret key (32 bytes hex, mode 0600). Sibling to
 * {@link BUILDER_FILE}, whose top-level `identity_pubkey` advertises the
 * matching x-only pubkey. Generated by `dvmctl identity create`; read by
 * `dvmctl deploy` to sign the deploy-time attestation.
 */
export const BUILDER_KEY_FILE = join(BUILDER_CONFIG_DIR, "builder.key");
export const MELT_PENDING_LOG_FILE = join(BUILDER_CONFIG_DIR, "melt-pending.log");
export const DRAIN_PARK_LOG_FILE = join(BUILDER_CONFIG_DIR, "drain-park.log");
/**
 * Per-DVM record of how long `dvmctl melt-pending` has been unable to read a
 * DVM's pending credit drains. One-shot runs keep no memory of each other, so
 * the ceiling on an indefinite melt hold has to survive between them.
 */
export const DRAIN_HOLD_STATE_FILE = join(BUILDER_CONFIG_DIR, "drain-hold.json");
/**
 * Last successful drain-servicing run per DVM. Command errors may still exit 0
 * after processing siblings, so scheduling monitors need this completion record.
 */
export const MELT_SUCCESS_FILE = join(BUILDER_CONFIG_DIR, "melt-success.json");
