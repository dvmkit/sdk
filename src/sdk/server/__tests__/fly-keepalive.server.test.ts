import { afterEach, describe, expect, it, vi } from "vitest";

import { setEmitter } from "../../../observability/with-span";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { createDVMHost } from "../host";
import { secp256k1Auth } from "../secp256k1-auth";

const servers = servedApps();
const shutdowns: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await servers.closeAll();
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  setEmitter(null);
});

const descriptor = () => configureDVM({
  name: "keepalive-route", capability: "work", auth: secp256k1Auth(), onJob(ctx) { ctx.complete("done"); },
});

describe("Fly keepalive route", () => {
  it.each(["standalone", "prefixed host"])("answers unauthenticated before database middleware in a %s", async mode => {
    const databaseMiddleware = vi.fn(() => { throw new Error("unexpected database access"); });
    let url: string;
    if (mode === "standalone") {
      const runtime = await createDVMServer(descriptor(), {
        env: {}, store: new MemoryKVStore(), devMode: true,
        healthHandler: databaseMiddleware,
      });
      shutdowns.push(runtime.shutdown);
      runtime.app.use("*", databaseMiddleware);
      url = await servers.serve(runtime.app);
    } else {
      const host = createDVMHost({ env: {}, devMode: true, port: 0, healthHandler: databaseMiddleware });
      shutdowns.push(host.shutdown);
      host.app.use("*", databaseMiddleware);
      host.mount(descriptor(), { prefix: "/first" });
      host.mount(descriptor(), { prefix: "/second" });
      url = (await host.serve()).url;
    }
    const emit = vi.fn();
    setEmitter(emit);

    const response = await fetch(`${url}/_sdk/keepalive`);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(databaseMiddleware).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
