import {
  SIGNED_REQUEST_AUTH_ID,
  type SignedRequestDomain,
} from "../../lib/signed-request-statement";
import type { ZodLike } from "../types";
import { protocolEnvelopeIgnoreFields } from "./request-envelope";
import type {
  CanonicalEnvelope,
  SignedRequestReplayStore,
  SignedRequestVerifier,
} from "./signed-request";
import {
  createDefaultReplayStore,
  createSignedRequestVerifier,
  SignedRequestError,
} from "./signed-request";

/**
 * Boot-summary backend: postgres is shared across machines; memory is per-process.
 * Explicit user-supplied stores and null (disabled) are never overridden.
 */
export type ReplayStoreBackend = "postgres" | "memory" | "user-supplied" | "disabled";

/**
 * Auth runs before payment; replay commits after accepted upfront payment.
 * Custom schemes must validate builder input while tolerating signed protocol
 * fields (credit, recovery and auth statement) outside the builder schema.
 */
export interface DVMAuthScheme {
  /** Wire-level identifier surfaced on `/v1/info#auth`. */
  readonly id: typeof SIGNED_REQUEST_AUTH_ID;
  /**
   * Also serve `POST /v1/job` bodies carrying no envelope field when the job
   * is paid per call. Such jobs run as the anonymous requester with no
   * `ctx.auth`, credit fields or recovery id; free capabilities stay signed-only.
   */
  readonly allowUnsignedPaid?: boolean;
  /** Schema + drift + signature check at request entry. No replay-store touch. */
  checkAuth<T>(
    schema: ZodLike<T>,
    input: unknown,
    domain?: SignedRequestDomain
  ): { pubkey: string; envelope: T & CanonicalEnvelope };
  /**
   * Reactivation validates schema and signature without timestamp drift or replay
   * checks: the original timestamp and already-committed nonce must remain usable.
   * Throws signature_invalid or schema_invalid on failed validation.
   */
  recheckSignature<T>(schema: ZodLike<T>, input: unknown, domain?: SignedRequestDomain): void;
  /** Commit the envelope's `(pubkey, timestamp, nonce)` to the replay store. Throws on duplicate. */
  recordReplay(envelope: CanonicalEnvelope): Promise<void>;
  /**
   * Called by `createDVMHost` after the Postgres pool is resolved.
   * The SDK passes a Postgres store when one is available; the scheme adopts
   * it iff the user did not supply `replayStore` explicitly at factory time.
   * Returns the resolved backend for boot-summary logging. User code should
   * not call this — it's a host-boot wiring seam.
   */
  resolveReplayStore?(opts: { postgresStore?: SignedRequestReplayStore }): ReplayStoreBackend;
}

export interface Secp256k1AuthOpts {
  /**
   * Omitting this lets the host adopt Postgres, otherwise falling back to a
   * bounded per-process store with a warning or fail-fast refusal outside dev mode.
   * Any explicit store, including null to disable replay tracking, is locked.
   */
  replayStore?: SignedRequestReplayStore | null;
  /** Permitted clock drift in seconds. Defaults to 300 (5 minutes). */
  driftSeconds?: number;
  /** Current Unix-seconds source. Defaults to `() => Math.floor(Date.now() / 1000)`. */
  now?: () => number;
  /**
   * Accept an unsigned `POST /v1/job` (no `pubkey`, `signature`, `timestamp`,
   * `nonce` or `auth_statement`) when the job requires a per-call Cashu
   * payment, and advertise `["secp256k1-schnorr-v2", "none"]` on `/v1/info#auth`. A body
   * carrying any envelope field is verified as before and never falls back.
   * Unsigned calls take Cashu, plus exact x402 on a capability that sets
   * `maxRuntimeSeconds` when the DVM has Postgres: that payment is verified
   * before the job and sent for settlement only if the job succeeds, so a
   * failed or timed-out job costs the payer nothing. Their 402 and mid-job
   * asks offer no credit menu (mid-job asks offer Cashu alone), and any other
   * x402 payment, or a Tempo payment, is refused with
   * `payment_method_requires_signature` before any settlement. A Cashu token is
   * the payment, so a failed job keeping it is ordinary Cashu behaviour.
   * Tempo stays signed-only: a push-mode credential is already broadcast when
   * the DVM sees it. A DVM with neither unsigned rail serves no unsigned
   * calls. Signed callers keep every rail.
   * Unsigned jobs run as the anonymous requester: the handler sees no
   * `ctx.auth`, the input omits the envelope fields, prepaid credit and
   * `request_id` recovery are refused, a payer whose response is lost recovers
   * the job only by retrying with the same Cashu proofs, `X-Cashu-Request-Id`
   * and body (a request id belongs to the first proofs banked under it, and a
   * signed caller's job never recovers unsigned), and money released by a failed job
   * lands on the shared anonymous requester. A dynamic-priced capability's `onQuote`
   * handler runs for these anonymous callers with no `callerPubkey`, so an
   * unauthenticated request can now trigger it, including any upstream calls
   * it makes. The capability input must be a plain
   * `z.object` schema so its envelope fields can be removed; any other schema
   * keeps that capability signed-only. Defaults to false.
   */
  allowUnsignedPaid?: boolean;
}

/**
 * One scheme covers all capabilities and shares their replay store. Per-schema
 * verifiers validate without touching replay state; the host commits replay
 * only after upfront payment verification, immediately before job creation.
 */
export function secp256k1Auth(opts: Secp256k1AuthOpts = {}): DVMAuthScheme {
  // The per-process default is replaceable at host boot. Any explicit store,
  // including null, locks the choice.
  const userExplicit = opts.replayStore !== undefined;
  let replayStore: SignedRequestReplayStore | null =
    opts.replayStore === null ? null : (opts.replayStore ?? createDefaultReplayStore());
  const driftSeconds = opts.driftSeconds;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  // Per-schema verifiers cache compiled checkers. They never touch the
  // replay store (replay is committed by this scheme's own `recordReplay`),
  // so the cached verifiers stay valid across a late `resolveReplayStore`
  // swap — only the closure variable above needs to change.
  const verifiers = new WeakMap<ZodLike, SignedRequestVerifier<unknown>>();
  function getVerifier<T>(schema: ZodLike<T>): SignedRequestVerifier<T> {
    const cached = verifiers.get(schema as ZodLike);
    if (cached) return cached as SignedRequestVerifier<T>;
    const v = createSignedRequestVerifier<T>(schema, {
      replayStore: null,
      driftSeconds,
      now,
      // the caller signs over the credit envelope, so it has to be in
      // the canonical bytes — but it is protocol-level, not capability input, so
      // the builder's schema must not have to tolerate it. Resolved once per
      // schema, cached with the verifier below.
      schemaIgnoreFields: protocolEnvelopeIgnoreFields(schema),
    });
    verifiers.set(schema as ZodLike, v as SignedRequestVerifier<unknown>);
    return v;
  }

  return {
    id: SIGNED_REQUEST_AUTH_ID,
    allowUnsignedPaid: opts.allowUnsignedPaid === true,
    checkAuth<T>(schema: ZodLike<T>, input: unknown, domain?: SignedRequestDomain) {
      const envelope = getVerifier(schema).checkAuth(input, domain);
      return { pubkey: envelope.pubkey, envelope };
    },
    recheckSignature<T>(schema: ZodLike<T>, input: unknown, domain?: SignedRequestDomain): void {
      getVerifier(schema).verifySignature(input, domain);
    },
    async recordReplay(envelope: CanonicalEnvelope): Promise<void> {
      if (replayStore === null) return;
      const t = now();
      if (
        await replayStore.checkAndRecord(envelope.pubkey, envelope.timestamp, envelope.nonce, t)
      ) {
        throw new SignedRequestError(
          "duplicate (pubkey, timestamp, nonce) in replay window",
          "replay_detected"
        );
      }
    },
    resolveReplayStore({ postgresStore }): ReplayStoreBackend {
      if (userExplicit) {
        return replayStore === null ? "disabled" : "user-supplied";
      }
      if (postgresStore) {
        replayStore = postgresStore;
        return "postgres";
      }
      return "memory";
    },
  };
}
