import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../sdk/index";
import { serve } from "../server/serve";

describe("lifecycle hooks", () => {
  let serverHandle: { close: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (serverHandle) {
      await serverHandle.close();
      serverHandle = undefined;
    }
  });

  it("calls onBoot before the server accepts connections", async () => {
    const order: string[] = [];
    const env = { MY_KEY: "my-value" };
    let receivedEnv: Record<string, string> | undefined;

    const dvm = configureDVM({
      name: "Boot Test",
      capability: "test",
      async onBoot(bootEnv) {
        receivedEnv = bootEnv;
        order.push("boot");
      },
      async onJob(ctx) {
        ctx.complete("ok");
      },
    });

    serverHandle = await serve(dvm, { port: 0, devMode: true, env });
    order.push("serving");

    expect(order).toEqual(["boot", "serving"]);
    expect(receivedEnv).toBe(env);
  });

  it("rejects serve() when onBoot throws", async () => {
    const dvm = configureDVM({
      name: "Boot Fail Test",
      capability: "test",
      async onBoot() {
        throw new Error("missing API key");
      },
      async onJob(ctx) {
        ctx.complete("ok");
      },
    });

    await expect(serve(dvm, { port: 0, devMode: true })).rejects.toThrow("missing API key");
  });

  it("awaits onShutdown and calls it once when closing", async () => {
    const shutdown = vi.fn();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dvm = configureDVM({
      name: "Async Shutdown Test",
      capability: "test",
      async onShutdown() {
        enter();
        await gate;
        shutdown();
      },
      async onJob(ctx) {
        ctx.complete("ok");
      },
    });
    serverHandle = await serve(dvm, { port: 0, devMode: true });
    expect(shutdown).not.toHaveBeenCalled();
    let returned = false;
    const close = serverHandle.close().then(() => {
      returned = true;
    });
    await entered;
    expect(returned).toBe(false);
    release();
    await close;
    expect(shutdown).toHaveBeenCalledOnce();
    expect(returned).toBe(true);
    serverHandle = undefined;
  });
});
