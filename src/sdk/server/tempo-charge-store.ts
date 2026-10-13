import { diagnosticConsole } from "../../observability/diagnostic-console";
import { Credential, type Store } from "mppx";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";

import { withSdkInitLock } from "./init-lock";
import type { HostedIntent, HostingCleanupFence } from "./hosting-cleanup-fence";
import { parseStoreValue, stringifyStoreValue } from "./store-json";

const DEFAULT_TABLE_NAME = "mpp_tempo_charge_replays";
const DEFAULT_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_GC_SAMPLE_RATE = 0.01;
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function replayKeyFor(credential: Credential.Credential): string {
  const payload = credential.payload as {
    type?: string; hash?: string; signature?: string;
  };
  if (payload.type === "proof") return `mppx:charge:proof:${credential.challenge.id}`;
  if (payload.type === "hash" && /^0x[0-9a-fA-F]{64}$/.test(payload.hash ?? "")) {
    return `mppx:charge:${payload.hash!.toLowerCase()}`;
  }
  if (payload.type === "transaction" && /^0x[0-9a-fA-F]+$/.test(payload.signature ?? "")) {
    return `mppx:charge:${keccak256(payload.signature as Hex).toLowerCase()}`;
  }
  throw new Error("Hosted Tempo charge credential has no supported replay key");
}

function canonicalCredential(credential: Credential.Credential): string {
  const serialized = Credential.serialize(credential);
  const encoded = serialized.slice(serialized.indexOf(" ") + 1);
  const wire = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, field]) => [key, sorted(field)]));
    }
    return value;
  };
  return JSON.stringify(sorted(wire));
}

export interface PostgresTempoChargeStoreOpts {
  /** Table name. Defaults to `"mpp_tempo_charge_replays"`. Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. */
  tableName?: string;
  /**
   * How long a row survives its last write, in milliseconds. Defaults to one
   * hour — see the class doc for why that is both generous and safe.
   */
  retentionMs?: number;
  /**
   * Probability (per write) of firing a fire-and-forget GC sweep that deletes
   * expired rows. Defaults to 0.01 — every ~100 writes runs one DELETE. Set to
   * 0 to disable GC entirely (rely on an external sweeper).
   */
  gcSampleRate?: number;
  /** Clock source (ms). Defaults to `Date.now`. Test seam for deterministic TTL. */
  now?: () => number;
}

/**
 * Postgres implementation of the atomic store mppx's `tempo.charge` uses for
 * replay protection.
 *
 * mppx refuses a charge credential whose transaction hash it has already taken
 * (`markHashUsed`), and refuses a zero-dollar proof credential whose challenge
 * id it has already taken — but only against the store it is handed. Omitting
 * one leaves it on `Store.memory()`: per-process, lost on restart, invisible to
 * sibling machines. A replayed credential then reaches a broadcast the chain
 * rejects instead of the cheap `Transaction hash has already been used`.
 *
 * {@link PostgresTempoSessionStore} cannot serve this keyspace — its `update`
 * asserts a monotonic *channel-state object*, and a replay marker is the number
 * `Date.now()`. Values here are deliberately opaque JSON: mppx writes a number
 * for a replay marker and a `SponsorBudget.State` object for the fee-sponsor
 * budget, which shares this store unprefixed so aggregate in-flight fee
 * exposure is sponsor-wide rather than per-process.
 *
 * **Retention is ours — mppx has no TTL at any layer of `Store`.** Every row
 * carries an `expires_at` refreshed on each write, swept by a sampled in-line
 * DELETE. The window is uniform rather than per-keyspace because it is safe for
 * both kinds of row: a replay marker guards a credential whose transaction is
 * settleable for about twenty-five seconds and whose challenge expires in
 * minutes, and a sponsor-budget reservation is bounded by that same expiring
 * nonce (plus a thirty-second lease while it is `prepared`), so an hour-idle
 * budget row holds only reservations `SponsorBudget.reconcile` would release on
 * sight. Sweeping such a row is equivalent to reconciling it, and the next
 * reservation recreates it. The hosted fence pins mppx's charge key forms;
 * a version that changes those forms must update the reservation derivation.
 *
 * `expires_at` is a GC marker only: reads do not filter on it, so protection
 * lapses when a row is swept and never before.
 */
export class PostgresTempoChargeStore implements Store.AtomicStore {
  private hostingCleanupFence?: HostingCleanupFence;

  useHostingCleanupFence(fence: HostingCleanupFence): void {
    this.hostingCleanupFence = fence;
  }

  async reserveHostedCharge(serializedCredential: string, intent: HostedIntent): Promise<void> {
    if (!this.hostingCleanupFence) return;
    const credential = Credential.deserialize(serializedCredential);
    if (credential.challenge.intent !== "charge" || credential.challenge.method !== "tempo") {
      throw new Error("Hosted Tempo charge credential is not a Tempo charge");
    }
    const challengeId = credential.challenge.id;
    const replayKey = replayKeyFor(credential);
    const artifactHash = createHash("sha256").update(serializedCredential).digest("hex");
    await this.hostingCleanupFence.withNewIntent({ ...intent, challengeId,
      paymentArtifactHash: artifactHash }, async (tx) => {
      if (intent.paymentSeq !== undefined && intent.jobId) {
        const original = await tx.query<{ credential: unknown }>(
          `SELECT data->'content'->'tempo_credential' AS credential FROM job_messages
           WHERE job_id=$1 AND seq=$2 AND status='pending-verification'`,
          [intent.jobId, intent.paymentSeq]
        );
        const recorded = original.rows[0]?.credential;
        if (!recorded || canonicalCredential(recorded as Credential.Credential) !==
          canonicalCredential(credential)) {
          throw new Error("Hosted Tempo charge differs from the original inbound payment");
        }
      }
      const prior = await tx.query<{ admission_id: string | null; job_id: string | null;
        payment_seq: number | null; replay_key: string | null;
        payment_artifact_hash: string | null }>(
        `SELECT admission_id,job_id,payment_seq,replay_key,payment_artifact_hash FROM sdk_hosted_tempo_charge_intents
         WHERE challenge_id=$1 FOR UPDATE`, [challengeId]
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.admission_id !== (intent.admissionId ?? null) ||
          row.job_id !== (intent.jobId ?? null) ||
          row.payment_seq !== (intent.paymentSeq ?? null) ||
          row.replay_key !== replayKey ||
          row.payment_artifact_hash !== artifactHash) {
          throw new Error("Hosted Tempo charge identity conflicts with the original payment");
        }
        return;
      }
      await tx.query(
        `INSERT INTO sdk_hosted_tempo_charge_intents
         (challenge_id,admission_id,job_id,payment_seq,replay_key,payment_artifact_hash,status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [challengeId,intent.admissionId ?? null,intent.jobId ?? null,intent.paymentSeq ?? null,
          replayKey,artifactHash]
      );
    });
  }

  async completeHostedCharge(challengeId: string): Promise<void> {
    if (!this.hostingCleanupFence) return;
    await this.pool.query(
      `UPDATE sdk_hosted_tempo_charge_intents SET status='complete'
       WHERE challenge_id=$1 AND status='pending' AND (
         EXISTS (SELECT 1 FROM processed_payments p
           WHERE p.payment_id=$1 AND p.rail='tempo' AND p.dvm_id=$2
             AND p.job_id IS NOT DISTINCT FROM sdk_hosted_tempo_charge_intents.job_id)
       )`, [challengeId, this.hostingCleanupFence.dvmId]
    );
  }
  private readonly pool: Pool;
  private readonly tableName: string;
  private readonly retentionMs: number;
  private readonly gcSampleRate: number;
  private readonly now: () => number;

  constructor(pool: Pool, opts?: PostgresTempoChargeStoreOpts) {
    const tableName = opts?.tableName ?? DEFAULT_TABLE_NAME;
    if (!VALID_IDENTIFIER.test(tableName)) {
      throw new Error(
        `PostgresTempoChargeStore: tableName must match ${VALID_IDENTIFIER.source}, got "${tableName}"`
      );
    }
    this.pool = pool;
    this.tableName = tableName;
    this.retentionMs = opts?.retentionMs ?? DEFAULT_RETENTION_MS;
    this.gcSampleRate = opts?.gcSampleRate ?? DEFAULT_GC_SAMPLE_RATE;
    this.now = opts?.now ?? (() => Date.now());
    // mppx passes store actions around as standalone functions, so the
    // AtomicStore boundary must not depend on method-call receiver binding —
    // the same reason `PostgresTempoSessionStore` binds its own `update`.
    this.get = this.get.bind(this);
    this.put = this.put.bind(this);
    this.delete = this.delete.bind(this);
    this.update = this.update.bind(this);
  }

  /** Run the CREATE TABLE migration. Idempotent — safe to call repeatedly. */
  async init(): Promise<void> {
    await withSdkInitLock(this.pool, () => this.createTables());
  }

  /** Read one stored value, or `null` when absent — mppx's miss sentinel. */
  async get(key: string): Promise<unknown> {
    const { rows } = await this.pool.query<{ value_json: string }>(
      `SELECT value_json FROM ${this.tableName} WHERE store_key = $1`,
      [key]
    );
    return rows[0] ? parseStoreValue(rows[0].value_json) : null;
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.update(key, () => ({ op: "set", value, result: undefined }));
  }

  /** Delete one stored value — mppx's compensating release on a failed broadcast. */
  async delete(key: string): Promise<void> {
    await this.update(key, () => ({ op: "delete", result: undefined }));
  }

  /**
   * Advisory locking covers the absent-row first write before the row lock.
   * Both competing presentations of one credential and the shared sponsor
   * budget need this serialization. The transaction contains no chain call.
   */
  async update<result>(
    key: string,
    fn: (current: unknown) => Store.Change<unknown, result>
  ): Promise<result> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 2036))`, [key]);
      const { rows } = await client.query<{ value_json: string }>(
        `SELECT value_json FROM ${this.tableName} WHERE store_key = $1 FOR UPDATE`,
        [key]
      );
      const current = rows[0] ? parseStoreValue(rows[0].value_json) : null;
      const change = fn(current);
      const now = this.now();
      if (change.op === "set") {
        if (this.hostingCleanupFence) {
          const pending = await client.query<{ reserved: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM sdk_hosted_tempo_charge_intents i
               LEFT JOIN sdk_hosting_admissions a ON a.id=i.admission_id
               LEFT JOIN jobs j ON j.id=i.job_id
               WHERE i.status='pending' AND i.replay_key=$3 AND
                 ((a.dvm_id=$1 AND a.scope=$2) OR j.dvm_id=$1)
             ) AS reserved`,
            [this.hostingCleanupFence.dvmId, this.hostingCleanupFence.scope, key]
          );
          if (!pending.rows[0]?.reserved) {
            await this.hostingCleanupFence.assertNewIntent(client);
          }
        }
        await client.query(
          `INSERT INTO ${this.tableName} (store_key, value_json, expires_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (store_key) DO UPDATE
             SET value_json = EXCLUDED.value_json, expires_at = EXCLUDED.expires_at`,
          [
            key,
            stringifyStoreValue(change.value, "Tempo charge store value"),
            now + this.retentionMs,
          ]
        );
      } else if (change.op === "delete") {
        await client.query(`DELETE FROM ${this.tableName} WHERE store_key = $1`, [key]);
      }
      await client.query("COMMIT");
      if (change.op !== "noop") this.maybeSweep(now);
      return change.result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async createTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        store_key  TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${this.tableName}_expires_at_idx
        ON ${this.tableName} (expires_at);
      CREATE TABLE IF NOT EXISTS sdk_hosted_tempo_charge_intents (
        challenge_id TEXT PRIMARY KEY,
        admission_id TEXT,
        job_id TEXT,
        payment_seq INTEGER,
        replay_key TEXT,
        payment_artifact_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','complete')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      ALTER TABLE sdk_hosted_tempo_charge_intents
        ADD COLUMN IF NOT EXISTS replay_key TEXT,
        ADD COLUMN IF NOT EXISTS payment_artifact_hash TEXT;
    `);
  }

  private maybeSweep(now: number): void {
    if (this.gcSampleRate <= 0 || Math.random() >= this.gcSampleRate) return;
    this.pool
      .query(`DELETE FROM ${this.tableName} WHERE expires_at < $1`, [now])
      .catch((err: unknown) => {
        diagnosticConsole.error("PostgresTempoChargeStore GC sweep failed:", err);
      });
  }
}
