import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";

import { afterEach, expect, it } from "vitest";

import { configureDVM } from "../../sdk/configure";
import { serve } from "../../sdk/server/serve";
import { startNip47Stub } from "../../test-support/nip47-stub";
import { getInfo, NwcError, parseNwcUri } from "../nwc";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function threeRelays() {
  const errors: Error[] = [];
  const recordError = (error: Error) => { errors.push(error); };
  process.on("uncaughtExceptionMonitor", recordError);
  closers.push(async () => { process.off("uncaughtExceptionMonitor", recordError); });

  const sockets = new Set<Socket>();
  let accepted = 0;
  const hanging = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // Accept TCP, but never answer the WebSocket upgrade.
    socket.resume();
  });
  hanging.listen(0, "127.0.0.1");
  await once(hanging, "listening");
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => hanging.close((error) => error ? reject(error) : resolve()));
  });

  const methods = ["get_info", "get_balance", "make_invoice", "lookup_invoice"];
  const wallet = await startNip47Stub({ methods, alias: "Example wallet" });
  closers.push(wallet.close);
  const other = await startNip47Stub({ methods });
  closers.push(other.close);
  const uri = new URL(wallet.uri);
  uri.searchParams.append("relay", `ws://127.0.0.1:${(hanging.address() as AddressInfo).port}`);
  uri.searchParams.append("relay", other.relayUrl);

  return { uri: uri.href, wallet, errors, accepted: () => accepted };
}

it.each([false, true])("contains a hanging handshake when the wallet is offline: %s", async (offline) => {
  const relays = await threeRelays();
  if (offline) relays.wallet.setFault({ mode: "offline" });

  const result = getInfo(parseNwcUri(relays.uri), { timeoutMs: 4_000 });
  if (offline) {
    const error = await result.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(NwcError);
    expect(error).toMatchObject({ code: "timeout" });
  } else {
    await expect(result).resolves.toMatchObject({ alias: "Example wallet" });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(relays.accepted()).toBeGreaterThan(0);
  expect(relays.errors).toEqual([]);
}, 8_000);

it("serves HTTP after the relay connection timeout despite a hanging handshake", async () => {
  const relays = await threeRelays();
  const dvm = configureDVM({
    name: "Example service",
    capability: "test",
    async onJob(ctx) { ctx.complete("done"); },
  });
  const started = performance.now();
  const handle = await serve(dvm, {
    port: 0,
    env: {},
    devMode: true,
    lightningReceive: { uri: relays.uri },
  });
  closers.push(handle.close);

  // The default per-relay connection budget is 3s; allow 2s for host setup and HTTP.
  expect((await fetch(`${handle.url}/healthz`)).status).toBe(200);
  expect(performance.now() - started).toBeLessThan(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(relays.accepted()).toBeGreaterThan(0);
  expect(relays.errors).toEqual([]);
}, 8_000);
