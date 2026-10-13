#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const releaseVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/u;
const releaseTitle = /^chore(?:\([^()\n]+\))?: release v?([0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?)$/u;
const releaseLabels = ["autorelease: pending", "autorelease: tagged"];

/**
 * @typedef {{ number: number, title: string, pull_request?: unknown }} Issue
 * @typedef {{ number: number, title: string, merged_at: string | null, merge_commit_sha: string | null, labels: { name: string }[], base: { repo: { full_name: string } } }} PullRequest
 */

/**
 * The release PR may precede reviewed fixes included in the immutable tag.
 * @param {{ repository: string, tag: string, version: string, commit: string, cwd?: string, readApi?: (endpoint: string, paginate?: boolean) => unknown }} options
 * @returns {number}
 */
export function resolveReleasePullRequest({ repository, tag, version, commit, cwd = process.cwd(), readApi = githubApi }) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !releaseVersion.test(version) || tag !== `v${version}` || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error("expected a repository and the exact verified release tag, version, and commit");
  }
  /** @param {string[]} args */
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["rev-parse", `refs/tags/${tag}^{commit}`]) !== commit) {
    throw new Error("release tag differs from the verified commit");
  }
  if (JSON.parse(git(["show", `${commit}:package.json`])).version !== version) {
    throw new Error("release tag package version differs from the verified version");
  }

  const numbers = new Set();
  for (const label of releaseLabels) {
    const pages = readApi(`repos/${repository}/issues?state=closed&labels=${encodeURIComponent(label)}&per_page=100`, true);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("release candidate pagination is malformed");
    for (const issue of /** @type {Issue[]} */ (pages.flat())) {
      if (issue.pull_request && releaseTitle.exec(issue.title)?.[1] === version) {
        if (!Number.isSafeInteger(issue.number) || issue.number <= 0) throw new Error("release candidate number is malformed");
        numbers.add(issue.number);
      }
    }
  }

  const matches = [];
  for (const number of numbers) {
    const pr = /** @type {PullRequest} */ (readApi(`repos/${repository}/pulls/${number}`));
    if (
      pr.number !== number || !pr.merged_at || releaseTitle.exec(pr.title)?.[1] !== version ||
      pr.base?.repo?.full_name !== repository || !pr.labels?.some((label) => releaseLabels.includes(label.name)) ||
      typeof pr.merge_commit_sha !== "string" || !/^[a-f0-9]{40}$/u.test(pr.merge_commit_sha)
    ) continue;
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", pr.merge_commit_sha, commit], { cwd, encoding: "utf8" });
    if (ancestry.error) throw ancestry.error;
    if (ancestry.status === 1) continue;
    if (ancestry.status !== 0) throw new Error("could not verify release pull request ancestry");
    const packageVersion = JSON.parse(git(["show", `${pr.merge_commit_sha}:package.json`])).version;
    const manifestVersion = JSON.parse(git(["show", `${pr.merge_commit_sha}:.release-please-manifest.json`]))["."];
    if (packageVersion === version && manifestVersion === version) matches.push(number);
  }
  if (matches.length !== 1) throw new Error(`expected exactly one merged release pull request for ${version} in the verified tag ancestry; found ${matches.length}`);
  return matches[0];
}

/** @param {string} endpoint @param {boolean} [paginate] @returns {unknown} */
function githubApi(endpoint, paginate = false) {
  return JSON.parse(execFileSync("gh", ["api", endpoint, ...(paginate ? ["--paginate", "--slurp"] : [])], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    /** @type {Record<string, string>} */
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i]?.replace(/^--/u, "");
      const value = args[i + 1];
      if (!name || !["repository", "tag", "version", "commit"].includes(name) || !value || value.startsWith("--") || options[name]) {
        throw new Error("use --repository owner/repo --tag vX.Y.Z --version X.Y.Z --commit verified-sha");
      }
      options[name] = value;
    }
    const { repository, tag, version, commit } = options;
    process.stdout.write(`${resolveReleasePullRequest({ repository, tag, version, commit })}\n`);
  } catch (error) {
    console.error(`release pull request: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
