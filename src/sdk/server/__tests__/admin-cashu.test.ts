import { CheckStateEnum } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";
import type * as LockPubkeyStoreModule from "../lock-pubkey-store";

vi.mock("../lock-pubkey-store", async (importOriginal) => {
  const actual = await importOriginal<typeof LockPubkeyStoreModule>();
  return {
    ...actual,
    rotateLockPubkey: vi.fn(),
  };
});

const { rotateLockPubkey: mockRotateLockPubkey } = await import("../lock-pubkey-store");

const { buildAdminChallenge, createAdminCashuNonceStore, installAdminCashuRoutes } =
  await import("../admin-cashu");

const PRIVKEY_HEX = "11".repeat(32);
const LOCK_PUBKEY = toLockPubkey(bytesToHex(schnorr.getPublicKey(hexToBytes(PRIVKEY_HEX))));
const DVM_ID = "dvm-admin-test";
const MINT_URL = "https://mint.example.com";

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function randomNonceHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function signAuth(args: { method: string; path: string; dvmId?: string; unixSeconds?: number; nonceHex?: string }): {
  header: string;
  nonceHex: string;
  unixSeconds: number;
} {
  const nonceHex = args.nonceHex ?? randomNonceHex();
  const unixSeconds = args.unixSeconds ?? Math.floor(Date.now() / 1000);
  const digest = buildAdminChallenge({
    method: args.method,
    path: args.path,
    dvmId: args.dvmId ?? DVM_ID,
    nonceHex,
    unixSeconds
  });
  const sigHex = bytesToHex(schnorr.sign(digest, hexToBytes(PRIVKEY_HEX)));
  return {
    header: `P2PK ${nonceHex}.${unixSeconds}.${sigHex}`,
    nonceHex,
    unixSeconds
  };
}

interface MockPool {
  query: ReturnType<typeof vi.fn>;
  capturedQueries: { text: string; params: unknown[] }[];
}

function makeMockPool(handlers: {
  pendingRows?: Record<string, unknown>[];
  meltRows?: Record<string, unknown>[];
  /** Override for the rowCount returned by `UPDATE wallet_accumulator ... SET melt_status = NULL`. */
  resetRowCount?: number;
}): MockPool {
  const capturedQueries: { text: string; params: unknown[] }[] = [];
  const query = vi.fn((text: string, params: unknown[]) => {
    capturedQueries.push({ text, params });
    if (text.includes("FROM wallet_accumulator") && text.includes("melted_at IS NULL")) {
      return Promise.resolve({ rows: handlers.pendingRows ?? [], rowCount: 0 });
    }
    if (text.startsWith("SELECT id, mint_url, proof_keyset_id")) {
      return Promise.resolve({ rows: handlers.meltRows ?? [], rowCount: 0 });
    }
    if (text.includes("SET melt_status = NULL")) {
      return Promise.resolve({
        rows: [],
        rowCount: handlers.resetRowCount ?? 0
      });
    }
    if (text.startsWith("UPDATE wallet_accumulator")) {
      return Promise.resolve({
        rows: [],
        rowCount: (params[0] as string[] | undefined)?.length ?? 1
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const client = { query, release: () => undefined };
  return {
    query,
    capturedQueries,
    connect: () => Promise.resolve(client)
  } as unknown as MockPool;
}

function makeWalletProvider(states: CheckStateEnum[]) {
  const wallet = {
    checkProofsStates: vi.fn((_proofs: { secret: string }[]) =>
      Promise.resolve(states.map((state, i) => ({ Y: `y${i}`, state, witness: null })))
    )
  };
  return { walletProvider: () => Promise.resolve(wallet as never), wallet };
}

function buildApp(opts: {
  pool: MockPool;
  walletProvider?: ReturnType<typeof makeWalletProvider>["walletProvider"];
  now?: () => number;
  /** Optional state override — defaults to `{ current: LOCK_PUBKEY, retired: [] }`. */
  state?: LockPubkeyStoreModule.LockPubkeyState;
  getLockPubkeyState?: LockPubkeyStoreModule.LockPubkeyStateLoader;
  nonceStore?: Parameters<typeof installAdminCashuRoutes>[1]["nonceStore"];
  onMelted?: Parameters<typeof installAdminCashuRoutes>[1]["onMelted"];
}): Hono {
  const app = new Hono();
  const state: LockPubkeyStoreModule.LockPubkeyState = opts.state ?? {
    current: LOCK_PUBKEY,
    retired: []
  };
  installAdminCashuRoutes(app, {
    db: opts.pool as never,
    dvmId: DVM_ID,
    getLockPubkeyState: opts.getLockPubkeyState ?? (() => Promise.resolve(state)),
    graceSeconds: 86_400,
    nonceStore: opts.nonceStore ?? createAdminCashuNonceStore(),
    walletProvider: opts.walletProvider as never,
    now: opts.now,
    onMelted: opts.onMelted
  });
  return app;
}

async function request(
  app: Hono,
  method: string,
  path: string,
  init?: { headers?: Record<string, string>; body?: unknown }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = init?.headers ?? {};
  const requestInit: RequestInit = { method, headers };
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestInit.body = JSON.stringify(init.body);
  }
  const res = await app.fetch(new Request(`http://localhost${path}`, requestInit));
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {}
  };
}

describe("admin-cashu auth", () => {
  let pool: MockPool;
  let app: Hono;

  beforeEach(() => {
    pool = makeMockPool({ pendingRows: [] });
    app = buildApp({ pool });
  });

  it("rejects when Authorization header is missing → 401 missing_auth", async () => {
    const res = await request(app, "GET", "/admin/cashu/pending-batches");
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("missing_auth");
  });

  it("rejects a malformed Authorization header → 401 malformed_auth", async () => {
    const res = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: "P2PK abc" }
    });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("malformed_auth");
  });

  it("rejects a bad nonce shape → 401 bad_nonce", async () => {
    const res = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: "P2PK xyz.1700000000.deadbeef" }
    });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad_nonce");
  });

  it("rejects a timestamp outside the 30s clock-skew window → 401 ts_skew", async () => {
    const stale = Math.floor(Date.now() / 1000) - 60;
    const { header } = signAuth({
      method: "GET",
      path: "/admin/cashu/pending-batches",
      unixSeconds: stale
    });
    const res = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: header }
    });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("ts_skew");
  });

  it("rejects a replayed nonce within the 5min window → 401 replay", async () => {
    const { header } = signAuth({
      method: "GET",
      path: "/admin/cashu/pending-batches"
    });
    const first = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: header }
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ batches: [] });
    const second = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: header }
    });
    expect(second.status).toBe(401);
    expect(second.body.reason).toBe("replay");
  });

  it("rejects a signature replayed across HTTP method/path → 401 bad_signature", async () => {
    // Sign GET, send as POST — method-binding in the challenge causes the
    // schnorr verify to fail.
    const { header } = signAuth({
      method: "GET",
      path: "/admin/cashu/pending-batches"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: { row_ids: ["r1"], melt_quote_id: "q", payment_preimage: "p" }
    });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad_signature");
  });

  it("rejects a signature from a different keypair → 401 bad_signature", async () => {
    const otherPriv = "22".repeat(32);
    const nonceHex = randomNonceHex();
    const unixSeconds = Math.floor(Date.now() / 1000);
    const digest = buildAdminChallenge({
      method: "GET",
      path: "/admin/cashu/pending-batches",
      dvmId: DVM_ID,
      nonceHex,
      unixSeconds
    });
    const sigHex = bytesToHex(schnorr.sign(digest, hexToBytes(otherPriv)));
    const res = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: `P2PK ${nonceHex}.${unixSeconds}.${sigHex}` }
    });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad_signature");
  });

  it("returns a retriable 503 without consuming the nonce when lock state is unavailable", async () => {
    const state = { current: LOCK_PUBKEY, retired: [] };
    const getLockPubkeyState = vi
      .fn<LockPubkeyStoreModule.LockPubkeyStateLoader>()
      .mockRejectedValueOnce(
        Object.assign(new Error("postgres://operator:secret@example.invalid/dvm"), {
          code: "57P01"
        })
      )
      .mockResolvedValue(state);
    const nonceStore = {
      has: vi.fn(() => Promise.resolve(false)),
      mark: vi.fn(() => Promise.resolve())
    };
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outagePool = makeMockPool({ pendingRows: [] });
    const outageApp = buildApp({
      pool: outagePool,
      getLockPubkeyState,
      nonceStore
    });
    const { header } = signAuth({
      method: "GET",
      path: "/admin/cashu/pending-batches"
    });

    const unavailable = await request(outageApp, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: header }
    });

    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({
      error: "admin_state_unavailable",
      message:
        "Admin authentication state is temporarily unavailable. No operation was performed; retry after database availability is restored."
    });
    expect(nonceStore.has).not.toHaveBeenCalled();
    expect(nonceStore.mark).not.toHaveBeenCalled();
    expect(outagePool.query).not.toHaveBeenCalled();
    const logged = warn.mock.calls[0]?.[0] as string;
    expect(JSON.parse(logged)).toMatchObject({
      event: "admin_lock_state_unavailable",
      level: "error",
      method: "GET",
      route: "GET /admin/cashu/pending-batches",
      error_code: "unknown_error"
    });
    expect(logged).not.toContain("operator");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("example.invalid");

    const recovered = await request(outageApp, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: header }
    });
    expect(recovered.status).toBe(200);
    expect(nonceStore.has).toHaveBeenCalledOnce();
    expect(nonceStore.mark).toHaveBeenCalledOnce();
  });
});

describe("GET /admin/cashu/pending-batches", () => {
  it("returns batches grouped by (lock_pubkey, mint_url) with t_expire=null for legacy rows", async () => {
    const pool = makeMockPool({
      pendingRows: [
        {
          id: "row-a",
          lock_pubkey: LOCK_PUBKEY,
          mint_url: MINT_URL,
          proof_keyset_id: "k1",
          proof_secret: "s1",
          proof_c: "C1",
          proof_amount: 100,
          proof_dleq: { e: "dleq-e", s: "dleq-s", r: "blind-r" },
          received_at: 1_000_000,
          melt_quote_id: null,
          t_expire: null
        },
        {
          id: "row-b",
          lock_pubkey: LOCK_PUBKEY,
          mint_url: MINT_URL,
          proof_keyset_id: "k1",
          proof_secret: "s2",
          proof_c: "C2",
          proof_amount: 200,
          received_at: 1_000_100,
          melt_quote_id: null,
          t_expire: null
        }
      ]
    });
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "GET",
      path: "/admin/cashu/pending-batches"
    });
    const res = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: header }
    });
    expect(res.status).toBe(200);
    const batches = res.body.batches as Record<string, unknown>[];
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      mint_url: MINT_URL,
      lock_pubkey: LOCK_PUBKEY,
      total_sats: 300,
      t_expire: null
    });
    expect(batches[0].proofs as unknown[]).toHaveLength(2);
    expect((batches[0].proofs as Record<string, unknown>[])[0].dleq).toEqual({
      e: "dleq-e",
      s: "dleq-s",
      r: "blind-r"
    });
    expect((batches[0].proofs as Record<string, unknown>[])[1].dleq).toBeUndefined();
    expect(batches[0].row_ids as string[]).toEqual(["row-a", "row-b"]);
  });

  it("emits t_expire (ms) from the store as the minimum per batch", async () => {
    // Two rows in the same (lock_pubkey, mint_url, melt_quote_id) group with
    // distinct t_expire values — the admin response must surface the minimum.
    const tExpireEarly = 1_800_000_000_000;
    const tExpireLate = 1_900_000_000_000;
    const pool = makeMockPool({
      pendingRows: [
        {
          id: "row-a",
          lock_pubkey: LOCK_PUBKEY,
          mint_url: MINT_URL,
          proof_keyset_id: "k1",
          proof_secret: "s1",
          proof_c: "C1",
          proof_amount: 100,
          received_at: 1_000_000,
          melt_quote_id: null,
          t_expire: tExpireLate
        },
        {
          id: "row-b",
          lock_pubkey: LOCK_PUBKEY,
          mint_url: MINT_URL,
          proof_keyset_id: "k1",
          proof_secret: "s2",
          proof_c: "C2",
          proof_amount: 200,
          received_at: 1_000_100,
          melt_quote_id: null,
          t_expire: tExpireEarly
        }
      ]
    });
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "GET",
      path: "/admin/cashu/pending-batches"
    });
    const res = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: header }
    });
    expect(res.status).toBe(200);
    const batches = res.body.batches as Record<string, unknown>[];
    expect(batches).toHaveLength(1);
    expect(batches[0].t_expire).toBe(tExpireEarly);
  });
});

describe("POST /admin/cashu/mark-melted", () => {
  function makeMeltRow(id: string, status: "melting" | "melted" | "failed" | null = null) {
    return {
      id,
      mint_url: MINT_URL,
      proof_keyset_id: "k1",
      proof_secret: `secret-${id}`,
      proof_c: `C-${id}`,
      proof_amount: 100,
      melt_status: status
    };
  }

  it("rejects body without row_ids array → 400", async () => {
    const pool = makeMockPool({});
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: { melt_quote_id: "q", payment_preimage: "p" }
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("rejects body missing melt_quote_id → 400", async () => {
    const pool = makeMockPool({});
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: { row_ids: ["r1"], payment_preimage: "p" }
    });
    expect(res.status).toBe(400);
  });

  it("rejects when one or more row_ids do not exist for this DVM → 404", async () => {
    const pool = makeMockPool({ meltRows: [makeMeltRow("r1")] });
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: {
        row_ids: ["r1", "r2"],
        melt_quote_id: "q",
        payment_preimage: "p"
      }
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("rows_not_found");
    expect(res.body.missing_row_ids).toEqual(["r2"]);
  });

  it("rejects when a row is already melted → 409", async () => {
    const pool = makeMockPool({ meltRows: [makeMeltRow("r1", "melted")] });
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: { row_ids: ["r1"], melt_quote_id: "q", payment_preimage: "p" }
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rows_already_melted");
  });

  it("rejects with proofs_not_spent when mint reports PENDING → 422", async () => {
    const pool = makeMockPool({ meltRows: [makeMeltRow("r1")] });
    const { walletProvider } = makeWalletProvider([CheckStateEnum.PENDING]);
    const app = buildApp({ pool, walletProvider });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: { row_ids: ["r1"], melt_quote_id: "q", payment_preimage: "p" }
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("proofs_not_spent");
  });

  it("queues the landed melt inside the transaction that marks the rows, and reports it once that commits", async () => {
    const pool = makeMockPool({
      meltRows: [makeMeltRow("r1"), makeMeltRow("r2")]
    });
    const { walletProvider, wallet } = makeWalletProvider([CheckStateEnum.SPENT, CheckStateEnum.SPENT]);
    const enqueue = vi.fn(async () => undefined);
    const committed = vi.fn();
    const app = buildApp({
      pool,
      walletProvider,
      onMelted: { enqueue, committed }
    });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: {
        row_ids: ["r1", "r2"],
        melt_quote_id: "quote-abc",
        payment_preimage: "preimage-xyz"
      }
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ melted: 2 });
    expect(wallet.checkProofsStates).toHaveBeenCalledOnce();
    expect(wallet.checkProofsStates.mock.calls[0][0].map((p) => p.secret)).toEqual(["secret-r1", "secret-r2"]);
    const updates = pool.capturedQueries.filter((q) => q.text.startsWith("UPDATE wallet_accumulator"));
    expect(updates).toHaveLength(2);
    expect(updates[0].text).toContain("SET melt_quote_id = $2, payment_preimage = $3");
    expect(updates[0].params).toEqual([["r1", "r2"], "quote-abc", "preimage-xyz"]);
    expect(updates[1].text).toContain("SET melt_status = 'melted'");
    expect(enqueue).toHaveBeenCalledWith(
      {
        rows: [
          { id: "r1", mintUrl: MINT_URL, proofAmount: 100 },
          { id: "r2", mintUrl: MINT_URL, proofAmount: 100 }
        ],
        meltQuoteId: "quote-abc",
        paymentPreimage: "preimage-xyz"
      },
      expect.objectContaining({ query: expect.any(Function) })
    );
    const texts = pool.capturedQueries.map((q) => q.text);
    const begin = texts.indexOf("BEGIN");
    const melted = texts.findIndex((t) => t.includes("SET melt_status = 'melted'"));
    const commit = texts.indexOf("COMMIT");
    expect(begin).toBeGreaterThan(-1);
    expect(melted).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(melted);
    expect(texts).not.toContain("ROLLBACK");
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed.mock.invocationCallOrder[0]).toBeGreaterThan(enqueue.mock.invocationCallOrder[0]);
  });

  it("rolls the mark back and fails the call when the payout row cannot be queued — the CLI re-posts", async () => {
    const pool = makeMockPool({ meltRows: [makeMeltRow("r1")] });
    const { walletProvider } = makeWalletProvider([CheckStateEnum.SPENT]);
    const enqueue = vi.fn(async () => {
      throw new Error("outbox down");
    });
    const committed = vi.fn();
    const app = buildApp({
      pool,
      walletProvider,
      onMelted: { enqueue, committed }
    });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    // Hono's default error page is text, so read the status off the raw response.
    const res = await app.fetch(
      new Request("http://localhost/admin/cashu/mark-melted", {
        method: "POST",
        headers: { Authorization: header, "Content-Type": "application/json" },
        body: JSON.stringify({
          row_ids: ["r1"],
          melt_quote_id: "q",
          payment_preimage: "p"
        })
      })
    );
    expect(res.status).toBe(500);
    const texts = pool.capturedQueries.map((q) => q.text);
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
    expect(committed).not.toHaveBeenCalled();
  });

  it("refuses a proof the mint reports UNSPENT before the payout hook can see it", async () => {
    const pool = makeMockPool({ meltRows: [makeMeltRow("r1")] });
    const { walletProvider } = makeWalletProvider([CheckStateEnum.UNSPENT]);
    const enqueue = vi.fn(async () => undefined);
    const onMelted = { enqueue, committed: vi.fn() };
    const app = buildApp({ pool, walletProvider, onMelted });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: { row_ids: ["r1"], melt_quote_id: "q", payment_preimage: "p" }
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("proofs_not_spent");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns 502 when the mint checkstate throws", async () => {
    const pool = makeMockPool({ meltRows: [makeMeltRow("r1")] });
    const walletProvider = () =>
      Promise.resolve({
        checkProofsStates: vi.fn(() => Promise.reject(new Error("mint down")))
      } as never);
    const app = buildApp({ pool, walletProvider });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: { row_ids: ["r1"], melt_quote_id: "q", payment_preimage: "p" }
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("mint_unreachable");
  });

  it("returns 502 mint_unreachable when NUT-7 returns fewer states than proofs", async () => {
    // The index-based attribution below assumes the mint returns exactly one
    // state per submitted proof — a short response would mis-label offenders
    // or silently mark not-SPENT proofs as melted. Surface as transient.
    const pool = makeMockPool({
      meltRows: [makeMeltRow("r1"), makeMeltRow("r2")]
    });
    const walletProvider = () =>
      Promise.resolve({
        checkProofsStates: vi.fn(() => Promise.resolve([{ Y: "y0", state: CheckStateEnum.SPENT, witness: null }]))
      } as never);
    const app = buildApp({ pool, walletProvider });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/mark-melted"
    });
    const res = await request(app, "POST", "/admin/cashu/mark-melted", {
      headers: { Authorization: header },
      body: {
        row_ids: ["r1", "r2"],
        melt_quote_id: "q",
        payment_preimage: "p"
      }
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("mint_unreachable");
    expect(res.body.message).toContain("1 proof states for 2 proofs");
  });
});

describe("POST /admin/cashu/restart-failed", () => {
  it("resets eligible rows when called with no body", async () => {
    const pool = makeMockPool({ resetRowCount: 3 });
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/restart-failed"
    });
    const res = await request(app, "POST", "/admin/cashu/restart-failed", {
      headers: { Authorization: header }
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ restarted: 3 });
  });

  it("scopes the reset to the supplied row_ids", async () => {
    const pool = makeMockPool({ resetRowCount: 1 });
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/restart-failed"
    });
    const res = await request(app, "POST", "/admin/cashu/restart-failed", {
      headers: { Authorization: header },
      body: { row_ids: ["row-x"] }
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ restarted: 1 });
    const update = pool.capturedQueries.find((q) => q.text.includes("AND id = ANY($2::text[])"));
    expect(update?.params).toEqual([DVM_ID, ["row-x"]]);
  });

  it("rejects an invalid row_ids body shape → 400", async () => {
    const pool = makeMockPool({});
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/restart-failed"
    });
    const res = await request(app, "POST", "/admin/cashu/restart-failed", {
      headers: { Authorization: header },
      body: { row_ids: "not-an-array" }
    });
    expect(res.status).toBe(400);
  });
});

describe("admin-cashu auth accepts retired-in-grace pubkey on read routes", () => {
  it("accepts a signature from a retired-but-in-grace pubkey on GET /pending-batches", async () => {
    // The current key has rotated, but the caller still signs with the
    // previously-current key (now retired). Within the grace window the
    // admin auth must still accept the signature.
    const NEW_PRIV = "33".repeat(32);
    const NEW_PUBKEY = toLockPubkey(bytesToHex(schnorr.getPublicKey(hexToBytes(NEW_PRIV))));
    const pool = makeMockPool({ pendingRows: [] });
    const app = buildApp({
      pool,
      state: {
        current: NEW_PUBKEY,
        // LOCK_PUBKEY is the retired one — the existing PRIVKEY_HEX still signs it.
        retired: [{ pubkey: LOCK_PUBKEY, retiredAtMs: Date.now() - 1000 }]
      }
    });
    const { header } = signAuth({
      method: "GET",
      path: "/admin/cashu/pending-batches"
    });
    const res = await request(app, "GET", "/admin/cashu/pending-batches", {
      headers: { Authorization: header }
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /admin/cashu/rotate-lock-pubkey", () => {
  const NEW_PUBKEY = toLockPubkey("02" + "55".repeat(32));

  beforeEach(() => {
    vi.mocked(mockRotateLockPubkey).mockReset();
  });

  it("rotates on a valid signed challenge with a well-formed new pubkey → 200", async () => {
    vi.mocked(mockRotateLockPubkey).mockResolvedValue({
      current: NEW_PUBKEY,
      retired: [{ pubkey: LOCK_PUBKEY, retiredAtMs: 1_700_000_000_000 }]
    });
    const pool = makeMockPool({});
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/rotate-lock-pubkey"
    });
    const res = await request(app, "POST", "/admin/cashu/rotate-lock-pubkey", {
      headers: { Authorization: header },
      body: { new_pubkey: NEW_PUBKEY }
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      current: NEW_PUBKEY,
      retired: [{ pubkey: LOCK_PUBKEY, retired_at_ms: 1_700_000_000_000 }]
    });
    expect(mockRotateLockPubkey).toHaveBeenCalledOnce();
  });

  it("rejects a signature from a retired-but-in-grace pubkey → 401", async () => {
    // Retired-key signing is honoured on read routes (auth accepts the
    // current+retired set), but the rotate route narrows to current-only:
    // only the holder of the current privkey may demote it.
    const NEW_PRIV = "44".repeat(32);
    const NEW_CURRENT_PUBKEY = toLockPubkey(bytesToHex(schnorr.getPublicKey(hexToBytes(NEW_PRIV))));
    const pool = makeMockPool({});
    const app = buildApp({
      pool,
      state: {
        current: NEW_CURRENT_PUBKEY,
        retired: [{ pubkey: LOCK_PUBKEY, retiredAtMs: Date.now() - 1000 }]
      }
    });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/rotate-lock-pubkey"
    });
    const res = await request(app, "POST", "/admin/cashu/rotate-lock-pubkey", {
      headers: { Authorization: header },
      body: { new_pubkey: NEW_PUBKEY }
    });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad_signature");
    expect(mockRotateLockPubkey).not.toHaveBeenCalled();
  });

  it("returns 503 without attempting rotation when current signer state is unavailable", async () => {
    const pool = makeMockPool({});
    const app = buildApp({
      pool,
      getLockPubkeyState: () => Promise.reject(new Error("connection terminated"))
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/rotate-lock-pubkey"
    });

    const res = await request(app, "POST", "/admin/cashu/rotate-lock-pubkey", {
      headers: { Authorization: header },
      body: { new_pubkey: NEW_PUBKEY }
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("admin_state_unavailable");
    expect(mockRotateLockPubkey).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a malformed new_pubkey → 400 invalid_pubkey", async () => {
    const pool = makeMockPool({});
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/rotate-lock-pubkey"
    });
    const res = await request(app, "POST", "/admin/cashu/rotate-lock-pubkey", {
      headers: { Authorization: header },
      body: { new_pubkey: "not-a-pubkey" }
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_pubkey");
  });

  it("rejects a no-op rotation (new_pubkey === current) → 409", async () => {
    // `state.current` carries the compressed form ("02"-prefix). `verifyChallenge`
    // strips the parity byte before schnorr.verify, so auth using the matching
    // privkey still works. The no-op guard then matches on the compressed
    // pubkey exactly.
    const compressed = toLockPubkey(`02${LOCK_PUBKEY}`);
    const pool = makeMockPool({});
    const app = buildApp({
      pool,
      state: { current: compressed, retired: [] }
    });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/rotate-lock-pubkey"
    });
    const res = await request(app, "POST", "/admin/cashu/rotate-lock-pubkey", {
      headers: { Authorization: header },
      body: { new_pubkey: compressed }
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_op_rotation");
  });

  it("rejects a non-JSON body → 400 invalid_body", async () => {
    const pool = makeMockPool({});
    const app = buildApp({ pool });
    const { header } = signAuth({
      method: "POST",
      path: "/admin/cashu/rotate-lock-pubkey"
    });
    const res = await app.fetch(
      new Request(`http://localhost/admin/cashu/rotate-lock-pubkey`, {
        method: "POST",
        headers: { Authorization: header, "Content-Type": "application/json" },
        body: "not json"
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });
});
