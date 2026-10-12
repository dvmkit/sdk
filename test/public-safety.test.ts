import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const scanner = resolve(import.meta.dirname, "../scripts/public-safety.mjs");

describe("public safety", () => {
  it.each(["CLAUDE.md", "AGENTS.md", ".claude/settings.json"])(
    "rejects an internal agent-config pointer in shipped source: %s",
    (pointer) => {
      const root = mkdtempSync(join(tmpdir(), "dvmkit-sdk-public-safety-"));
      try {
        execFileSync("git", ["init", "--quiet", root]);
        mkdirSync(join(root, "src"));
        writeFileSync(join(root, "src", "fixture.ts"), `// See ${pointer}\n`);

        const result = spawnSync(
          process.execPath,
          [scanner, "--root", root, "--skip-git", "--skip-pack"],
          { encoding: "utf8" }
        );

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "public safety: internal_agent_config at src/fixture.ts"
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each(["author", "committer"])("rejects an unapproved commit %s without disclosing its email", (role) => {
    const root = mkdtempSync(join(tmpdir(), "public-safety-identity-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      const approved = "265668992+aioli3@users.noreply.github.com";
      const rejected = "123+other@users.noreply.github.com";
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "test"], {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_COMMITTER_NAME: "Test",
          GIT_AUTHOR_EMAIL: role === "author" ? rejected : approved,
          GIT_COMMITTER_EMAIL: role === "committer" ? rejected : approved },
      });
      const result = spawnSync(process.execPath, [scanner, "--root", root, "--skip-pack"], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`unsafe_commit_${role}_email`);
      expect(result.stderr).not.toContain(rejected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["lowercase numbered fixture", "dvm-" + "999999-receipts-"],
    ["mixed-case numbered key", "DvM-" + "999999"],
    ["short numbered fixture prefix", "dvm-" + "999-fixture-"],
    ["underscore numbered schema", "dvm_" + "999999_schema"],
    ["short key in issue context", "issue dvm-" + "12"],
    ["private Fly host", "http://service." + "flycast:8080"],
    ["delimiter-free schema", "dvm" + "999999_schema"],
    ["delimiter-free numbered service", "dvm" + "999999"],
    ["delimiter-free short descriptive fixture", "dvm" + "999-fixture"],
    ["delimiter-free issue context", "ticket dvm" + "12"],
    ["embedded fake invoice label", "lnbcrt1dvm" + "999999"],
    ["embedded fake channel label", "0xdvm" + "999999channel"],
  ])("rejects %s", (_label, value) => {
    const root = mkdtempSync(join(tmpdir(), "public-safety-label-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      writeFileSync(join(root, "fixture.ts"), `const value = ${JSON.stringify(value)};\n`);
      const result = spawnSync(process.execPath, [scanner, "--root", root, "--skip-git", "--skip-pack"], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(value.includes("flycast") ? "non_public_host" : "internal_issue_id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves ordinary lowercase runtime IDs and reserved example domains", () => {
    const root = mkdtempSync(join(tmpdir(), "public-safety-runtime-id-"));
    try {
      execFileSync("git", ["init", "--quiet", root]);
      writeFileSync(join(root, "fixture.ts"), 'const ids = ["dvm-1", "dvm-123", "dvm1", "dvm123", "my-dvm-service"]; const url = "https://dvm-123.example.com";\n');
      const result = spawnSync(process.execPath, [scanner, "--root", root, "--skip-git", "--skip-pack"], { encoding: "utf8" });
      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scans a packed artifact without requiring repository metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "dvmkit-sdk-public-safety-pack-"));
    try {
      mkdirSync(join(root, "dist"));
      writeFileSync(
        join(root, "package.json"),
        `${JSON.stringify({ name: "safe-package", version: "1.0.0", files: ["dist"] }, null, 2)}\n`
      );
      writeFileSync(join(root, "dist", "index.js"), "export const safe = true;\n");
      const report = join(root, "packed-report.json");

      const result = spawnSync(
        process.execPath,
        [scanner, "--root", root, "--pack-only", "--report", report],
        { encoding: "utf8" }
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("0 repository files, 2 packed files, 0 commits");
      expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
        status: "passed",
        scanned: { files: 0, packedFiles: 2, commits: 0 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
