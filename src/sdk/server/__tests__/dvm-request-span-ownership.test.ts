import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpanRow } from "../../../observability/types";
import { setEmitter } from "../../../observability/with-span";
import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";

describe("host request-span ownership", () => {
  const emitted: SpanRow[] = [];

  beforeEach(() => {
    emitted.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    for (const level of ["log", "info", "warn"] as const) {
      vi.spyOn(console, level).mockImplementation(() => undefined);
    }
    setEmitter((row) => emitted.push(row));
  });

  afterEach(() => {
    setEmitter(null);
    vi.restoreAllMocks();
  });

  it.each([
    { root: true, prefix: undefined, rootFirst: true },
    { root: false, prefix: "/b", rootFirst: false },
    { root: true, prefix: "/b", rootFirst: true },
    { root: true, prefix: "/b/", rootFirst: true },
    { root: true, prefix: "/b", rootFirst: false },
    { root: true, prefix: "/b/", rootFirst: false },
  ])("records only the serving DVM (root=$root, prefix=$prefix, rootFirst=$rootFirst)", async ({ root, prefix, rootFirst }) => {
    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    const stopBeforeListen = new Error("stop before listen");

    async function checkRequests() {
      const mounts = [
        ...(root ? [{ path: "", slug: "root-span" }] : []),
        ...(prefix ? [{ path: "/b", slug: "sibling-span" }] : []),
      ];
      for (const mount of mounts) {
        for (const route of ["/v1/info", "/"]) {
          emitted.length = 0;
          const response = await host.app.request(`${mount.path}${route === "/" ? "" : route}` || "/");
          if (route === "/v1/info") expect(response.status).toBe(200);
          expect(emitted.filter((row) => row.name === "dvm.request")).toEqual([
            expect.objectContaining({
              dimensions: expect.objectContaining({ dvm_slug: mount.slug }),
              attributes: expect.objectContaining({ "http.route": route }),
            }),
          ]);
        }
        for (const route of ["/health", "/healthz", "/_dev", "/_internal/tempo-close-event"]) {
          emitted.length = 0;
          await host.app.request(`${mount.path}${route}`);
          expect(emitted.filter((row) => row.name === "dvm.request"), `${mount.path}${route}`).toEqual([]);
        }
      }
      if (root) {
        for (const path of ["/blue", "/b-not-a-mount"]) {
          emitted.length = 0;
          const response = await host.app.request(path);
          expect(response.status).toBe(404);
          expect(emitted.filter((row) => row.name === "dvm.request")).toEqual([
            expect.objectContaining({
              dimensions: expect.objectContaining({ dvm_slug: "root-span" }),
              attributes: expect.objectContaining({ "http.probe": true }),
            }),
          ]);
        }
      }
      // All mounts are initialized before onBoot; exercise their real routing
      // and stop here so the offline suite never opens a listening socket.
      throw stopBeforeListen;
    }

    const rootDVM = configureDVM({
      name: "root-span", capability: "echo",
      onBoot: checkRequests,
      onJob: (ctx) => ctx.complete("root"),
    });
    const sibling = configureDVM({
      name: "sibling-span", capability: "echo",
      onBoot: root ? undefined : checkRequests,
      onJob: (ctx) => ctx.complete("sibling"),
    });
    if (root && rootFirst) host.mount(rootDVM);
    if (prefix) host.mount(sibling, { prefix });
    if (root && !rootFirst) host.mount(rootDVM);

    await host.serve().then(
      () => { throw new Error("host unexpectedly opened a listener"); },
      (error: unknown) => { if (error !== stopBeforeListen) throw error; },
    );
  });
});
