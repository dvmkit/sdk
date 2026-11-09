import {
  assertPaymentRequiredFits,
  X402_SIZE_CHECK_AMOUNT,
  X402_SIZE_CHECK_ERROR,
  X402_SIZE_CHECK_ORIGIN,
  X402_SIZE_CHECK_TIMEOUT_SECONDS,
  x402ChannelPaymentRequired,
} from "../../lib/x402/bazaar";
import { X402_DEFAULT_FACILITATOR_TIMEOUT_MS } from "../../lib/x402/facilitator-request";
import { callerSettleResponse } from "../../lib/x402/settle-response";
import type { SettleResponse } from "../../lib/x402/spec";
import type { X402Config } from "../../lib/x402/types";
import { diagnosticConsole } from "../../observability/diagnostic-console";
import { CAPABILITY_SIGNED_FIELDS } from "../signed-envelope-schema";
import type { CapabilityDescriptor, DVMDescriptor, PaymentMethod } from "../types";
import { deferredX402Window, priceFiatMicro } from "./funding";
import type { JobStatus } from "./job-store";
import { DEFERRED_X402_SETTLE_WINDOW_CLOSED } from "./x402-exact-settlement";
import type { X402ExactSettlementIntent } from "./x402-exact-settlement-store";

/**
 * Signed-request field names an x402 route body may not carry. x402 callers
 * are unsigned, so such a body is refused before parsing rather than having
 * the fields stripped: a stripped `pubkey` would otherwise be silently
 * ignored by a caller who believed they were authenticating.
 */
export const X402_ROUTE_SIGNED_FIELDS: readonly string[] = [...CAPABILITY_SIGNED_FIELDS, "auth_statement"];

/**
 * Boot checks for the x402 route that the descriptor alone cannot make: the
 * server's own x402 configuration and payment methods, which a host may set
 * over the descriptor's, its public origin, and the challenge's size at that
 * origin with the route's own timeout and fixed price. Only devMode runs
 * without a public origin, answering on each request's own, so the
 * configure-time stand-in stays there; an `onQuote` amount is unknown until
 * the body arrives.
 */
export function assertX402RoutesServable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  descriptor: Pick<DVMDescriptor<any, any>, "x402Capabilities">,
  server: {
    x402Config: X402Config | undefined;
    paymentMethods: readonly PaymentMethod[] | undefined;
    publicOrigin: string | undefined;
    /** Path a host mounted the server under; see {@link x402RouteUrl}. */
    mountPrefix: string;
    devMode: boolean | undefined;
    /** `DVMKIT_X402_RESPONSE_LIMIT_MS`, parsed by {@link parseX402ResponseLimitMs}. */
    responseLimitMs?: number;
  }
): void {
  const definitions = Object.values(descriptor.x402Capabilities ?? {});
  const first = definitions[0];
  if (!first) return;
  const at = `createDVMServer: capability "${first.name}" is offered on x402`;
  const { x402Config, paymentMethods } = server;
  if (!x402Config) {
    throw new Error(
      `${at} but the server has no x402 configuration; pass the x402 option to createDVMServer, ` +
        "or supply an x402 rail through createDVMHost's options, environment, or mounted DVM"
    );
  }
  if (paymentMethods !== undefined && !paymentMethods.includes("x402")) {
    throw new Error(
      `${at} but paymentMethods (${JSON.stringify(paymentMethods)}) leaves out "x402"; ` +
        'add "x402" to paymentMethods or stop offering the capability on x402'
    );
  }
  // Every payment, and the facilitator's settlement of it, names the route's
  // address as its resource. A request's own origin comes from its Host
  // header, which the caller chooses, and reads http behind TLS termination.
  if (!server.publicOrigin && !server.devMode) {
    throw new Error(
      `${at} but DVMKIT_PUBLIC_URL is unset or not an http or https URL; set it to the origin callers reach ` +
        "this DVM at, such as https://dvm.example.com, since each x402 payment names that address as its resource"
    );
  }
  if (server.responseLimitMs !== undefined) {
    assertX402DeadlinesFit(definitions, x402Config, server.responseLimitMs, server.devMode);
  }
  for (const def of definitions) {
    const price = typeof def.price === "string" ? priceFiatMicro({ price: def.price }) : undefined;
    const required = x402ChannelPaymentRequired({
      name: def.name,
      listing: def.channels.x402?.listing,
      input: def.input,
      x402Config,
      publicOrigin: server.publicOrigin ?? X402_SIZE_CHECK_ORIGIN,
      mountPrefix: server.mountPrefix,
      requiredUsdcMicro: price ? BigInt(price.amountMicro) : X402_SIZE_CHECK_AMOUNT,
      maxTimeoutSeconds:
        def.maxRuntimeSeconds !== undefined
          ? deferredX402Window(def.maxRuntimeSeconds).advertisedTimeoutSeconds
          : X402_SIZE_CHECK_TIMEOUT_SECONDS,
      // A quote carries no `error`. A refused paid request carries one of the
      // payment path's fixed messages, whose only caller-chosen text is a
      // validBefore of at most 16 digits, so none is longer than this stand-in.
      error: X402_SIZE_CHECK_ERROR,
    });
    assertPaymentRequiredFits(
      `createDVMServer: capability "${def.name}"`,
      required,
      "the description, example, outputExample or input schema, or the public origin (DVMKIT_PUBLIC_URL)"
    );
  }
}

/**
 * `DVMKIT_X402_RESPONSE_LIMIT_MS`: the longest a gateway in front of this
 * server waits for response headers, less any margin the operator keeps.
 * Unset means no limit is checked; any other value must be a positive integer.
 */
export function parseX402ResponseLimitMs(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const limit = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(limit)) {
    throw new Error(
      `createDVMServer: DVMKIT_X402_RESPONSE_LIMIT_MS is ${JSON.stringify(value)}, not a positive whole number of ` +
        "milliseconds; set it to how long the gateway in front of this DVM waits for response headers, or unset it"
    );
  }
  return limit;
}

// A paid route request answers once, at its deadline: the runtime bound plus the
// facilitator timeout. A gateway that gives up first answers 504 while the job
// may still finish and settle, so the caller pays without receiving the result
// or the job token that reads it.
function assertX402DeadlinesFit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  definitions: CapabilityDescriptor<any, any>[],
  x402Config: X402Config,
  limitMs: number,
  devMode: boolean | undefined
): void {
  const facilitatorTimeoutMs = x402Config.facilitatorTimeoutMs ?? X402_DEFAULT_FACILITATOR_TIMEOUT_MS;
  for (const def of definitions) {
    if (def.maxRuntimeSeconds === undefined) continue;
    const deadlineMs = def.maxRuntimeSeconds * 1000 + facilitatorTimeoutMs;
    if (deadlineMs <= limitMs) continue;
    if (devMode) {
      diagnosticConsole.warn({ level: "warn", event: "x402_route_response_limit_exceeded" });
      continue;
    }
    throw new Error(
      `createDVMServer: capability "${def.name}" is offered on x402 with maxRuntimeSeconds ${def.maxRuntimeSeconds} ` +
        `and a ${facilitatorTimeoutMs} ms facilitator timeout, so a paid request can take ${deadlineMs} ms to answer, ` +
        `over DVMKIT_X402_RESPONSE_LIMIT_MS (${limitMs} ms); lower maxRuntimeSeconds or the x402 facilitatorTimeoutMs ` +
        "until the two fit within the limit, or offer the capability on the job channel only"
    );
  }
}

/**
 * Why a server that boots would still refuse every payment on its x402 route,
 * each with the diagnostic event a devMode server logs for it instead of
 * refusing to start: a pricing currency x402 cannot charge, dual-serve turned
 * off, so no 402 would offer x402 at all, or no durable exact-settlement
 * store to hold deferred authorizations, so every route request answers 503
 * `x402_not_offered`.
 */
export function x402RouteUnpayableReasons(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  descriptor: Pick<DVMDescriptor<any, any>, "x402Capabilities">,
  server: { durableSettlement: boolean; pricingCurrency: string; dualServe: boolean }
): { event: string; message: string }[] {
  const first = Object.values(descriptor.x402Capabilities ?? {})[0];
  if (!first) return [];
  const at = `createDVMServer: capability "${first.name}" is offered on x402 but`;
  const reasons: { event: string; message: string }[] = [];
  if (server.pricingCurrency !== "usd") {
    reasons.push({
      event: "x402_route_currency_unsupported",
      message:
        `${at} this DVM prices in ${JSON.stringify(server.pricingCurrency)}, and x402 charges only a USD price; ` +
        "price in USD or stop offering the capability on x402",
    });
  }
  if (!server.dualServe) {
    reasons.push({
      event: "x402_route_dual_serve_off",
      message:
        `${at} x402.dualServe is false, so no 402 would offer x402 payment; ` +
        "remove dualServe: false or stop offering the capability on x402",
    });
  }
  if (!server.durableSettlement) {
    reasons.push({
      event: "x402_route_settlement_store_missing",
      message:
        `${at} the server has no durable x402 settlement store, so every route request would answer 503 ` +
        "x402_not_offered; give the server a Postgres database (DATABASE_URL or the host's database option)",
    });
  }
  return reasons;
}

/** The route body as received: nothing, bytes that are not JSON, or a JSON value. */
export type X402RouteBody = { kind: "empty" } | { kind: "malformed" } | { kind: "json"; value: unknown };

export function parseX402RouteBody(text: string): X402RouteBody {
  if (text.trim() === "") return { kind: "empty" };
  try {
    return { kind: "json", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "malformed" };
  }
}

/** The signed-request fields present at the top level of a route body. */
export function signedFieldsIn(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return X402_ROUTE_SIGNED_FIELDS.filter((field) => Object.hasOwn(value, field));
}

/**
 * The one time budget of a paid route request, from its arrival: the
 * capability's runtime bound for verification and the handler, then the
 * facilitator timeout for settlement. A settlement may start only while a
 * full facilitator timeout remains, so it can finish before the answer.
 */
export function x402RouteBudget(
  arrivalMs: number,
  maxRuntimeSeconds: number,
  settleTimeoutMs: number
): { settleByMs: number; deadlineMs: number } {
  const settleByMs = arrivalMs + maxRuntimeSeconds * 1000;
  return { settleByMs, deadlineMs: settleByMs + settleTimeoutMs };
}

/** The rows of the paid-request response table. */
export type X402RouteRow =
  | "charged"
  | "handler_failed"
  | "runtime_bound"
  | "settlement_refused"
  | "authorization_lost"
  | "unknown";

/**
 * Which row a paid route request answers with, from what is durably known
 * once the wait ends. `terminalWorkFinished` is false when the deadline cut
 * the wait short; `heldLocally` is whether this process still holds the
 * authorization, the only copy there is.
 */
export function classifyX402RouteOutcome(args: {
  status: JobStatus;
  intent: Pick<X402ExactSettlementIntent, "status" | "lastOutcome"> | undefined;
  heldLocally: boolean;
  runtimeLimitExceeded: boolean;
  terminalWorkFinished: boolean;
}): X402RouteRow {
  const { status, intent } = args;
  // A job that did not complete never sends its authorization.
  if (status === "failed") return args.runtimeLimitExceeded ? "runtime_bound" : "handler_failed";
  // Only the service cancels a route job (a hosting drain): its caller holds no job token yet.
  if (status === "cancelled") return "runtime_bound";
  // Released unsent once the budget ran out, whether or not the job's end is recorded yet.
  if (intent?.status === "released" && intent.lastOutcome === DEFERRED_X402_SETTLE_WINDOW_CLOSED) return "runtime_bound";
  if (status !== "completed" || !intent) return "unknown";
  switch (intent.status) {
    case "complete":
      return "charged";
    case "rejected":
      return "settlement_refused";
    case "released":
      return "authorization_lost";
    case "prepared":
      // Settlement finished without sending it and nobody holds it: it can never settle.
      return args.terminalWorkFinished && !args.heldLocally ? "authorization_lost" : "unknown";
    default:
      // Submitted, or settled on chain but not yet recorded: money may have moved.
      return "unknown";
  }
}

/**
 * The PAYMENT-RESPONSE of a charged request: the facilitator's stored answer,
 * with the intent's transaction and network filling what it lacks. A
 * settlement recovered from chain evidence stores an answer with no network.
 */
export function chargedSettleResponse(
  intent: Pick<X402ExactSettlementIntent, "transaction" | "network" | "settleResponse">
): SettleResponse {
  const stored = callerSettleResponse(intent.settleResponse);
  return {
    ...stored,
    success: true,
    transaction: stored.transaction || intent.transaction || "",
    ...((stored.network ?? intent.network) !== undefined && { network: stored.network ?? intent.network }),
  };
}

/** Synthesized when the authorization was never sent, so no facilitator answered. */
export function authorizationUnavailableSettleResponse(network: string | undefined): SettleResponse {
  return {
    success: false,
    errorReason: "authorization_unavailable",
    transaction: "",
    ...(network !== undefined && { network }),
  };
}

/** Caller copy for each row that is not a success. */
export const X402_ROUTE_COPY = {
  handler_failed: {
    display: "The service could not complete this request. Nothing was charged.",
    hint: "Read the reason, correct the request if it caused the failure, and send it again with a new payment authorization.",
  },
  runtime_bound: {
    display: "The request ran out of time before the service could finish it. Nothing was charged.",
    hint: "Send the request again later, or with less work, with a new payment authorization.",
  },
  /** The runtime-bound row for a job that completed with too little of the budget left to settle. */
  settle_window_closed: {
    display: "The service finished the work, but no time was left to collect the payment, so the result was withheld. Nothing was charged.",
    hint: "Send the request again with a new payment authorization.",
  },
  settlement_refused: {
    display: "The payment did not go through, so the result was withheld. Nothing was charged.",
    hint: "Check the paying wallet's balance and authorization, then send the request again with a new payment authorization.",
  },
  authorization_lost: {
    display: "The service no longer holds the payment authorization, so it could not collect it and withheld the result. Nothing was charged.",
    hint: "Send the request again with a new payment authorization.",
  },
} as const;

/** Why the runtime-bound row answered a job that completed too late to settle. */
export const SETTLE_WINDOW_CLOSED_REASON =
  "The job finished too late in this request's time budget for its payment to settle.";

