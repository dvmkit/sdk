import { describe, expect, it } from "vitest";

import { servedApps } from "../../test-support/served-app";
import { configureDVM } from "../configure";
import { createDVMServer } from "../server/app";
import { MemoryKVStore } from "../store";

const descriptor = configureDVM({
  name: "DevTest",
  capability: "test",
  tag: "test",
  onJob(ctx) {
    ctx.complete(ctx.requesterId);
  },
});

describe("dev mode auth", () => {
  const servers = servedApps();
  let baseUrl: string;

  async function startApp(devMode: boolean): Promise<void> {
    const { app } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      devMode,
    });
    baseUrl = await servers.serve(app);
  }

  it("sets the dev requesterId on the context", async () => {
    await startApp(true);
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await fetch(`${baseUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const { job_id, job_token } = await res.json();
    const statusRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: job_token ? { "X-Job-Token": job_token } : {},
    });
    const status = await statusRes.json();
    expect(status.summary).toBe("dev-anonymous");
  });
});
