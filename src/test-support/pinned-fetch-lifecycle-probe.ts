import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setImmediate, setTimeout } from "node:timers/promises";

import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

import { createPinnedFetch } from "../sdk/server/ssrf";

const scenario = process.argv[2]!;
const network = process.argv[3] === "network";
const previousDispatcher = getGlobalDispatcher();
const sharedDispatcher = new Agent();
setGlobalDispatcher(sharedDispatcher);
const finite = ["success", "known-length", "keepalive", "literal"].includes(scenario);
const url = scenario === "literal" ? "https://93.184.216.34/" : "https://source.example.com/";
const aborter = new AbortController();
const received = Promise.withResolvers<void>();
const sockets = new Set<import("node:net").Socket>();
const agents = new Set<Agent>();
const calls: { origin: string; method: string; path: string }[] = [];
let responseAborted = false;
let produced = 0;
let canceled = 0;
let consumed = 0;

function respond(res: ServerResponse): void {
  if (scenario === "redirect" || scenario === "refusal") {
    res.writeHead(scenario === "redirect" ? 303 : 307, { location: "https://target.example.com/accepted" });
  }
  if (scenario === "misdirected") res.writeHead(421);
  if (scenario === "response-cancel" || scenario === "response-abort") {
    res.writeHead(200);
    res.write("partial");
    res.on("close", () => { responseAborted = true; });
  } else {
    res.end("accepted");
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === "/accepted") {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, undefined);
    res.end("accepted");
    return;
  }
  assert.equal(req.headers.authorization, "Bearer example");
  if (scenario === "known-length") assert.equal(req.headers["content-length"], String(64 * 1024));
  let responded = false;
  try {
    for await (const chunk of req) {
      assert((chunk as Buffer).every((byte) => byte === 97));
      consumed += (chunk as Buffer).length;
      received.resolve();
      if (scenario === "network-error") { req.socket.destroy(); return; }
      if (scenario === "abort") continue;
      if (!finite && !responded) { responded = true; respond(res); }
    }
    if (!responded) respond(res);
  } catch {
    // Abort, source failure and socket failure deliberately interrupt the peer.
  }
}

const server = network ? createServer((req, res) => { void handle(req, res); }) : undefined;
let origin: string | undefined;
if (server) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
}

const dispatch = Agent.prototype.dispatch;
Agent.prototype.dispatch = function (options, handler) {
  const requestOrigin = String(options.origin);
  assert(["https://source.example.com", "https://target.example.com", "https://93.184.216.34"].includes(requestOrigin));
  calls.push({ origin: requestOrigin, method: options.method, path: options.path });
  agents.add(this);
  if (origin) return dispatch.call(this, { ...options, origin }, handler);

  let failed = false;
  const fail = (error: Error): void => {
    if (failed) return;
    failed = true;
    responseAborted = true;
    handler.onError!(error);
  };
  handler.onConnect!((error) => fail(error ?? new Error("aborted")));
  void (async () => {
    let responded = false;
    const reply = (): void => {
      responded = true;
      const redirect = (scenario === "redirect" || scenario === "refusal") && options.path !== "/accepted";
      const status = redirect ? (scenario === "redirect" ? 303 : 307) : scenario === "misdirected" ? 421 : 200;
      handler.onHeaders!(status, redirect
        ? [Buffer.from("location"), Buffer.from("https://target.example.com/accepted")]
        : [], () => {}, "OK");
      handler.onData!(Buffer.from("accepted"));
      if (scenario !== "response-cancel" && scenario !== "response-abort") handler.onComplete!([]);
    };
    try {
      if (options.body) {
        for await (const chunk of options.body as AsyncIterable<Uint8Array>) {
          if (failed) break;
          assert(chunk.every((byte) => byte === 97));
          consumed += chunk.length;
          received.resolve();
          if (scenario === "network-error") { fail(new Error("connection reset")); break; }
          if (!finite && scenario !== "source-error" && scenario !== "abort" && !responded) reply();
          await setImmediate();
        }
      }
      if (!failed && !responded && scenario !== "abort") reply();
    } catch (error) {
      fail(error as Error);
    }
  })();
  return true;
};

const observed: { method: string; status: number; dispatcher: unknown }[] = [];
const resolved: string[] = [];
let notified = 0;
const pinned = await createPinnedFetch(url, {
  resolver: async (host) => {
    resolved.push(host);
    return [{ address: "93.184.216.34", family: 4 }];
  },
  baseFetch: async (input, init) => {
    const response = await fetch(input, init);
    observed.push({
      method: (input as Request).method,
      status: response.status,
      dispatcher: (init as RequestInit & { dispatcher?: Dispatcher }).dispatcher,
    });
    return response;
  },
  onRedirectFollowed: () => { notified++; },
});

let closed = false;
try {
  const body = scenario === "keepalive" ? "a".repeat(64 * 1024) : new ReadableStream<Uint8Array>({
    pull(controller) {
      if (finite && produced > 0) { controller.close(); return; }
      if (scenario === "source-error" && produced > 0) { controller.error(new Error("source failed")); return; }
      produced += 64 * 1024;
      controller.enqueue(new Uint8Array(64 * 1024).fill(97));
    },
    cancel() { canceled++; },
  });
  if (scenario === "pre-abort") aborter.abort(new Error("caller aborted"));
  const pending = pinned.fetch(url, {
    method: "POST", body, duplex: "half", signal: aborter.signal,
    keepalive: scenario === "keepalive",
    headers: {
      authorization: "Bearer example",
      ...(scenario === "known-length" ? { "content-length": String(64 * 1024) } : {}),
    },
  } as RequestInit);
  if (scenario === "abort" || scenario === "pre-abort") {
    if (scenario === "abort") { await received.promise; aborter.abort(new Error("caller aborted")); }
    await assert.rejects(pending, /caller aborted/);
  } else if (scenario === "network-error" || scenario === "source-error") {
    await assert.rejects(pending, /fetch failed/);
  } else if (scenario === "refusal") {
    await assert.rejects(pending, /cannot safely replay/);
  } else {
    const response = await pending;
    if (scenario === "response-cancel") await response.body!.cancel();
    else if (scenario === "response-abort") {
      aborter.abort(new Error("response aborted"));
      await assert.rejects(response.text(), { name: "AbortError" });
    } else assert.equal(await response.text(), "accepted");
    if (scenario === "misdirected") assert.equal(response.status, 421, "native fetch must not retry a stream");
  }
  await setImmediate();
  if (finite) {
    assert.equal(consumed, 64 * 1024);
  } else if (scenario !== "source-error") {
    assert.equal(canceled, 1, "the upload producer must be canceled");
    const atEnd = produced;
    await setTimeout(20);
    assert.equal(produced, atEnd, "upload production continued after cancellation");
  }
  if (scenario === "redirect") {
    assert.deepEqual(resolved, ["source.example.com", "target.example.com"]);
    assert.equal(notified, 1);
    assert.deepEqual(observed.map(({ method, status }) => ({ method, status })), [
      { method: "POST", status: 303 }, { method: "GET", status: 200 },
    ]);
    assert(observed.every((entry) => entry.dispatcher));
    assert.deepEqual(calls.map((call) => call.method), ["POST", "GET"]);
  } else {
    assert.equal(calls.length, scenario === "pre-abort" ? 0 : 1);
    assert.deepEqual(resolved, scenario === "literal" ? [] : ["source.example.com"]);
    assert.equal(notified, 0);
  }
  await pinned.close();
  closed = true;
  if (scenario === "literal") {
    assert.equal((getGlobalDispatcher() as Agent).closed, false, "a pin must not close the shared dispatcher");
    await getGlobalDispatcher().close();
  } else {
    assert([...agents].every((agent) => agent.closed), "pinned dispatchers remained open");
  }
  if (network) {
    for (let i = 0; sockets.size > 0 && i < 50; i++) await setTimeout(10);
    assert.equal(sockets.size, 0, "connections remained after closing the pinned transport");
  }
  if (scenario === "response-cancel" || scenario === "response-abort") assert(responseAborted, "response cancellation did not reach the transport");
  console.log(JSON.stringify({ scenario, canceled, calls: calls.length }));
} finally {
  if (!closed) await pinned.close();
  if (!sharedDispatcher.closed) await sharedDispatcher.close();
  setGlobalDispatcher(previousDispatcher);
  Agent.prototype.dispatch = dispatch;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
