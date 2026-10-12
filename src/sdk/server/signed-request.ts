import { diagnosticConsole } from "../../observability/diagnostic-console";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { z } from "zod";

import { type JsonValue } from "../../lib/cast-auth/index";
import {
  canonicalSignedRequestStatement,
  type SignedRequestDomain,
  signedRequestHeaderMatchesDomain,
  type SignedRequestStatementHeader,
  signedRequestStatementHeader,
  testOnlySignedRequestDomain,
} from "../../lib/signed-request-statement";
import { isZodSchema, type ZodLike } from "../types";
import { zodIssuesOf } from "./zod-error";

export interface CanonicalEnvelope {
  pubkey: string;
  signature: string;
  timestamp: number;
  nonce: string;
  auth_statement?: SignedRequestStatementHeader;
}

export interface CreateSignedRequestVerifierOpts {
  /** Fixed audience/operation for a custom signed route or standalone verifier. */
  domain?: SignedRequestDomain;
  /**
   * Permitted clock drift in seconds; default 300.
   */
  driftSeconds?: number;
  /**
   * Fields stripped from raw input when forming signing bytes; default signature,
   * which is always stripped even when additional fields are configured.
   */
  envelopeFields?: string[];
  /**
   * Field names removed from the input before `schema` validates it — and
   * **kept** in the canonical bytes the signature covers. For protocol-reserved
   * keys the caller signs but the schema never declares: the credit
   * envelope riding a capability schema. No additional fields are ignored by default;
   * auth_statement is always excluded from schema validation.
   *
   * This is the one place where "what is validated" and "what is signed"
   * legitimately differ. Don't reach for it to paper over a schema mismatch —
   * a key listed here is a key nothing validates.
   */
  schemaIgnoreFields?: readonly string[];
  /**
   * Replay store. Defaults to a bounded in-memory FIFO (10-min window, 100k
   * cap). Pass `null` to disable replay checks (single-shot signers, tests).
   */
  replayStore?: SignedRequestReplayStore | null;
  /** Current Unix-seconds source. Defaults to `() => Math.floor(Date.now() / 1000)`. */
  now?: () => number;
}

export interface SignedRequestReplayStore {
  /**
   * True iff (pubkey, timestamp, nonce) was already seen within the retention
   * window. Async so cross-machine implementations (e.g. `PostgresReplayStore`)
   * can satisfy the contract; in-memory implementations wrap with
   * `Promise.resolve(...)`.
   */
  checkAndRecord(pubkey: string, timestamp: number, nonce: string, now: number): Promise<boolean>;
}

export interface SignedRequestSignOpts {
  /** Unix timestamp in seconds. Defaults to `now()`. */
  timestamp?: number;
  /** Replay nonce. Defaults to a fresh 16-char URL-safe random string. */
  nonce?: string;
}

/**
 * Authentication does not touch replay state. Job submission commits replay
 * only after upfront payment verification, so unpaid discovery cannot burn
 * the nonce. Reactivation rechecks the persisted signature without drift/replay.
 */
export interface SignedRequestVerifier<T> {
  /**
   * Schema + drift + signature check against `input`. Returns the verified
   * envelope. Throws {@link SignedRequestError} with the matching `sub_reason`
   * on failure. Does NOT touch the replay store.
   */
  checkAuth(input: unknown, domain?: SignedRequestDomain): T & CanonicalEnvelope;
  /**
   * Schema + signature check against `input`, without the drift window check
   * or replay-store touch. For the reactivation path where the
   * persisted timestamp is from the original signing instant (could be hours
   * or days ago) and the replay nonce was already committed at submission.
   * Returns the verified envelope; throws {@link SignedRequestError} with
   * `sub_reason: "schema_invalid"` or `"signature_invalid"` on failure.
   */
  verifySignature(input: unknown, domain?: SignedRequestDomain): T & CanonicalEnvelope;
  /**
   * Commit `(pubkey, timestamp, nonce)` to the replay store. Throws
   * {@link SignedRequestError} with `sub_reason: "replay_detected"` on
   * duplicate within the retention window. No-op when the verifier was built
   * with `replayStore: null` (client-side signers, single-shot tests).
   */
  recordReplay(envelope: CanonicalEnvelope): Promise<void>;
  /** Canonical bytes the signature covers, for verifiers and signers. */
  canonicalBytes(input: unknown, domain?: SignedRequestDomain): Uint8Array;
  /**
   * Build a signed request from `body` (everything except the envelope's
   * signature) and a 32-byte secp256k1 private key. The resulting `pubkey` is
   * the BIP-340 x-only form (32 bytes, hex-encoded).
   */
  signRequest(
    privkey: Uint8Array,
    body: Record<string, unknown>,
    opts?: SignedRequestSignOpts,
    domain?: SignedRequestDomain
  ): T & CanonicalEnvelope;
}

export type SignedRequestFailure =
  | "schema_invalid"
  | "timestamp_drift"
  | "signature_invalid"
  | "replay_detected";

/**
 * One definition of envelope field types shared by the runtime shape guard
 * and error disclosure classifier. Envelope failures stay private; violations
 * of the published builder input schema can be disclosed.
 */
export const SIGNED_ENVELOPE_TYPES = {
  pubkey: "string",
  signature: "string",
  timestamp: "number",
  nonce: "string",
  auth_statement: "object",
} as const satisfies Record<keyof CanonicalEnvelope, "string" | "number" | "object">;

export const SIGNED_ENVELOPE_FIELDS = Object.keys(
  SIGNED_ENVELOPE_TYPES
) as readonly (keyof CanonicalEnvelope)[];

export class SignedRequestError extends Error {
  readonly code = "auth_error" as const;
  constructor(
    message: string,
    readonly sub_reason: SignedRequestFailure,
    /**
     * The Zod issues behind a `schema_invalid`, when the failure came from a
     * `safeParse` that produced any. `authErrorBody` reads their
     * paths to tell an input violation from an envelope one, and renders the
     * input half into the caller-facing `display`. Absent on every other
     * `sub_reason`, and on the `schema_invalid` throws that aren't a parse
     * result — a non-Zod schema, or an envelope that parsed but came back
     * mistyped — both of which are envelope-side by construction.
     */
    readonly issues?: readonly z.core.$ZodIssue[]
  ) {
    super(message);
    this.name = "SignedRequestError";
  }
}

const DEFAULT_DRIFT_SECONDS = 5 * 60;
const DEFAULT_ENVELOPE_FIELDS: readonly string[] = ["signature"];
const DEFAULT_REPLAY_WINDOW_SECONDS = 10 * 60;
const DEFAULT_REPLAY_CAP = 100_000;

/**
 * Signatures cover the raw input, not Zod-parsed output. Schema validation
 * may apply defaults or transformations without changing the signed bytes.
 */
export function createSignedRequestVerifier<T = unknown>(
  schema: ZodLike<T>,
  opts: CreateSignedRequestVerifierOpts = {}
): SignedRequestVerifier<T> {
  const driftSeconds = opts.driftSeconds ?? DEFAULT_DRIFT_SECONDS;
  // The signature field is always stripped — it can't be part of its own bytes.
  const stripFields = new Set<string>([...DEFAULT_ENVELOPE_FIELDS, ...(opts.envelopeFields ?? [])]);
  // Removed before the schema sees the input, never from the signing bytes.
  const schemaIgnoreFields = new Set<string>([
    "auth_statement",
    ...(opts.schemaIgnoreFields ?? []),
  ]);
  const replayStore =
    opts.replayStore === null ? null : (opts.replayStore ?? createDefaultReplayStore());
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  function requiredDomain(domain?: SignedRequestDomain): SignedRequestDomain {
    const resolved = domain ?? opts.domain ?? testOnlySignedRequestDomain();
    if (!resolved) {
      throw new SignedRequestError("signed-request domain is required", "signature_invalid");
    }
    return resolved;
  }

  function parse(input: unknown): T & CanonicalEnvelope {
    if (!isZodSchema(schema)) {
      throw new SignedRequestError("signed-request schema must be a Zod schema", "schema_invalid");
    }
    const parsed = schema.safeParse(withoutIgnoredFields(input, schemaIgnoreFields));
    if (!parsed.success) {
      throw new SignedRequestError(
        "input did not satisfy schema",
        "schema_invalid",
        zodIssuesOf(parsed.error)
      );
    }
    const envelope = {
      ...(parsed.data as T & Partial<CanonicalEnvelope>),
      auth_statement: statementHeader(input),
    } as T & Partial<CanonicalEnvelope>;
    const mistyped = Object.entries(SIGNED_ENVELOPE_TYPES).some(
      ([field, expected]) => typeof (envelope as Record<string, unknown>)[field] !== expected
    );
    if (mistyped) {
      throw new SignedRequestError(
        `schema must include ${SIGNED_ENVELOPE_FIELDS.join("/")} envelope fields`,
        "schema_invalid"
      );
    }
    return envelope as T & CanonicalEnvelope;
  }

  function canonicalBytes(input: unknown, domain?: SignedRequestDomain): Uint8Array {
    const expected = requiredDomain(domain);
    const stripped = stripEnvelope(input, stripFields);
    const header = statementHeader(input);
    if (!signedRequestHeaderMatchesDomain(header, expected)) {
      throw new SignedRequestError("signed-request domain does not match", "signature_invalid");
    }
    return canonicalSignedRequestStatement(header, stripped as Record<string, unknown>);
  }

  function checkAuth(input: unknown, domain?: SignedRequestDomain): T & CanonicalEnvelope {
    const envelope = parse(input);
    const t = now();
    if (Math.abs(t - envelope.timestamp) > driftSeconds) {
      throw new SignedRequestError(
        "timestamp drift exceeds the permitted window",
        "timestamp_drift"
      );
    }
    if (!verifyBytes(canonicalBytes(input, domain), envelope.signature, envelope.pubkey)) {
      throw new SignedRequestError("signature verification failed", "signature_invalid");
    }
    return envelope;
  }

  function verifySignature(input: unknown, domain?: SignedRequestDomain): T & CanonicalEnvelope {
    const envelope = parse(input);
    if (!verifyBytes(canonicalBytes(input, domain), envelope.signature, envelope.pubkey)) {
      throw new SignedRequestError("signature verification failed", "signature_invalid");
    }
    return envelope;
  }

  async function recordReplay(envelope: CanonicalEnvelope): Promise<void> {
    if (!replayStore) return;
    const t = now();
    if (await replayStore.checkAndRecord(envelope.pubkey, envelope.timestamp, envelope.nonce, t)) {
      throw new SignedRequestError(
        "duplicate (pubkey, timestamp, nonce) in replay window",
        "replay_detected"
      );
    }
  }

  function signRequest(
    privkey: Uint8Array,
    body: Record<string, unknown>,
    signOpts?: SignedRequestSignOpts,
    domain?: SignedRequestDomain
  ): T & CanonicalEnvelope {
    const pubkey = bytesToHex(schnorr.getPublicKey(privkey));
    const timestamp = signOpts?.timestamp ?? now();
    const nonce = signOpts?.nonce ?? randomNonce();
    // The body stays raw; signing fills the protocol envelope.
    const unsigned: Record<string, unknown> = {
      pubkey,
      timestamp,
      nonce,
      ...body,
    };
    const authStatement = signedRequestStatementHeader(requiredDomain(domain));
    const signature = bytesToHex(
      schnorr.sign(canonicalBytes({ ...unsigned, auth_statement: authStatement }, domain), privkey)
    );
    return { ...unsigned, auth_statement: authStatement, signature } as T & CanonicalEnvelope;
  }

  return { checkAuth, verifySignature, recordReplay, canonicalBytes, signRequest };
}

/**
 * Raw structured input for authentication and durable replay. data wins;
 * otherwise input is parsed as JSON, with absent/legacy text becoming {}.
 * Builder validation may transform the handler input but cannot rewrite these
 * signing bytes, including protocol-owned credit fields.
 */
export function signedRequestInput(body: { input?: string; data?: unknown }): unknown {
  if (body.data !== undefined) return body.data;
  if (typeof body.input === "string" && body.input.length > 0) {
    try {
      return JSON.parse(body.input);
    } catch {
      return {};
    }
  }
  return {};
}

/** Validation-only stripping; canonical bytes retain the untouched raw input. */
function withoutIgnoredFields(input: unknown, ignore: Set<string>): unknown {
  if (ignore.size === 0) return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const entries = Object.entries(input as Record<string, unknown>);
  if (!entries.some(([key]) => ignore.has(key))) return input;
  return Object.fromEntries(entries.filter(([key]) => !ignore.has(key)));
}

function stripEnvelope(input: unknown, stripFields: Set<string>): JsonValue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input as JsonValue;
  }
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (stripFields.has(k) || k === "auth_statement") continue;
    if (v === undefined) continue;
    out[k] = v as JsonValue;
  }
  return out;
}

function statementHeader(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return (input as Record<string, unknown>).auth_statement;
}

function verifyBytes(bytes: Uint8Array, signatureHex: string, pubkeyHex: string): boolean {
  try {
    return schnorr.verify(hexToBytes(signatureHex), bytes, hexToBytes(pubkeyHex));
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function randomNonce(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the bounded in-memory FIFO replay store used as the default when no
 * cross-machine `SignedRequestReplayStore` is supplied. 10-minute retention
 * window, 100k entry cap, per-process. Exported so `secp256k1Auth(...)` can
 * pre-build one and share it across every per-schema verifier plus its own
 * `recordReplay` path.
 *
 * When the cap is hit after the time-expired sweep, fresh inserts are
 * **rejected** (return `true` — treated as replay at the wire) rather than
 * silently evicting an in-window entry. Silent eviction would flush a
 * still-valid nonce back to "unseen" and let an attacker who can drive cap
 * pressure replay it. A rate-limited structured warning fires so
 * operators see saturation in `fly logs`; reaching cap means in-memory has
 * been pushed past where it's safe and the deploy should move to
 * `PostgresReplayStore`.
 */
export function createDefaultReplayStore(): SignedRequestReplayStore {
  const entries = new Map<string, number>();
  let lastSaturationWarnAt = 0;
  return {
    checkAndRecord(pubkey, timestamp, nonce, t) {
      const key = `${pubkey}|${timestamp.toString()}|${nonce}`;
      // Evict expired entries in insertion order (Map preserves it).
      const cutoff = t - DEFAULT_REPLAY_WINDOW_SECONDS;
      for (const [k, recordedAt] of entries) {
        if (recordedAt >= cutoff) break;
        entries.delete(k);
      }
      if (entries.has(key)) return Promise.resolve(true);
      if (entries.size >= DEFAULT_REPLAY_CAP) {
        if (t - lastSaturationWarnAt >= SATURATION_WARN_INTERVAL_SECONDS) {
          lastSaturationWarnAt = t;
          diagnosticConsole.warn(
            {
              level: "warn",
              event: "signed_request_replay_store_saturated",
              message:
                undefined,
              cap: DEFAULT_REPLAY_CAP,
              window_seconds: DEFAULT_REPLAY_WINDOW_SECONDS,
            }
          );
        }
        return Promise.resolve(true);
      }
      entries.set(key, t);
      return Promise.resolve(false);
    },
  };
}

const SATURATION_WARN_INTERVAL_SECONDS = 60;
