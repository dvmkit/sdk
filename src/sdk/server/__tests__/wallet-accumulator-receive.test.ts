import * as cashuTs from "@cashu/cashu-ts";
import { Amount, CheckStateEnum, type Proof } from "@cashu/cashu-ts";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";
import { DEFAULT_CASHU_LOCK_WINDOW_SECONDS } from "../../cashu-locktime";
import * as cashuVerify from "../../../lib/cashu/verify";

vi.mock("../../../lib/cashu/verify", () => ({
  verifyCashuToken: vi.fn(),
}));
vi.mock("@cashu/cashu-ts", async (importOriginal) => {
  const actual = await importOriginal<typeof cashuTs>();
  return {
    ...actual,
    verifyDleqIfPresent: vi.fn(),
  };
});

const { acceptAccumulatorPayment, valueCashuFunding } =
  await import("../wallet-accumulator-receive");
const { createDisposableCashuStore } = await import("../disposable-cashu-store");
const { hashProofSecret } = await import("../wallet-accumulator-store");

const mockVerify = vi.mocked(cashuVerify.verifyCashuToken);
const mockVerifyDleq = vi.mocked(cashuTs.verifyDleqIfPresent);

const RECOVERY_PUBKEY = toLockPubkey("02" + "ab".repeat(32));
const MINT = "https://mint.example.com";
const DVM_ID = "dvm-test-1";

interface MockPoolOpts {
  /** Set true to make INSERT throw a unique_violation (simulating either UNIQUE constraint firing). */
  insertReplay?: boolean;
}

function makeMockPool(mockOpts: MockPoolOpts = {}) {
  const clientQuery = vi.fn((text: string) => {
    if (mockOpts.insertReplay && text.startsWith("INSERT INTO wallet_accumulator")) {
      return Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const client: Pick<PoolClient, "query" | "release"> = {
    query: clientQuery as unknown as PoolClient["query"],
    release: vi.fn(),
  };
  const connect = vi.fn(() => Promise.resolve(client as unknown as PoolClient));
  const pool = {
    query: vi.fn(() =>
      Promise.resolve({ rows: [], rowCount: 0 })
    ) as unknown as PoolClient["query"],
    connect,
  };
  return { pool, client, clientQuery };
}

/** A real NUT-11 secret; `label` doubles as the nonce so each proof is distinct. */
function p2pkSecret(label: string, data: string = RECOVERY_PUBKEY, tags: string[][] = []): string {
  return JSON.stringify(["P2PK", { nonce: label, data, tags }]);
}

function makeProof(label = "secret-1", amount = 5, id = "keyset-1", secret = p2pkSecret(label)): Proof {
  return {
    id,
    amount: amount as unknown as Proof["amount"],
    secret,
    C: "C-deadbeef",
    dleq: { e: "01", s: "02", r: "03" },
  };
}

function setupHappyDecode(proofs: Proof[], totalSats: number, feeSats = 0) {
  mockVerify.mockReturnValue({ mint: MINT, totalMsats: totalSats * 1000, unit: "sat" });
  const wallet = {
    decodeToken: vi.fn(() => ({ proofs, mint: MINT, unit: "sat" })),
    getKeyset: vi.fn(() => ({ id: "keyset-1" })),
    getFeesForProofs: vi.fn(() => Amount.from(feeSats)),
    checkProofsStates: vi.fn(),
  };
  return { wallet };
}

describe("valueCashuFunding", () => {
  it("keeps zero-fee funding economically unchanged", () => {
    const proofs = [makeProof("zero", 400)];
    const getFeesForProofs = vi.fn(() => Amount.zero());

    expect(valueCashuFunding({ getFeesForProofs } as never, proofs)).toEqual({
      grossMsats: 400_000,
      inputFeeMsats: 0,
      netMsats: 400_000,
    });
    expect(getFeesForProofs).toHaveBeenCalledWith(proofs);
  });

  it("passes mixed active and inactive keyset ids to cashu-ts as one proof set", () => {
    const proofs = [
      makeProof("active", 200, "active-keyset"),
      makeProof("inactive", 201, "inactive-keyset"),
    ];
    const getFeesForProofs = vi.fn((received: Proof[]) => {
      expect(received.map((proof) => proof.id)).toEqual(["active-keyset", "inactive-keyset"]);
      return Amount.from(1);
    });

    expect(valueCashuFunding({ getFeesForProofs } as never, proofs)).toEqual({
      grossMsats: 401_000,
      inputFeeMsats: 1_000,
      netMsats: 400_000,
    });
  });

  it("converts the aggregate fee for more than ten proofs to msats", () => {
    const proofs = Array.from({ length: 11 }, (_, index) =>
      makeProof(`round-${index}`, 1, "100-ppk-keyset")
    );
    const getFeesForProofs = vi.fn(() => Amount.from(2));

    expect(valueCashuFunding({ getFeesForProofs } as never, proofs)).toEqual({
      grossMsats: 11_000,
      inputFeeMsats: 2_000,
      netMsats: 9_000,
    });
  });

  it("rejects an unknown keyset instead of falling back to zero fee", () => {
    const getFeesForProofs = vi.fn(() => {
      throw new Error("No keyset found for keyset id: retired-unknown");
    });
    expect(() =>
      valueCashuFunding({ getFeesForProofs } as never, [
        makeProof("unknown", 10, "retired-unknown"),
      ])
    ).toThrow("No keyset found");
  });

  it("rejects a fee at or above proof face and unsafe msat conversion", () => {
    expect(() =>
      valueCashuFunding({ getFeesForProofs: () => Amount.from(1) } as never, [
        makeProof("fee-equals-face", 1),
      ])
    ).toThrow("must be lower");
    expect(() =>
      valueCashuFunding({ getFeesForProofs: () => Amount.zero() } as never, [
        makeProof("unsafe", Number.MAX_SAFE_INTEGER),
      ])
    ).toThrow("exceeds Number.MAX_SAFE_INTEGER");
  });
});

describe("acceptAccumulatorPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyDleq.mockReturnValue(true);
  });

  it("rejects missing or invalid mint DLEQ evidence before accounting", async () => {
    const missing = makeProof();
    delete missing.dleq;
    const missingWallet = setupHappyDecode([missing], 5).wallet;
    const { pool } = makeMockPool();
    const base = {
      cashuToken: "cashuB...",
      requestId: "req-dleq",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
    };
    const missingResult = await acceptAccumulatorPayment({
      ...base,
      walletProvider: vi.fn(() => Promise.resolve(missingWallet as never)),
    });
    expect(missingResult).toMatchObject({ kind: "rejected", code: "invalid_token" });

    const invalidWallet = setupHappyDecode([makeProof()], 5).wallet;
    mockVerifyDleq.mockReturnValue(false);
    const invalidResult = await acceptAccumulatorPayment({
      ...base,
      requestId: "req-invalid-dleq",
      walletProvider: vi.fn(() => Promise.resolve(invalidWallet as never)),
    });
    expect(invalidResult).toMatchObject({ kind: "rejected", code: "invalid_token" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects when request_id is missing", async () => {
    const { pool } = makeMockPool();
    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.code).toBe("missing_request_id");
  });

  it("refuses a supplied request id in the derived-id namespace before touching the store", async () => {
    const { pool } = makeMockPool();
    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      requestId: `nut24-${"0".repeat(64)}`,
    });
    expect(result).toMatchObject({ kind: "rejected", code: "reserved_request_id" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects when proof is not P2PK-locked to recovery pubkey", async () => {
    const proofs = [makeProof("wrong", 5, "keyset-1", p2pkSecret("wrong", "02" + "11".repeat(32)))];
    const { wallet } = setupHappyDecode(proofs, 10);

    const { pool } = makeMockPool();

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-1",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.code).toBe("wrong_lock_pubkey");
  });

  it("rejects with proof_not_unspent when NUT-7 reports SPENT", async () => {
    const proofs = [makeProof()];
    const { wallet } = setupHappyDecode(proofs, 10);
    wallet.checkProofsStates.mockResolvedValue([
      { Y: "y", state: CheckStateEnum.SPENT, witness: null },
    ]);

    const { pool } = makeMockPool();

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-2",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.code).toBe("proof_not_unspent");
  });

  it("rejects with mint_unreachable when NUT-7 returns fewer states than proofs", async () => {
    // NUT-7 parallel-array invariant: a short states response would let SPENT
    // proofs at the trailing indices slip past `.some(...)` and persist into
    // the accumulator. Surfacing as `mint_unreachable` (transient) lets the
    // agent retry rather than mark the token permanently rejected.
    const proofs = [makeProof("s1"), makeProof("s2")];
    const { wallet } = setupHappyDecode(proofs, 10);
    wallet.checkProofsStates.mockResolvedValue([
      { Y: "y1", state: CheckStateEnum.UNSPENT, witness: null },
    ]);

    const { pool } = makeMockPool();

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-shape",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.code).toBe("mint_unreachable");
      expect(result.message).toContain("1 proof states for 2 proofs");
    }
  });

  it("rejects with proof_pending when NUT-7 reports PENDING (distinct from SPENT)", async () => {
    // PENDING is transient — the agent CLI retries with backoff. Surfacing
    // a distinct code lets it differentiate "retry shortly" from the
    // permanent "already spent" failure.
    const proofs = [makeProof()];
    const { wallet } = setupHappyDecode(proofs, 10);
    wallet.checkProofsStates.mockResolvedValue([
      { Y: "y", state: CheckStateEnum.PENDING, witness: null },
    ]);

    const { pool } = makeMockPool();

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-pending",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.code).toBe("proof_pending");
  });

  it("accumulates a P2PK payment via the insert transaction", async () => {
    const proofs = [makeProof("s1"), makeProof("s2")];
    proofs[0].dleq = { e: "dleq-e", s: "dleq-s", r: "blind-r" };
    const { wallet } = setupHappyDecode(proofs, 10);
    wallet.checkProofsStates.mockResolvedValue([
      { Y: "y1", state: CheckStateEnum.UNSPENT, witness: null },
      { Y: "y2", state: CheckStateEnum.UNSPENT, witness: null },
    ]);

    const { pool, clientQuery } = makeMockPool();

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-3",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });

    expect(result.kind).toBe("accumulated");
    if (result.kind === "accumulated") {
      expect(result.paidMsats).toBe(10_000);
      expect(result.mintUrl).toBe(MINT);
    }
    // BEGIN, two INSERTs, COMMIT
    const clientCalls = clientQuery.mock.calls.map((c) => c[0]);
    expect(clientCalls).toContain("BEGIN");
    expect(clientCalls).toContain("COMMIT");
    expect(
      clientCalls.filter((sql) => sql.startsWith("INSERT INTO wallet_accumulator")).length
    ).toBe(2);
    const inserts = (clientQuery.mock.calls as unknown as [string, unknown[]][]).filter((call) =>
      call[0].startsWith("INSERT INTO wallet_accumulator")
    );
    expect(inserts[0][1][8]).toEqual({ e: "dleq-e", s: "dleq-s", r: "blind-r" });
    expect(inserts[1][1][8]).toEqual({ e: "01", s: "02", r: "03" });
  });

  it("accepts 401 gross sats as 400 net at a 100-ppk mint", async () => {
    const proofs = [
      makeProof("f1", 256),
      makeProof("f2", 128),
      makeProof("f3", 16),
      makeProof("f4", 1),
    ];
    const { wallet } = setupHappyDecode(proofs, 401, 1);
    wallet.checkProofsStates.mockResolvedValue(
      proofs.map((_, index) => ({
        Y: `y${index}`,
        state: CheckStateEnum.UNSPENT,
        witness: null,
      }))
    );
    const beforeCommit = vi.fn();
    const withCommitTx = vi.fn();
    const { pool } = makeMockPool();

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-fee",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
      beforeCommit,
      withCommitTx,
    });

    const accepted = {
      grossMsats: 401_000,
      inputFeeMsats: 1_000,
      mintUrl: MINT,
      netMsats: 400_000,
      paidMsats: 400_000,
      requestId: "req-fee",
    };
    expect(result).toEqual({ kind: "accumulated", ...accepted });
    expect(beforeCommit).toHaveBeenCalledWith(accepted);
    expect(withCommitTx).toHaveBeenCalledWith(expect.anything(), accepted);
  });

  it("runs value validation before opening the accumulator transaction", async () => {
    const proofs = [makeProof("precommit", 10)];
    const { wallet } = setupHappyDecode(proofs, 10, 1);
    wallet.checkProofsStates.mockResolvedValue([
      { Y: "y", state: CheckStateEnum.UNSPENT, witness: null },
    ]);
    const { pool, clientQuery } = makeMockPool();

    await expect(
      acceptAccumulatorPayment({
        cashuToken: "cashuB...",
        requestId: "req-precommit",
        mints: [MINT],
        db: pool as never,
        dvmId: DVM_ID,
        lockPubkeys: [RECOVERY_PUBKEY],
        lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
        walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
        beforeCommit: () => {
          throw new Error("valuation mismatch");
        },
      })
    ).rejects.toThrow("valuation mismatch");
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("parses the NUT-11 locktime tag and persists t_expire (ms) on the row", async () => {
    // First proof carries a locktime tag (unix seconds); the second has none.
    // The store's INSERT must bind the parsed locktime in ms for the first
    // row and null for the second.
    const locktimeSec = Math.floor(Date.now() / 1000) + 7 * 86_400;
    const nut10Secret = p2pkSecret("n1", RECOVERY_PUBKEY, [["locktime", `${locktimeSec}`]]);
    const noTagSecret = p2pkSecret("no-tag");
    const proofs = [makeProof("n1", 5, "keyset-1", nut10Secret), makeProof("no-tag", 5, "keyset-1", noTagSecret)];
    const { wallet } = setupHappyDecode(proofs, 10);
    wallet.checkProofsStates.mockResolvedValue([
      { Y: "y1", state: CheckStateEnum.UNSPENT, witness: null },
      { Y: "y2", state: CheckStateEnum.UNSPENT, witness: null },
    ]);

    const { pool, clientQuery } = makeMockPool();
    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-locktime",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });
    expect(result.kind).toBe("accumulated");

    // INSERTs include t_expire as the 14th param ($14). Match each insert to
    // its proof via the proof_secret bind ($6) so order doesn't matter.
    const inserts = (clientQuery.mock.calls as unknown as [string, unknown[]][]).filter((c) =>
      c[0].startsWith("INSERT INTO wallet_accumulator")
    );
    expect(inserts).toHaveLength(2);
    const tExpireBySecret = new Map<string, unknown>();
    for (const [, params] of inserts) {
      tExpireBySecret.set(params[5] as string, params[13]);
    }
    expect(tExpireBySecret.get(nut10Secret)).toBe(locktimeSec * 1000);
    expect(tExpireBySecret.get(noTagSecret)).toBeNull();
  });

  it("returns replay_rejected on UNIQUE constraint violation", async () => {
    // Covers both UNIQUE constraints — the mock unique_violation doesn't
    // distinguish (dvm_id, request_id, proof_secret) from
    // (dvm_id, proof_secret_hash). The DB-level distinction lives in the
    // wallet-accumulator-store db test.
    const proofs = [makeProof("s-replay")];
    const { wallet } = setupHappyDecode(proofs, 10);
    wallet.checkProofsStates.mockResolvedValue([
      { Y: "y", state: CheckStateEnum.UNSPENT, witness: null },
    ]);

    const { pool } = makeMockPool({ insertReplay: true });
    // The post-rollback lookup finds the proof banked under this request id.
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ proof_secret_hash: hashProofSecret(proofs[0]!.secret), request_id: "req-replay" }],
      rowCount: 1,
    } as never);

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-replay",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });

    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.code).toBe("replay_rejected");
  });

  it("accepts a proof locked to a retired-but-in-grace pubkey", async () => {
    const RETIRED_PUBKEY = toLockPubkey("03" + "cd".repeat(32));
    // Proof was minted with outputs locked to the now-retired pubkey.
    const proofs = [makeProof("retired", 5, "keyset-1", p2pkSecret("retired", RETIRED_PUBKEY))];
    const { wallet } = setupHappyDecode(proofs, 10);
    wallet.checkProofsStates.mockResolvedValue([
      { Y: "y", state: CheckStateEnum.UNSPENT, witness: null },
    ]);
    const { pool, clientQuery } = makeMockPool();

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-grace",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY, RETIRED_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });

    expect(result.kind).toBe("accumulated");
    // Verify the row was inserted with the retired pubkey as its lock_pubkey
    // so the monitor can later surface it as a retired batch.
    const insertCall = clientQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].startsWith("INSERT INTO wallet_accumulator")
    );
    expect(insertCall).toBeTruthy();
    const insertParams = (insertCall as unknown as [string, unknown[]])[1];
    expect(insertParams[2]).toBe(RETIRED_PUBKEY); // lock_pubkey column
  });

  it("refuses a non-exclusive lock before the mint round-trip, valuation hooks or any write", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const proofs = [
      makeProof("ok"),
      makeProof("soon", 5, "keyset-1", p2pkSecret("soon", RECOVERY_PUBKEY, [
        ["locktime", `${nowSec + 3600}`],
        ["refund", "02" + "ef".repeat(32)],
      ])),
    ];
    const { wallet } = setupHappyDecode(proofs, 10);
    const { pool } = makeMockPool();
    const beforeCommit = vi.fn();
    const withCommitTx = vi.fn();

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-not-exclusive",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
      beforeCommit,
      withCommitTx,
    });

    expect(result).toMatchObject({ kind: "rejected", code: "lock_not_exclusive" });
    expect(wallet.checkProofsStates).not.toHaveBeenCalled();
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(withCommitTx).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("answers a below-floor retry of already-banked proofs as replay_rejected", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const proofs = [makeProof("aged", 5, "keyset-1", p2pkSecret("aged", RECOVERY_PUBKEY, [
      ["locktime", `${nowSec + 5 * 86_400}`],
    ]))];
    const { wallet } = setupHappyDecode(proofs, 5);
    const { pool } = makeMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ proof_secret_hash: hashProofSecret(proofs[0]!.secret), request_id: "req-aged" }],
      rowCount: 1,
    } as never);

    const result = await acceptAccumulatorPayment({
      cashuToken: "cashuB...",
      requestId: "req-aged",
      mints: [MINT],
      db: pool as never,
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    });

    expect(result).toMatchObject({ kind: "rejected", code: "replay_rejected", acceptedRequestId: "req-aged" });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("refuses a token carrying the same proof twice as invalid_token on either store, before any write", async () => {
    const LOOPBACK_MINT = "http://localhost:3338";
    const proof = makeProof("twice", 5);
    const { wallet } = setupHappyDecode([proof, { ...proof }], 10);
    mockVerify.mockReturnValue({ mint: LOOPBACK_MINT, totalMsats: 10_000, unit: "sat" });
    const { pool } = makeMockPool();
    const store = createDisposableCashuStore();
    const common = {
      cashuToken: "cashuB...",
      requestId: "req-twice",
      mints: [LOOPBACK_MINT],
      dvmId: DVM_ID,
      lockPubkeys: [RECOVERY_PUBKEY],
      lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
      walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
    };

    const onPostgres = await acceptAccumulatorPayment({ ...common, db: pool as never });
    const withLedger = vi.fn();
    const inMemory = await acceptAccumulatorPayment({ ...common, disposable: store.accumulator, withDisposableLedger: withLedger });

    for (const result of [onPostgres, inMemory]) {
      expect(result).toMatchObject({ kind: "rejected", code: "invalid_token" });
    }
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(withLedger).not.toHaveBeenCalled();
    expect(wallet.checkProofsStates).not.toHaveBeenCalled();
    // Nothing was claimed: the same request id still takes a well-formed payment.
    expect(await store.accumulator.acceptedRequestIds([proof.secret])).toEqual([undefined]);
  });

  it("keeps a disposable-store retry a replay after the clock passes the floor", async () => {
    const LOOPBACK_MINT = "http://localhost:3338";
    const store = createDisposableCashuStore();
    const t0 = Date.now();
    const lockedFor = (label: string) =>
      makeProof(label, 5, "keyset-1", p2pkSecret(label, RECOVERY_PUBKEY, [
        ["locktime", `${Math.floor(t0 / 1000) + 7 * 86_400}`],
        ["refund", "02" + "ef".repeat(32)],
      ]));
    const accept = (proof: Proof, requestId: string) => {
      const { wallet } = setupHappyDecode([proof], 5);
      mockVerify.mockReturnValue({ mint: LOOPBACK_MINT, totalMsats: 5000, unit: "sat" });
      wallet.checkProofsStates.mockResolvedValue([{ Y: "y", state: CheckStateEnum.UNSPENT, witness: null }]);
      return acceptAccumulatorPayment({
        cashuToken: "cashuB...",
        requestId,
        mints: [LOOPBACK_MINT],
        disposable: store.accumulator,
        withDisposableLedger: async () => {},
        dvmId: DVM_ID,
        lockPubkeys: [RECOVERY_PUBKEY],
        lockWindowSeconds: DEFAULT_CASHU_LOCK_WINDOW_SECONDS,
        walletProvider: vi.fn(() => Promise.resolve(wallet as never)),
      });
    };
    const banked = lockedFor("banked");
    expect(await accept(banked, "req-banked")).toMatchObject({ kind: "accumulated" });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t0 + 36 * 3_600_000);
      expect(await accept(banked, "req-banked")).toMatchObject({ code: "replay_rejected", acceptedRequestId: "req-banked" });
      expect(await accept(lockedFor("fresh"), "req-fresh")).toMatchObject({ code: "lock_not_exclusive" });
    } finally {
      vi.useRealTimers();
    }
  });
});
