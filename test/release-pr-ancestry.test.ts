import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error Release scripts are checked separately by tsconfig.scripts.json.
import { resolveReleasePullRequest } from "../scripts/resolve-release-pr.mjs";

const version = "1.2.3-rc.4";
const repository = "example/sdk";
const roots: string[] = [];
let templateRoot: string;
let commits: { old: string; inconsistent: string; release: string; commit: string; later: string };

beforeAll(() => {
  templateRoot = mkdtempSync(join(tmpdir(), "sdk-release-pr-template-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: templateRoot, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  const save = (packageVersion: string, manifestVersion: string, message: string) => {
    writeFileSync(join(templateRoot, "package.json"), JSON.stringify({ version: packageVersion }));
    writeFileSync(join(templateRoot, ".release-please-manifest.json"), JSON.stringify({ ".": manifestVersion }));
    git("add", "package.json", ".release-please-manifest.json");
    git("commit", "--allow-empty", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const old = save("1.2.2", "1.2.2", "chore: earlier release");
  const inconsistent = save(version, "1.2.2", "chore: incomplete release metadata");
  const release = save(version, version, `chore: release ${version}`);
  const commit = save(version, version, "fix: reviewed change after release");
  git("tag", `v${version}`);
  const later = save(version, version, "fix: newer than immutable tag");
  commits = { old, inconsistent, release, commit, later };
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => rmSync(templateRoot, { recursive: true, force: true }));

function history() {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-release-pr-"));
  cpSync(templateRoot, cwd, { recursive: true });
  roots.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const save = (packageVersion: string, manifestVersion: string, message: string) => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: packageVersion }));
    writeFileSync(join(cwd, ".release-please-manifest.json"), JSON.stringify({ ".": manifestVersion }));
    git("add", "package.json", ".release-please-manifest.json");
    git("commit", "--allow-empty", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  return { cwd, git, save, ...commits };
}

function pullRequest(merge: string, overrides: Record<string, unknown> = {}) {
  return {
    number: 11,
    title: `chore(master): release ${version}`,
    merged_at: "2026-01-01T00:00:00Z",
    merge_commit_sha: merge,
    labels: [{ name: "autorelease: pending" }],
    base: { repo: { full_name: repository } },
    ...overrides,
  };
}

function options(h: ReturnType<typeof history>, prs: ReturnType<typeof pullRequest>[]) {
  return {
    cwd: h.cwd, repository, version, tag: `v${version}`, commit: h.commit,
    readApi: (endpoint: string) => {
      if (endpoint.includes("/issues?")) {
        // Multiple pages and labels can repeat the same release PR.
        return [[], prs.map(({ number, title }) => ({ number, title, pull_request: {} }))];
      }
      const pr = prs.find((pr) => endpoint.endsWith(`/pulls/${pr.number}`));
      if (!pr) throw new Error(`unexpected API endpoint ${endpoint}`);
      return pr;
    },
  };
}

describe("release PR binding to immutable tag ancestry", () => {
  it.each(["autorelease: pending", "autorelease: tagged"])(
    "resolves the release before a later reviewed fix with %s",
    (label) => {
      const h = history();
      const release = pullRequest(h.release, { labels: [{ name: label }] });
      const fix = pullRequest(h.commit, { number: 22, title: "fix: reviewed follow-up", labels: [] });
      expect(resolveReleasePullRequest(options(h, [fix, release]))).toBe(11);
    }
  );

  it.each([
    ["an unmerged release", (h: ReturnType<typeof history>) => pullRequest(h.release, { merged_at: null })],
    ["a release after the tag", (h: ReturnType<typeof history>) => pullRequest(h.later)],
    ["another title version", (h: ReturnType<typeof history>) => pullRequest(h.release, { title: "chore(master): release 1.2.3-rc.5" })],
    ["an earlier package version", (h: ReturnType<typeof history>) => pullRequest(h.old)],
    ["a mismatching manifest version", (h: ReturnType<typeof history>) => pullRequest(h.inconsistent)],
    ["a stale release label", (h: ReturnType<typeof history>) => pullRequest(h.release, { labels: [] })],
    ["a foreign repository", (h: ReturnType<typeof history>) => pullRequest(h.release, { base: { repo: { full_name: "example/other" } } })],
  ] as const)("rejects %s", (_name, make) => {
    const h = history();
    expect(() => resolveReleasePullRequest(options(h, [make(h)]))).toThrow("found 0");
  });

  it("rejects two matching ancestors instead of choosing the latest label", () => {
    const h = history();
    expect(() => resolveReleasePullRequest(options(h, [pullRequest(h.release), pullRequest(h.commit, { number: 22 })]))).toThrow("found 2");
  });

  it("rejects a supplied commit or version that does not match the immutable tag", () => {
    const h = history();
    expect(() => resolveReleasePullRequest({ ...options(h, [pullRequest(h.release)]), commit: h.release })).toThrow("verified commit");
    h.git("tag", "v1.2.2", h.commit);
    expect(() => resolveReleasePullRequest({ ...options(h, [pullRequest(h.release)]), tag: "v1.2.2", version: "1.2.2" })).toThrow("verified version");
  });

  it("runs the read-only CLI with pagination across both release labels", () => {
    const h = history();
    const bin = join(h.cwd, "bin");
    mkdirSync(bin);
    const fixture = join(h.cwd, "api.json");
    writeFileSync(fixture, JSON.stringify(pullRequest(h.release)));
    const calls = join(h.cwd, "api-calls.jsonl");
    const gh = join(bin, "gh");
    writeFileSync(gh, `#!${process.execPath}\n` + `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.API_CALLS, JSON.stringify(args) + "\\n");
const pr = JSON.parse(fs.readFileSync(process.env.API_FIXTURE, "utf8"));
if (args[0] !== "api" || args.includes("--method")) process.exit(2);
if (args[1].includes("/issues?")) {
  if (!args.includes("--paginate") || !args.includes("--slurp")) process.exit(3);
  console.log(JSON.stringify([[], [{ number: pr.number, title: pr.title, pull_request: {} }]]));
} else if (args[1].endsWith("/pulls/11")) console.log(JSON.stringify(pr));
else process.exit(4);
`);
    chmodSync(gh, 0o755);
    const script = fileURLToPath(new URL("../scripts/resolve-release-pr.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--repository", repository, "--tag", `v${version}`, "--version", version, "--commit", h.commit], {
      cwd: h.cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, API_FIXTURE: fixture, API_CALLS: calls },
    });
    expect({ status: result.status, output: result.stdout.trim(), stderr: result.stderr }).toEqual({ status: 0, output: "11", stderr: "" });
    const endpoints = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)[1]);
    expect(endpoints).toEqual([
      `repos/${repository}/issues?state=closed&labels=autorelease%3A%20pending&per_page=100`,
      `repos/${repository}/issues?state=closed&labels=autorelease%3A%20tagged&per_page=100`,
      `repos/${repository}/pulls/11`,
    ]);
  });
});
