import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { CreditLedgerLike } from "../credit-ledger";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";
import { TempoSettlementReadiness } from "../tempo-settlement-readiness";
import type { CreateX402BatchSettlementServerOpts } from "../x402-batch-settlement";
import type * as X402ChannelStoreModule from "../x402-channel-store";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockStartRetryLoop = vi.fn();
const mockStop = vi.fn();
const mockReport = vi.fn().mockResolvedValue(undefined);
const mockReportTerminal = vi.fn().mockResolvedValue(undefined);
const mockReportCost = vi.fn().mockResolvedValue(undefined);
const mockReportRevenueSkippedNoRail = vi.fn().mockResolvedValue(undefined);
const mockReportX402SelfRelayGasBalance = vi.fn().mockResolvedValue(undefined);
const mockReportX402SelfRelayRpcHealth = vi.fn().mockResolvedValue(undefined);
const mockReportTempoSettlementBalance = vi.fn().mockResolvedValue(undefined);
const mockReportTempoSettlementFailure = vi.fn().mockResolvedValue(undefined);
const mockEnqueueDeposit = vi.fn().mockResolvedValue(undefined);
const mockEnqueueCreditDrain = vi.fn().mockResolvedValue(undefined);
const mockEnqueueCreditDrawRelease = vi.fn().mockResolvedValue(undefined);
const { mockChannelStorageClose, mockCreateX402BatchSettlementServer, mockSettlementStop } =
  vi.hoisted(() => {
    const mockChannelStorageClose = vi.fn().mockResolvedValue(undefined);
    const mockSettlementStop = vi.fn().mockResolvedValue(undefined);
    return {
      mockChannelStorageClose,
      mockSettlementStop,
      mockCreateX402BatchSettlementServer: vi.fn(
        async (_opts: CreateX402BatchSettlementServerOpts) => ({
          buildRequirements: vi.fn(),
          accept: vi.fn(),
          getChannel: vi.fn(),
          claimAndSettle: vi.fn(),
          stop: mockSettlementStop,
        })
      ),
    };
  });

class MockRevenueReporter {
  init = mockInit;
  startRetryLoop = mockStartRetryLoop;
  stop = mockStop;
  report = mockReport;
  reportCost = mockReportCost;
  reportTerminal = mockReportTerminal;
  reportRevenueSkippedNoRail = mockReportRevenueSkippedNoRail;
  reportX402SelfRelayGasBalance = mockReportX402SelfRelayGasBalance;
  reportX402SelfRelayRpcHealth = mockReportX402SelfRelayRpcHealth;
  reportTempoSettlementBalance = mockReportTempoSettlementBalance;
  reportTempoSettlementFailure = mockReportTempoSettlementFailure;
  enqueueDeposit = mockEnqueueDeposit;
  enqueueCreditDrain = mockEnqueueCreditDrain;
  enqueueCreditDrawRelease = mockEnqueueCreditDrawRelease;
  constructor(
    public db: unknown,
    public platformUrl: string,
    public platformToken: string
  ) {}
}
const RevenueReporterSpy = vi.fn(
  (...args: ConstructorParameters<typeof MockRevenueReporter>) => new MockRevenueReporter(...args)
);

vi.mock("../revenue-reporter", () => ({
  RevenueReporter: class {
    constructor(...args: ConstructorParameters<typeof MockRevenueReporter>) {
      return RevenueReporterSpy(...args);
    }
  },
}));

vi.mock("../x402-batch-settlement", () => ({
  createX402BatchSettlementServer: mockCreateX402BatchSettlementServer,
}));

// `createDVMServer` now builds the spend gate's durable store at ledger
// construction, so a batch-configured boot runs its DDL against
// `opts.db` — which here is a duck-type, not a pool. Only the class is
// replaced; the module's status constants are the real ones the ledger reads.
vi.mock("../x402-channel-store", async (importOriginal) => ({
  ...(await importOriginal<typeof X402ChannelStoreModule>()),
  PostgresX402ChannelStorage: class {
    init = vi.fn().mockResolvedValue(undefined);
    close = mockChannelStorageClose;
    pendingRefundSettlement = vi.fn().mockResolvedValue(undefined);
  },
}));

const DESCRIPTOR = configureDVM({
  name: "autowire-test",
  capability: "test",
  tag: "test",
  onJob(ctx) {
    ctx.complete("ok");
  },
});

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const fakePgPool = { query: vi.fn(), end: vi.fn() } as any;

describe("RevenueReporter auto-wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChannelStorageClose.mockResolvedValue(undefined);
    mockSettlementStop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-wires when platform env vars + db + dvmId are present", async () => {
    const { revenueReporterActive, shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "tok-test",
        DVMKIT_PLATFORM_URL: "http://platform.invalid",
      },
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      fxFetcher: stubFx,
    });

    expect(revenueReporterActive).toBe(true);
    expect(mockInit).toHaveBeenCalledOnce();
    expect(mockStartRetryLoop).toHaveBeenCalledOnce();

    await shutdown();
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it.each(["url", "token", "hosted"] as const)("reports terminal jobs only with complete hosted wiring (%s)", async mode => {
    const { app, shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {
        ...(mode !== "url" && { DVMKIT_PLATFORM_URL: "https://platform.example.com" }),
        ...(mode !== "token" && { DVMKIT_PLATFORM_TOKEN: "test-token" }),
      },
      store: new MemoryKVStore(), jobStore: new MemoryJobStore(), db: fakePgPool,
      dvmId: "example-dvm", devMode: true, fxFetcher: stubFx,
    });
    try {
      const response = await app.request("/v1/job", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({capability:"test",data:{}}) });
      expect(response.status).toBe(200);
      if (mode === "hosted") {
        expect(mockReportTerminal).toHaveBeenCalledOnce();
        expect(mockReportTerminal).toHaveBeenCalledWith(expect.objectContaining({outcome:"completed",paid:false,endedBy:null,receiptSeq:null}));
      } else expect(mockReportTerminal).not.toHaveBeenCalled();
    } finally { await shutdown(); }
  });

  it("disposes started resources when terminal-cost recovery fails during initialization", async () => {
    const failure = new Error("terminal-cost recovery failed");
    vi.spyOn(JobManager.prototype, "recoverTerminalCosts").mockRejectedValueOnce(failure);
    const jobManagerShutdown = vi.spyOn(JobManager.prototype, "shutdown");

    await expect(
      createDVMServer(DESCRIPTOR, {
        env: {
          DVMKIT_PLATFORM_TOKEN: "tok-test",
          DVMKIT_PLATFORM_URL: "http://platform.invalid",
        },
        store: new MemoryKVStore(),
        db: fakePgPool,
        dvmId: "dvm-123",
        fxFetcher: stubFx,
      })
    ).rejects.toBe(failure);

    expect(mockStartRetryLoop).toHaveBeenCalledOnce();
    expect(mockStop).toHaveBeenCalledOnce();
    expect(jobManagerShutdown).toHaveBeenCalledOnce();
  });

  it("awaits settlement stop before closing its dependent channel storage", async () => {
    let releaseSettlement: () => void = () => undefined;
    mockSettlementStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSettlement = resolve;
        })
    );
    const { shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {},
      store: new MemoryKVStore(),
      db: fakePgPool,
      fxFetcher: stubFx,
      x402: {
        payTo: "0x1111111111111111111111111111111111111111",
        network: "eip155:8453",
        batchSettlement: {
          selfRelay: {
            privateKey: `0x${"11".repeat(32)}`,
            rpcUrl: "https://base.example.invalid",
          },
        },
      },
    });

    const first = shutdown();
    await vi.waitFor(() => expect(mockSettlementStop).toHaveBeenCalledOnce());
    expect(mockChannelStorageClose).not.toHaveBeenCalled();
    releaseSettlement();
    await first;

    expect(mockChannelStorageClose).toHaveBeenCalledOnce();
    expect(mockSettlementStop.mock.invocationCallOrder[0]).toBeLessThan(
      mockChannelStorageClose.mock.invocationCallOrder[0] ?? 0
    );
    expect(shutdown()).toBe(first);
    await shutdown();
    expect(mockSettlementStop).toHaveBeenCalledOnce();
    expect(mockChannelStorageClose).toHaveBeenCalledOnce();
  });

  it("closes channel storage and preserves a settlement stop rejection", async () => {
    const failure = new Error("settlement stop failed");
    mockSettlementStop.mockRejectedValueOnce(failure);
    const { shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {},
      store: new MemoryKVStore(),
      db: fakePgPool,
      fxFetcher: stubFx,
      x402: {
        payTo: "0x1111111111111111111111111111111111111111",
        network: "eip155:8453",
        batchSettlement: {
          selfRelay: {
            privateKey: `0x${"11".repeat(32)}`,
            rpcUrl: "https://base.example.invalid",
          },
        },
      },
    });

    await expect(shutdown()).rejects.toBe(failure);
    expect(mockChannelStorageClose).toHaveBeenCalledOnce();
  });

  it("auto-wires a free job's declared cost through the cost reporter", async () => {
    const descriptor = configureDVM({
      name: "autowire-cost-test",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.cost({ amount: 0.0004, currency: "usd" });
        ctx.complete("ok");
      },
    });
    const { app, shutdown } = await createDVMServer(descriptor, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "tok-test",
        DVMKIT_PLATFORM_URL: "http://platform.invalid",
      },
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      fxFetcher: stubFx,
    });

    const response = await app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(mockReport).not.toHaveBeenCalled();
    expect(mockReportCost).toHaveBeenCalledWith({
      dvmId: "dvm-123",
      jobId: expect.any(String),
      capability: "test",
      outcome: "completed",
      costRevision: 1,
      cost: { amountMicro: 400, currency: "usd" },
    });
    await shutdown();
  });

  it("routes self-relay gas observations through the same platform reporter", async () => {
    const { shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "tok-test",
        DVMKIT_PLATFORM_URL: "http://platform.invalid",
      },
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      fxFetcher: stubFx,
      x402: {
        payTo: "0x1111111111111111111111111111111111111111",
        network: "eip155:8453",
        batchSettlement: {
          selfRelay: {
            privateKey: `0x${"11".repeat(32)}`,
            rpcUrl: "https://base.example.invalid",
          },
        },
      },
    });

    const call = mockCreateX402BatchSettlementServer.mock.calls[0]?.[0];
    const onBalance = call?.config.selfRelay?.onBalance;
    expect(onBalance).toBeTypeOf("function");
    await onBalance?.({
      address: "0x2222222222222222222222222222222222222222",
      network: "eip155:8453",
      balanceWei: 500n,
      lowBalanceWei: 1_000n,
      checkedAt: 1_700_000_000_000,
    });
    expect(mockReportX402SelfRelayGasBalance).toHaveBeenCalledWith({
      dvmId: "dvm-123",
      address: "0x2222222222222222222222222222222222222222",
      network: "eip155:8453",
      balanceWei: "500",
      lowBalanceWei: "1000",
      checkedAt: 1_700_000_000_000,
    });

    await shutdown();
  });

  it("routes redacted self-relay RPC health through the same platform reporter", async () => {
    const { shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "tok-test",
        DVMKIT_PLATFORM_URL: "http://platform.invalid",
      },
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      fxFetcher: stubFx,
      x402: {
        payTo: "0x1111111111111111111111111111111111111111",
        network: "eip155:8453",
        batchSettlement: {
          selfRelay: {
            privateKey: `0x${"11".repeat(32)}`,
            rpcUrl: "https://base.example.invalid/client-secret",
          },
        },
      },
    });

    const call = mockCreateX402BatchSettlementServer.mock.calls[0]?.[0];
    const onRpcHealth = call?.config.selfRelay?.onRpcHealth;
    expect(onRpcHealth).toBeTypeOf("function");
    await onRpcHealth?.({
      address: "0x2222222222222222222222222222222222222222",
      network: "eip155:8453",
      status: "failed",
      reason: "authentication",
      checkedAt: 1_700_000_000_000,
    });
    expect(mockReportX402SelfRelayRpcHealth).toHaveBeenCalledWith({
      dvmId: "dvm-123",
      address: "0x2222222222222222222222222222222222222222",
      network: "eip155:8453",
      status: "failed",
      reason: "authentication",
      checkedAt: 1_700_000_000_000,
    });

    await shutdown();
  });

  it("routes Tempo settlement balance and fee rejection reports through the same reporter", async () => {
    const readiness = new TempoSettlementReadiness({
      address: "0x1111111111111111111111111111111111111111",
      network: "eip155:4217",
      token: "0x2222222222222222222222222222222222222222",
      lowBalanceMicro: 10_000n,
      readBalance: async () => 5_000n,
      now: () => 1_700_000_000_000,
    });
    const { shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "tok-test",
        DVMKIT_PLATFORM_URL: "http://platform.invalid",
      },
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      fxFetcher: stubFx,
      tempoSettlementReadiness: readiness,
    });

    await readiness.checkBalance();
    await readiness.recordInsufficientFunds({
      operation: "close",
      creditId: "credit-1",
      drainId: "drain-1",
    });

    expect(mockReportTempoSettlementBalance).toHaveBeenCalledWith(
      expect.objectContaining({
        dvmId: "dvm-123",
        balanceMicro: "5000",
        lowBalanceMicro: "10000",
        ready: false,
      })
    );
    expect(mockReportTempoSettlementFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        dvmId: "dvm-123",
        operation: "close",
        errorClass: "InsufficientFundsError",
        creditId: "credit-1",
        drainId: "drain-1",
      })
    );

    await shutdown();
    readiness.stop();
  });

  it("auto-wires the settled-draw/no-rail report to the same reporter", async () => {
    const settledLedger = {
      getDraw: vi.fn().mockResolvedValue({
        creditId: "credit-1",
        drawId: "draw-1",
        amountMicro: 100_000,
        status: "settled",
        railValue: { rail: null, creditCurrency: "usd" },
      }),
    } as unknown as CreditLedgerLike;
    const { jobManager, shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "tok-test",
        DVMKIT_PLATFORM_URL: "http://platform.invalid",
      },
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      creditLedger: settledLedger,
      fxFetcher: stubFx,
    });

    const bookRevenue = (
      jobManager as unknown as {
        bookRevenue: (job: Record<string, unknown>) => Promise<boolean>;
      }
    ).bookRevenue.bind(jobManager);
    await bookRevenue({
      id: "job-1",
      status: "completed",
      paidMsats: 21_000,
      paymentRail: undefined,
      creditId: "credit-1",
      drawId: "draw-1",
    });

    expect(mockReportRevenueSkippedNoRail).toHaveBeenCalledWith(
      expect.objectContaining({
        dvmId: "dvm-123",
        jobId: "job-1",
        creditId: "credit-1",
        drawId: "draw-1",
        drawAmountMicro: 100_000,
        creditCurrency: "usd",
        creditRail: null,
        reason: "credit_rail_null",
      })
    );
    await shutdown();
  });

  it("skips auto-wire when platform env vars are absent", async () => {
    const { revenueReporterActive, shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {},
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      fxFetcher: stubFx,
    });

    expect(revenueReporterActive).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();

    await shutdown();
  });

  it("platform-hosted DVM crashes when db is absent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      createDVMServer(DESCRIPTOR, {
        env: {
          DVMKIT_PLATFORM_TOKEN: "tok-test",
          DVMKIT_PLATFORM_URL: "http://platform.invalid",
        },
        store: new MemoryKVStore(),
        dvmId: "dvm-123",
        fxFetcher: stubFx,
      })
    ).rejects.toThrow(/database/);
    errorSpy.mockRestore();
  });

  it("platform-hosted DVM crashes when dvmId is absent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      createDVMServer(DESCRIPTOR, {
        env: {
          DVMKIT_PLATFORM_TOKEN: "tok-test",
          DVMKIT_PLATFORM_URL: "http://platform.invalid",
        },
        store: new MemoryKVStore(),
        db: fakePgPool,
        fxFetcher: stubFx,
      })
    ).rejects.toThrow(/DVMKIT_DVM_ID/);
    errorSpy.mockRestore();
  });

  it("prefers explicit platformToken/platformUrl opts over env", async () => {
    const { revenueReporterActive, shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "env-tok",
        DVMKIT_PLATFORM_URL: "http://env-url",
      },
      platformToken: "opts-tok",
      platformUrl: "http://opts-url",
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      fxFetcher: stubFx,
    });

    expect(revenueReporterActive).toBe(true);
    expect(RevenueReporterSpy.mock.calls[0]?.slice(0, 3)).toEqual([
      fakePgPool,
      "http://opts-url",
      "opts-tok",
    ]);
    await shutdown();
  });

  it("explicit onJobCompleted bypasses auto-wire", async () => {
    const customCallback = vi.fn();
    const { revenueReporterActive, shutdown } = await createDVMServer(DESCRIPTOR, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "tok-test",
        DVMKIT_PLATFORM_URL: "http://platform.invalid",
      },
      store: new MemoryKVStore(),
      db: fakePgPool,
      dvmId: "dvm-123",
      fxFetcher: stubFx,
      onJobCompleted: customCallback,
    });

    expect(revenueReporterActive).toBe(false);
    expect(mockInit).not.toHaveBeenCalled();
    await shutdown();
  });

  it("platform-hosted DVM crashes on partial platform config", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      createDVMServer(DESCRIPTOR, {
        env: {
          DVMKIT_PLATFORM_URL: "http://platform.invalid",
          // Missing DVMKIT_PLATFORM_TOKEN — platform-hosted partial wiring.
        },
        store: new MemoryKVStore(),
        mints: ["https://mint.example.com"],
        cashuMode: "p2pk-accumulator",
        lockPubkey: "02abc",
        db: fakePgPool,
        dvmId: "dvm-123",
        failFast: false,
        fxFetcher: stubFx,
      })
    ).rejects.toThrow(/FATAL/);
    errorSpy.mockRestore();
  });
});
