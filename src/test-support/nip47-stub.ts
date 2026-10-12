/**
 * In-process fake NWC wallet service — a minimal nostr relay plus a NIP-47
 * wallet responder, over real WebSockets.
 *
 * The caller-side float pays real bolt11s through a wallet we don't control, so
 * every interesting behaviour lives on the far side of a relay: budget refusal,
 * a wallet that never answers, and — the one that costs real money — a lost
 * response. This stub makes all three reproducible with no network and no sats.
 *
 * The load-bearing detail is the **event-id dedup cache**. Real wallets dedup
 * identical event ids for minutes (Coinos ≈5), which is the only thing that
 * makes a byte-identical re-publish safe. The stub models both halves: inside
 * the window a re-publish returns the cached response without paying again;
 * outside it, the payment happens a second time. {@link Nip47Stub.payments} is
 * therefore a true double-pay oracle — assert its length, not just success.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { bytesToHex } from "@noble/hashes/utils.js";
import { decrypt as nip04Decrypt, encrypt as nip04Encrypt } from "nostr-tools/nip04";
import type { Event as NostrEvent, VerifiedEvent } from "nostr-tools/pure";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";

import { bolt11AmountMsats } from "./bolt11-amount";
import { sha256hex } from "../lib/hash";

/** A payment the fake wallet actually settled. One entry per real settlement. */
export interface Nip47StubPayment {
  bolt11: string;
  paymentHash: string;
  preimage: string;
  amountMsats: number;
  /** Routing fee charged by the stub wallet. */
  routingFeeMsats: number;
  /** Id of the request event that caused this settlement. */
  eventId: string;
  /** Unix ms when it settled. */
  settledAtMs: number;
}

/**
 * An invoice the fake wallet issued via `make_invoice`.
 *
 * Tracked separately from {@link Nip47StubPayment}, which records *outgoing*
 * settlements: a receive-side test needs `lookup_invoice` to answer for an
 * invoice this wallet minted and nobody has paid yet, which the payments list
 * structurally cannot express.
 */
export interface Nip47StubInvoice {
  bolt11: string;
  paymentHash: string;
  amountMsats: number;
  description?: string;
  /** Unix ms. */
  createdAtMs: number;
  /** Unix ms — the wallet refuses payment past this. */
  expiresAtMs: number;
  /** Unix ms, once {@link Nip47Stub.settleInvoice} marked it paid. */
  settledAtMs?: number;
  preimage?: string;
}

/** A request the relay delivered to the wallet responder — including dropped ones. */
export interface Nip47StubRequest {
  method: string;
  eventId: string;
  /** True when a fault stopped this request from being acted on. */
  dropped: boolean;
  /** True when the dedup cache answered instead of the wallet acting again. */
  deduped: boolean;
}

/**
 * Fault injection. `once` faults consume themselves after firing, so a test can
 * assert the *recovery* path in the same run that exercised the failure.
 */
export type Nip47Fault =
  /** Normal operation. */
  | { mode: "pass" }
  /** Relay accepts the event, wallet never answers — an asleep wallet. */
  | { mode: "offline" }
  /** The wallet never sees the request. No payment, no response. */
  | { mode: "drop-request"; once?: boolean }
  /** The wallet acts (money moves) but the response never reaches the client. */
  | { mode: "drop-response"; once?: boolean }
  /** The relay itself is unreachable — connections refused and torn down. */
  | { mode: "relay-down" };

/** How the fake wallet should behave. */
export interface Nip47StubOptions {
  /** Spendable balance in msats. Default 1_000_000 (1000 sats). */
  balanceMsats?: number;
  /**
   * Wallet-side spending budget in msats. When set, a payment that would push
   * cumulative spend past it is refused with NIP-47's `QUOTA_EXCEEDED` — the
   * one budget behaviour that *is* in the spec. Unset means no wallet budget.
   */
  budgetMsats?: number;
  /** Methods the wallet advertises and accepts. Default: the full set below. */
  methods?: string[];
  /**
   * What `get_info` *reports*, when that differs from what the wallet actually
   * accepts. Real wallets exist that answer `get_info` without listing methods
   * at all — indistinguishable, to a client, from one that permits everything.
   * Defaults to {@link methods}.
   */
  advertisedMethods?: string[];
  /**
   * Non-spec budget fields to volunteer on `get_info`. No NIP-47 method returns
   * a budget, so this models the bonus case where a wallet offers them anyway.
   */
  volunteerBudgetFields?: Record<string, unknown>;
  /** Event-id dedup window in ms. Default 300_000 (Coinos-like ≈5 min). */
  dedupWindowMs?: number;
  /**
   * Routing floor in msats: a `pay_invoice` below it fails with
   * `PAYMENT_FAILED` and a no-route message, the way an upstream channel's
   * `htlc_minimum_msat` surfaces on a real node. Unset means every amount
   * routes — the default.
   */
  routingFloorMsats?: number;
  /** Routing fee charged per payment, in msats. Default 0. */
  routingFeeMsats?: number;
  /** Omit `fees_paid` from pay and lookup responses while still charging the fee. */
  omitFeesPaid?: boolean;
  /** Wallet alias reported by `get_info`. Default "Stub Hub". */
  alias?: string;
  /**
   * Methods this connection is *recognised* for but not permitted to call —
   * answered with NIP-47's `RESTRICTED`. Distinct from omitting a
   * method from {@link methods}, which is the wallet saying it cannot do it at
   * all (`NOT_IMPLEMENTED`), and from {@link unauthorized}, which is the wallet
   * saying it has never heard of this connection.
   */
  restrictedMethods?: string[];
  /**
   * Refuse every request with NIP-47's `UNAUTHORIZED` — a revoked or expired
   * connection, which the wallet no longer recognises at all.
   */
  unauthorized?: boolean;
  /** The wallet's own wording on a `RESTRICTED` refusal. Default names a permission. */
  restrictedMessage?: string;
  /**
   * Shared settlement fabric. Stubs given the same handle can pay
   * each other's invoices: a `pay_invoice` here settles the issuing stub's
   * matching `make_invoice` record, so a `lookup_invoice` over there reports
   * it paid. Omit for a wallet that stands alone — the default.
   *
   * Needed because a caller's float and a DVM's receive wallet can never be
   * one stub: the receive connection must refuse `pay_invoice` (
   * validates that at config time), so a two-sided Lightning test needs two.
   */
  network?: Nip47Network;
}

/**
 * A shared settlement fabric between stubs — the fake Lightning network.
 * Create one with {@link createNip47Network} and hand it to every stub that
 * should be able to pay the others.
 */
export interface Nip47Network {
  /** Register an issuing wallet. Called by {@link startNip47Stub}. */
  register: (settle: (hashOrBolt11: string) => Nip47StubInvoice | undefined) => () => void;
  /**
   * Deliver a payment to whichever registered wallet issued this bolt11.
   * Returns true when one claimed it. A bolt11 nobody issued (a mint's own
   * invoice, say) is simply not ours to settle.
   */
  deliver: (bolt11: string) => boolean;
}

/** Create a settlement fabric shared by two or more stubs. */
export function createNip47Network(): Nip47Network {
  const issuers = new Set<(hashOrBolt11: string) => Nip47StubInvoice | undefined>();
  return {
    register(settle) {
      issuers.add(settle);
      return () => issuers.delete(settle);
    },
    deliver(bolt11) {
      for (const settle of issuers) {
        if (settle(bolt11)) return true;
      }
      return false;
    },
  };
}

/** A running fake NWC wallet service. */
export interface Nip47Stub {
  /** `nostr+walletconnect://…` URI pointing at this in-process wallet. */
  uri: string;
  /** Wallet service pubkey (hex). */
  walletPubkey: string;
  /** Relay URL the URI points at. */
  relayUrl: string;
  /** Settlements, in order. The no-double-pay oracle. */
  payments: Nip47StubPayment[];
  /**
   * Invoices this wallet issued, in order. The receive-side mirror
   * of {@link payments}: assert its length to catch a DVM that mints a second
   * bolt11 for a top-up it already issued one for.
   */
  invoices: Nip47StubInvoice[];
  /**
   * Mark an issued invoice paid, as an external payer would. Accepts the
   * payment hash or the bolt11. Returns the settled record, or `undefined`
   * when no such invoice was issued.
   */
  settleInvoice: (hashOrBolt11: string) => Nip47StubInvoice | undefined;
  /** Every request the relay routed to the wallet, including dropped ones. */
  requests: Nip47StubRequest[];
  /** Remaining spendable balance (msats). */
  balanceMsats: () => number;
  /** Cumulative spend against the wallet budget (msats). */
  spentMsats: () => number;
  /** Inject a fault. Replaces any previous one. */
  setFault: (fault: Nip47Fault) => void;
  /** Reset the budget window, as `budget_renewal` would. */
  renewBudget: () => void;
  close: () => Promise<void>;
}

/** Methods the stub implements when `options.methods` isn't given. */
export const NIP47_STUB_METHODS = [
  "get_info",
  "get_balance",
  "pay_invoice",
  "make_invoice",
  "lookup_invoice",
];

/**
 * Stand up an in-process NWC wallet on an ephemeral port. Await the returned
 * stub's `close()` in a `finally` — it terminates live sockets so vitest and
 * the money-loop scripts exit cleanly.
 */
export async function startNip47Stub(options: Nip47StubOptions = {}): Promise<Nip47Stub> {
  const walletSecret = generateSecretKey();
  const walletPubkey = getPublicKey(walletSecret);
  const clientSecret = generateSecretKey();

  const methods = options.methods ?? NIP47_STUB_METHODS;
  const dedupWindowMs = options.dedupWindowMs ?? 300_000;
  const alias = options.alias ?? "Stub Hub";

  const state = {
    balanceMsats: options.balanceMsats ?? 1_000_000,
    spentMsats: 0,
    fault: { mode: "pass" } as Nip47Fault,
  };
  const payments: Nip47StubPayment[] = [];
  const invoices: Nip47StubInvoice[] = [];
  const requests: Nip47StubRequest[] = [];
  /** eventId → the response the wallet already produced for it. */
  const dedup = new Map<string, { response: VerifiedEvent; atMs: number }>();
  /** Live subscriptions, so responses fan out to whoever is listening. */
  const subs = new Map<WebSocket, Map<string, Filterish[]>>();
  const stored: NostrEvent[] = [];

  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer();

  server.on("upgrade", (req, socket, head) => {
    if (state.fault.mode === "relay-down") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      subs.set(ws, new Map());
      ws.on("close", () => subs.delete(ws));
      ws.on("message", (data: Buffer) => {
        handleClientMessage(ws, data.toString("utf8"));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const relayUrl = `ws://127.0.0.1:${port}`;
  const unregister = options.network?.register(settleIssuedInvoice);
  const uri =
    `nostr+walletconnect://${walletPubkey}` +
    `?relay=${encodeURIComponent(relayUrl)}&secret=${bytesToHex(clientSecret)}`;

  return {
    uri,
    walletPubkey,
    relayUrl,
    payments,
    invoices,
    settleInvoice: settleIssuedInvoice,
    requests,
    balanceMsats: () => state.balanceMsats,
    spentMsats: () => state.spentMsats,
    setFault: (fault) => {
      state.fault = fault;
      if (fault.mode === "relay-down") {
        for (const client of wss.clients) client.terminate();
      }
    },
    renewBudget: () => {
      state.spentMsats = 0;
    },
    close: async () => {
      unregister?.();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
    },
  };

  function handleClientMessage(ws: WebSocket, raw: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(raw) as unknown[];
    } catch {
      return;
    }
    const verb = msg[0];

    if (verb === "EVENT") {
      const event = msg[1] as NostrEvent;
      stored.push(event);
      send(ws, ["OK", event.id, true, ""]);
      fanout(event);
      maybeRespond(event);
      return;
    }

    if (verb === "REQ") {
      const subId = msg[1] as string;
      const filters = msg.slice(2) as Filterish[];
      subs.get(ws)?.set(subId, filters);
      for (const event of stored) {
        if (filters.some((f) => matchesFilter(event, f))) send(ws, ["EVENT", subId, event]);
      }
      send(ws, ["EOSE", subId]);
      return;
    }

    if (verb === "CLOSE") {
      subs.get(ws)?.delete(msg[1] as string);
    }
  }

  function fanout(event: NostrEvent): void {
    for (const [ws, bySub] of subs) {
      for (const [subId, filters] of bySub) {
        if (filters.some((f) => matchesFilter(event, f))) send(ws, ["EVENT", subId, event]);
      }
    }
  }

  function send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  function maybeRespond(event: NostrEvent): void {
    if (event.kind !== 23194) return;
    if (!event.tags.some(([name, value]) => name === "p" && value === walletPubkey)) return;

    let request: { method?: string; params?: Record<string, unknown> };
    try {
      request = JSON.parse(nip04Decrypt(walletSecret, event.pubkey, event.content)) as {
        method?: string;
        params?: Record<string, unknown>;
      };
    } catch {
      return;
    }
    const method = request.method ?? "";

    // A cached response means this exact event was already acted on. Serving it
    // again is precisely the wallet-side dedup a byte-identical re-publish
    // relies on — no second payment.
    const cached = dedup.get(event.id);
    if (cached && Date.now() - cached.atMs < dedupWindowMs) {
      requests.push({ method, eventId: event.id, dropped: false, deduped: true });
      deliver(cached.response);
      return;
    }

    const fault = state.fault;
    if (fault.mode === "relay-down" || fault.mode === "offline") {
      requests.push({ method, eventId: event.id, dropped: true, deduped: false });
      return;
    }
    if (fault.mode === "drop-request") {
      if (fault.once) state.fault = { mode: "pass" };
      requests.push({ method, eventId: event.id, dropped: true, deduped: false });
      return;
    }

    requests.push({ method, eventId: event.id, dropped: false, deduped: false });
    const payload = dispatch(method, request.params ?? {}, event.id);
    const response = finalizeEvent(
      {
        kind: 23195,
        tags: [
          ["p", event.pubkey],
          ["e", event.id],
        ],
        content: nip04Encrypt(
          walletSecret,
          event.pubkey,
          JSON.stringify({ result_type: method, ...payload })
        ),
        created_at: Math.floor(Date.now() / 1000),
      },
      walletSecret
    );
    dedup.set(event.id, { response, atMs: Date.now() });

    if (fault.mode === "drop-response") {
      // The wallet acted — money moved — but the client will never hear back.
      if (fault.once) state.fault = { mode: "pass" };
      return;
    }
    deliver(response);
  }

  function deliver(response: VerifiedEvent): void {
    stored.push(response);
    fanout(response);
  }

  function dispatch(
    method: string,
    params: Record<string, unknown>,
    eventId: string
  ): { result?: Record<string, unknown>; error?: { code: string; message: string } } {
    if (options.unauthorized) {
      return { error: { code: "UNAUTHORIZED", message: "No wallet is connected to this key." } };
    }
    if (options.restrictedMethods?.includes(method)) {
      return {
        error: {
          code: "RESTRICTED",
          message:
            options.restrictedMessage ?? `This connection is not permitted to call ${method}.`,
        },
      };
    }
    if (!methods.includes(method)) {
      return { error: { code: "NOT_IMPLEMENTED", message: `${method} is not supported` } };
    }

    switch (method) {
      case "get_info":
        return {
          result: {
            alias,
            methods: options.advertisedMethods ?? methods,
            ...(options.volunteerBudgetFields ?? {}),
          },
        };

      case "get_balance":
        return { result: { balance: state.balanceMsats } };

      case "pay_invoice":
        return payInvoice(asString(params.invoice) ?? "", eventId);

      case "make_invoice":
        return makeInvoice(params, eventId);

      case "lookup_invoice":
        return lookupInvoice(params);

      default:
        return { error: { code: "NOT_IMPLEMENTED", message: `${method} is not supported` } };
    }
  }

  function payInvoice(
    bolt11: string,
    eventId: string
  ): { result?: Record<string, unknown>; error?: { code: string; message: string } } {
    if (!bolt11) return { error: { code: "OTHER", message: "missing invoice" } };
    const amountMsats = bolt11AmountMsats(bolt11) ?? 0;
    const routingFeeMsats = options.routingFeeMsats ?? 0;
    const walletDebitMsats = amountMsats + routingFeeMsats;

    if (
      options.budgetMsats !== undefined &&
      state.spentMsats + walletDebitMsats > options.budgetMsats
    ) {
      return {
        error: {
          code: "QUOTA_EXCEEDED",
          message: "The spending budget for this connection has been exhausted.",
        },
      };
    }
    if (walletDebitMsats > state.balanceMsats) {
      return { error: { code: "INSUFFICIENT_BALANCE", message: "Not enough balance." } };
    }
    // Below the budget and balance checks: a real node only discovers the
    // floor while routing, after its local checks pass.
    if (options.routingFloorMsats !== undefined && amountMsats < options.routingFloorMsats) {
      return {
        error: {
          code: "PAYMENT_FAILED",
          message: `no route found: ${amountMsats} msats is below this node's ${options.routingFloorMsats}-msat routing floor`,
        },
      };
    }

    state.balanceMsats -= walletDebitMsats;
    state.spentMsats += walletDebitMsats;
    const preimage = sha256hex(`preimage:${bolt11}`);
    payments.push({
      bolt11,
      paymentHash: sha256hex(bolt11),
      preimage,
      amountMsats,
      routingFeeMsats,
      eventId,
      settledAtMs: Date.now(),
    });
    // Deliver to the payee before answering, so a client that immediately asks
    // the receiving side whether the invoice settled gets the true answer —
    // real Lightning settles atomically, and a polling bridge here would make
    // the test's timing, not the code's correctness, decide the result.
    options.network?.deliver(bolt11);
    return {
      result: {
        preimage,
        ...(options.omitFeesPaid ? {} : { fees_paid: routingFeeMsats }),
      },
    };
  }

  /**
   * Mint an incoming invoice and remember it. The bolt11 encodes the
   * amount in its HRP so `bolt11AmountMsats` reads it back, and is salted with
   * the request event id so two invoices for the same amount differ — a stub
   * that returned identical bolt11s would hide exactly the duplicate-issuance
   * bug the receive tests exist to catch.
   *
   * The salt is hex with `1` mapped to `q`, because a real bech32 data part
   * cannot contain `1` and the parser relies on that to find the separator.
   * Hex has no `q`, so the substitution stays injective and two event ids
   * still give two invoices.
   */
  function makeInvoice(
    params: Record<string, unknown>,
    eventId: string
  ): { result?: Record<string, unknown>; error?: { code: string; message: string } } {
    const amountMsats = Number(params.amount ?? 0);
    const nowMs = Date.now();
    const expirySeconds = Number(params.expiry ?? 3600);
    const salt = eventId.slice(0, 12).replace(/1/g, "q");
    const bolt11 = `lnbcrt${Math.max(1, Math.round(amountMsats / 100))}n1stub${salt}`;
    const record: Nip47StubInvoice = {
      bolt11,
      paymentHash: sha256hex(bolt11),
      amountMsats,
      description: asString(params.description),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + expirySeconds * 1000,
    };
    invoices.push(record);
    return { result: invoiceResult(record) };
  }

  /**
   * `lookup_invoice` over both directions: invoices this wallet issued (paid or
   * not) and payments it made. The issued list is searched first — a receive
   * connection's whole job lives there.
   */
  function lookupInvoice(params: Record<string, unknown>): {
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
  } {
    const invoice = asString(params.invoice);
    const paymentHash = asString(params.payment_hash);
    const matches = (bolt11: string, hash: string): boolean =>
      (invoice !== undefined && bolt11 === invoice) ||
      (paymentHash !== undefined && hash === paymentHash);

    const issued = invoices.find((i) => matches(i.bolt11, i.paymentHash));
    if (issued) return { result: invoiceResult(issued) };

    const found = payments.find((p) => matches(p.bolt11, p.paymentHash));
    if (!found) {
      return { error: { code: "NOT_FOUND", message: "No matching transaction." } };
    }
    return {
      result: {
        type: "outgoing",
        invoice: found.bolt11,
        payment_hash: found.paymentHash,
        preimage: found.preimage,
        amount: found.amountMsats,
        ...(options.omitFeesPaid ? {} : { fees_paid: found.routingFeeMsats }),
        created_at: Math.floor(found.settledAtMs / 1000),
        settled_at: Math.floor(found.settledAtMs / 1000),
      },
    };
  }

  /** NIP-47 transaction shape for an issued invoice. `settled_at` absent until paid. */
  function invoiceResult(record: Nip47StubInvoice): Record<string, unknown> {
    return {
      type: "incoming",
      invoice: record.bolt11,
      payment_hash: record.paymentHash,
      ...(record.preimage ? { preimage: record.preimage } : {}),
      amount: record.amountMsats,
      created_at: Math.floor(record.createdAtMs / 1000),
      expires_at: Math.floor(record.expiresAtMs / 1000),
      ...(record.settledAtMs ? { settled_at: Math.floor(record.settledAtMs / 1000) } : {}),
    };
  }

  /** Stand in for an external payer settling one of our invoices. */
  function settleIssuedInvoice(hashOrBolt11: string): Nip47StubInvoice | undefined {
    const record = invoices.find(
      (i) => i.paymentHash === hashOrBolt11 || i.bolt11 === hashOrBolt11
    );
    if (!record) return undefined;
    if (record.settledAtMs) return record;
    record.settledAtMs = Date.now();
    record.preimage = sha256hex(`preimage:${record.bolt11}`);
    state.balanceMsats += record.amountMsats;
    return record;
  }
}

/** Read a decoded JSON param as a string, ignoring anything else a client sent. */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The subset of a nostr filter the stub matches on. */
interface Filterish {
  ids?: string[];
  kinds?: number[];
  authors?: string[];
  since?: number;
  until?: number;
  [tagFilter: string]: unknown;
}

function matchesFilter(event: NostrEvent, filter: Filterish): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const [key, want] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(want)) continue;
    const tagName = key.slice(1);
    const values = event.tags.filter(([name]) => name === tagName).map(([, value]) => value);
    if (!want.some((v) => values.includes(v as string))) return false;
  }
  return true;
}
