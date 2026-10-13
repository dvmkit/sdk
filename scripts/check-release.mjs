#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

import { SAFE_DATABASE_NAME } from "./safe-database-name.mjs";
import { assertCleanInstallDispatch, dispatchCleanInstall } from "./clean-install-dispatch.mjs";
import { assertReleaseDispatch, dispatchVerification } from "./verify-dispatch.mjs";
import { assertGateJob } from "./workflow-gate.mjs";

const rootArgument = process.argv.indexOf("--root");
const root =
  rootArgument >= 0 ? resolve(process.argv[rootArgument + 1] ?? "") : resolve(import.meta.dirname, "..");

const packageJson = readJson("package.json");
const surface = readJson("api-surface.json");
const manifest = readJson(".release-please-manifest.json");
const releasePleaseConfig = readJson("release-please-config.json");
const verify = readText(".github/workflows/verify.yml");
const releasePlease = readText(".github/workflows/release-please.yml");
const release = readText(".github/workflows/release.yml");
const artifact = readText("scripts/release-artifact.mjs");
const tagger = readText("scripts/release-tag.mjs");
const publisher = readText("scripts/pinned-publish-npm.mjs");
const releasePublisher = readText("scripts/publish-release.mjs");
const consumerInstaller = readText("scripts/install-published-release.mjs");
readText("scripts/resolve-release-pr.mjs");
const signers = readText(".github/release-signers");
const docs = readText("docs/RELEASING.md");
const signing = readText("docs/SIGNING.md");
const nvmrc = readText(".nvmrc").trim();

for (const [name, command] of Object.entries({
  "check:api": "node scripts/check-api-surface.mjs && node scripts/generate-api-reference.mjs --check",
  "check:consumer": "node scripts/consumer-smoke.mjs",
  "install-published-release": "node scripts/install-published-release.mjs",
  "check:package": "node scripts/package-smoke.mjs",
  "check:public-safety": "node scripts/public-safety.mjs",
  "check:release": "node scripts/check-release.mjs",
  "check:toolchain": "node scripts/check-toolchain.mjs",
  "clean-install-smoke": "node scripts/clean-install-smoke.mjs",
  lint: "eslint . --max-warnings 0",
  "release:tag": "node scripts/release-tag.mjs",
  "docs:api": "node scripts/generate-api-reference.mjs --write",
  "test:examples": "node --test examples/quickstart/handler.test.ts examples/authenticated-route/handler.test.ts examples/payments-and-lifecycle/handler.test.ts",
  "typecheck:scripts": "tsc --noEmit --project tsconfig.scripts.json",
  verify: "node scripts/verify.mjs",
})) {
  if (packageJson.scripts?.[name] !== command) fail(`package.json script ${name} must be ${JSON.stringify(command)}`);
}
const publicSafety = readText("scripts/public-safety.mjs");
try {
  assertReleaseDispatch(dispatchVerification);
  assertCleanInstallDispatch(dispatchCleanInstall);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const scriptsTsconfig = readJson("tsconfig.scripts.json");
if (scriptsTsconfig.compilerOptions?.checkJs !== true || scriptsTsconfig.compilerOptions?.strict !== true) {
  fail("tsconfig.scripts.json must type-check scripts/ with checkJs and strict enabled");
}
if (!scriptsTsconfig.include?.includes("scripts/**/*.mjs")) {
  fail("tsconfig.scripts.json must cover every script");
}
if (!readText("eslint.config.js").includes("typescript-eslint")) {
  fail("the lint configuration must parse TypeScript sources");
}
if (!publicSafety.includes('argument === "--pack-only"')) {
  fail("the verify gate must run once in the isolated locked-install tree and preserve its verified dist");
}
if (packageJson.publishConfig?.access !== "public") fail("package.json must publish with public access");
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(nvmrc)) fail(".nvmrc must pin an exact Node release");
const nvmrcMajor = nvmrc.split(".")[0];
if (packageJson.engines?.node !== `>=${nvmrcMajor}`) {
  fail(`package.json engines.node must be ">=${nvmrcMajor}"`);
}

if (manifest["."] !== packageJson.version) fail("release-please manifest version differs from package.json");
if (surface.version !== packageJson.version) {
  fail("api-surface.json version differs from package.json; release-please extra-files must keep them in step");
}
if (surface.package !== packageJson.name) fail("api-surface.json package differs from package.json");

// release-please prepares the version; it never tags, releases, or publishes.
if (releasePleaseConfig["skip-github-release"] !== true) fail("release-please must not create tags or GitHub releases");
if (
  releasePleaseConfig["include-component-in-tag"] !== false ||
  releasePleaseConfig["include-v-in-tag"] !== true ||
  releasePleaseConfig.packages?.["."]?.["release-type"] !== "node"
) {
  fail("release-please must configure the root Node package with unprefixed v tags");
}
if (releasePleaseConfig.prerelease === true || releasePleaseConfig.packages?.["."]?.prerelease === true) {
  // Standing prerelease mode would make every release a candidate. A release candidate is a
  // one-off decision taken with a `Release-As: X.Y.Z-rc.N` footer on the triggering commit.
  fail("release-please must not run in prerelease mode; release candidates come from a Release-As footer");
}
if (
  !releasePleaseConfig.packages?.["."]?.["extra-files"]?.some(
    (/** @type {{ type: string, path: string, jsonpath: string }} */ entry) =>
      entry.type === "json" && entry.path === "api-surface.json" && entry.jsonpath === "$.version"
  )
) {
  fail("release-please must bump api-surface.json alongside package.json");
}
for (const type of ["feat", "fix", "deps", "docs", "ci", "chore"]) {
  const sections = releasePleaseConfig["changelog-sections"];
  if (!sections?.some((/** @type {{ type: string, hidden?: boolean }} */ entry) => entry.type === type && !entry.hidden)) {
    fail(`release notes must surface ${type} commits so builders can read compatibility impact`);
  }
}
if (!/googleapis\/release-please-action@[a-f0-9]{40}\s+# v5\.0\.0/u.test(releasePlease)) {
  fail("release-please action must be pinned to its reviewed v5.0.0 commit");
}
if (!/permissions:\s*\n\s+contents: read/u.test(releasePlease)) {
  fail("release-please must leave the ordinary workflow token read-only");
}
if (!/if: vars\.RELEASE_PLEASE_ENABLED == 'true'/u.test(releasePlease)) {
  fail("release-please must stay disabled until its repository variable is explicitly enabled");
}
if (!/actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1\s+# v3\.2\.0/u.test(releasePlease)) {
  fail("release-please must mint its GitHub App token from the reviewed v3.2.0 action pin");
}
for (const input of [
  "app-id: ${{ vars.RELEASE_PLEASE_APP_ID }}",
  "private-key: ${{ secrets.RELEASE_PLEASE_APP_PRIVATE_KEY }}",
  "owner: ${{ github.repository_owner }}",
  "repositories: ${{ github.event.repository.name }}",
  "permission-contents: write",
  "permission-issues: write",
  "permission-pull-requests: write",
  "token: ${{ steps.app-token.outputs.token }}",
]) {
  if (!releasePlease.includes(input)) fail(`release-please is missing required GitHub App token input: ${input}`);
}
if (/id-token:\s*write/u.test(releasePlease)) fail("release-please must not have OIDC");
if (!/push:\s*\n\s+branches: \[master\]/u.test(releasePlease)) fail("release-please must run only on master pushes");

for (const [name, workflow] of Object.entries({ verify, "release-please": releasePlease, release })) {
  assertValidYaml(workflow, `${name} workflow`);
  assertPinnedActions(workflow, `${name} workflow`);
  assertNoGitHubExpressionInRunBlocks(workflow, `${name} workflow`);
  if (/self-hosted/u.test(workflow)) fail(`${name} workflow must run only on GitHub-hosted runners`);
}
if (/secrets\./u.test(verify)) fail("the verify workflow must not read any secret");
if (!/permissions:\s*\n\s+contents: read/u.test(verify)) fail("the verify workflow token must stay read-only");
if (!/node-version-file: \.nvmrc/u.test(verify) || !/node-version-file: \.nvmrc/u.test(release)) {
  fail("workflows must take their Node release line from .nvmrc");
}
if (!/npm run verify -- --require-database/u.test(verify)) {
  fail("the verify workflow must run the gate in the mode that refuses to skip the database suite");
}
assertFullHistoryWhereScanned(verify, "verify workflow");
assertFullHistoryWhereScanned(release, "release workflow");
try {
  assertGateJob(parse(verify)?.jobs?.verify, "verify workflow job verify");
  assertGateJob(parse(release)?.jobs?.build, "release workflow job build");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
for (const [name, workflow] of Object.entries({ verify, release })) {
  const retention = [...workflow.matchAll(/retention-days: (\d+)/gu)].map(([, days]) => days);
  if (retention.length === 0 || retention.some((days) => days !== "1")) {
    fail(`${name} workflow artifacts must retain for exactly one day`);
  }
  if (!/package-manager-cache: false/u.test(workflow)) {
    fail(`${name} workflow must disable package-manager caches so the gate installs from the lockfile alone`);
  }
  // Every migrated `*.db.test.ts` suite gates on this exact `DATABASE_URL` shape before running any
  // destructive statement (e.g. src/sdk/server/__tests__/credit-ledger.db.test.ts) — a Postgres
  // service that merely exists is not enough, or `--require-database` reports success while every
  // migrated suite silently skips.
  if (!/image: postgres:/u.test(workflow) || !/DATABASE_URL: postgres/u.test(workflow)) {
    fail(`the ${name} workflow must supply a Postgres service container for the database suite`);
  }
  const databaseUrl = /DATABASE_URL: (\S+)/u.exec(workflow)?.[1];
  if (!databaseUrl || !SAFE_DATABASE_NAME.test(databaseUrl)) {
    fail(`the ${name} workflow's DATABASE_URL must satisfy the database suite's safe-name guard, got ${databaseUrl ?? "none"}`);
  }
}

if (
  !/tags: \["v\*"\]/u.test(release) ||
  !/workflow_dispatch:/u.test(release) ||
  !/github_release_recovery:/u.test(release)
) {
  fail("release workflow must accept tags and a manual GitHub-release recovery");
}
if (!/release tag must be vX\.Y\.Z or vX\.Y\.Z-rc\.N/u.test(release)) {
  fail("release workflow must reject non-stable and non-RC tags");
}
if (!/git verify-tag "\$release_tag"/u.test(release) || !/release-signers/u.test(release)) {
  fail("release workflow must verify the signed tag against committed signers");
}
if (!/npm run verify -- --require-database/u.test(release)) {
  fail("the release build must run the same full gate as the verify workflow");
}
if (
  !/node scripts\/release-artifact\.mjs create/u.test(release) ||
  !/node scripts\/release-artifact\.mjs verify/u.test(release)
) {
  fail("release artifact must be bound and reverified before publication");
}
if (/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM|npm login|npm token/u.test(release)) {
  fail("release workflow must not use npm tokens or interactive npm authentication");
}
if (/--provenance/u.test(release)) {
  fail("release workflow must not claim source provenance while the repository is private");
}

const prepare = jobBlock(release, "prepare", "build");
const build = jobBlock(release, "build", "publish");
const publish = jobBlock(release, "publish", "github-release");
const githubRelease = jobBlock(release, "github-release", undefined);
const validation = prepare.indexOf('if [[ ! "$release_tag"');
const releaseRef = prepare.indexOf('git show-ref --verify --quiet "refs/tags/$release_tag"');
const output = prepare.indexOf('"$GITHUB_OUTPUT"');
if (
  !/EVENT_NAME: \$\{\{ github\.event_name \}\}/u.test(prepare) ||
  !/INPUT_TAG: \$\{\{ inputs\.tag \}\}/u.test(prepare) ||
  !/REF_NAME: \$\{\{ github\.ref_name \}\}/u.test(prepare) ||
  !/fetch-depth: 0/u.test(prepare) ||
  validation < 0 ||
  releaseRef < validation ||
  output < releaseRef
) {
  fail("release tag input must arrive through environment variables and be validated before use");
}
if (/id-token:\s*write/u.test(build)) fail("build job must not receive OIDC");
if (!/echo "commit=\$release_commit" >> "\$GITHUB_OUTPUT"/u.test(prepare)) {
  fail("prepare must publish the commit the verified tag resolved to");
}
for (const [name, job] of Object.entries({ build, publish })) {
  if (!/ref: \$\{\{ needs\.prepare\.outputs\.commit \}\}/u.test(job)) {
    // Checking out the tag name would re-resolve it: a tag moved mid-run could swap the code that
    // gets built or published while the OIDC credential is live.
    fail(`${name} job must check out the commit prepare verified, not the tag name`);
  }
  if (/ref: \$\{\{ needs\.prepare\.outputs\.tag \}\}/u.test(job)) {
    fail(`${name} job must not check out a movable tag reference`);
  }
}
if (!/npm pack --ignore-scripts --json --pack-destination "\$first"/u.test(build) || !/"\$second"/u.test(build)) {
  fail("build job must pack twice and bind both copies");
}
if (!/permissions:\s*\n\s+contents: read\s*\n\s+id-token: write/u.test(publish)) {
  fail("publish job must have only read contents plus OIDC");
}
if (!/timeout-minutes: 75/u.test(publish)) fail("publish job must allow both bounded 30-minute registry windows plus setup");
if (!/environment: npm-release/u.test(publish)) fail("publish job must require the npm-release environment");
if (!/if: github\.event_name == 'push'/u.test(publish)) fail("manual dispatch must never publish");
if (!/scripts\/publish-release\.mjs --archive "\$archive" --dist-tag "\$DIST_TAG"/u.test(publish)) {
  fail("publish job must use exact npm publication recovery");
}
for (const entry of ["@dvmkit/sdk\"", "@dvmkit/sdk/internal", "@dvmkit/sdk/server", "@dvmkit/sdk/testing"]) {
  if (!publish.includes(entry)) fail(`publish job must import ${entry} from the published package`);
}
if (
  !githubRelease.includes("needs: [prepare, build, publish]") ||
  !githubRelease.includes("github.event_name == 'push' && needs.publish.result == 'success'") ||
  !githubRelease.includes("github.event_name == 'workflow_dispatch' && inputs.github_release_recovery == true") ||
  !githubRelease.includes("needs.prepare.result == 'success'") ||
  !githubRelease.includes("needs.build.result == 'success'")
) {
  fail("GitHub release recovery must require the exact tag build, and tag pushes must require publication");
}
if (
  !/gh release create "\$TAG" --verify-tag --generate-notes "\$\{prerelease_flag\[@\]\}"/u.test(githubRelease) ||
  !/prerelease_flag=\(\)\s*\n\s*expected_prerelease=false\s*\n\s*if \[\[ "\$TAG" == \*-rc\.\* \]\]; then\s*\n\s*prerelease_flag=\(--prerelease\)\s*\n\s*expected_prerelease=true\s*\n\s*fi/u.test(
    githubRelease
  ) ||
  !/--json isPrerelease/u.test(githubRelease)
) {
  fail("GitHub release must mark release candidates as prereleases and reuse the existing tag");
}
const taggedLabel = githubRelease.indexOf("labels[]=autorelease: tagged");
const pendingLabel = githubRelease.indexOf("labels/autorelease%3A%20pending");
if (
  githubRelease.split("GH_REPO: ${{ github.repository }}").length - 1 !== 2 ||
  !githubRelease.includes('node scripts/resolve-release-pr.mjs --repository "$REPOSITORY" --tag "$TAG" --version "$VERSION" --commit "$COMMIT"') ||
  githubRelease.includes("repos/$REPOSITORY/commits/$TAG/pulls") ||
  !githubRelease.includes("fetch-depth: 0") ||
  !githubRelease.includes("ref: ${{ github.sha }}") ||
  !githubRelease.includes("VERSION: ${{ needs.prepare.outputs.version }}") ||
  !githubRelease.includes("COMMIT: ${{ needs.prepare.outputs.commit }}") ||
  taggedLabel < 0 ||
  pendingLabel < taggedLabel ||
  !githubRelease.includes('index("autorelease: tagged")') ||
  !githubRelease.includes('index("autorelease: pending")')
) {
  fail("GitHub release must transition the matching release pull request from pending to tagged");
}
if (
  /id-token:\s*write/u.test(githubRelease) ||
  !/permissions:\s*\n\s+contents: write\s*\n\s+issues: write\s*\n\s+pull-requests: write/u.test(githubRelease)
) {
  fail("GitHub release job must have write contents, issues, and pull requests without OIDC");
}

if (
  !tagger.includes("assertCleanWorktree") ||
  !tagger.includes("assertDefaultBranchTip") ||
  !tagger.includes("assertTagAbsent") ||
  !tagger.includes("assertSigningCapability")
) {
  fail("release tag command must fail closed on every local release precondition");
}
if (!tagger.includes('"ls-remote", "--symref", "--exit-code", "origin", "HEAD"')) {
  fail("release tag command must resolve the remote default branch without trusting cached tracking refs");
}
if (
  !tagger.includes("release tag dry run passed") ||
  !tagger.includes("signedTag(root") ||
  !tagger.includes("verifyTag(root")
) {
  fail("release tag command must prove signing in dry run and create verified signed tags");
}
if (
  !tagger.includes('"gpg.format=ssh"') ||
  !tagger.includes("gpg.ssh.allowedSignersFile=${signerAllowList}") ||
  tagger.includes('copyGitConfig(scratch, "gpg.format")') ||
  tagger.includes('copyGitConfig(scratch, "gpg.ssh.allowedSignersFile")')
) {
  fail("release tag command must force SSH signing and verify against committed release signers");
}
if (
  !artifact.includes("the two package archives have different SHA-256 digests") ||
  !artifact.includes("release tarball does not match its digest manifest") ||
  !artifact.includes('archive package name is not @dvmkit/sdk')
) {
  fail("artifact contract must bind both package copies, downloaded bytes, and this package name");
}
if (!publisher.includes('const npmVersion = "11.16.0"') || !publisher.includes("npmIntegrity")) {
  fail("trusted-publishing npm bootstrap must pin and integrity-check npm 11.16.0");
}
if (
  !releasePublisher.includes('const defaultRegistry = "https://registry.npmjs.org"') ||
  !releasePublisher.includes('const expectedPackageName = "@dvmkit/sdk"') ||
  !releasePublisher.includes('metadata?.["dist-tags"]?.[expected.distTag]') ||
  !releasePublisher.includes("sha256(remoteBytes) === expected.sha256") ||
  !releasePublisher.includes('"pinned-publish-npm.mjs"')
) {
  fail("npm publication recovery must bind the exact registry bytes and dist-tag before accepting a version");
}
if (
  !releasePublisher.includes("const defaultTimeoutMs = 30 * 60_000") ||
  !releasePublisher.includes('tarballResponse.status === 404') ||
  !releasePublisher.includes('initial === "missing" && !check')
) {
  fail("npm publication recovery must allow a bounded 30-minute visibility window");
}
if (
  !consumerInstaller.includes('const expectedPackageName = "@dvmkit/sdk"') ||
  !consumerInstaller.includes('const defaultTimeoutMs = 30 * 60_000') ||
  !consumerInstaller.includes('"--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online"') ||
  !consumerInstaller.includes("No matching version found for") ||
  !consumerInstaller.includes("https://registry.npmjs.org/") ||
  !consumerInstaller.includes('code !== "E404" && code !== "ETARGET"')
) {
  fail("published consumer install must retry only exact SDK propagation errors with its original safety flags");
}
if (!/npm run install-published-release -- --version "\$VERSION" --prefix "\$consumer"/u.test(publish)) {
  fail("publish job must retry the exact published SDK install through the release consumer helper");
}
const expectedSigner = {
  principal: "265668992+aioli3@users.noreply.github.com",
  key: "AAAAC3NzaC1lZDI1NTE5AAAAIIOAABfWAkQaX/F7qoDtDVT1APZho1qYllrCaXQOCWXR",
};
const signerLines = signers.split("\n").filter((line) => line.trim() !== "");
if (signerLines.length !== 1) {
  // Any extra line is another key that can sign a tag the release workflow will accept, so the
  // allow-list is pinned by count as well as by content.
  fail(`release signer allow-list must hold exactly one identity; found ${signerLines.length} lines`);
}
const signerLine = /^(\S+)\s+namespaces="git"\s+ssh-ed25519\s+(\S+)$/u.exec(signerLines[0]);
if (!signerLine) fail("release signer allow-list must contain one SSH git signing identity");
if (signerLine[1] !== expectedSigner.principal || signerLine[2] !== expectedSigner.key) {
  fail("release signer allow-list does not hold the reviewed maintainer identity and key");
}

for (const claim of [
  "npm trusted publishing supports publicly verifiable source provenance for releases from this public repository.",
  "Verify that the published version has a provenance attestation before claiming it; releases made while the repository was private do not establish public source provenance.",
  "tag-without-npm recovery",
  "github_release_recovery",
  "Never move, replace, or unpublish a release version.",
  "Breaking API changes",
  "Migrations",
  "Compatibility requirements",
  "dvmctl and platform prerequisites",
]) {
  if (!docs.includes(claim)) fail(`docs/RELEASING.md must document: ${claim}`);
}
if (!signing.includes("SHA256:") || !signing.includes(signerLine[1]) || !signing.includes(signerLine[2])) {
  fail("docs/SIGNING.md must record the maintainer identity, fingerprint, and public key in the signer allow-list");
}

console.log("release contract ok");

/** @param {string} path @returns {string} */
function readText(path) {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    fail(`required release file is missing: ${path}`);
  }
}

/** @param {string} path @returns {any} */
function readJson(path) {
  try {
    return JSON.parse(readText(path));
  } catch {
    fail(`invalid JSON: ${path}`);
  }
}

/**
 * Any job that runs the gate also runs the public-safety commit scan, which reads real history. At
 * checkout's default depth of one it would see a single commit — on a pull request, GitHub's
 * synthetic merge commit, whose identity and message always pass — so the scan would be structurally
 * incapable of failing while the documentation claims CI reads commit metadata.
 * @param {string} workflow @param {string} name
 */
function assertFullHistoryWhereScanned(workflow, name) {
  const document = parse(workflow);
  for (const [jobName, job] of Object.entries(document?.jobs ?? {})) {
    /** @type {{ run?: string, uses?: string, with?: Record<string, unknown> }[]} */
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    if (!steps.some((step) => typeof step?.run === "string" && step.run.includes("npm run verify"))) {
      continue;
    }
    const checkout = steps.find(
      (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@")
    );
    if (!checkout) fail(`${name} job ${jobName} runs the gate without checking the repository out`);
    if (checkout.with?.["fetch-depth"] !== 0) {
      fail(`${name} job ${jobName} runs the public-safety scan and must check out full history with fetch-depth: 0`);
    }
  }
}

/** @param {string} workflow @param {string} name */
function assertValidYaml(workflow, name) {
  try {
    parse(workflow);
  } catch (error) {
    fail(`${name} must be valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {string} workflow @param {string} name */
function assertPinnedActions(workflow, name) {
  const uses = [...workflow.matchAll(/^\s+uses: (.+)$/gmu)];
  if (uses.length === 0) fail(`${name} must use pinned actions`);
  for (const [, reference] of uses) {
    // The SHA says what runs; the trailing comment says which reviewed release that SHA is. Without
    // it a bump cannot be read, so the comment is part of the pin.
    const pinned = /^([^\s@]+)@([a-f0-9]{40}) # v[0-9]+\.[0-9]+\.[0-9]+$/u.exec(String(reference).trim());
    if (!pinned) {
      fail(`${name} action ${reference} must be pinned as <action>@<40-character SHA> # v<version>`);
    }
  }
}

/** @param {string} workflow @param {string} name */
function assertNoGitHubExpressionInRunBlocks(workflow, name) {
  const pending = [parse(workflow)];
  const seen = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value.run === "string" && value.run.includes("${{")) {
      fail(`${name} must not interpolate GitHub expressions directly into shell`);
    }
    pending.push(...Object.values(value));
  }
}

/** @param {string} workflow @param {string} job @param {string | undefined} nextJob @returns {string} */
function jobBlock(workflow, job, nextJob) {
  const start = workflow.indexOf(`  ${job}:\n`);
  if (start < 0) fail(`release workflow is missing ${job} job`);
  const end = nextJob ? workflow.indexOf(`  ${nextJob}:\n`, start + 1) : workflow.length;
  if (end < 0) fail(`release workflow is missing ${nextJob} job`);
  return workflow.slice(start, end);
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`release check: ${message}`);
  process.exit(1);
}
