---
name: public-readme
description: Draft, rewrite or review this repository's README.md and the root community files it links to (CONTRIBUTING, SECURITY, SUPPORT, CODE_OF_CONDUCT, NOTICE, TRADEMARKS). Use when a change touches README.md, adds or renames a command, entry point, install step or skill, or when asked to "update the README", "polish the docs", "review the README", or "write release-facing docs". Do NOT use for CHANGELOG entries, API reference generation, or dvmkit.com docs pages.
---

# Public README

## Who the README is for

Two readers, in this order. First, a stranger's coding agent that has been told "use dvmkit" and lands on the GitHub page or the npm page with no other context. Second, a human skimming the same page to decide whether to try it. Neither is a maintainer, an operator of the hosted platform, or someone upgrading from last week's release; those readers have their own documents.

The test every README must pass: **an agent that reads only the README can install the package and finish its first useful action** (the first free job served, or the first DVM called, or the first DVM scaffolded). Everything in the README serves that test or the decision to try it. Material that serves neither goes somewhere else.

## Where a piece of content goes

Walk this for every paragraph, table and code block, including ones already in the README:

```
Does the reader need it to install, or to finish the first useful action?
├── Yes → README
└── No
    ├── Is it reference a builder or caller needs after the first run (options, rails, protocol, operations)?
    │   └── Yes → dvmkit.com docs; the README links the page in one line
    ├── Is it about what changed in a release, a migration, or an upgrade?
    │   └── Yes → CHANGELOG.md
    ├── Is it how this repository is built, tested, verified or released?
    │   └── Yes → docs/ in this repository (RELEASING.md, a maintainer doc), or AGENTS.md for agent working rules
    ├── Is it policy (contributions, security, support, conduct, trademarks)?
    │   └── Yes → its root file; the README carries at most two lines and a link
    └── Otherwise → delete it
```

Why: the README is the only page both readers are guaranteed to see, and every line of operator detail pushes the quickstart further from the top. One fact lives in one place; a copy in the README goes stale the first time the real home changes.

## Required shape, in this order

1. **Title and one sentence.** The package name, then what it is and who it is for, in plain words: a Digital Vending Machine is a pay-per-use HTTPS service an AI agent can find, pay and call with no account and no API key. Say what this package does within that (build one, call one, deploy one). No slogans.
2. **Status line.** One sentence: pre-1.0 alpha, breaking changes are announced in the [release notes](./CHANGELOG.md), pin the version you install. Use the word "alpha" and nothing else ("beta", "preview", "experimental" are banned), so the README, CHANGELOG, SECURITY.md and dvmkit.com agree.
3. **Requirements.** Runtime and minimum version, in one line.
4. **Install.** The command that resolves the current release: `npm install --save-exact @dvmkit/sdk`, `npm install --global @dvmkit/dvm-cli`. Never write a version number into an install command. Why: a pinned number in prose goes stale every release and silently sends readers to an old version; `--save-exact` still records the exact resolved version in the reader's own `package.json`.
5. **Quickstart.** The smallest sequence that reaches the first useful action, copy-pasteable top to bottom in an empty directory, with the expected output shown. It must be a verbatim copy of an example that this repository's CI runs (for the SDK, `examples/quickstart`); if the two differ, the README is wrong. At most 40 lines of code in total.
6. **For agents** (CLI repositories only). How an agent installs and loads the shipped skill (`dvm` or `build-dvm`), in at most five lines. The README points at the skill; it never copies the skill's content.
7. **What's in the package.** Entry points or commands as one short table: name and one-line purpose. Link the full reference instead of listing options.
8. **Next steps.** Three to six links to dvmkit.com docs pages, each with a few words on when to read it.
9. **Contributing, security, support.** One short paragraph each, linking CONTRIBUTING.md, SECURITY.md and SUPPORT.md.
10. **License.** One line naming the license with links to LICENSE and NOTICE, and one line linking TRADEMARKS.md if the repository has it. License is the last section.

Total length: at most 150 lines, and the quickstart's first command appears within the first 40 lines. Why: both readers decide in the first screen; a README longer than this is carrying content that belongs elsewhere.

## Never in a README

- Operator, hosting or platform-internal material: admin routes, `/_internal/` endpoints, hosting control, drain/closure, content holds, financial exports, retention schedules, diagnostic catalogues. Why: callers and builders cannot act on it, and it reads as the README of a different product.
- Wire-format grammar, header byte rules, fixture schemas. Link the protocol docs.
- Upgrade and migration notes, "older consumers must…", references to specific past versions. These are CHANGELOG content and are stale by the next release.
- Unsupported entry points, except one sentence saying they exist and carry no stability promise.
- Test-gate internals, timings, CI mechanics. Maintainer docs only.
- Literal email addresses. Link SUPPORT.md or SECURITY.md, which are the single place each address is written, so a change of address (or a switch to a form because of spam) is one edit.
- Private or internal names: tracker keys, internal hostnames, machine names, internal tool names, private repository names, private URLs.
- Claims you have not checked (see below), superlatives, and comparisons with named competitors.

## Code snippets

- Code snippets are TypeScript (`.ts`), because `dvmctl` scaffolds a TypeScript DVM and a builder should see the same language in the README as in the project they generate. Snippets run with Node's built-in type stripping (`node server.ts`, Node 22.18 or later), so the quickstart needs no build step and no extra dependency; state "Node.js 22.18 or later" in the quickstart's requirements line. Write only syntax Node can strip (no `enum`, no `namespace`, no parameter properties) and import local files with their `.ts` extension. Why: a snippet that needs a compiler the reader has not installed fails at the first command.
- Snippets run as shown in a fresh directory. If the package is ESM-only and the quickstart starts from `npm init -y`, add `npm pkg set type=module` as a step. Why: `npm init -y` creates a CommonJS project, and an ESM-only package imported there fails with an error a stranger's agent will misdiagnose.
- Show the expected output after any command that prints something the reader needs to check.
- Never put secrets, real keys, real wallet strings or real endpoints in a snippet; use `example.com` and obviously fake values.

## Checking before you commit

1. Run every command and snippet in the README in a fresh temporary directory, against the published package or, for an unreleased change, a tarball packed from this repository (`npm pack`). A snippet you did not run does not go in.
2. Request every link and confirm it answers 200 at its final URL. Docs and site links use `dvmkit.com`, never `dvmkit.ai` (that domain hosts DVM endpoints, and its site paths only redirect).
3. Compare the install command, status word, runtime requirement and quickstart with the matching dvmkit.com docs page. If they disagree, say so in your hand-off; the site is fixed in its own repository, never by copying site text into the README.
4. Walk the "Where a piece of content goes" tree over the whole diff, then check the length budget.
5. Fresh-agent test for a rewrite: a new session with only the README must reach the first useful action. What trips it up is the edit list.

## This repository

<!-- Replace this block per repository. -->
- Package: `@dvmkit/sdk`. First useful action: serve a free DVM locally and get a job result with `curl`.
- CI-run example the quickstart copies: `examples/quickstart`.
- Matching site page: https://dvmkit.com/docs/sdk.
