import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

// @ts-expect-error Release scripts are separately checked as JavaScript by tsconfig.scripts.json.
import { installPublishedRelease } from "../scripts/install-published-release.mjs";
// @ts-expect-error Release scripts are separately checked as JavaScript by tsconfig.scripts.json.
import { inspectPublishedRelease, publishRelease } from "../scripts/publish-release.mjs";

const packageName = "@dvmkit/sdk";
const packageVersion = "0.1.2-rc.7";
const distTag = "next";
const registry = "https://registry.example/";
const tarball = "https://registry.example/@dvmkit/sdk/-/sdk-0.1.2-rc.7.tgz";
const staleRegistryServer = fileURLToPath(new URL("./fixtures/stale-npm-registry.mjs", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("npm release propagation", () => {
  it("retries missing metadata and a pending tarball after publishing once", async () => {
    const archive = makeArchive();
    const expected = expectedIdentity(archive);
    const fetchFn = responses([
      response(404),
      response(404),
      metadataResponse(),
      response(404),
      metadataResponse(),
      bytesResponse(expected.bytes),
    ]);
    const publishFn = vi.fn(() => 0);
    const waitFn = vi.fn(() => Promise.resolve());

    await expect(
      publishRelease({ archive, distTag, fetchFn, publishFn, registry, attempts: 3, retryDelayMs: 0, waitFn })
    ).resolves.toBe("published");

    expect(publishFn).toHaveBeenCalledOnce();
    expect(waitFn).toHaveBeenCalledTimes(2);
  });

  it("does not publish again when the version exists before its tarball does", async () => {
    const archive = makeArchive();
    const expected = expectedIdentity(archive);
    const fetchFn = responses([
      metadataResponse(),
      response(404),
      metadataResponse(),
      response(404),
      metadataResponse(),
      bytesResponse(expected.bytes),
    ]);
    const publishFn = vi.fn(() => 0);
    const waitFn = vi.fn(() => Promise.resolve());

    await expect(
      publishRelease({ archive, distTag, fetchFn, publishFn, registry, attempts: 2, retryDelayMs: 0, waitFn })
    ).resolves.toBe("already-published");

    expect(publishFn).not.toHaveBeenCalled();
    expect(waitFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a wrong dist-tag and a changed archive", async () => {
    const expected = {
      packageName,
      packageVersion,
      sha256: createHash("sha256").update("reviewed archive").digest("hex"),
      distTag,
    };
    await expect(
      inspectPublishedRelease({
        expected,
        fetchFn: responses([metadataResponse({ tag: "latest" })]),
        registry,
      })
    ).resolves.toBe("mismatch");
    await expect(
      inspectPublishedRelease({
        expected,
        fetchFn: responses([metadataResponse(), bytesResponse(Buffer.from("other archive"))]),
        registry,
      })
    ).resolves.toBe("mismatch");
  });
});

describe("bounded release visibility and read-only recovery", () => {
  it("waits beyond three minutes with one upload and polls immediately", async () => {
    const archive = makeArchive();
    const bytes = readFileSync(archive);
    let elapsed = 0;
    const observations: number[] = [];
    const fetchFn = vi.fn(async (url: URL) => {
      observations.push(elapsed);
      if (url.pathname.includes("/-/")) return bytesResponse(bytes);
      return elapsed < 240_000 ? response(404) : metadataResponse();
    });
    const publishFn = vi.fn(() => 0);
    await expect(publishRelease({ archive, distTag, registry, fetchFn, publishFn,
      nowFn: () => elapsed, waitFn: async (ms: number) => { elapsed += ms; },
    })).resolves.toBe("published");
    expect(publishFn).toHaveBeenCalledOnce();
    expect(observations.slice(0, 2)).toEqual([0, 0]);
    expect(elapsed).toBe(240_000);
  });

  it.each(["missing", "pending"])("exhausts the wall-clock window for %s visibility without another upload", async (state) => {
    const archive = makeArchive();
    let elapsed = 0;
    const publishFn = vi.fn(() => 0);
    const fetchFn = vi.fn(async (url: URL) => state === "pending" && !url.pathname.includes("/-/") ? metadataResponse() : response(404));
    await expect(publishRelease({ archive, distTag, registry, fetchFn, publishFn,
      nowFn: () => elapsed, retryDelayMs: 60_000, waitFn: async (ms: number) => { expect(ms).toBeLessThanOrEqual(15_000); elapsed += ms; },
    })).rejects.toThrow(/npm may still be processing.*read-only --check/);
    expect(elapsed).toBe(1_800_000);
    expect(publishFn).toHaveBeenCalledTimes(state === "missing" ? 1 : 0);
  });

  it.each(["missing", "pending", "match"])("read-only %s inspection never invokes publication", async (state) => {
    const archive = makeArchive();
    let elapsed = 0;
    const publishFn = vi.fn(() => { throw new Error("upload forbidden"); });
    const fetchFn = state === "match" ? responses([metadataResponse(), bytesResponse(readFileSync(archive))]) :
      vi.fn(async (url: URL) => state === "pending" && !url.pathname.includes("/-/") ? metadataResponse() : response(404));
    const result = publishRelease({ archive, distTag, registry, fetchFn, publishFn, check: true,
      timeoutMs: 100, nowFn: () => elapsed, waitFn: async (ms: number) => { elapsed += ms; },
    });
    if (state === "match") await expect(result).resolves.toBe("already-published");
    else await expect(result).rejects.toThrow("read-only --check");
    expect(publishFn).not.toHaveBeenCalled();
  });

  it("recovers an existing exact version without publishing", async () => {
    const archive = makeArchive();
    const publishFn = vi.fn(() => 0);
    await expect(publishRelease({ archive, distTag, registry, publishFn,
      fetchFn: responses([metadataResponse(), bytesResponse(readFileSync(archive))]),
    })).resolves.toBe("already-published");
    expect(publishFn).not.toHaveBeenCalled();
  });

  it.each(["name", "version", "origin", "integrity", "bytes", "tag"])("refuses existing %s mismatch without uploading", async (field) => {
    const archive = makeArchive();
    const metadata = { versions: { [packageVersion]: { name: packageName, version: packageVersion,
      dist: { tarball, integrity: integrityOf(readFileSync(archive)) } } }, "dist-tags": { next: packageVersion } };
    const version = metadata.versions[packageVersion];
    if (field === "name") version.name = "other-package";
    if (field === "version") version.version = "0.1.2-rc.70";
    if (field === "origin") version.dist.tarball = "https://other.example/sdk.tgz";
    if (field === "integrity") version.dist.integrity = integrityOf(Buffer.from("different"));
    if (field === "tag") metadata["dist-tags"].next = "0.1.2-rc.6";
    const publishFn = vi.fn(() => 0);
    await expect(publishRelease({ archive, distTag, registry, publishFn,
      fetchFn: responses([response(200, metadata), bytesResponse(field === "bytes" ? Buffer.from("different") : readFileSync(archive))]),
    })).rejects.toThrow("does not match");
    expect(publishFn).not.toHaveBeenCalled();
  });

  it.each(["fetch", "metadata body", "tarball body"])("bounds a hanging %s and aborts its request", async (stage) => {
    vi.useFakeTimers();
    const archive = makeArchive();
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn(async (_url: URL, options: RequestInit) => {
      signal = options.signal ?? undefined;
      if (stage === "fetch") return new Promise<Response>(() => {});
      if (stage === "metadata body") return { ok: true, status: 200, json: () => new Promise(() => {}) };
      if (fetchFn.mock.calls.length === 1) return metadataResponse();
      return { ok: true, status: 200, arrayBuffer: () => new Promise(() => {}) };
    });
    const result = inspectPublishedRelease({ expected: { packageName, packageVersion, distTag, sha256: expectedIdentity(archive).sha256 }, registry, fetchFn });
    const rejection = expect(result).rejects.toThrow("request/body deadline exhausted");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(signal?.aborted).toBe(true);
  });

  it("aborts an unread missing-version response body when inspection completes", async () => {
    const archive = makeArchive();
    let signal: AbortSignal | undefined;
    await expect(inspectPublishedRelease({ expected: { packageName, packageVersion, distTag, sha256: expectedIdentity(archive).sha256 }, registry,
      fetchFn: async (_url: URL, options: RequestInit) => {
        signal = options.signal ?? undefined;
        return new Response(new ReadableStream(), { status: 404 });
      },
    })).resolves.toBe("missing");
    expect(signal?.aborted).toBe(true);
  });

  it("caps an in-flight inspection to the remaining visibility budget", async () => {
    vi.useFakeTimers();
    const archive = makeArchive();
    const fetchFn = vi.fn().mockResolvedValueOnce(response(404)).mockImplementation(() => new Promise(() => {}));
    const result = publishRelease({ archive, distTag, registry, fetchFn, publishFn: () => 0, timeoutMs: 500 });
    const rejection = expect(result).rejects.toThrow("request/body deadline exhausted");
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("wires CLI --check to read-only missing-version recovery", () => {
    const archive = makeArchive();
    const root = mkdtempSync(join(tmpdir(), "sdk-read-only-cli-"));
    temporaryRoots.push(root);
    const preload = join(root, "preload.mjs");
    const uploaded = join(root, "upload-attempted");
    // Replace only external I/O. The real CLI parser and release state machine still execute.
    writeFileSync(preload, `import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { writeFileSync } from 'node:fs';
      childProcess.spawnSync = () => { writeFileSync(${JSON.stringify(uploaded)}, 'attempted'); throw new Error('upload forbidden'); };
      syncBuiltinESMExports();
      globalThis.fetch = async () => new Response(undefined, { status: 404 });
      let elapsed = 0;
      Object.defineProperty(performance, 'now', { value: () => elapsed += 900_000 });`);
    const result = spawnSync(process.execPath, ["--import", preload, "scripts/publish-release.mjs",
      "--archive", archive, "--dist-tag", distTag, "--check"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/deadline exhausted.*npm may still be processing/);
    expect(existsSync(uploaded)).toBe(false);
  });

  it("stops registry authorization failures without uploading or polling", async () => {
    const publishFn = vi.fn(() => 0);
    const waitFn = vi.fn();
    await expect(publishRelease({ archive: makeArchive(), distTag, registry,
      fetchFn: responses([response(401)]), publishFn, waitFn,
    })).rejects.toThrow("metadata request failed (401)");
    expect(publishFn).not.toHaveBeenCalled();
    expect(waitFn).not.toHaveBeenCalled();
  });

  it.each([
    ["--unknown", "x"], ["--archive", "x", "--archive", "y"],
    ["--check", "--check"], ["--check", "true"], ["--archive"], ["--dist-tag", "--check"],
  ])("rejects publisher flags before registry or upload work: %j", (...args) => {
    const result = spawnSync(process.execPath, ["scripts/publish-release.mjs", ...args], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown argument|duplicate argument|invalid argument/);
  });
});

describe("published consumer install propagation", () => {

  it("allows exact install propagation beyond three minutes", async () => {
    let elapsed = 0;
    const budgets: number[] = [];
    const runFn = vi.fn((_args: string[], _prefix: string, budget: number) => {
      budgets.push(budget);
      return elapsed < 240_000 ? { status: 1, output: "npm error code ETARGET\nnpm error No matching version found for @dvmkit/sdk@0.1.2-rc.7.\n" } : { status: 0, output: "" };
    });
    await expect(installPublishedRelease({ version: packageVersion, prefix: "/consumer", runFn,
      nowFn: () => elapsed, waitFn: async (ms: number) => { elapsed += ms; },
    })).resolves.toBeUndefined();
    expect(elapsed).toBe(240_000);
    expect(budgets.every((budget) => budget === 120_000)).toBe(true);
  });

  it("exhausts the install window with attempt budgets capped by remaining time", async () => {
    let elapsed = 0;
    const budgets: number[] = [];
    await expect(installPublishedRelease({ version: packageVersion, prefix: "/consumer",
      runFn: (_args: string[], _prefix: string, budget: number) => {
        budgets.push(budget);
        elapsed += 110_000;
        return { status: 1, output: "npm error code ETARGET\nnpm error No matching version found for @dvmkit/sdk@0.1.2-rc.7.\n" };
      }, nowFn: () => elapsed, waitFn: async (ms: number) => { elapsed += ms; },
    })).rejects.toThrow("install deadline exhausted");
    expect(budgets.at(-1)).toBe(50_000);
    expect(budgets.length).toBe(15);
  });

  it.each([false, true])("kills a hanging install process group even if its parent exited (%s)", async (exitParent) => {
    const root = mkdtempSync(join(tmpdir(), "sdk-install-hang-"));
    temporaryRoots.push(root);
    const npm = join(root, "npm-cli.mjs");
    const pidFile = join(root, "descendant-pid");
    writeFileSync(npm, `import { spawn } from 'node:child_process';
      import { renameSync, writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(child.pid));
      renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
      ${exitParent ? "process.exit(0);" : "setInterval(() => {}, 1000);"}`);
    vi.stubEnv("npm_execpath", npm);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = installPublishedRelease({ version: packageVersion, prefix: root });
    const rejection = expect(result).rejects.toThrow("including descendants");
    // Wait for the actual descendant before advancing its virtual two-minute allowance.
    const descendant = await readDescendantPid(pidFile);
    onTestFinished(() => killDescendant(descendant));
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
    vi.useRealTimers();
    await vi.waitFor(() => expect(() => process.kill(descendant, 0)).toThrow(), { timeout: 1000, interval: 10 });
  });

  it("stops descendants that close their pipes before a successful npm parent exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-install-closed-pipes-"));
    temporaryRoots.push(root);
    const npm = join(root, "npm-cli.mjs");
    const pidFile = join(root, "descendant-pid");
    writeFileSync(npm, `import { spawn } from 'node:child_process';
      import { renameSync, writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(child.pid));
      renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});
      process.exit(0);`);
    vi.stubEnv("npm_execpath", npm);
    await expect(installPublishedRelease({ version: packageVersion, prefix: root })).resolves.toBeUndefined();
    const descendant = await readDescendantPid(pidFile);
    onTestFinished(() => killDescendant(descendant));
    await vi.waitFor(() => expect(() => process.kill(descendant, 0)).toThrow(), { timeout: 1000, interval: 10 });
  });

  it("requires an ETARGET version boundary while accepting npm's sentence period", async () => {
    const exactTarget = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output:
          "npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/sdk@0.1.2-rc.7.\n",
      })
      .mockReturnValueOnce({ status: 0, output: "" });
    const waitFn = vi.fn(() => Promise.resolve());
    await expect(
      installPublishedRelease({
        version: packageVersion,
        prefix: "/consumer",
        attempts: 2,
        retryDelayMs: 0,
        runFn: exactTarget,
        waitFn,
      })
    ).resolves.toBeUndefined();
    expect(waitFn).toHaveBeenCalledWith(0);
    expect(exactTarget).toHaveBeenLastCalledWith(
      ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", "@dvmkit/sdk@0.1.2-rc.7"],
      "/consumer",
      expect.any(Number)
    );

    for (const publishedVersion of ["0.1.2-rc.7.1", "0.1.2-rc.70"]) {
      await expect(
        installPublishedRelease({
          version: packageVersion,
          prefix: "/consumer",
          attempts: 2,
          retryDelayMs: 0,
          runFn: () => ({
            status: 1,
            output: `npm error code ETARGET\nnpm error notarget No matching version found for @dvmkit/sdk@${publishedVersion}.\n`,
          }),
          waitFn: () => Promise.resolve(),
        })
      ).rejects.toThrow("npm install failed");
    }
  });

  it("does not retry a registry error that names an unrelated dependency beside the SDK", async () => {
    const runFn = vi.fn(() => ({
      status: 1,
      output:
        "npm error code E404\nnpm error 404 Not Found - GET https://registry.example/other-package - @dvmkit/sdk@0.1.2-rc.7 depends on other-package\n",
    }));
    const waitFn = vi.fn(() => Promise.resolve());

    await expect(
      installPublishedRelease({ version: packageVersion, prefix: "/consumer", attempts: 2, retryDelayMs: 0, runFn, waitFn })
    ).rejects.toThrow("npm install failed");

    expect(runFn).toHaveBeenCalledOnce();
    expect(waitFn).not.toHaveBeenCalled();
  });

  it("does not retry a wrong-host E404 even when another record quotes the exact SDK version", async () => {
    const runFn = vi.fn(() => ({
      status: 1,
      output:
        "npm error code E404\nnpm error 404 Not Found - GET https://registry.example/@dvmkit/sdk/-/sdk-0.1.2-rc.7.tgz - Not found\nnpm error 404  '@dvmkit/sdk@0.1.2-rc.7' is not in this registry.\n",
    }));

    await expect(
      installPublishedRelease({
        version: packageVersion,
        prefix: "/consumer",
        attempts: 2,
        retryDelayMs: 0,
        runFn,
        waitFn: () => Promise.resolve(),
      })
    ).rejects.toThrow("npm install failed");

    expect(runFn).toHaveBeenCalledOnce();
  });

  it("does not retry a mixed transient and fatal npm error", async () => {
    const runFn = vi.fn(() => ({
      status: 1,
      output:
        "npm error code E404\nnpm error 404  '@dvmkit/sdk@0.1.2-rc.7' is not in this registry.\nnpm error code E401\nnpm error Unable to authenticate\n",
    }));

    await expect(
      installPublishedRelease({
        version: packageVersion,
        prefix: "/consumer",
        attempts: 2,
        retryDelayMs: 0,
        runFn,
        waitFn: () => Promise.resolve(),
      })
    ).rejects.toThrow("npm install failed");

    expect(runFn).toHaveBeenCalledOnce();
  });

  it("recognizes npm's exact-version E404 response", async () => {
    const runFn = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output:
          "npm error code E404\nnpm error 404  '@dvmkit/sdk@0.1.2-rc.7' is not in this registry.\nnpm error 404\n",
      })
      .mockReturnValueOnce({ status: 0, output: "" });

    await expect(
      installPublishedRelease({
        version: packageVersion,
        prefix: "/consumer",
        attempts: 2,
        retryDelayMs: 0,
        runFn,
        waitFn: () => Promise.resolve(),
      })
    ).resolves.toBeUndefined();
  });

  it("requires an E404 version boundary", async () => {
    for (const publishedVersion of ["0.1.2-rc.7.1", "0.1.2-rc.70"]) {
      await expect(
        installPublishedRelease({
          version: packageVersion,
          prefix: "/consumer",
          attempts: 2,
          retryDelayMs: 0,
          runFn: () => ({
            status: 1,
            output: `npm error code E404\nnpm error 404  '@dvmkit/sdk@${publishedVersion}' is not in this registry.\n`,
          }),
          waitFn: () => Promise.resolve(),
        })
      ).rejects.toThrow("npm install failed");
    }
  });

  it("recognizes npm's exact SDK tarball E404 without accepting a nearby version", async () => {
    const runFn = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        output:
          "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit/sdk/-/sdk-0.1.2-rc.7.tgz - Not found\n",
      })
      .mockReturnValueOnce({ status: 0, output: "" });

    await expect(
      installPublishedRelease({
        version: packageVersion,
        prefix: "/consumer",
        attempts: 2,
        retryDelayMs: 0,
        runFn,
        waitFn: () => Promise.resolve(),
      })
    ).resolves.toBeUndefined();

    await expect(
      installPublishedRelease({
        version: "0.1.2-rc.4",
        prefix: "/consumer",
        attempts: 2,
        retryDelayMs: 0,
        runFn: () => ({
          status: 1,
          output:
            "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@dvmkit/sdk/-/sdk-0.1.2-rc.40.tgz - Not found\n",
        }),
        waitFn: () => Promise.resolve(),
      })
    ).rejects.toThrow("npm install failed");
  });

  it.each([["--unknown", "x"], ["--version", packageVersion, "--version", packageVersion], ["--prefix"]])(
    "rejects malformed consumer flags before starting npm: %j", (...args) => {
      const result = spawnSync(process.execPath, ["scripts/install-published-release.mjs", ...args], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/unknown argument|duplicate argument|invalid argument/);
    }
  );

  it("runs the direct CLI without npm_execpath through the selected npm executable", () => {
    const root = mkdtempSync(join(tmpdir(), "dvmkit-sdk-release-cli-"));
    temporaryRoots.push(root);
    const bin = join(root, "bin");
    const consumer = join(root, "consumer");
    const argumentsPath = join(root, "npm-arguments");
    mkdirSync(bin);
    mkdirSync(consumer);
    const npm = join(bin, "npm");
    writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' "$@" > "$SDK_TEST_NPM_ARGUMENTS"\n`);
    chmodSync(npm, 0o755);
    const { npm_execpath: _npmExecpath, ...environment } = process.env;

    execFileSync(process.execPath, ["scripts/install-published-release.mjs", "--version", packageVersion, "--prefix", consumer], {
      cwd: process.cwd(),
      env: {
        ...environment,
        PATH: `${bin}:${environment.PATH ?? ""}`,
        SDK_TEST_NPM_ARGUMENTS: argumentsPath,
      },
    });

    expect(readFileSync(argumentsPath, "utf8").trim().split("\n")).toEqual([
      "install",
      "--save-exact",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-online",
      "@dvmkit/sdk@0.1.2-rc.7",
    ]);
  });
});

describe("published consumer install against a stale cached version listing", () => {
  const previousVersion = "0.1.2-rc.6";
  const staleRegistryTimeoutMs = 60_000;

  it("reproduces npm replaying its cached listing when a retry omits --prefer-online", { timeout: staleRegistryTimeoutMs }, async () => {
    const registry = await startStaleRegistry();
    const consumer = makeConsumer();
    const legacyArgs = ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", `${packageName}@${packageVersion}`];

    expect(registry.run(legacyArgs, consumer).output).toContain(`No matching version found for ${packageName}@${packageVersion}`);
    registry.publish();
    const retry = registry.run(legacyArgs, consumer);

    expect(retry.status).not.toBe(0);
    expect(retry.output).toContain("code ETARGET");
    expect(registry.listingRequests()).toBe(1);
  });

  it("observes the newly published version on the next retry and installs it exactly", { timeout: staleRegistryTimeoutMs }, async () => {
    const registry = await startStaleRegistry();
    const consumer = makeConsumer();
    const waitFn = vi.fn(() => {
      registry.publish();
      return Promise.resolve();
    });

    await expect(
      installPublishedRelease({ version: packageVersion, prefix: consumer, attempts: 3, retryDelayMs: 0, runFn: registry.run, waitFn })
    ).resolves.toBeUndefined();

    expect(waitFn).toHaveBeenCalledOnce();
    expect(registry.listingRequests()).toBe(2);
    const installed = JSON.parse(readFileSync(join(consumer, "node_modules", "@dvmkit", "sdk", "package.json"), "utf8"));
    expect(installed).toMatchObject({ name: packageName, version: packageVersion });
    expect(JSON.parse(readFileSync(join(consumer, "package.json"), "utf8")).dependencies).toEqual({
      [packageName]: packageVersion,
    });
  });

  it("still fails within its attempt bound when the version never appears", { timeout: staleRegistryTimeoutMs }, async () => {
    const registry = await startStaleRegistry();
    const runFn = vi.fn(registry.run);

    await expect(
      installPublishedRelease({
        version: packageVersion,
        prefix: makeConsumer(),
        attempts: 2,
        retryDelayMs: 0,
        runFn,
        waitFn: () => Promise.resolve(),
      })
    ).rejects.toThrow(`npm registry did not expose ${packageName}@${packageVersion} after 2 install attempts`);

    expect(runFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a published tarball whose bytes do not match the listed integrity", { timeout: staleRegistryTimeoutMs }, async () => {
    const registry = await startStaleRegistry({ servedTarballContent: "tampered" });
    registry.publish();
    const runFn = vi.fn(registry.run);

    await expect(
      installPublishedRelease({
        version: packageVersion,
        prefix: makeConsumer(),
        attempts: 3,
        retryDelayMs: 0,
        runFn,
        waitFn: () => Promise.resolve(),
      })
    ).rejects.toThrow("npm install failed");

    expect(runFn).toHaveBeenCalledOnce();
  });

  function makeConsumer() {
    const consumer = mkdtempSync(join(tmpdir(), "dvmkit-sdk-release-consumer-"));
    temporaryRoots.push(consumer);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "sdk-release-consumer", version: "0.0.0", private: true }));
    return consumer;
  }

  async function startStaleRegistry({ servedTarballContent = "published" } = {}) {
    const root = mkdtempSync(join(tmpdir(), "dvmkit-sdk-stale-registry-"));
    temporaryRoots.push(root);
    const tarballs = join(root, "tarballs");
    mkdirSync(tarballs);
    const integrity: Record<string, string> = {};
    for (const version of [previousVersion, packageVersion]) {
      const published = packageTarball(root, version, "published");
      integrity[version] = integrityOf(published);
      const served = servedTarballContent === "published" ? published : packageTarball(root, version, servedTarballContent);
      writeFileSync(join(tarballs, `sdk-${version}.tgz`), served);
    }
    const statePath = join(root, "published-versions.json");
    const requestLog = join(root, "listing-requests");
    writeFileSync(statePath, JSON.stringify([previousVersion]));
    writeFileSync(requestLog, "");
    const server = spawn(process.execPath, [staleRegistryServer], {
      env: { REGISTRY_STATE: statePath, REGISTRY_TARBALLS: tarballs, REGISTRY_REQUEST_LOG: requestLog, REGISTRY_INTEGRITY: JSON.stringify(integrity) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    stopAfterTest(server);
    const origin = await new Promise<string>((resolvePromise, reject) => {
      server.once("error", reject);
      server.stdout.once("data", (chunk: Buffer) => resolvePromise(chunk.toString("utf8").trim()));
    });
    const cache = join(root, "npm-cache");
    const userconfig = join(root, "npmrc");
    writeFileSync(userconfig, "");
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_config_/iu.test(name)));

    return {
      publish: () => writeFileSync(statePath, JSON.stringify([previousVersion, packageVersion])),
      listingRequests: () => readFileSync(requestLog, "utf8").length,
      run: (args: string[], prefix: string) => {
        const npmCli = /npm-cli\.[cm]?js$/u.test(process.env.npm_execpath ?? "") ? process.env.npm_execpath : undefined;
        const result = spawnSync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...args] : args, {
          cwd: prefix,
          encoding: "utf8",
          env: {
            ...environment,
            npm_config_cache: cache,
            npm_config_fetch_retries: "0",
            npm_config_registry: `${origin}/`,
            npm_config_update_notifier: "false",
            npm_config_userconfig: userconfig,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.error) throw result.error;
        return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
      },
    };
  }

  function packageTarball(root: string, version: string, content: string) {
    const directory = mkdtempSync(join(root, "package-"));
    mkdirSync(join(directory, "package"));
    writeFileSync(join(directory, "package", "package.json"), JSON.stringify({ name: packageName, version, description: content }));
    const archive = join(directory, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
    return readFileSync(archive);
  }
});

// The writer may be observed between file creation and the pid landing; never act on a partial read.
async function readDescendantPid(pidFile: string) {
  for (;;) {
    const text = existsSync(pidFile) ? readFileSync(pidFile, "utf8") : "";
    const pid = /^\d+$/.test(text) ? Number(text) : 0;
    if (pid > 1) return pid;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
}

// kill(0) and kill(1) would signal the whole process group / init, not a descendant.
function killDescendant(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* Already stopped. */ }
}

function stopAfterTest(child: { kill: () => boolean }) {
  onTestFinished(() => {
    child.kill();
  });
}

function integrityOf(bytes: Buffer) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function makeArchive() {
  const root = mkdtempSync(join(tmpdir(), "dvmkit-sdk-release-propagation-"));
  temporaryRoots.push(root);
  const packageDirectory = join(root, "package");
  mkdirSync(packageDirectory);
  writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: packageName, version: packageVersion }));
  const archive = join(root, "sdk.tgz");
  execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
  return archive;
}

function expectedIdentity(archive: string) {
  const bytes = readFileSync(archive);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function metadataResponse({ tag = distTag } = {}) {
  return response(200, {
    versions: {
      [packageVersion]: {
        name: packageName,
        version: packageVersion,
        dist: { tarball },
      },
    },
    "dist-tags": { [tag]: packageVersion },
  });
}

function bytesResponse(bytes: Buffer) {
  return new Response(new Uint8Array(bytes), { status: 200 });
}

function response(status: number, body?: unknown) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function responses(items: Response[]) {
  return vi.fn(async () => {
    const next = items.shift();
    if (!next) throw new Error("unexpected registry request");
    return next.clone();
  });
}
