import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkProjectionHistory } from "../scripts/check-projection-history.mjs";

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
    expect(() => checkProjectionHistory(root)).toThrow("no previous reachable release tag");
    git("tag", "v0.1.0");
    commit();
    expect(checkProjectionHistory(root)).toContain("first release of the projection corpus");
  });

  it("rejects re-pinning or removing released batches without an epoch bump", () => {
    git("tag", "v0.1.0");
    writePins(batch);
    commit();
    git("tag", "v0.2.0");
    const addition = { ...repinned, id: "addition" };
    writePins(batch, addition);
    commit();
    expect(checkProjectionHistory(root)).toContain("checked against v0.2.0");

    writePins(repinned);
    expect(() => checkProjectionHistory(root)).toThrow("batch initial changed or disappeared");
    writePins(addition);
    expect(() => checkProjectionHistory(root)).toThrow("batch initial changed or disappeared");

    writePins(addition, { ...batch, id: "nextEpoch", epoch: 2 });
    expect(checkProjectionHistory(root)).toContain("checked against v0.2.0");
  });

  it("compares a new release tag to its predecessor", () => {
    writePins(batch);
    commit();
    git("tag", "-am", "baseline release", "v0.1.0");
    writePins(repinned);
    commit();
    git("tag", "-am", "candidate release", "v0.2.0");
    expect(() => checkProjectionHistory(root)).toThrow("changed or disappeared since v0.1.0");
  });
});
