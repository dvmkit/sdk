import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";
import { SignedRequestError } from "../signed-request";

describe("auth from an independently loaded SDK module graph", () => {
  it("keeps schema, signature and replay refusals structured at the app boundary", async () => {
    // The packed-consumer fixture covers physical installations and HTTP; this
    // offline case isolates constructor identity without requiring a listener.
    vi.resetModules();
    const foreign = await import("../signed-request");
    const { secp256k1Auth } = await import("../secp256k1-auth");
    expect(foreign.SignedRequestError).not.toBe(SignedRequestError);
    const schema = z.object({ text: z.string().max(3), pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string() });
    let handled = 0;
    const store = new MemoryJobStore();
    const save = vi.spyOn(store, "save");
    const auth = secp256k1Auth();
    const replay = vi.spyOn(auth, "recordReplay");
    const descriptor = configureDVM({
      name: "example", auth,
      capabilities: { run: { input: schema, onJob(ctx) { handled++; ctx.complete("done"); } } },
    });
    const { app, shutdown } = await createDVMServer(descriptor, { env: {}, devMode: true, store: new MemoryKVStore(), jobStore: store });
    try {
      const info = await (await app.request("/v1/info")).json();
      const signer = foreign.createSignedRequestVerifier(schema, { replayStore: null });
      const sign = (path: string, text = "ok", nonce = "example-nonce") => signer.signRequest(
        new Uint8Array(32).fill(1), { text }, { nonce },
        { audience: info.auth_audience, method: "POST", path, capability: "run" },
      );
      const post = (path: string, data: unknown) => app.request(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability: "run", data }),
      });
      const lookup = "/v1/request-result/example-request";
      const refused = await post(lookup, sign(lookup, "long"));
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ error: "auth_error", sub_reason: "schema_invalid", display: expect.stringContaining("text: too long") });
      for (const path of ["/v1/job", "/v1/quote"]) {
        const invalidSignature = await post(path, { ...sign(path), signature: "00".repeat(64) });
        expect(invalidSignature.status).toBe(401);
        expect(await invalidSignature.json()).toMatchObject({ error: "auth_error", sub_reason: "signature_invalid" });
        expect((await post(path, { text: "long" })).status).toBe(400);
      }
      expect(save).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
      expect(handled).toBe(0);

      const valid = sign("/v1/job");
      expect((await post("/v1/job", valid)).status).toBe(200);
      expect(handled).toBe(1);
      const duplicate = await post("/v1/job", valid);
      expect(duplicate.status).toBe(401);
      expect(await duplicate.json()).toMatchObject({ error: "auth_error", sub_reason: "replay_detected" });
      expect(handled).toBe(1);
    } finally {
      await shutdown();
    }
  });
});
