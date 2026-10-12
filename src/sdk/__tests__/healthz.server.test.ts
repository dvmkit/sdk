import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureDVM } from "../../sdk/index";
import { servedApps } from "../../test-support/served-app";
import { createDVMServer } from "../server/app";
import { MemoryKVStore } from "../store";

// the DVM SDK serves its own unauthenticated /healthz so the proxied
// `<slug>.example.com/healthz` reports the DVM's own commit instead of being
// shadowed by the router's build info.
describe("/healthz", () => {
  const servers = servedApps();
  let url: string;
  let origGitSha: string | undefined;
  let origBuildTime: string | undefined;
  let origDeployId: string | undefined;

  const dvm = configureDVM({
    name: "Healthz Test DVM",
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
    origBuildTime = process.env.BUILD_TIME;
    origDeployId = process.env.DVMKIT_DEPLOY_ID;
  });

  afterEach(async () => {
    await servers.closeAll();
    if (origGitSha === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = origGitSha;
    if (origBuildTime === undefined) delete process.env.BUILD_TIME;
    else process.env.BUILD_TIME = origBuildTime;
    if (origDeployId === undefined) delete process.env.DVMKIT_DEPLOY_ID;
    else process.env.DVMKIT_DEPLOY_ID = origDeployId;
  });

  it("reports the 7-char gitSha and deployedAt from the supplied host env, unauthenticated", async () => {
    process.env.GIT_SHA = "ambient-sha";
    process.env.BUILD_TIME = "ambient-time";
    process.env.DVMKIT_DEPLOY_ID = "ambient-deploy";
    await startServer({
      GIT_SHA: "abc1234def5678901234567890abcdef12345678",
      BUILD_TIME: "2026-07-05T12:00:00Z",
      DVMKIT_DEPLOY_ID: "deploy-candidate",
    });

    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      gitSha: string;
      deployedAt: string;
      deployId: string;
    };
    expect(body.ok).toBe(true);
    expect(body.gitSha).toBe("abc1234");
    expect(body.deployedAt).toBe("2026-07-05T12:00:00Z");
    expect(body.deployId).toBe("deploy-candidate");
    await startServer();
    const empty = await fetch(`${url}/healthz`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      gitSha: "unknown",
      deployedAt: "unknown",
      deployId: "unknown",
    });
  });
});
