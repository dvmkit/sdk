import assert from "node:assert/strict";
import test from "node:test";

import { createSignedRequestVerifier } from "@dvmkit/sdk";
import { serve } from "@dvmkit/sdk/server";

import dvm, { signedEchoSchema } from "./handler.mjs";

const testSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

test("a custom route verifies the same audience-bound request shape", async () => {
  const server = await serve(dvm, { devMode: true, port: 0 });
  try {
    const infoResponse = await fetch(`${server.url}/v1/info`);
    const info = await infoResponse.json();
    assert.equal(infoResponse.status, 200);
    assert.ok(info.auth_audience);

    const verifier = createSignedRequestVerifier(signedEchoSchema, {
      domain: {
        audience: info.auth_audience,
        method: "POST",
        path: "/private/echo",
        capability: null,
      },
    });
    const body = verifier.signRequest(testSecret, { text: "private hello" });
    const response = await fetch(`${server.url}/private/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "private hello", caller: body.pubkey });
  } finally {
    await server.close();
  }
});
