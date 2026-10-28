/*
 * Token decoding and DLEQ checks are mocked; lock judgement parses the real secrets; accumulator inserts and credit accounting use real Postgres
 * on one transaction. A throw between those writes must roll back both.
 */
import * as cashuTs from "@cashu/cashu-ts";
import { Amount, CheckStateEnum, type Proof } from "@cashu/cashu-ts";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";
import * as cashuVerify from "../../../lib/cashu/verify";
import { fundCredit } from "./__helpers__/credit-fixtures";

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

const { acceptAccumulatorPayment } = await import("../wallet-accumulator-receive");
const { initWalletAccumulatorTable } = await import("../wallet-accumulator-store");
const { CreditLedger } = await import("../credit-ledger");

const mockVerify = vi.mocked(cashuVerify.verifyCashuToken);
const mockVerifyDleq = vi.mocked(cashuTs.verifyDleqIfPresent);

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const LOCK_PUBKEY = toLockPubkey("02" + "ab".repeat(32));
const MINT = "https://mint.example.com";
const DVM_ID = "dvm-funding-atomicity";
const CALLER = "ef".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

let secretCounter = 0;
function makeProof(amount = 10, tags: string[][] = []): Proof {
  const nonce = `dvm-funding-secret-${++secretCounter}-${Date.now()}`;
  return {
    id: "keyset-1",
    amount: amount as unknown as Proof["amount"],
    secret: JSON.stringify(["P2PK", { nonce, data: LOCK_PUBKEY, tags }]),
    C: "C-deadbeef",
    dleq: { e: "01", s: "02", r: "03" },
  };
}

function walletFor(proofs: Proof[]) {
  return {
    decodeToken: vi.fn(() => ({ proofs, mint: MINT, unit: "sat" })),
    getKeyset: vi.fn(() => ({ id: "keyset-1" })),
    getFeesForProofs: vi.fn(() => Amount.zero()),
    checkProofsStates: vi.fn(() =>
      Promise.resolve(proofs.map(() => ({ state: CheckStateEnum.UNSPENT })))
    ),
  };
}

describe.skipIf(!RUN)("cashu rail commit + ledger fund/draw atomicity", () => {
  let pool: pg.Pool;
  let ledger: InstanceType<typeof CreditLedger>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await initWalletAccumulatorTable(pool);
    ledger = new CreditLedger(pool);
    await ledger.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyDleq.mockReturnValue(true);
  });

  afterEach(async () => {
    await pool.query("DELETE FROM wallet_accumulator WHERE dvm_id = $1", [DVM_ID]);
    await pool.query("DELETE FROM credit_draws WHERE credit_id LIKE 'imp:cashu:atom-%'");
    await pool.query("DELETE FROM credits WHERE credit_id LIKE 'imp:cashu:atom-%'");
  });

  afterAll(async () => {
    await pool.end();
  });

  function accept(opts: {
    proofs: Proof[];
    requestId: string;
    withCommitTx?: Parameters<typeof acceptAccumulatorPayment>[0]["withCommitTx"];
  }) {
    const totalSats = opts.proofs.reduce((s, p) => s + (p.amount as unknown as number), 0);
    mockVerify.mockReturnValue({ mint: MINT, totalMsats: totalSats * 1000, unit: "sat" });
    return acceptAccumulatorPayment({
      cashuToken: "cashuAtomicity",
      requestId: opts.requestId,
      mints: [MINT],
      db: pool,
      dvmId: DVM_ID,
      lockPubkeys: [LOCK_PUBKEY],
      walletProvider: (() => Promise.resolve(walletFor(opts.proofs))) as never,
      withCommitTx: opts.withCommitTx,
    });
  }

  it("commits proofs + fund + draw in one transaction", async () => {
    const requestId = "atom-ok";
    const creditId = `imp:cashu:${requestId}`;
    const result = await accept({
      proofs: [makeProof(10)],
      requestId,
      withCommitTx: async (tx, accepted) => {
        await fundCredit(ledger, {
          creditId,
          callerPubkey: CALLER,
          currency: "usd",
          amountMicro: accepted.paidMsats, // stand-in denomination for the test
          expiryMs: FUTURE_MS,
          tx,
        });
        await ledger.draw({
          creditId,
          drawId: requestId,
          amountMicro: accepted.paidMsats,
          jobId: "job-atom-ok",
          tx,
        });
      },
    });
    expect(result.kind).toBe("accumulated");

    const rows = await pool.query("SELECT * FROM wallet_accumulator WHERE dvm_id = $1", [DVM_ID]);
    expect(rows.rowCount).toBe(1);
    const draw = await ledger.getDraw({ creditId, drawId: requestId });
    expect(draw?.status).toBe("pending");
    expect(draw?.jobId).toBe("job-atom-ok");
    const snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(10_000);
    expect(snap?.availableMicro).toBe(0);
  });

  it("crash between rail commit and ledger fund rolls back EVERYTHING — no money-without-credit state", async () => {
    const requestId = "atom-crash";
    const proofs = [makeProof(10)];
    await expect(
      accept({
        proofs,
        requestId,
        withCommitTx: async () => {
          throw new Error("injected crash before the ledger fund");
        },
      })
    ).rejects.toThrow("injected crash");

    const rows = await pool.query("SELECT * FROM wallet_accumulator WHERE dvm_id = $1", [DVM_ID]);
    expect(rows.rowCount).toBe(0);
    expect(await ledger.get(`imp:cashu:${requestId}`)).toBeUndefined();

    const retry = await accept({
      proofs,
      requestId,
      withCommitTx: async (tx, accepted) => {
        await fundCredit(ledger, {
          creditId: `imp:cashu:${requestId}`,
          callerPubkey: CALLER,
          currency: "usd",
          amountMicro: accepted.paidMsats,
          expiryMs: FUTURE_MS,
          tx,
        });
        await ledger.draw({
          creditId: `imp:cashu:${requestId}`,
          drawId: requestId,
          amountMicro: accepted.paidMsats,
          tx,
        });
      },
    });
    expect(retry.kind).toBe("accumulated");
    expect((await ledger.get(`imp:cashu:${requestId}`))?.balanceMicro).toBe(10_000);
  });

  it("a rail-level replay rejects before the ledger leg runs — no double fund", async () => {
    const requestId = "atom-replay";
    const creditId = `imp:cashu:${requestId}`;
    const proofs = [makeProof(10)];
    const commit: NonNullable<
      Parameters<typeof acceptAccumulatorPayment>[0]["withCommitTx"]
    > = async (tx, accepted) => {
      await fundCredit(ledger, {
        creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: accepted.paidMsats,
        expiryMs: FUTURE_MS,
        tx,
      });
      await ledger.draw({ creditId, drawId: requestId, amountMicro: accepted.paidMsats, tx });
    };

    const first = await accept({ proofs, requestId, withCommitTx: commit });
    expect(first.kind).toBe("accumulated");

    const replay = await accept({ proofs, requestId, withCommitTx: commit });
    expect(replay.kind).toBe("rejected");
    expect(replay.kind === "rejected" && replay.code).toBe("replay_rejected");
    expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000);
    expect((await ledger.get(creditId))?.lastLedgerSeq).toBe(1);
  });
  it("a non-exclusive lock writes no accumulator row and no credit", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const payer = "02" + CALLER;
    const shapes: [string, string[][]][] = [
      ["past", [["locktime", `${nowSec - 60}`], ["refund", payer]]],
      ["soon", [["locktime", `${nowSec + 60}`], ["refund", payer]]],
      ["bare", [["locktime", `${nowSec + 60}`]]],
      ["oneofn", [["pubkeys", payer]]],
      ["multisig", [["pubkeys", payer], ["n_sigs", "2"]]],
    ];
    for (const [label, tags] of shapes) {
      const requestId = `atom-lock-${label}`;
      const withCommitTx = vi.fn();
      const result = await accept({ proofs: [makeProof(10, tags)], requestId, withCommitTx });
      expect(result, label).toMatchObject({ kind: "rejected", code: "lock_not_exclusive" });
      expect(withCommitTx, label).not.toHaveBeenCalled();
      expect(await ledger.get(`imp:cashu:${requestId}`), label).toBeUndefined();
    }
    const rows = await pool.query("SELECT 1 FROM wallet_accumulator WHERE dvm_id = $1", [DVM_ID]);
    expect(rows.rowCount).toBe(0);
  });

  it("a retry after the lock floor has passed still resolves as the original payment's replay", async () => {
    const requestId = "atom-aged-replay";
    const creditId = `imp:cashu:${requestId}`;
    const t0 = Date.now();
    const proofs = [makeProof(10, [["locktime", `${Math.floor(t0 / 1000) + 7 * 86_400}`], ["refund", "02" + CALLER]])];
    const commit: NonNullable<Parameters<typeof acceptAccumulatorPayment>[0]["withCommitTx"]> = async (tx, accepted) => {
      await fundCredit(ledger, {
        creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: accepted.paidMsats,
        expiryMs: FUTURE_MS + 7 * 24 * 60 * 60 * 1000,
        tx,
      });
      await ledger.draw({ creditId, drawId: requestId, amountMicro: accepted.paidMsats, tx });
    };
    expect((await accept({ proofs, requestId, withCommitTx: commit })).kind).toBe("accumulated");

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t0 + 36 * 60 * 60 * 1000);
      const retry = await accept({ proofs, requestId, withCommitTx: commit });
      expect(retry.kind === "rejected" && retry.code).toBe("replay_rejected");
      // The same shape from a payment never banked is refused at this clock.
      const fresh = await accept({ proofs: [makeProof(10, [["locktime", `${Math.floor(t0 / 1000) + 7 * 86_400}`]])], requestId: "atom-aged-fresh" });
      expect(fresh.kind === "rejected" && fresh.code).toBe("lock_not_exclusive");
    } finally {
      vi.useRealTimers();
    }
    expect((await ledger.get(creditId))?.lastLedgerSeq).toBe(1);
    const rows = await pool.query("SELECT 1 FROM wallet_accumulator WHERE dvm_id = $1", [DVM_ID]);
    expect(rows.rowCount).toBe(1);
  });
});
