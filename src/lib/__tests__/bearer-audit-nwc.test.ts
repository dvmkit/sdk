import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initLoggers } from "../../observability/loggers";
import { SpanWriter } from "../../observability/span-writer";
import type { SpanRow, SpanTransport } from "../../observability/types";
import { setEmitter } from "../../observability/with-span";

const BEARER_SECRET_HEX = "deadbeefcafebabe1234567890abcdef1234567890abcdef1234567890abcdef";
const BEARER_PREIMAGE = "aabbccdd11223344556677889900aabbccddeeff11223344556677889900aabb";

const BEARER_PATTERNS = [BEARER_SECRET_HEX, BEARER_PREIMAGE];
const poolMocks = vi.hoisted(() => ({ useWebSocketImplementation: vi.fn() }));

vi.mock("nostr-tools/nip04", () => ({
  encrypt: vi.fn().mockReturnValue("encrypted_content"),
  decrypt: vi
    .fn()
    .mockReturnValue(JSON.stringify({ result: { preimage: BEARER_PREIMAGE, balance: 50000 } })),
}));
vi.mock("nostr-tools/pool", () => {
  const MockSimplePool = vi.fn(function (this: Record<string, unknown>) {
    // Publishing connects explicitly so a dead relay is distinguishable from a
    // lost reply — see `publishEvent` in nwc.ts.
    this.ensureRelay = vi.fn(() => Promise.resolve({ publish: vi.fn(() => Promise.resolve("")) }));
    this.subscribeMany = vi.fn(
      (_relays: unknown, _filters: unknown, handlers: { onevent: (ev: unknown) => void }) => {
        setTimeout(() => {
          handlers.onevent({ content: "encrypted_response" });
        }, 5);
        return { close: vi.fn() };
      }
    );
    this.close = vi.fn();
  });
  return { SimplePool: MockSimplePool, useWebSocketImplementation: poolMocks.useWebSocketImplementation };
});
vi.mock("nostr-tools/pure", () => ({
  finalizeEvent: vi.fn().mockReturnValue({
    id: "event_id",
    content: "enc",
    kind: 23194,
    tags: [],
    pubkey: "pk",
    sig: "sig",
    created_at: 0,
  }),
  getPublicKey: vi.fn().mockReturnValue("client_pubkey_hex"),
}));
vi.mock("ws", () => ({ default: vi.fn() }));

describe("lightning/NWC bearer-data audit", () => {
  let captured: SpanRow[];

  beforeEach(() => {
    poolMocks.useWebSocketImplementation.mockClear();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    captured = [];
    const transport: SpanTransport = { async send() {} };
    const writer = new SpanWriter(transport, 60_000);
    initLoggers(writer, "test-svc");
    setEmitter((row) => captured.push(row));
  });

  afterEach(() => {
    setEmitter(null);
    vi.restoreAllMocks();
  });

  const conn = {
    walletPubkey: "wallet_pubkey_hex",
    relays: ["wss://relay.test"],
    secret: new Uint8Array(Buffer.from(BEARER_SECRET_HEX, "hex")),
    clientPubkey: "client_pubkey_hex",
  };

  it("configures the WebSocket implementation only when an NWC operation uses a pool", async () => {
    const { getBalance, parseNwcUri } = await import("../nwc");
    expect(poolMocks.useWebSocketImplementation).not.toHaveBeenCalled();

    parseNwcUri(
      `nostr+walletconnect://wallet?relay=wss%3A%2F%2Frelay.test&secret=${BEARER_SECRET_HEX}`
    );
    expect(poolMocks.useWebSocketImplementation).not.toHaveBeenCalled();

    await getBalance(conn);
    expect(poolMocks.useWebSocketImplementation).toHaveBeenCalledOnce();
  });

  it("payInvoiceReconciling does not leak preimage or secret into spans", async () => {
    const { payInvoiceReconciling } = await import("../nwc");
    const result = await payInvoiceReconciling(conn, "lnbc1000...");
    expect(result.preimage).toBe(BEARER_PREIMAGE);
    await tick();

    assertNoBearerLeak(captured);
  });

  it("getBalance does not leak secret into spans", async () => {
    const { getBalance } = await import("../nwc");
    await getBalance(conn);
    await tick();

    assertNoBearerLeak(captured);
  });
});

function assertNoBearerLeak(spans: SpanRow[]): void {
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    const json = JSON.stringify(span.attributes) + JSON.stringify(span.dimensions);
    for (const pattern of BEARER_PATTERNS) {
      expect(json).not.toContain(pattern);
    }
  }
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}
