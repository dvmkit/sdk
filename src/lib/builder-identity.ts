import { diagnosticConsole } from "../observability/diagnostic-console";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { BUILDER_CONFIG_DIR, BUILDER_KEY_FILE } from "../defaults";
import { loadIdentityPubkey, setIdentityPubkey } from "./builder-store";
import { canonicaliseForSigning, type JsonValue } from "./cast-auth";
import { DvmError } from "./errors";

/**
 * Canonical deploy-time attestation payload. One signature serves
 * both auth-on-deploy and the `/v1/info#builder` attestation — the bytes the
 * builder signs are the canonical JSON of this object.
 */
export interface AttestationPayload {
  /** Immutable platform or self-hosted DVM identifier this attestation applies to. */
  dvm_id: string;
  /** DVM slug the attestation applies to (must match the deploy request's slug). */
  slug: string;
  /** sha256(`canonicaliseForSigning(capabilities)`) hex. Binds the attestation
   * to the capability shape declared at deploy time. */
  capabilities_hash: string;
  /** Builder identity x-only secp256k1 pubkey, hex (32 bytes / 64 chars). */
  builder_pubkey: string;
  /**
   * Per-DVM receipt-signing x-only pubkey, hex. Binds the key the
   * deployed DVM signs job receipts with to the cold builder identity: the
   * builder signs this payload, so a receipt verifying under
   * `receipt_pubkey` inherits the builder's authority.
   *
   * Optional: attestations signed before receipts shipped omit it and still
   * verify byte-for-byte (canonical JSON drops absent keys), and deploy paths
   * that can't provision the matching secret leave it unset rather than
   * attesting a key the running process doesn't hold.
   */
  receipt_pubkey?: string;
  /** Unix seconds at which the attestation was signed. */
  deployed_at: number;
}

export interface BuilderIdentityKeypair {
  /** secp256k1 BIP-340 x-only pubkey, 32 bytes hex (64 chars). */
  pubkey: string;
  /** secp256k1 secret, 32 bytes hex (64 chars). */
  secret: string;
}

export function generateIdentity(): BuilderIdentityKeypair {
  const { secretKey, publicKey } = schnorr.keygen();
  return { pubkey: bytesToHex(publicKey), secret: bytesToHex(secretKey) };
}

/**
 * Read the builder identity secret from `~/.dvmkit/builder.key`. Returns
 * `null` when absent so callers can surface an `identity_required` error.
 *
 * `writeIdentity` persists the key `0o600`, but a destination mode survives
 * `cp`/`scp`/git-checkout intact only by luck — those can land it `0o644`,
 * leaving the signing key world-readable on a multi-user box. On POSIX we
 * detect loose group/other bits, warn, and best-effort re-tighten to `0o600`
 * (same self-heal posture as `writeIdentity`) rather than throw — a hard
 * failure would brick a CLI whose key got widened in transit.
 */
export function loadIdentitySecret(): string | null {
  if (!existsSync(BUILDER_KEY_FILE)) return null;
  warnAndTightenLooseKeyMode();
  const raw = readFileSync(BUILDER_KEY_FILE, "utf-8").trim();
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new DvmError(
      "identity_secret_malformed",
      `${BUILDER_KEY_FILE} is not a 32-byte hex secret.`,
      "Delete the file and re-run `dvmctl identity create` (this rotates the key — existing DVM attestations need re-deploy)."
    );
  }
  return raw;
}

/**
 * Persist a builder identity keypair: pubkey into `~/.dvmkit/builder.json`
 * (top-level), secret into `~/.dvmkit/builder.key` (mode 0600 on POSIX).
 * Atomic tmp+rename on the secret file so a crash mid-write never leaves a
 * truncated key on disk — a torn write here is unrecoverable; the operator
 * loses the ability to re-sign attestations for every DVM under this key.
 *
 * Refuses to overwrite when an identity already exists unless `force` is
 * passed; the force path warns that any DVMs deployed under the old key
 * need to be re-deployed to refresh their attestations.
 */
export function writeIdentity(
  keypair: BuilderIdentityKeypair,
  opts: { force?: boolean } = {}
): void {
  const existing = loadIdentityPubkey();
  if (existing && !opts.force) {
    throw new DvmError(
      "identity_exists",
      "A builder identity already exists.",
      "Pass --force to overwrite. Any DVMs deployed under the old key will need to be re-deployed to refresh their /v1/info attestation."
    );
  }

  mkdirSync(BUILDER_CONFIG_DIR, { recursive: true, mode: 0o700 });

  const tmp = `${BUILDER_KEY_FILE}.tmp`;
  writeFileSync(tmp, keypair.secret + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, BUILDER_KEY_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup; leftover .tmp is harmless next run
    }
    throw err;
  }
  // A stale temp file can retain a wider mode: writeFileSync mode applies only
  // when creating it, so re-tighten the committed key.
  try {
    chmodSync(BUILDER_KEY_FILE, 0o600);
  } catch {
    // POSIX-only; no-op on Windows. Help text + JSON output warn there.
  }

  setIdentityPubkey(keypair.pubkey);
}

/**
 * Compute the canonical `capabilities_hash` (sha256-hex of canonical JSON)
 * for the supplied capabilities block. Shared between the CLI signer and any
 * future verifier so both compute identical bytes.
 */
export function hashCapabilities(capabilities: JsonValue): string {
  return bytesToHex(sha256(canonicaliseForSigning(capabilities)));
}

/**
 * Assemble the deploy-time attestation payload. `deployedAt`
 * defaults to the current Unix second; tests can pin it for reproducibility.
 */
export function buildAttestation(args: {
  dvmId: string;
  slug: string;
  capabilities: JsonValue;
  builderPubkey: string;
  /** Receipt-signing pubkey to attest. Omitted when the deploy path
   * can't provision the matching `DVMKIT_RECEIPT_KEY`. */
  receiptPubkey?: string;
  deployedAt?: number;
}): AttestationPayload {
  return {
    dvm_id: args.dvmId,
    slug: args.slug,
    capabilities_hash: hashCapabilities(args.capabilities),
    builder_pubkey: args.builderPubkey,
    ...(args.receiptPubkey ? { receipt_pubkey: args.receiptPubkey } : {}),
    deployed_at: args.deployedAt ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Sign an attestation payload with the builder identity secret. Returns the
 * 64-byte Schnorr signature as hex. The canonical bytes are produced via the
 * same `canonicaliseForSigning` the verifier uses — both sides hash identical
 * input regardless of object key order.
 */
export function signAttestation(payload: AttestationPayload, secretHex: string): string {
  const secretBytes = hexToBytes(secretHex);
  const canonicalBytes = canonicaliseForSigning(payload as unknown as JsonValue);
  return bytesToHex(schnorr.sign(canonicalBytes, secretBytes));
}

/**
 * Verify a deploy-time attestation. Returns `true` iff the signature is a
 * valid BIP-340 Schnorr signature of `canonicaliseForSigning(payload)` under
 * `pubkeyHex`. Independent of the platform binding — callers (the deploy
 * route, `/v1/info` clients) cross-check the pubkey against their trust root.
 */
export function verifyAttestation(
  payload: AttestationPayload,
  signatureHex: string,
  pubkeyHex: string
): boolean {
  try {
    const canonicalBytes = canonicaliseForSigning(payload as unknown as JsonValue);
    return schnorr.verify(hexToBytes(signatureHex), canonicalBytes, hexToBytes(pubkeyHex));
  } catch {
    return false;
  }
}

/**
 * On POSIX, warn (and best-effort self-heal) when `~/.dvmkit/builder.key` is
 * readable by group/other. No-op on Windows, where the mode bits are
 * meaningless. Swallows stat/chmod errors — the read itself is the source of
 * truth for whether the key is usable.
 */
function warnAndTightenLooseKeyMode(): void {
  if (process.platform === "win32") return;
  try {
    const mode = statSync(BUILDER_KEY_FILE).mode & 0o777;
    if ((mode & 0o077) === 0) return;
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "builder_identity_key_loose_mode",
        message:
          undefined,
        path: BUILDER_KEY_FILE,
        mode: mode.toString(8).padStart(3, "0"),
      }
    );
    chmodSync(BUILDER_KEY_FILE, 0o600);
  } catch {
    // best-effort: a stat/chmod failure shouldn't block the subsequent read,
    // which surfaces its own error if the file is genuinely unusable.
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hex string has odd length: ${String(hex.length)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
