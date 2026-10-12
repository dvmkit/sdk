import { CheckStateEnum, type ProofLike } from "@cashu/cashu-ts";
import type { Context, Hono } from "hono";
import type { BlankSchema, Env } from "hono/types";
import type { Pool } from "pg";

import {
  ADMIN_AUTH_CLOCK_SKEW_SECONDS,
  ADMIN_AUTH_NONCE_TTL_SECONDS,
  buildAdminChallenge,
} from "../../lib/cashu/admin-auth";
import { getWallet } from "../../lib/cashu/wallet";
import { verifyChallenge } from "../../lib/wallet-agent/sign";
import { loadAdminLockPubkeyState } from "./admin-auth-state";
import {
  type ConsumedCredentialStore,
  MemoryConsumedCredentialStore,
} from "./consumed-credential-store";
import {
  type LockPubkeyState,
  type LockPubkeyStateLoader,
  rotateLockPubkey,
  toLockPubkey,
} from "./lock-pubkey-store";
import type { CashuMeltCompleted, TransactionalPayoutHook } from "./payout-reporter";
import {
  fetchRowsForMelt,
  listPendingBatches,
  markRowsMelted,
  recordMeltAudit,
  resetFailedRows,
} from "./wallet-accumulator-store";

export interface InstallAdminCashuRoutesOpts {
  db: Pool;
  /** Identifier of this DVM — bound into every signed admin challenge. */
  dvmId: string;
  /**
   * Live lock-pubkey state loader. Auth accepts a signature from the current
   * pubkey or any retired pubkey still within the rotation grace window
   * The `/admin/cashu/rotate-lock-pubkey` route narrows that to
   * current-only.
   */
  getLockPubkeyState: LockPubkeyStateLoader;
  /** Rotation grace window in seconds — threaded into `rotateLockPubkey`. */
  graceSeconds: number;
  /** Replay-protection store keyed by nonce. */
  nonceStore: ConsumedCredentialStore;
  /** Runs after mint checkstate reports the proofs SPENT, inside the transaction that
   * records the caller-reported melt audit and marks rows melted. Enqueue failure
   * rolls the mark back for recovery; committed runs only after commit. */
  onMelted?: TransactionalPayoutHook<CashuMeltCompleted>;
  /** Override for cashu-ts wallet construction (tests). */
  walletProvider?: typeof getWallet;
  /** Override for the current time (tests). Returns ms since epoch. */
  now?: () => number;
}

export interface AdminAuthOk {
  ok: true;
  actor: string;
}

/**
 * Auth failure outcome — caller surfaces `reason` in the 401 body so operators
 * and `dvmctl melt-pending` can disambiguate misconfiguration from replay.
 */
export interface AdminAuthErr {
  ok: false;
  reason:
    | "missing_auth"
    | "malformed_auth"
    | "bad_nonce"
    | "bad_timestamp"
    | "ts_skew"
    | "replay"
    | "bad_signature";
}

export type AdminAuthResult = AdminAuthOk | AdminAuthErr;

/** Realm key for the admin nonce store — keeps it disjoint from MPP credentials. */
export const NONCE_REALM = "admin-cashu";
/** 5-minute sliding window aligns with NUT-19 cache TTLs. */
export const NONCE_TTL_SECONDS = ADMIN_AUTH_NONCE_TTL_SECONDS;
/** Clock-skew window enforced on `unix_seconds`. */
export const CLOCK_SKEW_SECONDS = ADMIN_AUTH_CLOCK_SKEW_SECONDS;

// `buildAdminChallenge` lives in `src/lib/cashu/admin-auth.ts` so the CLI's
// signed-challenge client can share it without pulling in pg / cashu-ts.
// Existing tests import it from this module — re-export for back-compat.
export { buildAdminChallenge };

/**
 * Verify the `Authorization: P2PK <nonce>.<unix>.<sig>` header for an admin
 * endpoint. Method + path are bound into the signed message so a `GET`
 * signature can't be replayed against a `POST`. Successful verification marks
 * the nonce consumed for the TTL window before returning. Replay handling is
 * ordered as `has()` → signature verification → atomic `consume()` so an
 * unauthenticated caller cannot burn a valid signed request's replay slot.
 * Legacy stores without `consume()` retain their check/mark behavior; case-hold
 * routes require atomic consumption. Invalid signatures still require bounded
 * verification work; the SDK's default store is TTL-limited and capped.
 *
 * `acceptedPubkeys` is the set of pubkeys whose signature is honoured for
 * this call. Default-routed callers pass the full active set (current +
 * retired-in-grace); the rotate route narrows it to current-only.
 */
export async function verifyAdminAuth(opts: {
  authHeader: string | undefined;
  method: string;
  path: string;
  dvmId: string;
  acceptedPubkeys: string[];
  nonceStore: ConsumedCredentialStore;
  now?: () => number;
}): Promise<AdminAuthResult> {
  const header = opts.authHeader;
  if (!header?.startsWith("P2PK ")) return { ok: false, reason: "missing_auth" };
  const parts = header.slice(5).split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_auth" };
  const [nonceHex, unixStr, sigHex] = parts;
  if (!/^[0-9a-f]{32}$/i.test(nonceHex)) return { ok: false, reason: "bad_nonce" };
  if (!/^\d+$/.test(unixStr)) return { ok: false, reason: "bad_timestamp" };

  const nowMs = opts.now ? opts.now() : Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const unixSec = Number(unixStr);
  if (Math.abs(unixSec - nowSec) > CLOCK_SKEW_SECONDS) return { ok: false, reason: "ts_skew" };

  if (await opts.nonceStore.has(NONCE_REALM, nonceHex)) return { ok: false, reason: "replay" };

  const digest = buildAdminChallenge({
    method: opts.method,
    path: opts.path,
    dvmId: opts.dvmId,
    nonceHex,
    unixSeconds: unixStr,
  });
  const matched = opts.acceptedPubkeys.find((pk) => verifyChallenge(pk, digest, sigHex));
  if (!matched) return { ok: false, reason: "bad_signature" };

  if (opts.nonceStore.consume) {
    if (!await opts.nonceStore.consume(NONCE_REALM, nonceHex, NONCE_TTL_SECONDS)) return { ok: false, reason: "replay" };
  } else {
    await opts.nonceStore.mark(NONCE_REALM, nonceHex, NONCE_TTL_SECONDS);
  }
  return { ok: true, actor: matched };
}

export function installAdminCashuRoutes<E extends Env = Env, S extends BlankSchema = BlankSchema>(
  app: Hono<E, S>,
  opts: InstallAdminCashuRoutesOpts
): void {
  app.get("/admin/cashu/pending-batches", (c) => handlePendingBatches(c, opts));
  app.post("/admin/cashu/mark-melted", (c) => handleMarkMelted(c, opts));
  app.post("/admin/cashu/restart-failed", (c) => handleRestartFailed(c, opts));
  app.post("/admin/cashu/rotate-lock-pubkey", (c) => handleRotateLockPubkey(c, opts));
}

/**
 * Convenience constructor for the in-memory nonce store — exported so callers
 * outside `app.ts` (tests, custom wiring) can mint a store with the same caps
 * the SDK uses by default.
 */
export function createAdminCashuNonceStore(): ConsumedCredentialStore {
  return new MemoryConsumedCredentialStore({ maxEntries: 10_000 });
}

async function authWithActiveState(
  c: Context,
  opts: InstallAdminCashuRoutesOpts
): Promise<
  { state: LockPubkeyState; auth: AdminAuthOk } | { err: AdminAuthErr } | { response: Response }
> {
  const loaded = await loadAdminLockPubkeyState(c, opts);
  if ("response" in loaded) return loaded;
  const { state } = loaded;
  const acceptedPubkeys = [state.current, ...state.retired.map((r) => r.pubkey)];
  const auth = await verifyAdminAuth({
    authHeader: c.req.header("Authorization"),
    method: c.req.method,
    path: c.req.path,
    dvmId: opts.dvmId,
    acceptedPubkeys,
    nonceStore: opts.nonceStore,
    now: opts.now,
  });
  if (!auth.ok) return { err: auth };
  return { state, auth };
}

async function handlePendingBatches(
  c: Context,
  opts: InstallAdminCashuRoutesOpts
): Promise<Response> {
  const outcome = await authWithActiveState(c, opts);
  if ("response" in outcome) return outcome.response;
  if ("err" in outcome) return c.json({ error: "unauthorized", reason: outcome.err.reason }, 401);

  const batches = await listPendingBatches(opts.db, opts.dvmId);
  return c.json({
    batches: batches.map((b) => ({
      mint_url: b.mintUrl,
      lock_pubkey: b.lockPubkey,
      row_ids: b.rowIds,
      proofs: b.proofs.map((p) => ({
        id: p.id,
        amount: p.amount,
        secret: p.secret,
        C: p.C,
        ...(p.dleq ? { dleq: { ...p.dleq } } : {}),
      })),
      t_expire: b.oldestTExpire,
      total_sats: b.totalSats,
    })),
  });
}

async function handleMarkMelted(c: Context, opts: InstallAdminCashuRoutesOpts): Promise<Response> {
  const outcome = await authWithActiveState(c, opts);
  if ("response" in outcome) return outcome.response;
  if ("err" in outcome) return c.json({ error: "unauthorized", reason: outcome.err.reason }, 401);

  let body: { row_ids?: unknown; melt_quote_id?: unknown; payment_preimage?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be JSON." }, 400);
  }

  const rowIds = body.row_ids;
  const meltQuoteId = body.melt_quote_id;
  const paymentPreimage = body.payment_preimage;
  if (
    !Array.isArray(rowIds) ||
    rowIds.length === 0 ||
    !rowIds.every((id): id is string => typeof id === "string" && id.length > 0)
  ) {
    return c.json(
      { error: "invalid_body", message: "row_ids must be a non-empty string array." },
      400
    );
  }
  if (typeof meltQuoteId !== "string" || meltQuoteId.length === 0) {
    return c.json(
      { error: "invalid_body", message: "melt_quote_id must be a non-empty string." },
      400
    );
  }
  if (typeof paymentPreimage !== "string" || paymentPreimage.length === 0) {
    return c.json(
      { error: "invalid_body", message: "payment_preimage must be a non-empty string." },
      400
    );
  }

  const rows = await fetchRowsForMelt(opts.db, opts.dvmId, rowIds);
  if (rows.length !== rowIds.length) {
    const found = new Set(rows.map((r) => r.id));
    return c.json(
      {
        error: "rows_not_found",
        message: "One or more row_ids do not exist for this DVM.",
        missing_row_ids: rowIds.filter((id) => !found.has(id)),
      },
      404
    );
  }
  const alreadyMelted = rows.filter((r) => r.meltStatus === "melted").map((r) => r.id);
  if (alreadyMelted.length > 0) {
    return c.json(
      {
        error: "rows_already_melted",
        message: "One or more rows are already marked melted.",
        row_ids: alreadyMelted,
      },
      409
    );
  }

  // NUT-7 checkstate per mint — `listPendingBatches` groups by mint_url so a
  // single mark-melted call typically covers exactly one mint, but a builder
  // may bundle batches across mints in one POST, so iterate to be safe.
  const byMint = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byMint.get(row.mintUrl);
    if (list) list.push(row);
    else byMint.set(row.mintUrl, [row]);
  }
  const walletProvider = opts.walletProvider ?? getWallet;
  for (const [mintUrl, mintRows] of byMint) {
    let states: { state: CheckStateEnum }[];
    let proofs: ProofLike[];
    try {
      const wallet = await walletProvider(mintUrl);
      proofs = mintRows.map((r) => ({
        id: r.proofKeysetId,
        secret: r.proofSecret,
        C: r.proofC,
        amount: r.proofAmount,
      }));
      states = await wallet.checkProofsStates(proofs);
    } catch (mintErr) {
      return c.json(
        {
          error: "mint_unreachable",
          message:
            mintErr instanceof Error
              ? mintErr.message
              : "Mint checkstate failed; retry once mint is reachable.",
          mint_url: mintUrl,
        },
        502
      );
    }
    // NUT-7 parallel-array invariant: index-based access below assumes the
    // mint returned exactly one state per submitted proof. A short response
    // would mis-attribute states to row_ids or silently skip checks on
    // trailing rows. Surface as transient so the builder retries.
    if (states.length !== proofs.length) {
      return c.json(
        {
          error: "mint_unreachable",
          message: `Mint returned ${states.length} proof states for ${proofs.length} proofs (NUT-7 contract violated).`,
          mint_url: mintUrl,
        },
        502
      );
    }
    const offenders: { row_id: string; state: string }[] = [];
    states.forEach((s, i) => {
      if (s.state !== CheckStateEnum.SPENT) {
        offenders.push({ row_id: mintRows[i].id, state: s.state });
      }
    });
    if (offenders.length > 0) {
      return c.json(
        {
          error: "proofs_not_spent",
          message:
            "Mint reports one or more proofs are not SPENT — refusing to mark melted. " +
            "Retry once the LN payment settles.",
          mint_url: mintUrl,
          offenders,
        },
        422
      );
    }
  }

  // The audit, the mark and the payout report commit together: a
  // report queued after the mark could be lost between the two, and a mark
  // that rolls back is simply re-posted by the CLI's recovery sweep.
  const client = await opts.db.connect();
  try {
    await client.query("BEGIN");
    await recordMeltAudit(client, rowIds, { meltQuoteId, paymentPreimage });
    await markRowsMelted(client, rowIds);
    if (opts.onMelted) {
      await opts.onMelted.enqueue(
        {
          rows: rows.map((r) => ({ id: r.id, mintUrl: r.mintUrl, proofAmount: r.proofAmount })),
          meltQuoteId,
          paymentPreimage,
        },
        client
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  opts.onMelted?.committed();
  return c.json({ melted: rowIds.length });
}

async function handleRestartFailed(
  c: Context,
  opts: InstallAdminCashuRoutesOpts
): Promise<Response> {
  const outcome = await authWithActiveState(c, opts);
  if ("response" in outcome) return outcome.response;
  if ("err" in outcome) return c.json({ error: "unauthorized", reason: outcome.err.reason }, 401);

  // Missing row_ids selects all eligible rows; an explicit empty array selects none.
  let body: { row_ids?: unknown };
  try {
    body = await c.req.json<{ row_ids?: unknown }>();
  } catch {
    body = {};
  }

  let rowIds: string[] | undefined;
  if (body.row_ids !== undefined) {
    if (
      !Array.isArray(body.row_ids) ||
      !body.row_ids.every((id): id is string => typeof id === "string" && id.length > 0)
    ) {
      return c.json(
        {
          error: "invalid_body",
          message: "row_ids, when present, must be a non-empty string array.",
        },
        400
      );
    }
    rowIds = body.row_ids;
  }

  const restarted = await resetFailedRows(opts.db, opts.dvmId, rowIds);
  return c.json({ restarted });
}

/**
 * Rotate the DVM's per-DVM lock pubkey. Auth narrows to current-only:
 * the caller must hold the current privkey, so a retired-key signer (which a
 * previous rotation has already demoted) can't rotate the DVM back into a
 * state they control.
 *
 * Body: `{ new_pubkey: <hex> }`. On success, the response carries the
 * post-rotation `{ current, retired }` so the CLI can confirm what was
 * applied without a follow-up `/v1/info` round-trip.
 */
async function handleRotateLockPubkey(
  c: Context,
  opts: InstallAdminCashuRoutesOpts
): Promise<Response> {
  const loaded = await loadAdminLockPubkeyState(c, opts);
  if ("response" in loaded) return loaded.response;
  const { state } = loaded;
  const auth = await verifyAdminAuth({
    authHeader: c.req.header("Authorization"),
    method: c.req.method,
    path: c.req.path,
    dvmId: opts.dvmId,
    acceptedPubkeys: [state.current],
    nonceStore: opts.nonceStore,
    now: opts.now,
  });
  if (!auth.ok) return c.json({ error: "unauthorized", reason: auth.reason }, 401);

  let body: { new_pubkey?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be JSON." }, 400);
  }
  const raw = body.new_pubkey;
  if (typeof raw !== "string" || raw.length === 0) {
    return c.json(
      { error: "invalid_body", message: "new_pubkey must be a non-empty string." },
      400
    );
  }
  if (!/^0[23][0-9a-f]{64}$/i.test(raw)) {
    return c.json(
      {
        error: "invalid_pubkey",
        message:
          "new_pubkey must be a 33-byte compressed secp256k1 public key (66 hex characters starting with 02 or 03).",
      },
      400
    );
  }
  if (toLockPubkey(raw) === state.current) {
    return c.json(
      {
        error: "no_op_rotation",
        message: "new_pubkey already matches the current lock pubkey.",
      },
      409
    );
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  const after = await rotateLockPubkey(opts.db, opts.dvmId, raw, opts.graceSeconds * 1000, nowMs);
  return c.json({
    current: after.current,
    retired: after.retired.map((r) => ({ pubkey: r.pubkey, retired_at_ms: r.retiredAtMs })),
  });
}
