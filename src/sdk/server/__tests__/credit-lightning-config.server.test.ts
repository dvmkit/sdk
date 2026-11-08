import { afterEach, describe, expect, it, vi } from "vitest";

import type { Nip47Stub } from "../../../test-support/nip47-stub";
import { startNip47Stub } from "../../../test-support/nip47-stub";
import { closeNextNwcPublish } from "../../../test-support/nwc-publish-fault";
import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";
import { secp256k1Auth } from "../secp256k1-auth";
import {
  LightningReceive,
  resolveInvoiceTtl,
} from "../lightning-receive";

const RECEIVE_ONLY = ["get_info", "get_balance", "make_invoice", "lookup_invoice"];
const ALBY_HUB_RECEIVE_ONLY = [
  ...RECEIVE_ONLY,
  "make_hold_invoice",
  "settle_hold_invoice",
  "cancel_hold_invoice",
  "get_budget"
];

let stub: Nip47Stub | undefined;

afterEach(async () => {
  await stub?.close();
  stub = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function triggerRecovery(receive: LightningReceive, wallet: Nip47Stub): Promise<void> {
  wallet.setFault({ mode: "pass" });
  vi.setSystemTime(Date.now() + 60_001);
  receive.available();
  await vi.waitFor(() => {
    expect(wallet.requests.filter((request) => request.method === "get_info")).toHaveLength(1);
  });
}

describe("receive-only credential validation", () => {
  it("accepts a receive-only connection", async () => {
    stub = await startNip47Stub({ methods: RECEIVE_ONLY });
    const receive = await LightningReceive.create({ uri: stub.uri });
    expect(receive?.available()).toBe(true);
  });

  it("accepts Alby Hub's receive-only capability expansion", async () => {
    stub = await startNip47Stub({ methods: ALBY_HUB_RECEIVE_ONLY });
    const receive = await LightningReceive.create({ uri: stub.uri });
    expect(receive?.available()).toBe(true);
  });

  it("refuses a connection that can pay, naming the fix", async () => {
    stub = await startNip47Stub({ methods: [...RECEIVE_ONLY, "pay_invoice"] });
    const uri = stub.uri;
    await expect(LightningReceive.create({ uri })).rejects.toThrow(
      /pay_invoice[\s\S]*receive-only connection/
    );
  });

  it("refuses methods outside the receive-safe allowlist", async () => {
    stub = await startNip47Stub({ methods: [...RECEIVE_ONLY, "pay_keysend"] });
    await expect(LightningReceive.create({ uri: stub.uri })).rejects.toThrow(/pay_keysend/);
  });

  it.each([false, true])("refuses a wallet that won't state its permitted methods (allowSpend=%s)", async (allowSpend) => {
    // An empty advertised method list is unverifiable authority; do not treat reachability as
    // permission validation.
    stub = await startNip47Stub({ methods: RECEIVE_ONLY, advertisedMethods: [] });
    await expect(LightningReceive.create({ uri: stub.uri, allowSpend })).rejects.toThrow(
      /does not advertise which methods/
    );
  });

  it.each([false, true])("refuses a malformed permitted-method observation (allowSpend=%s)", async (allowSpend) => {
    stub = await startNip47Stub({
      methods: RECEIVE_ONLY,
      advertisedMethods: ["get_info", 42] as unknown as string[]
    });
    await expect(LightningReceive.create({ uri: stub.uri, allowSpend })).rejects.toThrow(/malformed/);
  });

  it.each([false, true])("refuses a connection that cannot look up its own invoices (allowSpend=%s)", async (allowSpend) => {
    stub = await startNip47Stub({ methods: ["get_info", "get_balance", "make_invoice", ...(allowSpend ? ["pay_invoice"] : [])] });
    await expect(LightningReceive.create({ uri: stub.uri, allowSpend })).rejects.toThrow(/lookup_invoice/);
  });

  it.each([false, true])("refuses a connection that cannot issue invoices (allowSpend=%s)", async (allowSpend) => {
    stub = await startNip47Stub({ methods: ["get_info", "get_balance", "lookup_invoice", ...(allowSpend ? ["pay_invoice"] : [])] });
    await expect(LightningReceive.create({ uri: stub.uri, allowSpend })).rejects.toThrow(/make_invoice/);
  });

  it.each([{}, ["make_invoice", "lookup_invoice", " "]])(
    "refuses malformed method lists with the override enabled: %j",
    async (advertisedMethods) => {
      stub = await startNip47Stub({
        methods: RECEIVE_ONLY,
        advertisedMethods: advertisedMethods as string[]
      });
      await expect(LightningReceive.create({ uri: stub.uri, allowSpend: true }))
        .rejects.toThrow(/malformed/);
    }
  );

  it("refuses an absent permission list with the override enabled", async () => {
    stub = await startNip47Stub({ methods: RECEIVE_ONLY, volunteerBudgetFields: { methods: undefined } });
    await expect(LightningReceive.create({ uri: stub.uri, allowSpend: true }))
      .rejects.toThrow(/does not advertise which methods/);
  });

  it("refuses an unreadable permission list with the override enabled", async () => {
    stub = await startNip47Stub({ methods: RECEIVE_ONLY, restrictedMethods: ["get_info"] });
    await expect(LightningReceive.create({ uri: stub.uri, allowSpend: true }))
      .rejects.toThrow(/usable get_info permission observation/);
  });

  it("keeps the override through refresh and warns once without leaking wallet text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stub = await startNip47Stub({
      methods: [...RECEIVE_ONLY, "pay_invoice", "pay_keysend", "SENTINEL_SECRET"]
    });
    const receive = await LightningReceive.create({ uri: stub.uri, allowSpend: true });
    expect(receive?.available()).toBe(true);
    const warnings = () => warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => entry.event === "lightning_receive_allow_spend_enabled");
    expect(warnings()).toEqual([{
      event: "lightning_receive_allow_spend_enabled",
      level: "warn",
      override: "DVMKIT_NWC_RECEIVE_ALLOW_SPEND=true",
      spending_methods: ["pay_invoice", "pay_keysend", "unknown_method"]
    }]);
    expect(JSON.stringify(warnings())).not.toContain(stub.uri);
    expect(JSON.stringify(warnings())).not.toContain("SENTINEL_SECRET");

    stub.setFault({ mode: "relay-down" });
    vi.setSystemTime(Date.now() + 60_001);
    receive?.available();
    await vi.waitFor(() => expect(receive?.available()).toBe(false));
    stub.requests.length = 0;
    await triggerRecovery(receive!, stub);
    await vi.waitFor(() => expect(receive?.available()).toBe(true));
    expect(warnings()).toHaveLength(1);
  });

  it("warns when spending authority is first observed after an unreachable boot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stub = await startNip47Stub({ methods: [...RECEIVE_ONLY, "pay_invoice"] });
    stub.setFault({ mode: "relay-down" });
    const receive = await LightningReceive.create({ uri: stub.uri, allowSpend: true });
    expect(receive?.available()).toBe(false);
    await triggerRecovery(receive!, stub);
    await vi.waitFor(() => expect(receive?.available()).toBe(true));
    expect(warn.mock.calls.map(([line]) => String(line)).filter((line) =>
      line.includes("lightning_receive_allow_spend_enabled"))).toHaveLength(1);
  });

  it("refuses a malformed URI with a copy-this-instead hint", async () => {
    await expect(LightningReceive.create({ uri: "https://wallet.example" })).rejects.toThrow(
      /nostr\+walletconnect/
    );
  });

  it("returns undefined when no receive wallet is configured", async () => {
    expect(await LightningReceive.create({})).toBeUndefined();
  });

  it("boots — degraded — when the wallet is unreachable", async () => {
    stub = await startNip47Stub({ methods: RECEIVE_ONLY });
    const uri = stub.uri;
    await stub.close();
    stub = undefined;

    const receive = await LightningReceive.create({ uri });
    expect(receive).toBeDefined();
    expect(receive?.available()).toBe(false);
  });

  it("boots with Lightning unavailable when its socket closes during the permission probe", async () => {
    stub = await startNip47Stub({ methods: RECEIVE_ONLY });
    closeNextNwcPublish(stub);

    const receive = await LightningReceive.create({ uri: stub.uri });

    expect(receive).toBeDefined();
    expect(receive?.available()).toBe(false);
    expect(stub.requests).toHaveLength(0);
  });

  it("logs one unreachable event when a healthy connection's refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    stub = await startNip47Stub({ methods: RECEIVE_ONLY });
    const receive = await LightningReceive.create({ uri: stub.uri });
    if (!receive) throw new Error("test receive wallet was not constructed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    stub.setFault({ mode: "relay-down" });
    vi.setSystemTime(Date.now() + 60_001);
    expect(receive.available()).toBe(true);
    receive.available();
    await vi.waitFor(() => {
      expect(
        warn.mock.calls.filter(([line]) => String(line).includes("lightning_receive_unreachable"))
      ).toHaveLength(1);
    });

    expect(receive.available()).toBe(false);
    expect(
      warn.mock.calls.filter(([line]) => String(line).includes("lightning_receive_unreachable"))
    ).toHaveLength(1);
  });

  it("keeps a spend-capable recovery unavailable and emits an operator-safe reason", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stub = await startNip47Stub({ methods: [...RECEIVE_ONLY, "pay_invoice"] });
    stub.setFault({ mode: "relay-down" });
    const receive = await LightningReceive.create({ uri: stub.uri });
    if (!receive) throw new Error("test receive wallet was not constructed");
    expect(receive?.available()).toBe(false);

    await triggerRecovery(receive, stub);
    receive?.available();

    let refusal: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      refusal = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((entry) => entry.event === "lightning_receive_permission_refused");
      expect(refusal).toBeDefined();
    });
    expect(receive?.available()).toBe(false);
    expect(stub.requests.filter((request) => request.method === "get_info")).toHaveLength(1);
    expect(refusal).toEqual({
      event: "lightning_receive_permission_refused",
      level: "warn"
    });
    expect(JSON.stringify(refusal)).not.toContain("nostr+walletconnect");
  });

  it("restores availability only after the recovered observation proves receive-only scope", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stub = await startNip47Stub({ methods: RECEIVE_ONLY });
    stub.setFault({ mode: "relay-down" });
    const receive = await LightningReceive.create({ uri: stub.uri });
    if (!receive) throw new Error("test receive wallet was not constructed");

    await triggerRecovery(receive, stub);
    await vi.waitFor(() => expect(receive?.available()).toBe(true));
  });

  it("keeps an unstated recovery unavailable with a relayable operator hint", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stub = await startNip47Stub({
      methods: RECEIVE_ONLY,
      advertisedMethods: []
    });
    stub.setFault({ mode: "relay-down" });
    const receive = await LightningReceive.create({ uri: stub.uri });
    if (!receive) throw new Error("test receive wallet was not constructed");

    await triggerRecovery(receive, stub);
    await vi.waitFor(() => {
      const lines = warn.mock.calls.map(([line]) => String(line)).join("\n");
      expect(lines).toContain('"event":"lightning_receive_unreachable"');
      expect(lines).not.toContain('"reason":"methods_absent"');
    });
    expect(receive?.available()).toBe(false);
  });
});

describe("invoice TTL", () => {
  it("defaults to a lifetime a caller can actually pay within", () => {
    expect(resolveInvoiceTtl(undefined)).toBe(900);
  });

  it("refuses a lifetime shorter than the funding negotiation it must outlive", () => {
    expect(() => resolveInvoiceTtl(60)).toThrow(/at least/);
    expect(() => resolveInvoiceTtl(600)).not.toThrow();
  });
});

describe("host receive override environment", () => {
  it.each([undefined, "1", "yes", "TRUE", "true ", "true"])(
    "enables spending authority only for exact true (value=%s)",
    async (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      stub = await startNip47Stub({ methods: [...RECEIVE_ONLY, "pay_invoice"] });
      const host = createDVMHost({
        devMode: true,
        port: 0,
        mints: ["http://localhost:3338"],
        env: {
          DVMKIT_NWC_RECEIVE_URI: stub.uri,
          ...(value === undefined ? {} : { DVMKIT_NWC_RECEIVE_ALLOW_SPEND: value })
        }
      });
      host.mount(configureDVM({
        name: "receive-override-test",
        capability: "test",
        price: "$0.10",
        credit: { min: "$0.10", max: "$5.00" },
        auth: secp256k1Auth(),
        onJob(ctx) { ctx.complete("ok"); }
      }));
      if (value !== "true") {
        await expect(host.serve()).rejects.toThrow(/pay_invoice[\s\S]*receive-only connection/);
        return;
      }
      const server = await host.serve();
      try {
        const response = await fetch(`${server.url}/v1/info`);
        const body = await response.json() as { credit?: { funding: string[] } };
        expect(response.status).toBe(200);
        expect(body.credit?.funding).toContain("lightning");
        expect(warn.mock.calls.map(([line]) => String(line)).join("\n"))
          .toContain('"override":"DVMKIT_NWC_RECEIVE_ALLOW_SPEND=true"');
      } finally {
        await server.close();
      }
    }
  );
});
