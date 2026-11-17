import type { FacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  computeChannelId,
  createBatchSettlementEIP3009DepositPayload,
  signVoucher,
} from "@x402/evm/batch-settlement/client";
import type { Channel } from "@x402/evm/batch-settlement/server";
import pg from "pg";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loggers } from "../../../observability/loggers";
import { createX402BatchSettlementServer } from "../x402-batch-settlement";
import { PostgresX402ChannelStorage } from "../x402-channel-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = `dvm_x402_channel_lock_${process.pid}`;
const NETWORK = "eip155:84532" as const;
const BUSY = "invalid_batch_settlement_evm_channel_busy";
const CUMULATIVE_MISMATCH = "invalid_batch_settlement_evm_cumulative_amount_mismatch";
const LIVE_MS = 60_000;

const earnedNothing = (): Promise<number> => Promise.resolve(0);

type Construction = "db" | "channelStorage" | "config.storage";

describe.skipIf(!RUN)("x402 channel admission lock in Postgres", () => {
  let admin: pg.Pool;
  // Two machines of one fleet: their own pools and stores over one database.
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let machineA: PostgresX402ChannelStorage;
  let machineB: PostgresX402ChannelStorage;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    const options = `-c search_path=${SCHEMA}`;
    poolA = new pg.Pool({ connectionString: DATABASE_URL, options });
    poolB = new pg.Pool({ connectionString: DATABASE_URL, options });
    machineA = new PostgresX402ChannelStorage(poolA);
    machineB = new PostgresX402ChannelStorage(poolB);
    await machineA.init();
    await machineB.init();
    await poolA.query(`CREATE TABLE ledger_effects (effect_id TEXT PRIMARY KEY)`);
  });

  afterAll(async () => {
    await machineA.close();
    await machineB.close();
    await poolA.end();
    await poolB.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  async function expireLock(channelId: string): Promise<void> {
    await poolA.query(
      `UPDATE x402_batch_channel_locks SET expires_at = clock_timestamp() - interval '1 second'
       WHERE channel_id = $1`,
      [channelId.toLowerCase()]
    );
  }

  async function lockRows(channelId: string): Promise<number> {
    const { rows } = await poolA.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM x402_batch_channel_locks WHERE channel_id = $1`,
      [channelId.toLowerCase()]
    );
    return Number(rows[0]?.count);
  }

  async function setLegacyReservation(channelId: string, reservation: unknown): Promise<void> {
    await poolA.query(
      `UPDATE x402_batch_channels SET pending_request = $2::jsonb WHERE channel_id = $1`,
      [channelId.toLowerCase(), JSON.stringify(reservation)]
    );
  }

  async function legacyReservation(channelId: string): Promise<unknown> {
    const { rows } = await poolA.query<{ pending_request: unknown }>(
      `SELECT pending_request FROM x402_batch_channels WHERE channel_id = $1`,
      [channelId.toLowerCase()]
    );
    return rows[0]?.pending_request;
  }

  describe("store", () => {
    it("admits exactly one of many requests racing across machines for one channel", async () => {
      const channelId = generatePrivateKey();

      const won = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? machineA : machineB).acquire(channelId, `request-${i}`, LIVE_MS)
        )
      );

      expect(won.filter(Boolean)).toHaveLength(1);
      const owner = `request-${won.indexOf(true)}`;
      const loser = owner === "request-0" ? "request-1" : "request-0";
      expect(await machineA.isHeld(channelId)).toBe(true);
      expect(await machineB.isHeld(channelId, owner)).toBe(true);
      expect(await machineB.isHeld(channelId, loser)).toBe(false);
      await machineA.release(channelId, loser);
      expect(await machineB.isHeld(channelId, owner)).toBe(true);
      await machineA.release(channelId, owner);
      expect(await machineB.isHeld(channelId)).toBe(false);
      expect(await machineB.acquire(channelId, "next", LIVE_MS)).toBe(true);
    });

    it("hands an expired lock to the next request and keeps its old owner from releasing it", async () => {
      const channelId = generatePrivateKey();
      expect(await machineA.acquire(channelId, "stalled", LIVE_MS)).toBe(true);
      expect(await machineB.acquire(channelId, "waiting", LIVE_MS)).toBe(false);

      await expireLock(channelId);

      // Past its TTL the lock admits no one, but the stalled request still owns
      // it until another request takes it over.
      expect(await machineB.isHeld(channelId)).toBe(false);
      expect(await machineA.isHeld(channelId, "stalled")).toBe(true);
      expect(await machineB.acquire(channelId, "next", LIVE_MS)).toBe(true);
      expect(await machineA.isHeld(channelId, "stalled")).toBe(false);
      await machineA.release(channelId, "stalled");
      expect(await machineB.isHeld(channelId, "next")).toBe(true);
    });

    it("holds a channel for an older SDK's live reservation and keeps it through a newer machine's write", async () => {
      const channelId = generatePrivateKey();
      await machineA.updateChannel(channelId, () => storedChannel(channelId));
      await setLegacyReservation(channelId, { pendingId: "older-sdk", expiresAt: Date.now() + LIVE_MS });

      expect(await machineB.acquire(channelId, "newer-sdk", LIVE_MS)).toBe(false);
      expect(await machineB.isHeld(channelId)).toBe(true);
      expect(await machineB.isHeld(channelId, "older-sdk")).toBe(true);
      expect(await machineB.isHeld(channelId, "newer-sdk")).toBe(false);
      // The older machine settles against its reservation after this write, and
      // reads it from the same column if the fleet rolls back.
      await machineB.updateChannel(channelId, (current) => ({
        ...requireChannel(current),
        lastRequestTimestamp: requireChannel(current).lastRequestTimestamp + 1,
      }));
      expect(await legacyReservation(channelId)).toMatchObject({ pendingId: "older-sdk" });

      await machineB.release(channelId, "older-sdk");
      expect(await legacyReservation(channelId)).toBeNull();
      expect(await machineB.acquire(channelId, "newer-sdk", LIVE_MS)).toBe(true);
    });

    it("admits a request over an older SDK's expired reservation", async () => {
      const channelId = generatePrivateKey();
      await machineA.updateChannel(channelId, () => storedChannel(channelId));
      await setLegacyReservation(channelId, { pendingId: "older-sdk", expiresAt: Date.now() - 1 });

      expect(await machineB.isHeld(channelId)).toBe(false);
      expect(await machineB.acquire(channelId, "newer-sdk", LIVE_MS)).toBe(true);
    });

    it("fails closed on a reservation it cannot read rather than treating it as no lock", async () => {
      const channelId = generatePrivateKey();
      await machineA.updateChannel(channelId, () => storedChannel(channelId));
      await setLegacyReservation(channelId, { pendingId: 7, expiresAt: "later" });

      // Upstream rethrows a TypeError instead of continuing without a lock.
      await expect(machineB.acquire(channelId, "newer-sdk", LIVE_MS)).rejects.toThrow(TypeError);
      await expect(machineB.isHeld(channelId)).rejects.toThrow(TypeError);
    });

    it.each([
      [
        "an older SDK's live reservation",
        (channelId: string) =>
          setLegacyReservation(channelId, { pendingId: "older-sdk", expiresAt: Date.now() + LIVE_MS }),
      ],
      [
        "another machine's live lock",
        async (channelId: string) => {
          await machineA.acquire(channelId, "other-machine", LIVE_MS);
        },
      ],
    ])("refuses a drain's revocation of unclaimed charge while %s admits a request", async (_case, admit) => {
      const channelId = generatePrivateKey();
      await machineA.updateChannel(channelId, () => ({
        ...storedChannel(channelId),
        chargedCumulativeAmount: "100",
        signedMaxClaimable: "100",
      }));
      const revoke = () =>
        machineB.withSanctionedRefundBase("40", () =>
          machineB.updateChannel(channelId, (current) => ({
            ...requireChannel(current),
            chargedCumulativeAmount: "40",
          }))
        );
      await admit(channelId);

      await expect(revoke()).rejects.toThrow("attempted to decrease chargedCumulativeAmount");

      await setLegacyReservation(channelId, null);
      await expireLock(channelId);
      await revoke();
      expect(await machineA.get(channelId)).toMatchObject({ chargedCumulativeAmount: "40" });
    });

    it("fails a channel transaction whose COMMIT Postgres answered with a rollback", async () => {
      const channelId = generatePrivateKey();
      const effectId = `${channelId}:swallowed-failure`;

      const run = machineA.withChannelTransaction(channelId, async (tx) => {
        await tx.query(`INSERT INTO ledger_effects (effect_id) VALUES ($1)`, [effectId]);
        await tx.query(`SELECT 1 / 0`).catch(() => undefined);
        return "committed";
      });

      await expect(run).rejects.toThrow(`x402 channel transaction for ${channelId} rolled back at COMMIT`);
      const { rows } = await poolA.query(`SELECT 1 FROM ledger_effects WHERE effect_id = $1`, [effectId]);
      expect(rows).toHaveLength(0);
    });
  });

  describe("accept", () => {
    function facilitator(): FacilitatorClient {
      return {
        getSupported: vi.fn(async () => ({
          kinds: [{ x402Version: 2, scheme: "batch-settlement", network: NETWORK }],
          extensions: [],
          signers: {},
        })),
        verify: vi.fn(async (payload: PaymentPayload): Promise<VerifyResponse> => {
          const raw = payload.payload as { channelConfig: { payer: string }; voucher: { channelId: string } };
          return {
            isValid: true,
            payer: raw.channelConfig.payer,
            extra: {
              channelId: raw.voucher.channelId,
              balance: "1000",
              totalClaimed: "0",
              withdrawRequestedAt: 0,
              refundNonce: "0",
            },
          };
        }),
        settle: vi.fn(
          async (payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
            const raw = payload.payload as { channelConfig?: { payer: string }; voucher?: { channelId: string } };
            return {
              success: true,
              transaction: "0xdeposit",
              network: requirements.network,
              payer: raw.channelConfig?.payer,
              amount: "1000",
              extra: {
                channelState: {
                  channelId: raw.voucher?.channelId,
                  balance: "1000",
                  totalClaimed: "0",
                  withdrawRequestedAt: 0,
                  refundNonce: "0",
                },
              },
            };
          }
        ),
      };
    }

    /** One DVM machine, built the way `construction` names, with an open channel. */
    async function openChannel(construction: Construction, pool: pg.Pool) {
      const payer = privateKeyToAccount(generatePrivateKey());
      const receiver = privateKeyToAccount(generatePrivateKey());
      const own = new PostgresX402ChannelStorage(pool);
      await own.init();
      const server = await dvm(construction, pool, own, receiver);
      const [built] = await server.buildRequirements("100");
      const requirements = built as PaymentRequirements;
      const channelConfig: Channel["channelConfig"] = {
        payer: payer.address,
        payerAuthorizer: payer.address,
        receiver: receiver.address,
        receiverAuthorizer: receiver.address,
        token: requirements.asset as `0x${string}`,
        withdrawDelay: 86_400,
        salt: generatePrivateKey(),
      };
      const channelId = computeChannelId(channelConfig, NETWORK);
      const deposit = await createBatchSettlementEIP3009DepositPayload(
        payer, 2, requirements, channelConfig, "1000", "100"
      );
      const opened = await server.accept({
        paymentHeader: encodeHeader(deposit, requirements),
        amount: "100",
        operation: "fund",
        effectId: `${channelId}:fund-1`,
        commit: async (funding) => funding.paymentId,
      });
      expect(opened).toMatchObject({ ok: true });
      const voucherHeader = async (maximum: string) =>
        encodeHeader(
          {
            x402Version: 2,
            payload: { type: "voucher", channelConfig, voucher: await signVoucher(payer, channelId, maximum, NETWORK) },
          },
          requirements
        );
      const stop = async () => {
        await server.stop();
        await own.close();
      };
      return { server, channelId, receiver, requirements, voucherHeader, stop };
    }

    async function dvm(
      construction: Construction,
      pool: pg.Pool,
      own: PostgresX402ChannelStorage,
      receiver: ReturnType<typeof privateKeyToAccount>
    ) {
      return createX402BatchSettlementServer({
        network: NETWORK,
        payTo: receiver.address,
        earnedNative: earnedNothing,
        ...(construction === "config.storage" ? {} : { db: pool }),
        ...(construction === "channelStorage" ? { channelStorage: own } : {}),
        config: {
          ...(construction === "config.storage" ? { storage: own } : {}),
          facilitatorClient: facilitator(),
          receiverAuthorizerSigner: receiver,
          autoSettlement: false,
        },
        settlementEvidenceReader: {
          getBlockNumber: async () => 100n,
          findAppliedSettlement: async () => undefined,
        },
      });
    }

    it.each<Construction>(["db", "channelStorage", "config.storage"])(
      "refuses a request while another machine holds the channel, and serves it once that lock expires (%s)",
      async (construction) => {
        const dvmB = await openChannel(construction, poolB);
        try {
          // Another machine of the fleet admitted a request on this channel and
          // then died holding the lock.
          expect(await machineA.acquire(dvmB.channelId, "other-machine", LIVE_MS)).toBe(true);
          const paymentHeader = await dvmB.voucherHeader("200");
          const commit = vi.fn(async () => "charged");

          const busy = await dvmB.server.accept({
            paymentHeader, amount: "100", operation: "fund", effectId: `${dvmB.channelId}:fund-2`, commit,
          });

          expect(busy).toMatchObject({ ok: false, reason: BUSY });
          expect(commit).not.toHaveBeenCalled();
          expect(await machineA.get(dvmB.channelId)).toMatchObject({ chargedCumulativeAmount: "100" });

          await expireLock(dvmB.channelId);
          const served = await dvmB.server.accept({
            paymentHeader, amount: "100", operation: "fund", effectId: `${dvmB.channelId}:fund-3`, commit,
          });

          expect(served).toMatchObject({ ok: true, value: { committed: "charged" } });
          expect(await machineA.get(dvmB.channelId)).toMatchObject({ chargedCumulativeAmount: "200" });
          expect(await lockRows(dvmB.channelId)).toBe(0);
        } finally {
          await dvmB.stop();
        }
      }
    );

    it("charges once when two machines take concurrent requests built on the same charge", async () => {
      const dvmA = await openChannel("db", poolA);
      const own = new PostgresX402ChannelStorage(poolB);
      await own.init();
      const serverB = await dvm("db", poolB, own, dvmA.receiver);
      try {
        // Both requests were signed against the charge of 100 before either landed.
        const paymentHeader = await dvmA.voucherHeader("200");
        const commits = vi.fn(async () => "charged");

        const results = await Promise.all(
          [dvmA.server, serverB, dvmA.server, serverB].map((server, i) =>
            server.accept({
              paymentHeader, amount: "100", operation: "fund", effectId: `${dvmA.channelId}:race-${i}`, commit: commits,
            })
          )
        );

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(results.filter((result) => !result.ok)).toEqual(
          Array.from({ length: 3 }, () => expect.objectContaining({ ok: false, reason: CUMULATIVE_MISMATCH }))
        );
        expect(commits).toHaveBeenCalledOnce();
        expect(await machineA.get(dvmA.channelId)).toMatchObject({ chargedCumulativeAmount: "200" });
        expect(await lockRows(dvmA.channelId)).toBe(0);
      } finally {
        await serverB.stop();
        await own.close();
        await dvmA.stop();
      }
    });

    it.each([
      ["taking", "INSERT OR UPDATE"],
      ["releasing", "DELETE"],
    ])("commits a charge and its ledger effect when %s the lock fails inside the request", async (_case, events) => {
      const dvmB = await openChannel("db", poolB);
      const warn = vi.spyOn(loggers.x402, "warn");
      await poolA.query(`
        CREATE FUNCTION fail_channel_lock() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'channel lock store unavailable'; END $$`);
      await poolA.query(`
        CREATE TRIGGER fail_channel_lock BEFORE ${events} ON x402_batch_channel_locks
        FOR EACH ROW EXECUTE FUNCTION fail_channel_lock()`);
      try {
        const effectId = `${dvmB.channelId}:fund-2`;

        const served = await dvmB.server.accept({
          paymentHeader: await dvmB.voucherHeader("200"),
          amount: "100",
          operation: "fund",
          effectId,
          commit: async (_funding, tx) => {
            await tx?.query(`INSERT INTO ledger_effects (effect_id) VALUES ($1)`, [effectId]);
            return "charged";
          },
        });

        expect(served).toMatchObject({ ok: true, value: { committed: "charged" } });
        expect(await machineA.get(dvmB.channelId)).toMatchObject({ chargedCumulativeAmount: "200" });
        const { rows } = await poolA.query(`SELECT 1 FROM ledger_effects WHERE effect_id = $1`, [effectId]);
        expect(rows).toHaveLength(1);
        if (events === "DELETE") {
          expect(warn).toHaveBeenCalledWith("x402_channel_lock_release_failed", expect.anything());
        }
      } finally {
        await poolA.query(`DROP TRIGGER fail_channel_lock ON x402_batch_channel_locks`);
        await poolA.query(`DROP FUNCTION fail_channel_lock()`);
        await dvmB.stop();
      }
    });
  });
});

function storedChannel(channelId: string): Channel {
  return {
    channelId,
    channelConfig: {
      payer: "0x1111111111111111111111111111111111111111",
      payerAuthorizer: "0x1111111111111111111111111111111111111111",
      receiver: "0x2222222222222222222222222222222222222222",
      receiverAuthorizer: "0x2222222222222222222222222222222222222222",
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      withdrawDelay: 86_400,
      salt: `0x${"44".repeat(32)}`,
    },
    chargedCumulativeAmount: "0",
    signedMaxClaimable: "0",
    signature: `0x${"55".repeat(65)}`,
    balance: "1000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    onchainSyncedAt: Date.now(),
    lastRequestTimestamp: Date.now(),
  };
}

function requireChannel(channel: Channel | undefined): Channel {
  if (!channel) throw new Error("expected a stored channel");
  return channel;
}

function encodeHeader(
  payload: Pick<PaymentPayload, "x402Version" | "payload">,
  accepted: PaymentRequirements
): string {
  return Buffer.from(
    JSON.stringify({ ...payload, accepted, resource: { url: "/v1/credit" } })
  ).toString("base64");
}
