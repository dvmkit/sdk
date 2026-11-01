import { AbstractRelay } from "nostr-tools/abstract-relay";
import { encrypt } from "nostr-tools/nip04";
import type { SimplePool } from "nostr-tools/pool";
import { getPublicKey } from "nostr-tools/pure";
import { expect, it, vi } from "vitest";

import { getBalance, NwcError, type NwcConnection } from "../nwc";

it("contains a socket close between connection and publish, then serves another request", async () => {
  const walletSecret = new Uint8Array(32).fill(7);
  const secret = new Uint8Array(32).fill(8);
  const conn: NwcConnection = {
    walletPubkey: getPublicKey(walletSecret),
    clientPubkey: getPublicKey(secret),
    secret,
    relays: ["wss://relay.example.com"],
  };
  let socket: ControlledSocket;
  let onResponse: ((event: { content: string }) => void) | undefined;
  let relay: AbstractRelay;

  class ControlledSocket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onclose?: (event: { message: string }) => void;

    constructor() {
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }

    send(message: string): void {
      const [kind, event] = JSON.parse(message);
      if (kind !== "EVENT") return;
      relay._onmessage({ data: JSON.stringify(["OK", event.id, true, ""]) } as MessageEvent);
      onResponse?.({
        content: encrypt(walletSecret, conn.clientPubkey, JSON.stringify({ result: { balance: 42 } })),
      });
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.({ message: "socket closed" });
    }
  }

  relay = new AbstractRelay(conn.relays[0], {
    verifyEvent: () => true,
    websocketImplementation: ControlledSocket as unknown as typeof WebSocket,
  });
  relay.publishTimeout = 25;
  let closeBeforePublish = true;
  const pool = {
    async ensureRelay() {
      await relay.connect();
      // The connection succeeded, but its socket closes before the SDK gets it.
      if (closeBeforePublish) {
        closeBeforePublish = false;
        socket.close();
      }
      return relay;
    },
    subscribeMany(_urls: unknown, _filter: unknown, handlers: { onevent: typeof onResponse }) {
      onResponse = handlers.onevent;
      return { close: vi.fn() };
    },
  } as unknown as SimplePool;
  const unhandled: unknown[] = [];
  const recordUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", recordUnhandled);
  try {
    const error = await getBalance(conn, { pool, timeoutMs: 100 }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(NwcError);
    expect(error).toMatchObject({ code: "publish_rejected" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);

    await expect(getBalance(conn, { pool, timeoutMs: 100 })).resolves.toBe(42);
  } finally {
    relay.close();
    process.off("unhandledRejection", recordUnhandled);
  }
});
