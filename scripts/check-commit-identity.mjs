#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const approvedEmails = new Set([
  "265668992+aioli3@users.noreply.github.com",
  "noreply@github.com",
  "41898282+github-actions[bot]@users.noreply.github.com",
  "319907686+dvmkit-release-automation[bot]@users.noreply.github.com",
  "49699333+dependabot[bot]@users.noreply.github.com",
  "29139614+renovate[bot]@users.noreply.github.com",
  "github-actions[bot]@users.noreply.github.com",
  "dependabot[bot]@users.noreply.github.com",
  "release-please[bot]@users.noreply.github.com",
]);

/** Only explicitly approved identities may enter the public history. @param {string} email */
export function isApprovedCommitEmail(email) {
  return approvedEmails.has(email);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [base, head, ...extra] = process.argv.slice(2);
    if (extra.length || !base || !head || !/^[a-f0-9]{40}$/u.test(base) || !/^[a-f0-9]{40}$/u.test(head)) {
      throw new Error("expected full base and head commit hashes");
    }
    const git = (/** @type {string[]} */ args) => execFileSync("git", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    }).trim();
    if (git(["rev-parse", "--is-shallow-repository"]) !== "false") {
      throw new Error("complete history is required");
    }
    git(["merge-base", base, head]);
    const commits = git(["rev-list", `${base}..${head}`]).split("\n").filter(Boolean);
    if (!commits.length) throw new Error("commit range is empty");
    let rejected = 0;
    for (const commit of commits) {
      const [author, committer] = git(["show", "-s", "--format=%ae%x00%ce", commit]).split("\0");
      for (const [role, email] of [["author", author], ["committer", committer]]) {
        if (!email || !isApprovedCommitEmail(email)) {
          // Never disclose the rejected address in public workflow logs.
          console.error(`commit identity: unapproved ${role} on ${commit}`);
          rejected += 1;
        }
      }
    }
    if (rejected) process.exitCode = 1;
    else console.log(`commit identity ok: ${commits.length} commits`);
  } catch {
    console.error("commit identity: could not validate the complete commit range");
    process.exitCode = 1;
  }
}
