import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureDVM } from "../../sdk/index";
import { servedApps } from "../../test-support/served-app";
import { createDVMServer } from "../server/app";
import { MemoryKVStore } from "../store";

describe("/v1/info sdk_sha", () => {
  const servers = servedApps();
  let url: string;
  let origGitSha: string | undefined;

  const dvm = configureDVM({
    name: "SHA Test DVM",
    capability: "test",
    async onJob(ctx) {
      ctx.complete("done");
    },
  });

  async function startServer(env: Record<string, string> = {}): Promise<void> {
    const { app } = await createDVMServer(dvm, {
      env,
      store: new MemoryKVStore(),
      devMode: true,
    });

    url = await servers.serve(app);
  }

  beforeEach(() => {
    origGitSha = process.env.GIT_SHA;
  });

  afterEach(async () => {
    await servers.closeAll();
    if (origGitSha === undefined) {
      delete process.env.GIT_SHA;
    } else {
      process.env.GIT_SHA = origGitSha;
    }
  });

  it("exposes GIT_SHA from the supplied host environment", async () => {
    process.env.GIT_SHA = "ambient-sha";
    await startServer({ GIT_SHA: "abc1234def5678901234567890abcdef12345678" });

    const res = await fetch(`${url}/v1/info`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.sdk_sha).toBe("abc1234def5678901234567890abcdef12345678");
    await startServer();
    const empty = await fetch(`${url}/v1/info`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ sdk_sha: "unknown" });
  });
});
