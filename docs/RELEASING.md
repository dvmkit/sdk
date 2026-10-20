# Releasing `@dvmkit/sdk`

Every published version comes from one immutable signed `vX.Y.Z` tag, built and published by GitHub-hosted runners with no npm token anywhere in the pipeline. Nothing else publishes this package.

## The gate

`npm run verify` is the whole gate, and it is the same command locally and in CI. It checks the toolchain and the repository's files, history and pull-request input in the real checkout, then copies only tracked and unignored source into an isolated directory and installs from the lockfile. That clean source tree runs lint, build, typecheck, a second typecheck of `scripts/` under `tsconfig.scripts.json`, unit tests, server tests that open local ports, runnable public examples, database tests, the public API surface and generated reference diff, package shape and two identical packs, a clean consumer install of the packed tarball that runs those examples again, packed-artifact safety, and this release-contract check. Only after the complete gate passes does it copy the verified `dist` back to the checkout, where the release job packs it without rebuilding.

The split keeps each old guarantee without running the build, typecheck, unit suite or API check twice:

| Guarantee | Retained check |
| --- | --- |
| Missing or ignored source/build input | The isolated copy excludes ignored `dist` and `node_modules`; its locked install owns the only build, typecheck, unit and API pass, then returns that verified build output for release packaging. |
| Missing packaged dependency or entry point | Package shape and the exact packed-tarball consumer install run after the clean build. |
| API baseline or generated reference mismatch | `check:api` reads declarations produced by the clean build. |
| Unsafe repository metadata or source | The checkout scan retains Git history, unignored files and CI pull-request input. |
| Unsafe published bytes | The pack-only scan inspects the clean-built tarball. |
| Missing database coverage | The clean source gate reports an unset `DATABASE_URL` as skipped, and `--require-database` fails before isolation starts. In that mode an unreachable local Cashu mint fails the mint-dependent suites instead of skipping them. |

The whole gate takes about 82 seconds on Node 22.23.2 without the database suite; that suite is skipped, not passed.

`scripts/` gets its own typecheck because the package `tsconfig.json` covers only `src` and `test`, which would leave the release scripts — the code that mints tags, binds artifacts and drives publication — checked by nothing but lint. `tsconfig.scripts.json` runs `checkJs` over them under `strict`, so a mistyped property or a wrong argument count fails the gate rather than a release.

The public-safety checks read what Git would carry into a public repository — tracked and unignored files, commit metadata and a pull request body on CI — before inspecting the packed tarball produced in the clean source tree. They reject issue keys, tracker links, absolute private paths, non-public hostnames, first-party repository locators outside the published set, unexpected commit identities, and credential material including npm, GitHub, Stripe and AWS keys, private key blocks, Nostr private keys, and wallet connection strings carrying a spending secret. Every job that runs the gate checks out full history, so the commit scan covers every branch the remote carries rather than the tip alone; when this repository goes public those branches go with it.

The database suite is skipped when `DATABASE_URL` is unset, and the summary says so — a skipped suite verified nothing, so never report it as green. Pass `npm run verify -- --require-database` to make a missing `DATABASE_URL` a failure; both CI workflows do. That mode also requires the FakeWallet test mint on `localhost:3338` that the Cashu integration suites pay against; `node scripts/start-cashu-mint.mjs` starts it with the same command both workflows use, and `docker rm --force sdk-cashu-mint` removes it.

Locally, point it at a throwaway Postgres whose database is named `dvmkit_test` (or `dvmkit_test_` followed by 8 lowercase hex characters) — every migrated database suite refuses to run against any other name. Within that database the suite creates and drops its own randomly named schema, so it is safe to run against a `dvmkit_test` database that already holds other things:

```sh
nvm install        # installs and uses the exact release in .nvmrc
npm ci
node scripts/start-cashu-mint.mjs
DATABASE_URL=postgresql://user:password@localhost:5432/dvmkit_test npm run verify -- --require-database
```

`.nvmrc` pins an exact Node release rather than a major, so rebuilding an old tag months later resolves the same toolchain and reproduces the same tarball. `npm run check:toolchain` refuses any other Node, and refuses an npm outside the major that ships with it, because the lockfile is maintained with that npm.

## Runner image

All workflows select `ubuntu-26.04` explicitly. This keeps verification and release jobs on the same supported image instead of changing their operating system when GitHub moves `ubuntu-latest`. GitHub's [Ubuntu 26.04 migration notice](https://github.com/actions/runner-images/issues/14748) describes the transition and the `ubuntu-24.04` fallback if an incompatibility requires it.

Node still comes from `.nvmrc`, including tag verification and release bookkeeping. The gate uses its bundled npm 10; publication uses the integrity-checked npm 11.16.0 bootstrap. The publishing toolchain satisfies the [npm trusted-publishing requirements](https://docs.npmjs.com/trusted-publishers/) of Node 22.14.0 or newer and npm 11.5.1 or newer. Only the publish job receives `id-token: write` and uses the `npm-release` environment.

## Preparing a version

Release-please turns merged Conventional Commits into a version and changelog pull request. It does not create a tag, a GitHub release, or an npm publication, and it stays switched off until the repository variable `RELEASE_PLEASE_ENABLED` is exactly `true`.

Before 1.0, breaking changes advance the minor version on the 0.x line through the root package's `bump-minor-pre-major` setting. Ordinary Conventional Commit version calculation still applies. An eventual 1.0 release requires a separate explicit release decision. This version policy preserves the breaking-change disclosures, API review, and migration requirements below.

The version is a decision made on that pull request, not a constant in this repository. To pin an exact version for one release — a specific release candidate, for instance — put a one-shot `Release-As: X.Y.Z-rc.N` footer on the triggering Conventional Commit. Release-please applies that footer to the next release pull request only; the checked-in configuration stays on ordinary Conventional Commit versioning and never enters prerelease mode on its own. `-rc.N` is the only prerelease shape the tag and dist-tag rules below accept, so a release candidate is always a deliberate, one-off `Release-As` decision rather than a standing configuration.

To graduate a tested release candidate to stable, use `Release-As: X.Y.Z` on a new Conventional Commit. Preserve that footer in the final squash commit, or put the complete Conventional Commit between `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE` lines in the triggering pull request description. The signed stable tag publishes the stable version to `latest`; do not repoint `latest` at a prerelease version.

For the version in this checkout, read `package.json` with `npm pkg get version`; the release tag command also requires `.release-please-manifest.json` to agree. To inspect npm publication state, use `npm view @dvmkit/sdk versions --json` for published versions and `npm view @dvmkit/sdk dist-tags --json` for the versions selected by `latest` and `next`.

### First release on fresh history

Seed the repository with one reviewed, signed snapshot whose `package.json`, root lockfile metadata, `api-surface.json`, and release-please manifest all say `0.8.0`. Build, verify and qualify its exact packed archive before publication. Leave the first `0.8.0` changelog entry to the genuine release-please pull request.

After the fresh signed seed exists, set `bootstrap-sha` in `release-please-config.json` to that seed's actual commit SHA. Land this truthful bootstrap configuration through review, preserving a one-shot version footer on its Conventional Commit:

```text
chore: configure first release

Release-As: 0.8.0
```

The pinned release-please implementation accepts this explicit version even when the seed manifest already records `0.8.0`. Use the commit footer rather than a persistent `release-as` configuration property. Enable the configured release App and let it open the genuine release pull request; do not fabricate a release pull request or tag. Review substantive builder-facing notes under the headings below, and require the existing checks and `autorelease: pending` label before merging. Keep the merged-release-PR resolver and label transitions unchanged.

Before the signed-tag pipeline publishes, compare its actual packed tarball byte for byte with the qualified archive. Changelog and bootstrap configuration are not packaged, but that alone does not prove equality. Any byte change stops publication until the new archive is reviewed and consumers qualify against it again.

### Builder-facing release notes

The generated changelog is the starting point, not the release note. Before merging a release pull request, edit its body so a builder upgrading this SDK can decide whether to take the version without reading the diff. Four headings, each either filled in or explicitly marked "none":

- **Breaking API changes** — every public name added, renamed, or removed. `npm run check:api` is the source of truth: it fails on any change to the declaration-level names it pins or the generated `docs/API.md`, and the accompanying `api-surface.json` update is the exact list. A removal or a changed signature also needs a `!` marker or a `BREAKING CHANGE:` footer on its commit, so release-please files it under breaking changes.
- **Migrations** — anything an existing DVM must change to keep working: renamed configuration keys, moved exports, database schema the SDK creates on `init()`, on-disk or wire formats.
- **Compatibility requirements** — the minimum Node release (`engines.node`), and any dependency floor a builder will feel, such as a `pg` or `viem` major.
- **dvmctl and platform prerequisites** — the minimum `dvmctl` version that can build and deploy a DVM against this SDK, and any platform-side capability the version depends on. Say "none" when a version needs neither; silence reads as "unknown".

The fourth entry point, `@dvmkit/sdk/internal`, is outside all four headings. It exists so the dvmkit platform can run on this source rather than a fork of it, and it has no stability promise: a name under it may change or disappear in any release, including a patch, without a `!` marker or a `BREAKING CHANGE:` footer, and without a line in the release notes. `npm run check:api` still pins its names, so the change is visible in review, but the pin records movement rather than forbidding it. Promoting a name out of `./internal` into `.`, `./server` or `./testing` is the opposite: a deliberate `feat` that adds a public name, belongs under **Breaking API changes** with the rest of the surface change, and from then on the name is covered by every promise above.

## Cutting the release

After the release pull request is merged, a maintainer creates the one immutable signed tag from the default-branch tip:

```sh
npm run release:tag -- --tag v1.2.3 --dry-run
npm run release:tag -- --tag v1.2.3
git push origin v1.2.3
```

The local command fails unless the worktree is clean, `HEAD` equals the current `origin` default-branch tip, the release-please manifest and package versions agree, the exact stable or release-candidate tag is absent both locally and on `origin`, and Git can create and verify an annotated SSH signature. The dry run performs the same checks, including an isolated signing probe in a scratch clone, without adding a tag to this repository. [`SIGNING.md`](./SIGNING.md) records the signing identity that the pipeline accepts.

Only `vX.Y.Z` publishes with npm dist-tag `latest`. Only `vX.Y.Z-rc.N` publishes with npm dist-tag `next`. Nothing else is a releasable version, and the tag, the packed manifest version, and the dist-tag are checked against each other in three separate places.

## What the pipeline does

A pushed tag runs `Release package` on GitHub-hosted runners.

`prepare` re-fetches the tag, rejects any tag that is not `vX.Y.Z` or `vX.Y.Z-rc.N`, verifies its SSH signature against the committed `.github/release-signers` allow-list, checks out that exact commit, and refuses to continue unless the tag and `package.json` version are identical. It derives the dist-tag from the version shape.

`build` installs from the committed lockfile, starts the test mint, runs the full gate against a Postgres service container, packs the package twice, fails if the two tarballs differ by SHA-256 digest or file list, and uploads exactly one tarball plus a digest manifest binding it to the tag, version, and dist-tag. That artifact is retained for one day. The job is bounded at 30 minutes, Verify's limit, against a passing run of about eight; a failed, timed-out or cancelled gate still uploads its complete log and mint log as a separate one-day artifact, and packing never runs after a failed gate. This job has no OIDC and no secrets.

`publish` is the only job with OIDC and the only one bound to the protected `npm-release` environment. It downloads the artifact, re-verifies the tarball against its digest manifest, publishes that exact tarball through npm trusted publishing, then installs the published version into a clean consumer directory and imports `@dvmkit/sdk`, `@dvmkit/sdk/internal`, `@dvmkit/sdk/server` and `@dvmkit/sdk/testing` from the registry copy. It never runs on a manual dispatch.

Both packed-consumer verification and published-package acceptance run the same payment-diagnostic probe through the installed package. It uses valid synthetic Cashu proofs against a loopback mint, real mppx challenge validation with synthetic broadcast outcomes, and a loopback x402 facilitator. The probe verifies retained categories, excluded provider/error text, generic credential responses, and accepted Cashu payments whose unavailable denomination skips credit. It checks the installed lockfile integrity against the exact archive and records its package version, SHA-256, SHA-512 integrity, and exercised case counts. No live payments or external payment credentials are used; synthetic persistence is not database-path evidence.

`github-release` creates or verifies the GitHub release for the existing tag, marking release candidates as prereleases, and flips the merged release pull request from `autorelease: pending` to `autorelease: tagged`. Without that transition release-please treats the merged pull request as untagged and refuses to prepare the next version.

Manual dispatch accepts an existing signed tag and runs the no-publish build path. Its separate `no-publish` job downloads the uploaded package, verifies its tag, version, dist-tag, file list, and digest, and runs the pinned publishing npm bootstrap with `--version`. This exercises the artifact handoff and tar extraction without publishing or requesting an OIDC token. It does not prove npm authorization or a registry publication. Setting `github_release_recovery` to true also runs the release-notes and label step, but only after that exact tag verifies and builds successfully. It cannot publish and it cannot create a tag, so a release candidate still requires a reviewed and signed `vX.Y.Z-rc.N` tag.

npm trusted publishing supports publicly verifiable source provenance for releases from this public repository. Verify that the published version has a provenance attestation before claiming it; releases made while the repository was private do not establish public source provenance.

## External setup before the first release

None of this can be configured from a pull request; it is operator work in the npm and GitHub interfaces.

Configure the npm trusted publisher for `@dvmkit/sdk` with GitHub organization `dvmkit`, repository `sdk`, workflow filename `release.yml`, environment `npm-release`, and allowed action `npm publish` only. Configure the `npm-release` GitHub environment for selected branches and tags with a tag rule of `v*`. Release authorization comes from the reviewed release pull request and signed tag. Configure one tag ruleset that lets only the release maintainer create `v*` tags and a second ruleset that lets nobody update or delete them. The workflow independently verifies the annotated SSH tag signature against the committed signer allow-list. No npm token belongs in GitHub secrets or in any workflow here.

Release-please stays disabled until the repository variable `RELEASE_PLEASE_ENABLED` is exactly `true`. Before enabling it, create the repository labels `autorelease: pending` and `autorelease: tagged`, then create a GitHub App installed only on this repository with repository permissions `contents: write`, `issues: write`, and `pull requests: write` and no unrelated permissions. Create an App private key and store its complete PEM value in the repository secret `RELEASE_PLEASE_APP_PRIVATE_KEY`. Store the numeric App ID, not the client ID, in the repository variable `RELEASE_PLEASE_APP_ID`. Keep `RELEASE_PLEASE_ENABLED` unset or false until the App installation and both values exist. The workflow mints a short-lived installation token narrowed to this repository and those three permissions and passes it straight to release-please, which is what lets release pull request CI run without a personal access token or a second human re-triggering it.

The npm interface may require an existing package before it permits trusted-publisher configuration. Do not bootstrap or publish `@dvmkit/sdk` through another path to work around that limitation without a separate explicit operator decision. A one-time bootstrap must still bind the reviewed tarball bytes, use a non-default dist-tag, and leave the normal signed-tag trusted-publishing path unchanged for every subsequent version.

## Recovery

Never move, replace, or unpublish a release version. If the build or the pre-publish checks fail, fix only release infrastructure and rerun the same immutable tag once the correction is reviewed. A candidate may instead be withdrawn only under the conditions below.

### Withdraw a never-published candidate

Withdrawal is available only when terminal workflow evidence proves that the publish job never started and the exact candidate version is absent from the npm registry. Evidence collected before a publication run reaches its terminal state does not count. Missing registry visibility alone does not prove that no upload happened. An unknown upload outcome, pending registry processing, or an existing version requires the read-only publication recovery below rather than withdrawal.

1. Cancel or reject any waiting publication run or deployment for the candidate first.
2. Wait for every publication run for that candidate to reach a terminal completed/cancelled state. Confirm that the publish job never started and no deployments are pending.
3. Only then confirm that the exact candidate version is absent from the npm registry.
4. Preserve its immutable signed tag and source history. Retain an explicit withdrawn/unpublished record in the changelog and merged release pull request, including its feature, breaking-change, and migration information.
5. After the corrective source change is reviewed and merged, remove only the stale `autorelease: pending` label from that candidate's merged release pull request. Do not add `autorelease: tagged`, create a GitHub release, dispatch release recovery, or delete or move a tag.
6. Rerun normal release-please generation only after retiring that pending label: a merged pending release blocks regeneration, so the source correction alone cannot prepare the next version.

Never rerun `Release package` for a withdrawn candidate's tag or rerun any cancelled publication run for that candidate. The `npm-release` approvers must reject every deployment for a withdrawn version.

For the withdrawn `1.0.0-rc.1` candidate, preserve this one-shot footer in the actual merged Conventional Commit that corrects the version policy:

```text
Release-As: 0.11.0-rc.1
```

Preserve the footer in the final commit when using a squash merge; a pull request body alone is insufficient. Let normal release-please generation update the existing open release-please pull request to `0.11.0-rc.1`. The current `1.0.0-rc.1` package and manifest versions need no manual reset in the corrective source change. The pre-major setting applies only while the current major version is zero, so it cannot by itself correct this manifest.

A retained higher abandoned tag can narrow generated notes. Review all changes since published `0.10.1`, restore all four builder-facing headings above, and identify `1.0.0-rc.1` truthfully as withdrawn and unpublished. The merged-release-PR resolver and the human approval requirement on the `npm-release` environment remain in force.

### Publication recovery

Before publishing, every run queries the exact npm version. An existing version is accepted only when its downloaded registry tarball is byte-for-byte identical to the reviewed artifact and the expected `latest` or `next` dist-tag already points at it; a mismatch fails closed without a second publish attempt. That also recovers a run where npm accepted the upload before the client lost its response, or where a later smoke check failed.

npm can expose the version metadata and the tarball at different times. After the first exact version appears, the publish step never publishes again. It waits up to 30 minutes after the single upload for exact metadata and tarball visibility, then allows a separate 30-minute clean exact-version consumer install window. Polling pauses are capped at 15 seconds. Each registry request, including response bodies, is bounded to 30 seconds; each install attempt and its descendants is bounded to two minutes or the remaining window, whichever is shorter. The publish job allows 75 minutes for these windows and setup. A wrong dist-tag, an unexpected tarball origin, or a checksum mismatch still fails immediately.

An exhausted window leaves publication uncertain: npm may still be processing the accepted upload. Do not upload again while processing is pending. First verify the reviewed archive read-only:

```sh
node scripts/publish-release.mjs --archive package.tgz --dist-tag next --check
```

Use `latest` only for a stable archive. This mode never uploads, even when metadata or the tarball is missing. It requires the exact archive bytes, package name, version, registry origin, and dist-tag to match; a listed integrity mismatch also fails closed. Unknown, duplicate, and malformed options fail before registry or publication work. A successful read-only check permits recovery of the remaining smoke checks from the immutable signed tag. Missing visibility alone is not proof that upload failed: establish the prior upload outcome before using the tag-without-npm path.

The tag-without-npm recovery is the same path when a tag exists but npm publication did not happen and the version has not been withdrawn: repair the trusted-publisher or environment configuration, then rerun `Release package` for that existing tag. Do not retag.

If npm has accepted a bad version, deprecate that exact version, return the affected dist-tag to the last good version, and publish a new fixed version. GitHub release creation can be rerun on its own for a successfully published tag when only the release notes or the label step failed: manually dispatch `Release package` with that existing tag and `github_release_recovery` set to true.

The label step resolves a merged release pull request by its exact release-title version and pending/tagged label, then requires its merge commit to be an ancestor of the verified tag with the same version in `package.json` and `.release-please-manifest.json`. A reviewed fix after the release pull request can therefore be included in the tag. Zero or multiple matching release pull requests fail before label writes; the step never chooses the latest labelled pull request.

For a bookkeeping-only repair, dispatch recovery from the reviewed default-branch workflow using the existing immutable tag. The workflow uses the newer resolver while the package build remains bound to the verified tag commit. Keep the existing npm version and GitHub release notes; do not move the tag or republish to repair labels.

## Commit identity

Require the `commit-identity` pull request check in the default branch ruleset. It executes the identity policy from the trusted base revision and checks both the author and committer of every commit in the pull request, including commits before the tip. The explicit noreply allow-list lives in `scripts/check-commit-identity.mjs`; add another bot only after verifying its GitHub identity. Missing history, an empty range, unknown identities, and a changed pull request head fail closed. Rejected email addresses are never printed in workflow logs.
