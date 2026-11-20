import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-projection-history.mjs");

const batch = { id: "initial", epoch: 1, sha256: "a".repeat(64) };
const repinned = { ...batch, sha256: "b".repeat(64) };

describe("projection release history", () => {
  let root: string;

  function git(...args: string[]): void {
    execFileSync("git", ["-c", "user.name=Example Maintainer", "-c", "user.email=maintainer@example.com",
      "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: root, stdio: "pipe" });
  }

  function writePins(...pins: typeof batch[]): void {
    const path = join(root, "src/observability/__tests__/fixtures/projection/batch-pins.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(pins));
  }

  function check(status: number, message: string): void {
    const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(status);
    expect(status === 0 ? result.stdout : result.stderr).toContain(message);
  }

  function commit(): void {
    git("add", ".");
    git("commit", "-qm", "test release");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "projection-history-"));
    git("init", "-q");
    writeFileSync(join(root, "README.md"), "Example\n");
    commit();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("requires a reachable predecessor, then allows the first corpus release", () => {
    writePins(batch);
    check(1, "no previous reachable release tag");
    git("tag", "v0.1.0");
    commit();
    check(0, "first release of the projection corpus");
  });

  it("rejects re-pinning or removing released batches without an epoch bump", () => {
    git("tag", "v0.1.0");
    writePins(batch);
    commit();
    git("tag", "v0.2.0");
    const addition = { ...repinned, id: "addition" };
    writePins(batch, addition);
    commit();
    check(0, "checked against v0.2.0");

    writePins(repinned);
    check(1, "batch initial changed or disappeared");
    writePins(addition);
    check(1, "batch initial changed or disappeared");

    writePins(addition, { ...batch, id: "nextEpoch", epoch: 2 });
    check(0, "checked against v0.2.0");
  });

  it("rejects an older tag when intervening release tags are missing", () => {
    git("tag", "v0.1.0");
    writePins(batch);
    const releaseState = join(root, ".release-please-manifest.json");
    writeFileSync(releaseState, JSON.stringify({ ".": "0.2.0" }));
    commit();
    writeFileSync(releaseState, JSON.stringify({ ".": "0.3.0" }));
    commit();
    check(1, "release tags are incomplete after v0.1.0");
  });

  it.each([true, false])("guards the first corpus release when its tag is missing (pins committed at rollover: %s)", (atRollover) => {
    git("tag", "v0.1.0");
    writeFileSync(join(root, ".release-please-manifest.json"), JSON.stringify({ ".": "0.2.0" }));
    if (atRollover) writePins(batch);
    commit();
    if (!atRollover) {
      writePins(batch);
      commit();
    }
    git("tag", "v0.2.0");
    git("tag", "-d", "v0.2.0");
    check(0, "projection history ok:");

    writePins(repinned);
    commit();
    check(1, "published projection batch initial changed or disappeared since v0.2.0");
  });

  it("checks uncommitted changes against the release tag at HEAD", () => {
    git("tag", "v0.1.0");
    writePins(batch);
    commit();
    git("tag", "-am", "first release with corpus pins", "v0.2.0");
    check(0, "projection history ok:");

    writePins(repinned);
    check(1, "published projection batch initial changed or disappeared since v0.2.0");
  });

  it("compares a new release tag to its predecessor", () => {
    writePins(batch);
    commit();
    git("tag", "-am", "baseline release", "v0.1.0");
    writePins(repinned);
    commit();
    git("tag", "-am", "candidate release", "v0.2.0");
    writePins(batch);
    check(1, "changed or disappeared since v0.1.0");
  });
});
