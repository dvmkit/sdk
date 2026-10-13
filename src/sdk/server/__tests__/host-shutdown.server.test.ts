import { createServer, type AddressInfo } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";

const { mountInitializers, mountShutdowns } = vi.hoisted(() => ({
  mountInitializers: [] as Array<(() => Promise<void>) | undefined>,
  mountShutdowns: [] as Array<() => Promise<void>>,
}));

vi.mock("../app", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app")>();
  const { Hono } = await import("hono");
  return {
    ...original,
    createDVMServer: vi.fn(async () => {
      await mountInitializers.shift()?.();
      return {
        app: new Hono(),
        shutdown: mountShutdowns.shift() ?? (() => Promise.resolve()),
        jobManager: {},
        revenueReporterActive: false,
      };
    }),
  };
});

import { createDVMHost } from "../host";

function descriptor(name: string, onShutdown?: () => void) {
  return configureDVM({
    name,
    capability: "test",
    tag: "test",
    onShutdown,
    onJob(ctx) {
      ctx.complete("ok");
    },
  });
}

describe("createDVMHost mount teardown", () => {
  beforeEach(() => {
    mountInitializers.length = 0;
    mountShutdowns.length = 0;
  });

  it("rolls back every initialized mount and only shuts down descriptors whose boot completed", async () => {
    const calls: string[] = [];
    const bootFailure = new Error("later descriptor boot failed");
    const earlierMountShutdown = vi.fn(async () => {
      calls.push("earlier:mount");
    });
    const failingMountShutdown = vi.fn(async () => {
      calls.push("failing:mount");
    });
    const unbootedMountShutdown = vi.fn(async () => {
      calls.push("unbooted:mount");
    });
    mountShutdowns.push(earlierMountShutdown, failingMountShutdown, unbootedMountShutdown);

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(
      configureDVM({
        name: "earlier",
        capability: "test",
        tag: "test",
        onBoot() {
          calls.push("earlier:boot");
        },
        onShutdown() {
          calls.push("earlier:hook");
        },
        onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );
    host.mount(
      configureDVM({
        name: "failing",
        capability: "test",
        tag: "test",
        onBoot() {
          calls.push("failing:boot");
          throw bootFailure;
        },
        onShutdown() {
          calls.push("failing:hook");
        },
        onJob(ctx) {
          ctx.complete("never");
        },
      }),
      { prefix: "/failing" }
    );
    host.mount(
      configureDVM({
        name: "unbooted",
        capability: "test",
        tag: "test",
        onBoot() {
          calls.push("unbooted:boot");
        },
        onShutdown() {
          calls.push("unbooted:hook");
        },
        onJob(ctx) {
          ctx.complete("never");
        },
      }),
      { prefix: "/unbooted" }
    );

    await expect(host.serve()).rejects.toBe(bootFailure);
    await expect(host.shutdown()).resolves.toBeUndefined();

    expect(calls).toEqual([
      "earlier:boot",
      "failing:boot",
      "unbooted:mount",
      "failing:mount",
      "earlier:hook",
      "earlier:mount",
    ]);
    expect(unbootedMountShutdown).toHaveBeenCalledOnce();
    expect(failingMountShutdown).toHaveBeenCalledOnce();
    expect(earlierMountShutdown).toHaveBeenCalledOnce();
  });

  it("does not run descriptor shutdown when the first onBoot fails", async () => {
    const bootFailure = new Error("first descriptor boot failed");
    const descriptorShutdown = vi.fn();
    const mountShutdown = vi.fn().mockResolvedValue(undefined);
    mountShutdowns.push(mountShutdown);

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(
      configureDVM({
        name: "first",
        capability: "test",
        tag: "test",
        onBoot() {
          throw bootFailure;
        },
        onShutdown: descriptorShutdown,
        onJob(ctx) {
          ctx.complete("never");
        },
      })
    );

    await expect(host.serve()).rejects.toBe(bootFailure);

    expect(descriptorShutdown).not.toHaveBeenCalled();
    expect(mountShutdown).toHaveBeenCalledOnce();
    await expect(host.serve()).rejects.toThrow(/host can only serve once/i);
    expect(mountShutdown).toHaveBeenCalledOnce();
  });

  it("unwinds earlier mounts when a later mount fails to initialize", async () => {
    const mountFailure = new Error("later mount initialization failed");
    const earlierMountShutdown = vi.fn().mockResolvedValue(undefined);
    const earlierDescriptorShutdown = vi.fn();
    mountInitializers.push(undefined, () => Promise.reject(mountFailure));
    mountShutdowns.push(earlierMountShutdown);

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(descriptor("earlier", earlierDescriptorShutdown));
    host.mount(descriptor("later"), { prefix: "/later" });

    await expect(host.serve()).rejects.toBe(mountFailure);

    expect(earlierMountShutdown).toHaveBeenCalledOnce();
    expect(earlierDescriptorShutdown).not.toHaveBeenCalled();
  });

  it("rejects with the bind error and rolls back boot when the port is taken", async () => {
    // Bind on all interfaces, matching the host listener's default, so the
    // conflict holds on both IPv4 and IPv6.
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(0, resolve));
    const heldPort = (holder.address() as AddressInfo).port;
    try {
      const descriptorShutdown = vi.fn();
      const mountShutdown = vi.fn().mockResolvedValue(undefined);
      mountShutdowns.push(mountShutdown);

      const host = createDVMHost({ devMode: true, port: 0, env: {} });
      host.mount(descriptor("port-taken", descriptorShutdown));

      await expect(host.serve({ port: heldPort })).rejects.toMatchObject({
        code: "EADDRINUSE",
        syscall: "listen",
        port: heldPort,
      });

      expect(descriptorShutdown).toHaveBeenCalledOnce();
      expect(mountShutdown).toHaveBeenCalledOnce();
      await expect(host.shutdown()).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("preserves the boot failure when rollback also fails", async () => {
    const bootFailure = new Error("useful boot failure");
    const cleanupFailure = new Error("mount cleanup failed");
    const mountShutdown = vi.fn().mockRejectedValue(cleanupFailure);
    mountShutdowns.push(mountShutdown);

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(
      configureDVM({
        name: "cleanup-failure",
        capability: "test",
        tag: "test",
        onBoot() {
          throw bootFailure;
        },
        onJob(ctx) {
          ctx.complete("never");
        },
      })
    );

    await expect(host.serve()).rejects.toBe(bootFailure);
    await expect(host.shutdown()).rejects.toBe(cleanupFailure);
    expect(mountShutdown).toHaveBeenCalledOnce();
  });

  it("awaits each mount in reverse order before starting the next", async () => {
    const calls: string[] = [];
    let probeRequests = 0;
    let releaseLaterMount: () => void = () => undefined;
    const earlierShutdown = vi.fn(async () => {
      calls.push("earlier");
    });
    const laterShutdown = vi.fn(async () => {
      calls.push("later:start");
      await new Promise<void>((resolve) => {
        releaseLaterMount = resolve;
      });
      calls.push("later:done");
    });
    mountShutdowns.push(earlierShutdown, laterShutdown);

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.app.get("/probe", (c) => {
      probeRequests++;
      return c.text("ok");
    });
    host.mount(descriptor("earlier"));
    host.mount(descriptor("later"), { prefix: "/later" });
    const server = await host.serve();
    await expect(fetch(`${server.url}/probe`).then((response) => response.text())).resolves.toBe(
      "ok"
    );
    const closing = server.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });

    await vi.waitFor(() => expect(laterShutdown).toHaveBeenCalledOnce());
    await expect(fetch(`${server.url}/probe`)).rejects.toThrow();
    expect(probeRequests).toBe(1);
    expect(closed).toBe(false);
    expect(earlierShutdown).not.toHaveBeenCalled();
    releaseLaterMount();
    await closing;

    expect(calls).toEqual(["later:start", "later:done", "earlier"]);
  });

  it("finishes later cleanup, surfaces a rejecting mount, and is idempotent", async () => {
    const calls: string[] = [];
    const failure = new Error("later mount failed");
    const earlierShutdown = vi.fn(async () => {
      calls.push("earlier:mount");
    });
    const laterShutdown = vi.fn(async () => {
      calls.push("later:mount");
      throw failure;
    });
    mountShutdowns.push(earlierShutdown, laterShutdown);

    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(descriptor("earlier", () => calls.push("earlier:hook")));
    host.mount(descriptor("later", () => calls.push("later:hook")), { prefix: "/later" });
    const server = await host.serve();

    const first = server.close();
    const second = host.shutdown();
    expect(second).toBe(first);
    expect(server.close()).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);

    expect(calls).toEqual([
      "later:hook",
      "later:mount",
      "earlier:hook",
      "earlier:mount",
    ]);
    expect(laterShutdown).toHaveBeenCalledOnce();
    expect(earlierShutdown).toHaveBeenCalledOnce();
    await expect(fetch(`${server.url}/v1/info`)).rejects.toThrow();
  });
});
