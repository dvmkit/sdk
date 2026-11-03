/* Card-credit test support: a DVM with the real mppx stripe method, HMAC binding and ledger,
 * against a fake Stripe that simulates only the PaymentIntent endpoint. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { Challenge, Credential } from "mppx";
import { expect } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../../configure";
import type { FxFetcher } from "../../../pricing/index";
import { MemoryKVStore } from "../../../store";
import { createDVMServer, type SDKServerOpts } from "../../app";
import type { CreditLedgerLike } from "../../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../../credit-routes";
import { fundingCommitment } from "../../funding";
import { MemoryJobStore } from "../../memory-job-store";
import { createMppFromOpts } from "../../mpp-setup";
import type { CreditDepositPayload } from "../../revenue-reporter";
import { secp256k1Auth } from "../../secp256k1-auth";
import { createSignedRequestVerifier } from "../../signed-request";
import { createStripeCreditRail } from "../../stripe-credit";
import { durableLedger } from "./credit-fixtures";

export const HMAC = "44".repeat(32);
export const PRIVKEY = new Uint8Array(32).fill(13);
export const CALLER = Buffer.from(schnorr.getPublicKey(PRIVKEY)).toString("hex");
const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);
const jobInput = z.object({
  pubkey: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
});
export const jobSigner = createSignedRequestVerifier(jobInput);
// Card top-ups are charged in cents; a rate lookup on that path is a defect.
export const noRateFx: FxFetcher = {
  fetch: () => Promise.reject(new Error("a card top-up must not need a rate")),
  supportedCurrencies: () => ["usd"],
};
export const rateFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-11-01T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

interface StripeCall {
  idempotencyKey: string | null;
  body: URLSearchParams;
}

/** An SPT in Stripe's own error text: what must never reach a log line or a response. */
export const LEAKY_SPT = "spt_1SecretBearerValue";

type FakeStripeMode =
  | "succeed"
  | "decline"
  /** Creates the PaymentIntent, then drops the connection once: the outcome is unknown. */
  | "lose-first-response"
  /** Stripe's 400 for a used, over-limit or unknown token; its message quotes the token. */
  | "unusable-token"
  /** Reports a PaymentIntent for a different amount than the one requested. */
  | "wrong-amount";

/** Stripe's PaymentIntent create: idempotent on the key, or one of the failure shapes. */
export function fakeStripe(mode: FakeStripeMode = "succeed", idPrefix = "pi_test_") {
  let responseLost = false;
  const calls: StripeCall[] = [];
  const intents = new Map<string, string>();
  const intentParams = new Map<string, string>();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const idempotencyKey = headers.get("Idempotency-Key");
    const body = new URLSearchParams(init?.body as URLSearchParams);
    calls.push({ idempotencyKey, body });
    if (mode === "decline") {
      return Response.json(
        {
          error: {
            type: "card_error",
            code: "card_declined",
            decline_code: "generic_decline",
            message: `Your card was declined. (${LEAKY_SPT})`,
          },
        },
        { status: 402 }
      );
    }
    if (mode === "unusable-token") {
      return Response.json(
        {
          error: {
            type: "invalid_request_error",
            code: "resource_missing",
            message: `No such shared_payment_token: '${LEAKY_SPT}'`,
          },
        },
        { status: 400 }
      );
    }
    const key = idempotencyKey ?? `anon-${calls.length}`;
    const replayed = intents.has(key);
    const fingerprint = JSON.stringify([...body].sort(([a], [b]) => a.localeCompare(b)));
    if (replayed && intentParams.get(key) !== fingerprint) {
      return Response.json({ error: { type: "idempotency_error" } }, { status: 400 });
    }
    if (!replayed) {
      intents.set(key, `${idPrefix}${intents.size + 1}`);
      intentParams.set(key, fingerprint);
    }
    if (mode === "lose-first-response" && !responseLost) {
      responseLost = true;
      throw new TypeError(`fetch failed: socket hang up (${LEAKY_SPT})`);
    }
    const amount = Number(body.get("amount")) + (mode === "wrong-amount" ? 1 : 0);
    return Response.json(
      { id: intents.get(key), status: "succeeded", amount, currency: body.get("currency") },
      { headers: replayed ? { "idempotent-replayed": "true" } : {} }
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export async function cardServer(
  opts: {
    stripe?: ReturnType<typeof fakeStripe> | null;
    ledger?: CreditLedgerLike;
    deposits?: CreditDepositPayload[];
    fx?: FxFetcher;
    serverOpts?: Partial<SDKServerOpts>;
  } = {}
) {
  const stripe = opts.stripe === undefined ? fakeStripe() : opts.stripe;
  const ledger = opts.ledger ?? durableLedger();
  const dvm = configureDVM({
    name: "card-credit",
    capability: "run",
    input: jobInput,
    auth: secp256k1Auth(),
    price: "$0.10",
    credit: { min: "$0.10", max: "$5.00" },
    onJob(ctx) {
      ctx.complete("done");
    },
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    creditLedger: ledger,
    fxFetcher: opts.fx ?? noRateFx,
    // A Tempo handle sits beside the card rail so the job surface has MPP challenges to issue.
    mpp: createMppFromOpts(
      { tempoRecipient: "0x1111111111111111111111111111111111111111" },
      { DVMKIT_TEMPO_SECRET_KEY: HMAC }
    ),
    ...(stripe && {
      stripeCredit: createStripeCreditRail({
        secretKey: "sk_test_fake",
        networkId: "profile_test",
        hmacSecret: HMAC,
        apiBase: "https://stripe.invalid",
        fetch: stripe.fetchImpl,
      }),
    }),
    ...(opts.deposits && {
      dvmId: "dvm-card",
      onCreditFunded: (info) => {
        opts.deposits?.push(info);
      },
    }),
    ...opts.serverOpts,
  });
  return { app, ledger, stripe };
}

export type App = Awaited<ReturnType<typeof cardServer>>["app"];

export async function fund(
  app: App,
  args: { fundId: string; amountMicro?: number; credential?: string; commitment?: string; creditId?: string }
): Promise<Response> {
  const commitment =
    args.commitment ?? (args.credential ? fundingCommitment(args.credential) : "00".repeat(32));
  return app.request("/v1/credit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(args.credential && { Authorization: args.credential }),
    },
    body: JSON.stringify(
      creditSigner.signRequest(PRIVKEY, {
        op: "fund",
        ...(args.creditId && { credit_id: args.creditId }),
        fund: {
          amount_micro: args.amountMicro ?? 600_000,
          fund_id: args.fundId,
          commitment,
          method: "stripe",
        },
      })
    ),
  });
}

export function paymentChallenges(response: Response): Challenge.Challenge[] {
  const header = response.headers.get("WWW-Authenticate") ?? "";
  return header
    .split(/,\s*(?=Payment\s)/i)
    .filter(Boolean)
    .map((value) => Challenge.deserialize(value));
}

export async function drain(
  app: App,
  args: { creditId: string; drainId: string; method: string; payout: Record<string, string> }
): Promise<Response> {
  return app.request("/v1/credit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      creditSigner.signRequest(PRIVKEY, {
        op: "drain",
        credit_id: args.creditId,
        drain: { drain_id: args.drainId, method: args.method, payout: args.payout },
      })
    ),
  });
}

/** What the caller's agent builds from the 402 and the token its human approved. */
export async function credentialFor(app: App, fundId: string, amountMicro = 600_000): Promise<string> {
  const discovery = await fund(app, { fundId, amountMicro });
  expect(discovery.status).toBe(402);
  const [challenge] = paymentChallenges(discovery);
  return Credential.serialize(Credential.from({ challenge: challenge!, payload: { spt: "spt_test" } }));
}

