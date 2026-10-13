import type { Pool, PoolClient } from "pg";

export interface HostedIntent {
  admissionId?: string;
  jobId?: string;
  creditId?: string;
  fundId?: string;
  callerPubkey?: string;
  fundingCommitment?: string;
  paymentSeq?: number;
  paymentArtifactHash?: string;
  challengeId?: string;
  invoicePaymentHash?: string;
  invoiceRepairPaymentHash?: string;
  amountMicro?: number;
}

export interface HostedFundingReservation {
  admissionId: string;
  creditId: string;
  fundId: string;
  callerPubkey: string;
  commitment: string;
  paymentArtifactHash: string;
}

type Querier = Pick<PoolClient, "query">;

/** The control row is the common transaction lock for hosted obligation creation and closure. */
export class HostingCleanupFence {
  constructor(
    private readonly pool: Pool,
    readonly dvmId: string,
    readonly scope: string
  ) {}

  async assertNewIntent(tx: Querier, intent?: HostedIntent): Promise<void> {
    // An already persisted admission may finish after closure. Read it without
    // retaining the closure lock across a rail's external settlement call.
    const continuation = intent?.admissionId || intent?.paymentSeq !== undefined ||
      intent?.invoicePaymentHash || intent?.invoiceRepairPaymentHash ||
      (intent?.creditId && intent.fundId && intent.callerPubkey);
    const { rows } = await tx.query<{ state: string; closed_at_ms: string | null;
      closed_at_us: string | null }>(
      `SELECT state, closed_at_ms, closed_at_us FROM sdk_hosting_control
       WHERE dvm_id=$1 AND scope=$2 ${continuation ? "" : "FOR UPDATE"}`,
      [this.dvmId, this.scope]
    );
    const control = rows[0];
    if (!control) throw new Error("Hosted obligation fence is unavailable");
    if (control.state === "closed" && (control.closed_at_ms === null ||
      control.closed_at_us === null)) {
      throw new Error("Hosted closure cutoff is unavailable");
    }
    if (control.state !== "closed" && !continuation) return;
    if (intent?.invoicePaymentHash || intent?.invoiceRepairPaymentHash) {
      const repair = !!intent.invoiceRepairPaymentHash;
      const invoice = await tx.query<{ payment_hash: string }>(
        `SELECT i.payment_hash FROM credit_invoices i
         LEFT JOIN sdk_hosting_admissions a ON a.id=i.hosting_admission_id
         WHERE i.payment_hash=$1 AND i.caller_pubkey=$4 AND i.amount_micro=$5
           AND (($10::boolean AND $3=i.payment_hash AND i.status IN ('blocked','written_off'))
             OR (NOT $10::boolean AND i.credit_id=$2 AND i.fund_id=$3 AND i.status='pending'))
           AND ((i.hosting_admission_id IS NULL AND
                 ($9::bigint IS NULL OR i.created_at_db_us <= $9)) OR
             (a.dvm_id=$6 AND a.scope=$7 AND a.credit_id=i.credit_id
              AND a.fund_id=i.fund_id AND a.caller_pubkey=i.caller_pubkey
              AND a.outcome IN ('pending','accepted','unresolved')
              AND ($8::bigint IS NULL OR a.admitted_at_ms <= $8)))`,
        [intent.invoicePaymentHash ?? intent.invoiceRepairPaymentHash,
          intent.creditId, intent.fundId, intent.callerPubkey,
          intent.amountMicro, this.dvmId, this.scope, control.closed_at_ms,
          control.closed_at_us, repair]
      );
      if (invoice.rows[0]) return;
      throw new Error("Hosted invoice has no original payable admission");
    }
    if (intent?.paymentSeq !== undefined && intent.jobId) {
      const payment = await tx.query<{ job_id: string }>(
        `SELECT m.job_id FROM job_messages m JOIN jobs j ON j.id=m.job_id
         WHERE m.job_id=$1 AND m.seq=$2 AND m.status='pending-verification'
           AND m.created_at_ms IS NOT NULL
           AND ($3::bigint IS NULL OR m.created_at_ms <= $3) AND j.dvm_id=$4
           AND ($6::text IS NULL OR m.data->'content'->'tempo_credential'->'challenge'->>'id'=$6)
           AND EXISTS (SELECT 1 FROM sdk_hosting_admissions a
             WHERE a.dvm_id=$4 AND a.scope=$5 AND a.job_id=m.job_id AND a.outcome <> 'failed')`,
        [intent.jobId, intent.paymentSeq, control.closed_at_ms, this.dvmId, this.scope,
          intent.challengeId ?? null]
      );
      if (payment.rows[0]) return;
      throw new Error("Hosted payment has no pre-closure inbound intent");
    }
    if ((!intent?.admissionId && !intent?.jobId && !(intent?.creditId && intent.fundId && intent.callerPubkey)) ||
      (!intent?.jobId && !(intent?.creditId && intent.fundId))) {
      throw new Error("Hosted obligations are closed to new intents");
    }
    const accepted = await tx.query<{ id: string }>(
      `SELECT id FROM sdk_hosting_admissions
       WHERE ($1::text IS NULL OR id=$1) AND dvm_id=$2 AND scope=$3
         AND ($4::bigint IS NULL OR admitted_at_ms <= $4)
         AND (outcome IN ('pending', 'unresolved') OR ($11::boolean AND outcome='accepted'))
         AND ($5::text IS NULL OR job_id=$5)
         AND ($6::text IS NULL OR credit_id=$6)
         AND ($7::text IS NULL OR fund_id=$7)
         AND ($8::text IS NULL OR caller_pubkey=$8)
         AND ($9::text IS NULL OR funding_commitment=$9)
         AND ($10::text IS NULL OR payment_artifact_hash=$10)`,
      [intent.admissionId ?? null, this.dvmId, this.scope, control.closed_at_ms,
        intent.jobId ?? null, intent.creditId ?? null, intent.fundId ?? null,
        intent.callerPubkey ?? null, intent.fundingCommitment ?? null,
        intent.paymentArtifactHash ?? null, control.state !== 'closed']
    );
    if (!accepted.rows[0]) throw new Error("Hosted obligation has no pre-closure admission");
  }

  async withNewIntent<T>(intent: HostedIntent | undefined, operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.withNewIntentOn(this.pool, intent, operation);
  }

  async assertFundingReservation(tx: Querier, reservation: HostedFundingReservation): Promise<void> {
    await this.assertNewIntent(tx, {
      admissionId: reservation.admissionId,
      creditId: reservation.creditId,
      fundId: reservation.fundId,
      callerPubkey: reservation.callerPubkey,
      fundingCommitment: reservation.commitment,
      paymentArtifactHash: reservation.paymentArtifactHash,
    });
    const verified = await tx.query<{ id: string }>(
      `SELECT id FROM sdk_hosting_admissions
       WHERE id=$1 AND dvm_id=$2 AND scope=$3 AND credit_id=$4 AND fund_id=$5
         AND caller_pubkey=$6 AND funding_commitment=$7 AND payment_artifact_hash=$8
         AND outcome IN ('pending','accepted','unresolved')`,
      [reservation.admissionId, this.dvmId, this.scope, reservation.creditId,
        reservation.fundId, reservation.callerPubkey, reservation.commitment,
        reservation.paymentArtifactHash]
    );
    if (!verified.rows[0]) throw new Error("Hosted funding has no authentic admission");
  }

  async fundingAdmission(tx: Querier, creditId: string, fundId: string,
    callerPubkey: string): Promise<string> {
    await this.assertNewIntent(tx, { creditId, fundId, callerPubkey });
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM sdk_hosting_admissions
       WHERE dvm_id=$1 AND scope=$2 AND credit_id=$3 AND fund_id=$4
         AND caller_pubkey=$5 AND outcome IN ('pending','unresolved')
       ORDER BY admitted_at_ms,id LIMIT 2`,
      [this.dvmId, this.scope, creditId, fundId, callerPubkey]
    );
    if (rows.length !== 1) throw new Error("Hosted invoice funding admission is missing or ambiguous");
    return rows[0].id;
  }

  async withNewIntentOn<T>(
    db: Pool, intent: HostedIntent | undefined, operation: (tx: PoolClient) => Promise<T>
  ): Promise<T> {
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await this.assertNewIntent(tx, intent);
      const result = await operation(tx);
      await tx.query("COMMIT");
      return result;
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  }
}
