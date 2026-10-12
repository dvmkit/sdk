# Contributing to @dvmkit/sdk

`@dvmkit/sdk` is the server framework for building Digital Vending Machines (DVMs): accountless, pay-per-use HTTPS services with typed inputs, jobs, and payment rails.

## The short version

**This repository does not accept unsolicited pull requests.** A pull request opened without an invitation is closed automatically, with a comment pointing at the place your report belongs. No judgement is passed on the code and no hard feelings are involved.

**Issues and discussions are welcome, wanted, and read.** A precise bug report with a reproduction is the most valuable thing an outside contributor can send us, and it is worth more to us than a patch.

## Why the door is closed

We would not merge a change we could not verify ourselves.

If we can reproduce a bug, our own pipeline can write the fix, review it, and prove it against the SDK's test suite. If we cannot reproduce it, no patch is mergeable on trust, however good it looks. Either way the load-bearing artefact is the reproduction, not the diff. So we ask for the reproduction directly and skip the step that adds review cost without adding evidence.

Two sentences on how the work actually gets done, because it explains the ask: research, implementation, and first review here are performed by agents against a layered verification suite, and a maintainer merges. That pipeline consumes a well-specified issue very efficiently and cannot do anything useful with a patch it cannot reproduce.

The one case this would otherwise lose is the environment bug we cannot see: a path that only breaks on Windows, a shell we do not run, a Node.js release we do not test. That is a continuous-integration problem, not a contribution problem, and the answer to it is a platform matrix on our side rather than a patch from yours.

## What to send instead

| You have | Send |
| --- | --- |
| A reproducible defect in the SDK | A **bug report** issue, with the reproduction the form asks for |
| Behaviour that changed between two SDK versions, or a type or export that moved | An **API compatibility report** issue |
| Wrong, missing, or misleading documentation, including a typo | A **documentation** issue. Do not open a pull request for a typo; we will just fix it |
| An idea, a design question, a use case that does not fit, or an argument about direction | A **discussion** |
| A suspected vulnerability | Never a public issue. Follow [SECURITY.md](SECURITY.md) |
| Account, billing, or dvmkit service trouble | See [SUPPORT.md](SUPPORT.md) |

A failing test case is welcome, as a snippet in the issue or a link to a small standalone repository. Attach it to the issue rather than opening a pull request with it. `npm test` runs offline, `npm run test:server` needs free local ports, `npm run test:db` needs Postgres, and `npm run verify` runs all of them.

### What makes a report reproducible here

This is a server framework, so a report that names only a symptom usually cannot be acted on. Include the SDK version, the Node.js version, the deployment shape (container image, long-running host process, managed platform, local development), the entry point involved (`@dvmkit/sdk`, `@dvmkit/sdk/server`, or `@dvmkit/sdk/testing`), and the smallest handler or configuration that shows the problem. Where money is involved, name the payment rail and use test-mode or synthetic values throughout.

**Never put a live API key, wallet credential, recovery mnemonic, access token, real payment data, or customer content in an issue, a discussion, a fixture, or an attachment.** Replace every secret with a synthetic value before you post.

## What happens to a pull request you open

A workflow comments with where the report belongs and closes the pull request. It does not run your code, and it does not check out your branch.

It leaves alone pull requests from this repository's own release automation, from maintainers, collaborators, and organization members, and any branch pushed to this repository rather than a fork. If yours was closed and you believe it fits one of those cases, say so in a comment.

If a maintainer has explicitly invited a pull request on a specific issue, say so in the description and reopen it; invited work is the exception the automation cannot see.

## What accepting an issue does and does not mean

Accepting an issue means we agree the problem is real and worth solving. It is not a delivery date, a place in a queue, an assignment, or a commitment to any particular design.

Nothing about an accepted issue extends the support or stability promises in [Compatibility and versioning](README.md#compatibility-and-versioning). This is a pre-1.0 alpha SDK: breaking changes happen, they are announced in the release notes for the release that carries them, and there is no long-term support release.

Maintainers retain authority over the public API, the roadmap, and design direction. Contributing a report, a discussion, or a reproduction does not confer any of the three. We may implement a reported problem differently from the way it was proposed, or decide not to implement it at all.

## Licensing

The SDK is licensed under the [Apache License 2.0](LICENSE). Anything you post in an issue or a discussion, including a reproduction or a suggested fix, is offered under that same licence so we can act on it.

There is **no contributor licence agreement** and **no Developer Certificate of Origin sign-off** to add. Neither has a subject while unsolicited pull requests are closed, so neither exists here. Do not add a `Signed-off-by` trailer expecting it to mean something.

The Apache licence covers the source. It grants no rights in the dvmkit name or branding; see [Trademarks](README.md#trademarks).

## Which repository takes what

Four surfaces, easy to confuse:

- **This repository** owns the SDK: the DVM server runtime, its public API, its payment-rail and credit implementations, and its own tests and documentation.
- **The caller CLI** owns the `dvm` command that callers use to find, pay, and drive a DVM. Its repository, [dvm-cli](https://github.com/dvmkit/dvm-cli), opens publicly in the same wave as this one.
- **The builder CLI** (`dvmctl`) owns scaffolding, running, deploying, and operating a DVM.
- **The dvmkit platform** is a hosted service. A defect you can reproduce without this SDK is a service problem, and goes through [SUPPORT.md](SUPPORT.md).

If you cannot tell which one owns your problem, file it here and describe the observable failure. Routing it is our job, not yours.

## Code of conduct

Everything here, in the issue tracker and in discussions, is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
