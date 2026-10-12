import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";

const MINIMAL_DESCRIPTOR = configureDVM({
  name: "test",
  capability: "test",
  tag: "test",
  onJob(ctx) {
    ctx.complete("ok");
  }
});

const MINIMAL_OPTS = {
  env: {},
  store: new MemoryKVStore()
};

describe("createDVMServer boot warnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const originalDvmkitCashuMints = process.env.DVMKIT_CASHU_MINTS;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.DVMKIT_CASHU_MINTS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDvmkitCashuMints !== undefined)
      process.env.DVMKIT_CASHU_MINTS = originalDvmkitCashuMints;
    else delete process.env.DVMKIT_CASHU_MINTS;
  });

  function warnedCashuOptsEnvIgnored(): boolean {
    return warnSpy.mock.calls.some((args: unknown[]) => {
      try {
        const parsed = JSON.parse(args[0] as string) as { event?: string };
        return parsed.event === "cashu_opts_env_ignored";
      } catch {
        return false;
      }
    });
  }

  it("warns when the supplied env sets DVMKIT_CASHU_MINTS but cashuMode is undefined", async () => {
    await createDVMServer(MINIMAL_DESCRIPTOR, {
      ...MINIMAL_OPTS,
      env: { DVMKIT_CASHU_MINTS: "https://mint.example.com" }
    });
    expect(warnedCashuOptsEnvIgnored()).toBe(true);
  });

  it("does not warn when the supplied env sets DVMKIT_CASHU_MINTS and cashuMode is provided", async () => {
    await createDVMServer(MINIMAL_DESCRIPTOR, {
      ...MINIMAL_OPTS,
      env: { DVMKIT_CASHU_MINTS: "https://mint.example.com" },
      cashuMode: "p2pk-accumulator"
    });
    expect(warnedCashuOptsEnvIgnored()).toBe(false);
  });
});
