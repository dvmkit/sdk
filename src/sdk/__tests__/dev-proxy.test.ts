import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../configure";
import { createDVMServer } from "../server/app";
import { MemoryKVStore } from "../store";

describe("dev-mode proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the job token without forwarding unrelated request headers", async () => {
    const remoteFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const dvm = configureDVM({
      name: "Proxy Test",
      capability: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
    });

    const response = await app.request("http://dev.test/_proxy/v1/job/job-1/messages?after=2", {
      method: "POST",
      headers: {
        Authorization: "Bearer must-not-forward",
        Cookie: `dvmkit_target=${encodeURIComponent("https://remote.example")}`,
        "Content-Type": "application/json",
        "X-Job-Token": "job-token-1",
        "X-Unrelated": "must-not-forward",
      },
      body: '{"type":"response"}',
    });

    expect(response.status).toBe(200);
    expect(remoteFetch).toHaveBeenCalledOnce();
    expect(remoteFetch).toHaveBeenCalledWith(
      "https://remote.example/v1/job/job-1/messages?after=2",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Job-Token": "job-token-1",
        },
        body: '{"type":"response"}',
      }
    );
  });
});
