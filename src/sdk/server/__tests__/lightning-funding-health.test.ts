/*
 * Lightning's place in the funding menu after an idle spell: stale health gets one bounded
 * refresh before the menu is answered, and a single background probe timeout does not drop a
 * healthy rail. Both health sources are fakes on a fake clock; the invoice-operation path that
 * still drops the rail at once is covered over a real wallet stub in
 * `credit-lightning.server.test.ts` ("refuses funding after a socket closes before publication").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LightningWalletInfo } from "../../../lib/lightning-backend";
import { NwcError } from "../../../lib/nwc";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import {
  LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS,
  LIGHTNING_RAIL_HEALTH_REFRESH_TTL_MS,
  PlatformLightningRailHealth,
} from "../lightning-rail-health";
import {
  LIGHTNING_HEALTH_WAIT_MS,
  LightningReceive,
} from "../lightning-receive";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { durableLedger } from "./__helpers__/credit-fixtures";

const RECEIVE_ONLY: LightningWalletInfo = {
  methods: ["get_info", "get_balance", "make_invoice", "lookup_invoice"],
};
/** Past the receive probe's 60-second cache. */
const PAST_PROBE_TTL_MS = 60_001;

const stubFx: FxFetcher = {
  fetch: () =>
    Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-11-01T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

type ProbeAnswer = () => Promise<LightningWalletInfo>;
type RailAnswer = () => Promise<Response>;

const ok: ProbeAnswer = () => Promise.resolve(RECEIVE_ONLY);
const timesOut: ProbeAnswer = () =>
  Promise.reject(new NwcError("timeout", "no reply"));
const routable: RailAnswer = () => Promise.resolve(observation(true));

function after(ms: number, answer: ProbeAnswer): ProbeAnswer;
function after(ms: number, answer: RailAnswer): RailAnswer;
function after(
  ms: number,
  answer: () => Promise<unknown>,
): () => Promise<unknown> {
  return () => new Promise((resolve) => setTimeout(resolve, ms)).then(answer);
}

function observation(isRoutable: boolean): Response {
  return new Response(
    JSON.stringify({ routable: isRoutable, observed_at_ms: Date.now() }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function harness() {
  const probes: ProbeAnswer[] = [];
  const pulls: RailAnswer[] = [];
  const getInfo = vi.fn(() => (probes.shift() ?? ok)());
  const fetchFn = vi.fn(() => (pulls.shift() ?? routable)());
  const unused = vi
    .fn()
    .mockRejectedValue(new Error("unexpected wallet operation"));
  const railHealth = new PlatformLightningRailHealth({
    url: "https://platform.example.com/_internal/lightning-rail-health",
    fetchFn: fetchFn as unknown as typeof fetch,
    now: () => Date.now(),
    retries: 0,
  });
  const lightningReceive = await LightningReceive.create({
    backend: {
      getInfo,
      getBalance: unused,
      createInvoice: unused,
      lookupInvoice: unused,
      payInvoice: unused,
    },
    railHealth,
  });
  const { app } = await createDVMServer(
    configureDVM({
      name: "lightning-idle",
      capability: "run",
      auth: secp256k1Auth(),
      price: "$0.10",
      credit: { min: "$0.10", max: "$5.00" },
      onJob(ctx) {
        ctx.complete("done");
      },
    }),
    {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      creditLedger: durableLedger(),
      fxFetcher: stubFx,
      paymentMethods: [],
      mints: ["https://mint.example.com"],
      lightningReceive,
    },
  );
  const funding = async (): Promise<string[]> => {
    const body = (await (await app.request("/v1/info")).json()) as {
      credit?: { funding?: string[] };
    };
    return body.credit?.funding ?? [];
  };
  /** Let a background probe or pull started by the last request finish. */
  const settleBackground = () => vi.advanceTimersByTimeAsync(0);
  return { probes, pulls, getInfo, fetchFn, funding, settleBackground };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Record when a menu request answers, without awaiting it. */
function tracked(funding: Promise<string[]>): {
  funding: Promise<string[]>;
  answered: boolean;
} {
  const request = { funding, answered: false };
  void funding.finally(() => {
    request.answered = true;
  });
  return request;
}

/** Two consecutive probe timeouts, each sent by a menu request once the cache is stale. */
async function driveUnreachable(h: Harness): Promise<void> {
  h.probes.push(timesOut, timesOut);
  vi.setSystemTime(Date.now() + PAST_PROBE_TTL_MS);
  await h.funding();
  await h.settleBackground();
  await h.funding();
  await h.settleBackground();
  expect(await h.funding()).not.toContain("lightning");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Lightning funding after an idle spell", () => {
  it("lists lightning on the first request when both stale sources answer healthy within the bound", async () => {
    const h = await harness();
    await driveUnreachable(h);

    // Hours idle: the wallet observation is past its TTL and the platform observation past its
    // staleness ceiling. Each would leave lightning out if the menu answered from the cache.
    vi.setSystemTime(
      Date.now() + LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS + 60_000,
    );
    h.probes.push(after(600, ok));
    h.pulls.push(after(300, routable));
    const request = h.funding();
    await vi.advanceTimersByTimeAsync(600);

    expect(await request).toContain("lightning");
  });

  it.each([
    ["wallet probe", "probes"],
    ["platform rail health", "pulls"],
  ] as const)(
    "answers at the bound without lightning when the %s is slower, then lists it once it lands",
    async (_source, queue) => {
      const h = await harness();
      await driveUnreachable(h);
      vi.setSystemTime(
        Date.now() + LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS + 60_000,
      );
      const slow = LIGHTNING_HEALTH_WAIT_MS + 1_000;
      if (queue === "probes") {
        h.probes.push(after(slow, ok));
        h.pulls.push(routable);
      } else {
        h.probes.push(ok);
        h.pulls.push(after(slow, routable));
      }
      const probesBefore = h.getInfo.mock.calls.length;
      const pullsBefore = h.fetchFn.mock.calls.length;

      const first = tracked(h.funding());
      const second = tracked(h.funding());
      await vi.advanceTimersByTimeAsync(1_000);
      // A request joining the refresh half way waits only for what is left of the bound.
      const joiner = tracked(h.funding());
      await vi.advanceTimersByTimeAsync(LIGHTNING_HEALTH_WAIT_MS - 1_000 - 1);
      expect([first.answered, second.answered, joiner.answered]).toEqual([
        false,
        false,
        false,
      ]);
      await vi.advanceTimersByTimeAsync(1);
      expect([first.answered, second.answered, joiner.answered]).toEqual([
        true,
        true,
        true,
      ]);
      for (const request of [first, second, joiner]) {
        expect(await request.funding).not.toContain("lightning");
      }
      // Concurrent menus shared one refresh of each source.
      expect(h.getInfo.mock.calls.length - probesBefore).toBe(1);
      expect(h.fetchFn.mock.calls.length - pullsBefore).toBe(1);

      await vi.advanceTimersByTimeAsync(slow);
      expect(await h.funding()).toContain("lightning");
    },
  );

  it("lists lightning in every concurrent request when the shared refresh lands inside the bound", async () => {
    const h = await harness();
    await driveUnreachable(h);
    vi.setSystemTime(
      Date.now() + LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS + 60_000,
    );
    h.probes.push(after(500, ok));
    h.pulls.push(after(500, routable));
    const first = tracked(h.funding());
    const second = tracked(h.funding());
    await vi.advanceTimersByTimeAsync(500);

    expect([first.answered, second.answered]).toEqual([true, true]);
    expect(await first.funding).toContain("lightning");
    expect(await second.funding).toContain("lightning");
  });

  it("lists lightning on the first request when the platform's last word, now out of date, was not routable", async () => {
    const h = await harness();
    vi.setSystemTime(Date.now() + LIGHTNING_RAIL_HEALTH_REFRESH_TTL_MS + 1);
    h.pulls.push(() => Promise.resolve(observation(false)));
    await h.funding();
    await h.settleBackground();
    const pulls = h.fetchFn.mock.calls.length;
    // A fresh "not routable" is answered as is, with no wait and no extra pull.
    expect(await h.funding()).not.toContain("lightning");
    expect(h.fetchFn.mock.calls.length).toBe(pulls);

    vi.setSystemTime(Date.now() + 30 * 60_000);
    h.pulls.push(after(300, routable));
    const request = h.funding();
    await vi.advanceTimersByTimeAsync(300);
    expect(await request).toContain("lightning");
  });

  it("does not wait on a platform pull that failed within its refresh interval", async () => {
    const h = await harness();
    vi.setSystemTime(
      Date.now() + LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS + 60_000,
    );
    h.pulls.push(() => Promise.reject(new Error("offline")));
    expect(await h.funding()).not.toContain("lightning");
    const pulls = h.fetchFn.mock.calls.length;

    vi.setSystemTime(Date.now() + LIGHTNING_RAIL_HEALTH_REFRESH_TTL_MS - 1);
    expect(await h.funding()).not.toContain("lightning");
    expect(h.fetchFn.mock.calls.length).toBe(pulls);
  });
});

describe("a rail-health hook that throws", () => {
  it("is answered from its cached signal instead of failing the menu", async () => {
    const unused = vi
      .fn()
      .mockRejectedValue(new Error("unexpected wallet operation"));
    const receive = await LightningReceive.create({
      backend: {
        getInfo: unused,
        getBalance: unused,
        createInvoice: unused,
        lookupInvoice: unused,
        payInvoice: unused,
      },
      railHealth: {
        available: () => true,
        ensureFresh: () => {
          throw new Error("hook failed");
        },
      },
    });
    if (!receive) throw new Error("test receive wallet was not constructed");

    await expect(receive.ensureFresh()).resolves.toBeUndefined();
    expect(receive.available()).toBe(true);
  });
});

describe("a background wallet probe that times out", () => {
  it("keeps lightning through one timeout and through timeouts a success separates", async () => {
    const h = await harness();
    h.probes.push(timesOut, ok, timesOut);
    for (let probe = 0; probe < 3; probe++) {
      vi.setSystemTime(Date.now() + PAST_PROBE_TTL_MS);
      expect(await h.funding()).toContain("lightning");
      await h.settleBackground();
    }
    expect(h.getInfo).toHaveBeenCalledTimes(3);
    expect(await h.funding()).toContain("lightning");
  });

  it("drops lightning on the second consecutive timeout, probed by the next request", async () => {
    const h = await harness();
    h.probes.push(timesOut, timesOut);
    vi.setSystemTime(Date.now() + PAST_PROBE_TTL_MS);
    expect(await h.funding()).toContain("lightning");
    await h.settleBackground();

    // No further clock movement: the first timeout leaves the observation stale, so this
    // request sends the confirming probe rather than waiting out another TTL.
    await h.funding();
    await h.settleBackground();
    expect(h.getInfo).toHaveBeenCalledTimes(2);
    expect(await h.funding()).not.toContain("lightning");
  });
});
