import assert from "node:assert/strict";
import { setImmediate, setTimeout } from "node:timers/promises";

import { Agent } from "undici";

import { createPinnedFetch } from "../sdk/server/ssrf";

const size = Number(process.argv[2]);
assert(Number.isSafeInteger(size) && size > 0);
assert(global.gc, "the probe needs --expose-gc");

async function liveBuffers(): Promise<number> {
  for (let i = 0; i < 3; i++) {
    global.gc!();
    await setImmediate();
  }
  return process.memoryUsage().arrayBuffers;
}

let consumed = 0;
let produced = 0;
let peakLive = 0;
let peakAhead = 0;
const baseline = await liveBuffers();
let nextSample = size / 4;
// Only replace the network sink. Node's bundled fetch still constructs and
// clones the production request; mocking fetch itself would hide the defect.
const dispatch = Agent.prototype.dispatch;
Agent.prototype.dispatch = function (options, handler) {
  assert.equal(String(options.origin), "https://upload.example.com");
  let aborted: Error | undefined;
  handler.onConnect!((error) => { aborted = error ?? new Error("aborted"); });
  void (async () => {
    try {
      for await (const chunk of options.body as AsyncIterable<Uint8Array>) {
        if (aborted) throw aborted;
        assert(chunk.every((byte) => byte === 97), "upload bytes changed");
        consumed += chunk.length;
        peakAhead = Math.max(peakAhead, produced - consumed);
        if (consumed >= nextSample) {
          peakLive = Math.max(peakLive, (await liveBuffers()) - baseline);
          nextSample += size / 4;
        }
        await setTimeout(1);
      }
      assert.equal(consumed, size);
      handler.onHeaders!(200, [], () => {}, "OK");
      handler.onData!(Buffer.from("accepted"));
      handler.onComplete!([]);
    } catch (error) {
      handler.onError!(error as Error);
    }
  })();
  return true;
};

const pinned = await createPinnedFetch("https://upload.example.com/", {
  resolver: async () => [{ address: "93.184.216.34", family: 4 }],
});
try {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced === size) {
        controller.close();
        return;
      }
      const length = Math.min(64 * 1024, size - produced);
      produced += length;
      controller.enqueue(new Uint8Array(length).fill(97));
    },
  });
  const request = new Request("https://upload.example.com/", {
    method: "POST", body, duplex: "half",
  } as RequestInit);
  const response = await pinned.fetch(request);
  assert.equal(await response.text(), "accepted");
  assert.equal(consumed, size);
  const retained = (await liveBuffers()) - baseline;
  // Keep both public objects reachable through the measurement, as callers may.
  assert.equal(request.url, response.url);
  console.log(JSON.stringify({ size, consumed, retained, peakLive, peakAhead }));
} finally {
  await pinned.close();
  Agent.prototype.dispatch = dispatch;
}
