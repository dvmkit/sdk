import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-release-rollover.mjs");
const roots: string[] = [];

function fixture({ version = "0.11.0", baseline = "0.10.0", tags = ["v0.9.0", "v0.10.0"], notes = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "sdk-release-rollover-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=Release Test", "-c", "user.email=release@example.com", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "chore: release fixture");
  for (const tag of tags) git("-c", "tag.gpgsign=false", "tag", tag);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "api-baseline.json"), JSON.stringify({ version: baseline }));
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\n${notes}\n## [${version}](https://example.com/releases)\n\n- Shipped change.\n`);
  return {
    root,
    check: () => spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release rollover command", () => {
  it("rejects a stale baseline with the exact tag-based recovery command", () => {
    const result = fixture({ baseline: "0.9.0" }).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("api-baseline.json version 0.9.0 must equal 0.10.0");
    expect(result.stderr).toContain("--baseline-from-tag v0.10.0");
  });

  it.each(["- Already shipped.\n", "### Breaking changes\n\n- Changed signature.\n"])("rejects leftover Unreleased content: %s", (notes) => {
    const result = fixture({ notes }).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unreleased must be empty");
    expect(result.stderr).toContain("move its notes into the 0.11.0 release section");
  });

  it.each(["", " \t\r\n"])("accepts a rolled-over release with whitespace-only Unreleased: %j", (notes) => {
    const result = fixture({ notes }).check();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0.11.0 compares against v0.10.0");
  });

  it("accepts a changelog without an Unreleased heading", () => {
    const f = fixture();
    writeFileSync(join(f.root, "CHANGELOG.md"), "# Changelog\n\n## 0.11.0\n\n- Shipped change.\n");
    const result = f.check();
    expect(result.status, result.stderr).toBe(0);
  });

  it("checks linked and repeated Unreleased headings instead of overlooking their notes", () => {
    const f = fixture();
    writeFileSync(join(f.root, "CHANGELOG.md"), "## Unreleased\n\n## [Unreleased](https://example.com/compare)\n\n- Leftover change.\n");
    const result = f.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unreleased must be empty");
  });

  it("sorts stable versions numerically and excludes the current, future, prerelease and malformed tags", () => {
    const result = fixture({
      tags: ["v0.10.0", "v0.9.9", "v0.11.0", "v1.0.0", "v0.10.1-rc.1", "v0.10.2-beta.1", "v0.10.9+build", "v00.10.9"],
    }).check();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("compares against v0.10.0");
  });

  it("keeps release candidates on the previous stable baseline, excluding their matching stable core", () => {
    const result = fixture({ version: "0.11.0-rc.2", tags: ["v0.10.0", "v0.11.0-rc.1", "v0.11.0"] }).check();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0.11.0-rc.2 compares against v0.10.0");
  });

  it("rejects a baseline advanced to the release being prepared", () => {
    const result = fixture({ baseline: "0.11.0", tags: ["v0.10.0", "v0.11.0"] }).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("version 0.11.0 must equal 0.10.0");
  });

  it("fails closed when previous stable tags are unavailable", () => {
    const result = fixture({ tags: ["v0.11.0", "v0.11.0-rc.1"] }).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no stable release tag below 0.11.0");
    expect(result.stderr).toContain("fetch the complete release tags");
  });
});
