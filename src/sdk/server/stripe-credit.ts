import { randomBytes } from "node:crypto";

import type { Challenge } from "mppx";
import { Credential, Errors as MppxErrors, PaymentRequest } from "mppx";
import { Mppx } from "mppx/server";
import { charge as stripeCharge } from "mppx/stripe/server";

import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { CardChargeJournal } from "./card-charge-journal";
import { MPPX_HMAC_MISMATCH_REASON } from "./mpp-setup";
import { fiatMicroToMethodAmount } from "./mpp-units";
import { createStripeRefundApi, type StripeRefundApi } from "./stripe-refund-api";

/** The env vars that opt a DVM into card-funded credit. */
export interface StripeCreditConfig {
  /** Seller's Stripe secret key; the charge lands in this account. */
  secretKey: string;
  /** Seller's Stripe network profile id, echoed to the caller for its spend request. */
  networkId: string;
  /** MPP challenge-binding HMAC secret, shared with Tempo. */
  hmacSecret: string;
}

/**
 * Read card-credit configuration from the environment. Neither variable set
 * means the DVM does not offer card credit and behaves exactly as before. A
 * half-configured DVM fails at startup rather than silently dropping the rail.
 */
export function stripeCreditConfigFromEnv(
  env: Record<string, string | undefined>
): StripeCreditConfig | undefined {
  const secretKey = env.DVMKIT_STRIPE_SECRET_KEY?.trim();
  const networkId = env.DVMKIT_STRIPE_NETWORK_ID?.trim();
  if (!secretKey && !networkId) return undefined;
  if (!secretKey) {
    throw new Error(
      "DVMKIT_STRIPE_NETWORK_ID is set but DVMKIT_STRIPE_SECRET_KEY is not. Card credit needs both."
    );
  }
  if (!networkId) {
    throw new Error(
      "DVMKIT_STRIPE_SECRET_KEY is set but DVMKIT_STRIPE_NETWORK_ID is not. Card credit needs both: the network id is your Stripe profile id (profile_…)."
    );
  }
  const hmacSecret = env.DVMKIT_TEMPO_SECRET_KEY;
  if (!hmacSecret) {
    throw new Error(
      "Card credit requires DVMKIT_TEMPO_SECRET_KEY: it binds MPP challenges for both Tempo and card credit. Generate one with 'openssl rand -hex 32'."
    );
  }
  return { secretKey, networkId, hmacSecret };
}

/** Stripe's own error classification: enums, never Stripe's free-text message. */
export interface StripeErrorCodes {
  type?: string;
  code?: string;
  declineCode?: string;
}

/** What one charge attempt established. */
export type StripeChargeOutcome =
  | {
      ok: true;
      /** The PaymentIntent id: the funding's settlement reference and replay key. */
      paymentIntentId: string;
      /** Stripe answered from its idempotency cache: this credential was charged before. */
      replayed: boolean;
    }
  | {
      ok: false;
      /**
       * `invalid_credential`: refused before any Stripe call (binding, expiry, amount).
       * `declined`: Stripe refused the card; nothing was charged.
       * `requires_action`: the card needs an authentication step the agent cannot do.
       * `token_unusable`: Stripe rejected the token itself (already used, over its approved
       * limit, unknown); nothing was charged.
       * `mismatch`: Stripe reported a PaymentIntent whose amount or currency is not this
       * top-up's. It is not booked.
       * `indeterminate`: the charge may or may not exist.
       * `unavailable`: refused before any Stripe call because the charge attempt could not
       * be journaled; nothing was charged and the same credential can be resent.
       */
      reason:
        | "unavailable"
        | "invalid_credential"
        | "declined"
        | "requires_action"
        | "token_unusable"
        | "mismatch"
        | "indeterminate";
      /**
       * A fixed description of the category. Never upstream text: Stripe's and mppx's
       * messages can quote the shared payment token, which is a bearer credential.
       */
      message: string;
      stripeError?: StripeErrorCodes;
      /**
       * A PaymentIntent Stripe reported on a failed or unconfirmed attempt. It is what a
       * later reconciliation of unbooked charges looks up.
       */
      paymentIntentId?: string;
    };

/**
 * Card-credit rail with optional server-owned `dvmkit_dvm_id` PaymentIntent metadata.
 * Separate from the Tempo MPP handle on purpose: no job
 * surface ever holds it, so `/v1/job` cannot issue or accept a stripe challenge.
 */
export interface StripeCreditRail {
  networkId: string;
  /** Issue a `method="stripe"` charge challenge for a top-up of `amountMicro` USD micro. */
  issueChallenge(args: {
    amountMicro: number;
    resourcePath: string;
    /** ISO timestamp; the upfront challenge window, shared with Tempo. */
    expires: string;
  }): Promise<Challenge.Challenge>;
  /** Verify the credential against this top-up and charge the token once. */
  charge(
    credential: string,
    args: {
      amountMicro: number;
      resourcePath: string;
      /** Server-resolved identity for `metadata[dvmkit_dvm_id]`; omitted for standalone servers. */
      canonicalDvmId?: string;
    }
  ): Promise<StripeChargeOutcome>;
  /** The same Stripe account's refund, dispute and lookup calls, for returning card credit. */
  refunds: StripeRefundApi;
  /** The charge-attempt journal the sweep reads to find charges that were never booked. */
  chargeJournal?: CardChargeJournal;
}

export interface CreateStripeCreditRailOpts extends StripeCreditConfig {
  /**
   * The HMAC secret that was active before the last `DVMKIT_TEMPO_SECRET_KEY` rotation,
   * while its window is open. A credential bound under it is still verified, so a resend
   * across a redeploy can book the charge it made.
   */
  previousHmacSecret?: () => Promise<string | undefined>;
  /**
   * Where each charge attempt's challenge id is noted before Stripe is called, so a charge
   * that is never booked can be found and refunded. See {@link CardChargeJournal}.
   */
  chargeJournal?: CardChargeJournal;
  /** Stripe API origin. Tests point it at a local fake. */
  apiBase?: string;
  fetch?: typeof fetch;
}

/**
 * Build the card-credit rail on mppx's Stripe charge method.
 *
 * mppx owns the challenge, its HMAC binding, expiry, the amount check and the
 * PaymentIntent parameters except the server-owned `dvmkit_dvm_id` metadata,
 * including the idempotency key `mppx_<challengeId>_<spt>`.
 * This module owns the HTTP call because
 * mppx refuses a Stripe idempotent replay as "already processed", which would
 * leave a charge that succeeded before a crash permanently unbooked. Reporting
 * the replayed PaymentIntent as an ordinary success lets a retry of the same
 * credential book it; the ledger's processed-payment marker on the
 * PaymentIntent id is what stops a replay from booking twice.
 */
export function createStripeCreditRail(opts: CreateStripeCreditRailOpts): StripeCreditRail {
  const apiBase = opts.apiBase ?? "https://api.stripe.com";
  const fetchImpl = opts.fetch ?? fetch;
  const build = (client: StripeClientLike, secretKey: string) =>
    Mppx.create({
      methods: [
        stripeCharge({
          client,
          networkId: opts.networkId,
          paymentMethodTypes: ["card"],
          currency: "usd",
          decimals: 2,
        }),
      ],
      secretKey,
    });
  const issuer = build(unusedClient, opts.hmacSecret);

  return {
    networkId: opts.networkId,
    refunds: createStripeRefundApi({ secretKey: opts.secretKey, apiBase, fetch: fetchImpl }),
    ...(opts.chargeJournal && { chargeJournal: opts.chargeJournal }),

    async issueChallenge({ amountMicro, resourcePath, expires }) {
      return issuer.challenge.stripe.charge({
        amount: fiatMicroToMethodAmount(amountMicro, "stripe"),
        expires,
        meta: { path: resourcePath, nonce: randomBytes(16).toString("hex") },
      });
    },

    async charge(serialized, { amountMicro, resourcePath, canonicalDvmId }) {
      let credential: ReturnType<typeof Credential.deserialize>;
      try {
        credential = Credential.deserialize(serialized);
      } catch {
        return invalidCredential("the credential is not a well-formed MPP credential");
      }
      if (credential.challenge.method !== "stripe" || credential.challenge.intent !== "charge") {
        return invalidCredential("the credential is not for a stripe charge challenge");
      }
      const attempt: ChargeAttempt = {};
      // Journaled only once mppx has verified the challenge and is about to call Stripe, so a
      // forged or expired credential leaves no row for the stranded-charge search to chase.
      // No row, no charge: a charge the journal never saw could not be found and refunded
      // if its booking then failed.
      const journal = opts.chargeJournal;
      const beforeCharge = journal
        ? async () => {
            try {
              await journal.record(credential.challenge.id);
            } catch (err) {
              attempt.journalFailed = true;
              diagnosticConsole.warn({ event: "card_charge_journal_failed" });
              throw err;
            }
          }
        : undefined;
      // The decimal amount ("0.60"); mppx turns it into cents for Stripe.
      const amount = fiatMicroToMethodAmount(amountMicro, "stripe");
      const broadcast = (secretKey: string) =>
        build(fetchClient({ apiBase, secretKey: opts.secretKey, fetchImpl, attempt, beforeCharge, canonicalDvmId }), secretKey)
          .broadcastCredential(serialized, {
            request: { amount },
            meta: { path: resourcePath, nonce: readNonce(credential.challenge) },
          });
      try {
        let receipt;
        try {
          receipt = await broadcast(opts.hmacSecret);
        } catch (err) {
          const previous = !attempt.called && isHmacMismatch(err)
            ? await opts.previousHmacSecret?.()
            : undefined;
          if (!previous) throw err;
          receipt = await broadcast(previous);
        }
        if (!attempt.paymentIntentId || receipt.reference !== attempt.paymentIntentId) {
          return {
            ok: false,
            reason: "indeterminate",
            message: "the charge succeeded without a PaymentIntent this server observed",
          };
        }
        if (attempt.amount !== amountMicro / 10_000 || attempt.currency !== "usd") {
          return {
            ok: false,
            reason: "mismatch",
            message: "the PaymentIntent's amount or currency is not this top-up's",
            paymentIntentId: attempt.paymentIntentId,
          };
        }
        return { ok: true, paymentIntentId: attempt.paymentIntentId, replayed: attempt.replayed === true };
      } catch (err) {
        if (attempt.journalFailed) {
          return {
            ok: false,
            reason: "unavailable",
            message: "the charge attempt could not be recorded, so this request did not charge the card",
          };
        }
        if (!attempt.called) return invalidCredential(credentialFailure(err));
        const stripeError = attempt.failure?.codes;
        const known = {
          ...(stripeError && { stripeError }),
          ...(attempt.paymentIntentId && { paymentIntentId: attempt.paymentIntentId }),
        };
        if (stripeError?.type === "card_error") {
          return { ok: false, reason: "declined", message: "the card was declined", ...known };
        }
        if (attempt.failure?.status === 400 && stripeError?.type === "invalid_request_error") {
          return {
            ok: false,
            reason: "token_unusable",
            message: "Stripe refused the shared payment token; nothing was charged",
            ...known,
          };
        }
        if (attempt.status === "requires_action") {
          return {
            ok: false,
            reason: "requires_action",
            message: "the card requires an authentication step",
            ...known,
          };
        }
        return {
          ok: false,
          reason: "indeterminate",
          message: attempt.failure
            ? `Stripe answered HTTP ${attempt.failure.status} without confirming the charge`
            : attempt.status
              ? `the PaymentIntent is ${attempt.status}, not succeeded`
              : "Stripe could not be reached or its answer was lost",
          ...known,
        };
      }
    },
  };
}

/** The slice of the Stripe SDK client mppx calls. */
interface StripeClientLike {
  paymentIntents: {
    create(
      params: Record<string, unknown>,
      options: { apiVersion?: string; idempotencyKey?: string; stripeAccount?: string }
    ): Promise<{ id: string; status: string }>;
  };
}

interface ChargeAttempt {
  called?: boolean;
  /** The journal write failed after verification; Stripe was never called. */
  journalFailed?: boolean;
  paymentIntentId?: string;
  status?: string;
  amount?: number;
  currency?: string;
  replayed?: boolean;
  failure?: { status: number; codes: StripeErrorCodes };
}

const unusedClient: StripeClientLike = {
  paymentIntents: {
    create() {
      return Promise.reject(new Error("the challenge issuer never charges"));
    },
  },
};

function fetchClient(args: {
  apiBase: string;
  secretKey: string;
  fetchImpl: typeof fetch;
  attempt: ChargeAttempt;
  beforeCharge?: () => Promise<void>;
  canonicalDvmId?: string;
}): StripeClientLike {
  return {
    paymentIntents: {
      async create(params, options) {
        await args.beforeCharge?.();
        const form = formEncode(params);
        // Reserve this key for server configuration, including when no identity is configured.
        form.delete("metadata[dvmkit_dvm_id]");
        if (args.canonicalDvmId) form.set("metadata[dvmkit_dvm_id]", args.canonicalDvmId);
        args.attempt.called = true;
        const send = async (requestBody: URLSearchParams) => {
          const response = await args.fetchImpl(`${args.apiBase}/v1/payment_intents`, {
            method: "POST",
            headers: {
              Authorization: `Basic ${Buffer.from(`${args.secretKey}:`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
              ...(options.idempotencyKey && { "Idempotency-Key": options.idempotencyKey }),
              ...(options.apiVersion && { "Stripe-Version": options.apiVersion }),
              ...(options.stripeAccount && { "Stripe-Account": options.stripeAccount }),
            },
            body: requestBody,
          });
          const body = (await response.json().catch(() => ({}))) as {
            id?: unknown;
            status?: unknown;
            amount?: unknown;
            currency?: unknown;
            error?: { type?: unknown; code?: unknown; decline_code?: unknown; payment_intent?: { id?: unknown } };
          };
          return { response, body };
        };
        let { response, body } = await send(form);
        if (response.status === 400 && body.error?.type === "idempotency_error" &&
          options.idempotencyKey && args.canonicalDvmId) {
          // A pre-upgrade charge has no identity metadata. Retry its original parameters
          // once under the same key so a lost response or booking can still be recovered.
          const legacyForm = new URLSearchParams(form);
          legacyForm.delete("metadata[dvmkit_dvm_id]");
          ({ response, body } = await send(legacyForm));
        }
        if (!response.ok) {
          const enumField = (value: unknown) =>
            typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined;
          const type = enumField(body.error?.type);
          const code = enumField(body.error?.code);
          const declineCode = enumField(body.error?.decline_code);
          args.attempt.failure = {
            status: response.status,
            codes: { ...(type && { type }), ...(code && { code }), ...(declineCode && { declineCode }) },
          };
          const intent = body.error?.payment_intent?.id;
          if (typeof intent === "string" && /^pi_[A-Za-z0-9]+$/.test(intent)) {
            args.attempt.paymentIntentId = intent;
          }
          // A fixed message: Stripe's own text can quote the shared payment token.
          throw new Error(`Stripe answered HTTP ${response.status}`);
        }
        if (typeof body.id !== "string" || typeof body.status !== "string") {
          throw new Error("Stripe returned a PaymentIntent without an id or status");
        }
        args.attempt.paymentIntentId = body.id;
        args.attempt.status = body.status;
        if (typeof body.amount === "number") args.attempt.amount = body.amount;
        if (typeof body.currency === "string") args.attempt.currency = body.currency;
        args.attempt.replayed = response.headers.get("idempotent-replayed") === "true";
        // No `lastResponse`: mppx would refuse an idempotent replay outright.
        return { id: body.id, status: body.status };
      },
    },
  };
}

/** Stripe's form encoding: nested objects as `a[b]=c`, arrays as `a[0]=c`. */
function formEncode(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const visit = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(`${key}[${index}]`, item));
    } else if (typeof value === "object") {
      for (const [child, nested] of Object.entries(value)) visit(`${key}[${child}]`, nested);
    } else {
      out.set(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(params)) visit(key, value);
  return out;
}

/**
 * The challenge's server nonce, read from the HMAC-bound `opaque` form a
 * deserialized credential carries (the same source mppx compares against). A
 * missing nonce rebuilds a challenge that fails mppx's binding check, which is
 * the right refusal.
 */
function readNonce(challenge: Challenge.Challenge): string {
  let meta: Record<string, unknown> | undefined;
  try {
    meta = challenge.opaque
      ? (PaymentRequest.deserialize(challenge.opaque) as Record<string, unknown>)
      : challenge.meta;
  } catch {
    return "";
  }
  return typeof meta?.nonce === "string" ? meta.nonce : "";
}

function invalidCredential(message: string): StripeChargeOutcome {
  return { ok: false, reason: "invalid_credential", message };
}

/** A fixed description of why mppx refused the credential before charging. */
function credentialFailure(err: unknown): string {
  if (isHmacMismatch(err)) return "the challenge was not issued by this server";
  if (err instanceof MppxErrors.PaymentExpiredError) return "the challenge has expired";
  return "the credential does not match this top-up's challenge";
}

function isHmacMismatch(err: unknown): boolean {
  return (
    err instanceof MppxErrors.InvalidChallengeError &&
    err.message.includes(MPPX_HMAC_MISMATCH_REASON)
  );
}
