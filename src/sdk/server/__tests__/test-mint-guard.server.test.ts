import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDVMHost } from "../host";
import { MemoryJobStore } from "../memory-job-store";

/**
 * A supplied jobStore bypasses DATABASE_URL without enabling devMode.
 * Non-refusal cases assert only that this guard's message is absent; later boot failures may occur.
 */
function host(env: Record<string, string>, mints: string[], extra?: { devMode?: boolean }) {
  return createDVMHost({ port: 0, env, mints, jobStore: new MemoryJobStore(), ...extra });
}

/** Run serve() to completion, returning the boot error (if any). */
async function bootError(
  env: Record<string, string>,
  mints: string[],
  extra?: { devMode?: boolean }
): Promise<Error | undefined> {
  try {
    const server = await host(env, mints, extra).serve();
    await server.close();
    return undefined;
  } catch (err) {
    return err as Error;
  }
}

const GUARD = /Refusing to boot/;

describe("test-mint boot guard", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names every offending test mint in the refusal", async () => {
    await expect(
      host({ DVMKIT_PLATFORM_URL: "http://platform.invalid" }, [
        "http://localhost:3338",
        "https://testnut.cashu.space",
      ]).serve()
    ).rejects.toThrow(/localhost:3338, https:\/\/testnut\.cashu\.space/);
  });

  it("allows the boot (past the guard) when DVMKIT_ALLOW_TEST_MINTS=true", async () => {
    const err = await bootError(
      { DVMKIT_PLATFORM_URL: "http://platform.invalid", DVMKIT_ALLOW_TEST_MINTS: "true" },
      ["http://localhost:3338"]
    );
    expect(err?.message ?? "").not.toMatch(GUARD);
    // Bypass is logged loudly so an operator sees the deliberate exception.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("platform_hosted_test_mint_allowed")
    );
  });

  it("does not fire for a devMode boot, even platform-hosted with a test mint", async () => {
    // Dev/test harnesses (dvmctl dev, serve.ts, money-loop, e2e/smoke) pass
    // devMode + FakeWallet mint and inherit the shell's env; an exported
    // DVMKIT_PLATFORM_URL must not trip the guard for them.
    const err = await bootError(
      { DVMKIT_PLATFORM_URL: "http://platform.invalid" },
      ["http://localhost:3338"],
      { devMode: true }
    );
    expect(err?.message ?? "").not.toMatch(GUARD);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("platform_hosted_test_mint_allowed")
    );
  });

  it("does not fire when not platform-hosted (no DVMKIT_PLATFORM_URL)", async () => {
    const err = await bootError({}, ["http://localhost:3338"]);
    expect(err?.message ?? "").not.toMatch(GUARD);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("platform_hosted_test_mint_allowed")
    );
  });

  it("does not fire for a production mint on a platform-hosted boot", async () => {
    const err = await bootError({ DVMKIT_PLATFORM_URL: "http://platform.invalid" }, [
      "https://mint.example.com",
    ]);
    expect(err?.message ?? "").not.toMatch(GUARD);
  });
});
