# Support

`@dvmkit/sdk` is the server framework you build a Digital Vending Machine on. The right route depends on whether the problem is in the SDK, in the hosted dvmkit service, in one of the CLIs, or in your own DVM.

## GitHub issues

Use an issue for a reproducible defect in the SDK, a behaviour that changed between two SDK versions, or documentation that is wrong or missing. Search open and closed issues first, then use the matching form. Blank issues are turned off so that a report arrives with the fields a fix needs.

Include the `@dvmkit/sdk` version, your Node.js version, the deployment shape (container image, long-running host process, managed platform, or local development), the entry point involved, the smallest handler or configuration that shows the problem, and what you expected instead. If money is involved, name the payment rail and keep everything in test mode.

Never post an API key, wallet credential, recovery mnemonic, access token, real payment data, customer content, or an unredacted server log. If a report might expose a vulnerability, stop and follow [SECURITY.md](SECURITY.md).

## GitHub discussions

Use a discussion for anything without a reproduction: an idea, a design question, a use case the SDK does not cover, a pattern you want a second opinion on, or an argument about direction. Discussions are where a proposal belongs, and where a maintainer will point you if you file one as an issue.

## Documentation

The builder documentation lives at [dvmkit.com/docs/build](https://dvmkit.com/docs/build), and the full SDK reference is at [dvmkit.com/docs/sdk](https://dvmkit.com/docs/sdk). The protocol a DVM speaks to callers is specified at [dvmkit.com/docs/protocol](https://dvmkit.com/docs/protocol). If the documentation is wrong, that is a documentation issue in this repository, not a discussion.

## Pull requests

Unsolicited pull requests are closed automatically. This is deliberate and is explained in [CONTRIBUTING.md](CONTRIBUTING.md); the reproduction we ask for instead is worth more to us than a patch.

## Email

Email `support@dvmkit.com` for account access, billing, a private deployment-specific problem, or dvmkit service availability. Include the affected account or organization, the DVM slug, the approximate time and time zone, any trace or deploy identifier, and the SDK version. Do not email wallet recovery material or plaintext credentials.

Use this address for code-of-conduct reports with the subject `dvmkit sdk code of conduct report`, and for trademark permission requests with the subject `dvmkit trademark use request`.

Email is not the route for an SDK bug. A bug sent by email loses the searchable public record that makes it fixable, so we will ask you to file it.

## Boundaries

We can investigate the SDK itself and the official dvmkit service interfaces it speaks to. You remain responsible for your handler code, your provider credentials and their spend, your data, your infrastructure, and any third-party service you call from a job.

General application design, debugging a custom handler, and vendor-specific failures may get guidance, but they are not guaranteed support work. Community support carries no response-time commitment and no service level agreement; a paid service commitment, if you have one, is governed by the agreement for that service rather than by this file.
