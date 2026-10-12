import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreditDepositPayload,
  CreditDrawReleasePayload,
  JobCostReportPayload,
  RevenueReportPayload,
  RevenueSkippedNoRailPayload,
  TempoSettlementBalancePayload,
  TempoSettlementFailurePayload,
  X402SelfRelayGasBalancePayload,
  X402SelfRelayRpcHealthPayload,
} from "../server/revenue-reporter";
import { RevenueReporter } from "../server/revenue-reporter";

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const REPORT_DELIVERY_DEADLINE_MS = 1_000;
const DELAYED_CLIENT_ERROR_DELIVERY_MS = 75;

const pg = await import("pg");
type Pool = InstanceType<typeof pg.default.Pool>;

let pool: Pool;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  pool = new pg.default.Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool?.end();
});

const PAYLOAD: RevenueReportPayload = {
  dvmId: "dvm-test-1",
  jobId: "job-test-1",
  capability: "transcribe",
  paidMsats: 100_000,
  paymentMint: "https://mint.example",
  rail: "cashu",
  paymentTxHash: "req-uuid-1",
  cashuFlow: "p2pk_accumulator",
  cost: { amountMicro: 21_500, currency: "usd" },
};

const COST_PAYLOAD: JobCostReportPayload = {
  dvmId: "dvm-test-1",
  jobId: "job-cost-test-1",
  capability: "transcribe",
  outcome: "failed",
  costRevision: 3,
  cost: { amountMicro: 21_500, currency: "usd" },
};

describe.skipIf(!RUN)("RevenueReporter", () => {
  let reporter: RevenueReporter;

  beforeEach(async () => {
    reporter = new RevenueReporter(pool, "http://platform.test:8080", "test-token");
    await reporter.init();
    await pool.query("DELETE FROM pending_dvm_reports");
  });

  afterEach(() => {
    reporter.stop();
  });

  it("marks row stale on 401 (token rotated)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    try {
      await reporter.report(PAYLOAD);
      await new Promise((r) => setTimeout(r, 50));
      const { rows } = await pool.query("SELECT * FROM pending_dvm_reports");
      expect(rows.length).toBe(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row.stale).toBe(true);
      expect(row.stale_reason).toBe("token_rotated");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks row stale on 400 on first delivery attempt (permanent client error)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            // This exceeds the former 50ms test sleep. The assertion below
            // waits for the durable stale state, not elapsed wall time.
            setTimeout(
              () =>
                resolve(
                  new Response('{"error":"jobId, rail, paidMsats required"}', { status: 400 })
                ),
              DELAYED_CLIENT_ERROR_DELIVERY_MS
            );
          })
      );
    try {
      await reporter.report(PAYLOAD);
      const row = await vi.waitFor(async () => {
        const { rows } = await pool.query("SELECT * FROM pending_dvm_reports");
        expect(rows).toHaveLength(1);
        const pending = rows[0] as Record<string, unknown>;
        expect(pending.stale).toBe(true);
        return pending;
      }, { timeout: REPORT_DELIVERY_DEADLINE_MS });
      expect(row.stale_reason).toBe("client_error:400");
      expect(row.retry_count).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks row stale on 403 (dvmId mismatch)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"error":"dvmId mismatch"}', { status: 403 }));
    try {
      await reporter.report(PAYLOAD);
      await new Promise((r) => setTimeout(r, 50));
      const { rows } = await pool.query("SELECT * FROM pending_dvm_reports");
      expect(rows.length).toBe(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row.stale).toBe(true);
      expect(row.stale_reason).toBe("client_error:403");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not mark stale on 503 — retries with backoff", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"revenue callback not configured"}', { status: 503 })
      );
    try {
      await reporter.report(PAYLOAD);
      await new Promise((r) => setTimeout(r, 50));
      await reporter.drainPending();
      const { rows } = await pool.query("SELECT * FROM pending_dvm_reports");
      expect(rows.length).toBe(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row.stale).toBe(false);
      expect(row.stale_reason).toBeNull();
      expect(Number(row.retry_count)).toBeGreaterThanOrEqual(1);
      expect(Number(row.next_retry_at)).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("abandons a row after 24h of failed retries", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"error":"down"}', { status: 503 }));
    try {
      // Seed a row whose created_at is 25h old, due for retry now.
      const id = "abandon-test-1";
      const oldCreatedAt = Date.now() - 25 * 60 * 60 * 1000;
      await pool.query(
        `INSERT INTO pending_dvm_reports (id, payload, retry_count, next_retry_at, created_at)
         VALUES ($1, $2, 5, 0, $3)`,
        [id, JSON.stringify(PAYLOAD), oldCreatedAt]
      );
      await reporter.drainPending();
      const { rows } = await pool.query("SELECT * FROM pending_dvm_reports WHERE id = $1", [
        id,
      ]);
      expect(rows.length).toBe(1);
      const row = rows[0] as Record<string, unknown>;
      expect(row.stale).toBe(true);
      expect(row.stale_reason).toBe("abandoned");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getQueueStats separates live retry from stale-by-reason", async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO pending_dvm_reports (id, payload, stale, stale_reason, created_at) VALUES
        ('live-1',  $1, false, NULL,            $2),
        ('aband-1', $1, true,  'abandoned',     $2),
        ('cerr-1',  $1, true,  'client_error:400', $2),
        ('cerr-2',  $1, true,  'client_error:400', $2)`,
      [JSON.stringify(PAYLOAD), now]
    );
    const stats = await reporter.getQueueStats();
    expect(stats.liveRetry).toBe(1);
    expect(stats.stale).toBe(3);
    expect(stats.byReason).toEqual({ abandoned: 1, "client_error:400": 2 });
  });

  it("preserves the job's capability and cost through durable retry", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));
    globalThis.fetch = mockFetch;
    try {
      await reporter.report(PAYLOAD);
      await new Promise((r) => setTimeout(r, 50));

      const queued = await pool.query(
        "SELECT payload, stale FROM pending_dvm_reports WHERE payload->>'jobId' = $1",
        [PAYLOAD.jobId]
      );
      expect(queued.rows).toHaveLength(1);
      expect(queued.rows[0]?.stale).toBe(false);
      expect(queued.rows[0]?.payload).toEqual(PAYLOAD);

      await pool.query(
        "UPDATE pending_dvm_reports SET next_retry_at = 0 WHERE payload->>'jobId' = $1",
        [PAYLOAD.jobId]
      );
      await reporter.drainPending();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [url, init] of mockFetch.mock.calls as [string, RequestInit][]) {
        expect(url).toBe("http://platform.test:8080/_internal/job-revenue");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
        expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
      }
      expect(
        await pool.query("SELECT 1 FROM pending_dvm_reports WHERE payload->>'jobId' = $1", [
          PAYLOAD.jobId,
        ])
      ).toMatchObject({ rowCount: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("delivers a rail-less job cost through its own durable outbox kind", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"down"}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));
    globalThis.fetch = mockFetch;
    try {
      await reporter.reportCost(COST_PAYLOAD);
      await new Promise((r) => setTimeout(r, 50));

      const queued = await pool.query(
        "SELECT payload, kind FROM pending_dvm_reports WHERE payload->>'jobId' = $1",
        [COST_PAYLOAD.jobId]
      );
      expect(queued.rows).toEqual([{ payload: COST_PAYLOAD, kind: "cost" }]);
      expect(queued.rows[0]?.payload).not.toHaveProperty("rail");
      expect(queued.rows[0]?.payload).not.toHaveProperty("paidMsats");

      await pool.query(
        "UPDATE pending_dvm_reports SET next_retry_at = 0 WHERE payload->>'jobId' = $1",
        [COST_PAYLOAD.jobId]
      );
      await reporter.drainPending();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [url, init] of mockFetch.mock.calls as [string, RequestInit][]) {
        expect(url).toBe("http://platform.test:8080/_internal/job-cost");
        expect(JSON.parse(init.body as string)).toEqual(COST_PAYLOAD);
      }
      expect(
        await pool.query("SELECT 1 FROM pending_dvm_reports WHERE payload->>'jobId' = $1", [
          COST_PAYLOAD.jobId,
        ])
      ).toMatchObject({ rowCount: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends no cost key for a job whose handler declared none", async () => {
    // `not.toHaveProperty` on the stored JSONB, not `=== undefined`: the whole
    // point of the field is that unreported and zero are different facts.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    try {
      const { cost: _cost, ...noCost } = PAYLOAD;
      await reporter.report({ ...noCost, jobId: "job-test-nocost" });
      await new Promise((r) => setTimeout(r, 50));
      const { rows } = await pool.query(
        "SELECT payload FROM pending_dvm_reports WHERE payload->>'jobId' = $1",
        ["job-test-nocost"]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).not.toHaveProperty("cost");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves a missing capability instead of inventing an attribution", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));
    try {
      const { capability: _capability, ...legacyPayload } = PAYLOAD;
      await reporter.report({ ...legacyPayload, jobId: "job-test-legacy-capability" });
      await new Promise((r) => setTimeout(r, 50));
      const { rows } = await pool.query(
        "SELECT payload FROM pending_dvm_reports WHERE payload->>'jobId' = $1",
        ["job-test-legacy-capability"]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload).not.toHaveProperty("capability");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves a deposit's caller through durable retry", async () => {
    const payload: CreditDepositPayload = {
      dvmId: "dvm-test-1",
      creditId: "credit-deposit-1",
      callerPubkey: "ab".repeat(32),
      fundingId: "funding-deposit-1",
      rail: "cashu",
      paidMsats: 100_000,
      amountMicro: 100_000,
      creditCurrency: "usd",
      fundedAt: Date.now(),
      expiryMs: Date.now() + 60_000,
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await reporter.enqueueDeposit(client, payload);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const originalFetch = globalThis.fetch;
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"down"}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));
    globalThis.fetch = mockFetch;
    try {
      await reporter.drainPending();
      const queued = await pool.query(
        "SELECT payload FROM pending_dvm_reports WHERE payload->>'fundingId' = $1",
        [payload.fundingId]
      );
      expect(queued.rows).toHaveLength(1);
      expect(queued.rows[0]?.payload).toEqual(payload);

      await pool.query(
        "UPDATE pending_dvm_reports SET next_retry_at = 0 WHERE payload->>'fundingId' = $1",
        [payload.fundingId]
      );
      await reporter.drainPending();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [, init] of mockFetch.mock.calls as [string, RequestInit][]) {
        expect(JSON.parse(init.body as string)).toEqual(payload);
      }
      expect(
        await pool.query(
          "SELECT 1 FROM pending_dvm_reports WHERE payload->>'fundingId' = $1",
          [payload.fundingId]
        )
      ).toMatchObject({ rowCount: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("queues a draw release transactionally and delivers it on the release endpoint", async () => {
    const payload: CreditDrawReleasePayload = {
      dvmId: "dvm-test-1",
      creditId: "credit-release-1",
      drawId: "draw-release-1",
      amountMicro: 25_000,
      creditCurrency: "usd",
      ledgerSeq: 2,
      releasedAt: Date.now(),
    };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await reporter.enqueueCreditDrawRelease(client, payload);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const queued = await pool.query(
      "SELECT kind, payload FROM pending_dvm_reports WHERE payload->>'drawId' = $1",
      [payload.drawId]
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]?.kind).toBe("release");
    expect(queued.rows[0]?.payload).toEqual(payload);

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    globalThis.fetch = mockFetch;
    try {
      await reporter.drainPending();
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://platform.test:8080/_internal/credit-draw-release");
      expect(JSON.parse(init.body as string)).toEqual(payload);
      expect(
        await pool.query("SELECT 1 FROM pending_dvm_reports WHERE payload->>'drawId' = $1", [
          payload.drawId,
        ])
      ).toMatchObject({ rowCount: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

const SKIPPED_NO_RAIL_PAYLOAD: RevenueSkippedNoRailPayload = {
  dvmId: "dvm-test-1",
  jobId: "job-test-2",
  creditId: "credit-test-1",
  drawId: "draw-test-1",
  paidMsats: 21_000,
  drawAmountMicro: 100_000,
  creditCurrency: "usd",
  creditRail: null,
  reason: "credit_rail_null",
};

describe("RevenueReporter settled-draw notices", () => {
  it("posts the no-rail report best-effort to the platform", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    try {
      const reporter = new RevenueReporter({} as Pool, "http://platform.test:8080", "test-token");
      await reporter.reportRevenueSkippedNoRail(SKIPPED_NO_RAIL_PAYLOAD);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://platform.test:8080/_internal/revenue-skipped-no-rail");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      expect(JSON.parse(init.body as string)).toEqual(SKIPPED_NO_RAIL_PAYLOAD);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("swallows transport and non-2xx failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("bad", { status: 503 }))
      .mockRejectedValueOnce(new Error("platform offline"));
    try {
      const reporter = new RevenueReporter({} as Pool, "http://platform.test:8080", "test-token");
      await reporter.reportRevenueSkippedNoRail(SKIPPED_NO_RAIL_PAYLOAD);
      await reporter.reportRevenueSkippedNoRail(SKIPPED_NO_RAIL_PAYLOAD);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({
        event: "revenue_skipped_no_rail_report_failed",
        level: "warn",
      });
    } finally {
      fetchSpy.mockRestore();
      warn.mockRestore();
    }
  });
});

const SELF_RELAY_BALANCE: X402SelfRelayGasBalancePayload = {
  dvmId: "dvm-test-1",
  address: "0x1111111111111111111111111111111111111111",
  network: "eip155:8453",
  balanceWei: "500000000000000",
  lowBalanceWei: "1000000000000000",
  checkedAt: 1_700_000_000_000,
};

describe("RevenueReporter x402 self-relay gas gauge", () => {
  it("posts the exact wei observation over the authenticated platform channel", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    try {
      const reporter = new RevenueReporter({} as Pool, "http://platform.test:8080", "test-token");
      await reporter.reportX402SelfRelayGasBalance(SELF_RELAY_BALANCE);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://platform.test:8080/_internal/x402-self-relay-gas-balance");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      expect(JSON.parse(init.body as string)).toEqual(SELF_RELAY_BALANCE);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

const SELF_RELAY_RPC_FAILURE: X402SelfRelayRpcHealthPayload = {
  dvmId: "dvm-test-1",
  address: "0x1111111111111111111111111111111111111111",
  network: "eip155:8453",
  status: "failed",
  reason: "rate_limit",
  checkedAt: 1_700_000_000_000,
};

describe("RevenueReporter x402 self-relay RPC health", () => {
  it("posts only the redacted failure class over the authenticated platform channel", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    try {
      const reporter = new RevenueReporter({} as Pool, "http://platform.test:8080", "test-token");
      await reporter.reportX402SelfRelayRpcHealth(SELF_RELAY_RPC_FAILURE);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://platform.test:8080/_internal/x402-self-relay-rpc-health");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      expect(JSON.parse(init.body as string)).toEqual(SELF_RELAY_RPC_FAILURE);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

const TEMPO_BALANCE: TempoSettlementBalancePayload = {
  dvmId: "dvm-test-1",
  address: "0x1111111111111111111111111111111111111111",
  network: "eip155:4217",
  token: "0x2222222222222222222222222222222222222222",
  balanceMicro: "5000",
  lowBalanceMicro: "10000",
  checkedAt: 1_700_000_000_000,
  ready: false,
};

const TEMPO_FAILURE: TempoSettlementFailurePayload = {
  dvmId: "dvm-test-1",
  address: TEMPO_BALANCE.address,
  network: TEMPO_BALANCE.network,
  token: TEMPO_BALANCE.token,
  operation: "close",
  errorClass: "InsufficientFundsError",
  checkedAt: 1_700_000_000_001,
  balanceMicro: "100000",
  creditId: "credit-1",
  drainId: "drain-1",
};

describe("RevenueReporter Tempo settlement readiness", () => {
  it.each([
    ["balance", TEMPO_BALANCE, "/_internal/tempo-settlement-balance"],
    ["failure", TEMPO_FAILURE, "/_internal/tempo-settlement-failure"],
  ] as const)(
    "posts the redacted %s report over the authenticated platform channel",
    async (kind, payload, path) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
      try {
        const reporter = new RevenueReporter({} as Pool, "http://platform.test:8080", "test-token");
        if (kind === "balance") await reporter.reportTempoSettlementBalance(payload);
        else await reporter.reportTempoSettlementFailure(payload);

        expect(fetchSpy).toHaveBeenCalledOnce();
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(`http://platform.test:8080${path}`);
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
        expect(JSON.parse(init.body as string)).toEqual(payload);
      } finally {
        fetchSpy.mockRestore();
      }
    }
  );
});
