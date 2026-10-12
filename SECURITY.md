# Security policy

## Reporting a vulnerability

**Do not open a public issue, a discussion, or a pull request for a suspected vulnerability.**

Report it privately, by either route:

- **GitHub private vulnerability reporting**, from this repository's Security tab. Private reporting is enabled on this repository from the moment it becomes public, and it is the preferred route because it keeps the report, the fix, and the advisory in one place.
- **Email `security@dvmkit.com`**, with the subject `dvmkit sdk security report`. Use this if the GitHub form is unavailable to you. Ask for an encrypted channel before sending anything sensitive, rather than sending it and hoping.

Both routes are private. Neither is a reason to relax what you leave out of the report; see below.

## What to include

The SDK runs as a server holding money, so a report that names a symptom without a way to reach it usually cannot be acted on. Include:

- the SDK version (`@dvmkit/sdk` version or commit) and the Node.js version;
- the deployment shape: container image, long-running host process, managed platform, or local development;
- the entry point involved: `@dvmkit/sdk`, `@dvmkit/sdk/server`, or `@dvmkit/sdk/testing`;
- the payment rail, if one is involved;
- reproduction steps, and a minimal proof of concept if it can be shared safely;
- the impact you believe is reachable, and any mitigation you would suggest.

## Payment, authentication, and receipt reports

These carry the highest impact in this codebase and the highest risk of a report doing damage of its own. The rule is: **we want the reproduction, and we never want the credential.**

Send a reproduction that runs against test-mode or synthetic values. Never send, paste, screenshot, or attach:

- a live API key, facilitator key, provider credential, or access token;
- a wallet secret of any kind: a private key, a seed phrase or recovery mnemonic, a Cashu proof or token with real value, a channel or session credential, or a Nostr Wallet Connect string;
- real payment data, a real settlement, a transaction that moved actual funds, or anything identifying a real payer;
- another person's job content, or any customer data.

Redact key material to a prefix at most. If a credential has already been exposed in the course of your research, rotate it and say so in the report; do not include the value to prove it.

**Stop and report immediately if a test moves real funds, reaches another party's balance, or exposes data that is not yours.** Do not continue to characterize the issue past that point.

For the specific surfaces: an authentication report should name the endpoint and the envelope or key path it defeats rather than including a working forged credential; a receipt report should show the verification step that wrongly passes or fails, with a synthetic key; a payment report should name the rail, the leg, and the ledger or accounting outcome you can reach.

## Scope

In scope: the source in this repository, the published `@dvmkit/sdk` release artefacts, and the way a DVM built on this SDK authenticates callers, prices and takes payment, issues receipts, and accounts for credit.

Out of scope for this repository:

- a vulnerability in a builder's own handler code, provider credentials, or infrastructure;
- the hosted dvmkit platform, the router, and the CLIs, which have their own reporting routes. Send it to the same security address anyway and we will route it internally rather than bounce you;
- social engineering, phishing, physical attacks, and denial-of-service testing;
- automated scanning that degrades a running service, ours or anyone else's;
- third-party dependencies, where this SDK neither creates nor worsens the vulnerability;
- a dependency version match with no demonstrated effect on a supported use of this SDK.

## Supported versions and what alpha means here

This is pre-1.0 alpha software, and the support promise matches that honestly:

- Security fixes are made on the **latest published release**. There is **no long-term support release** and no backport branch.
- Reproduce on the latest release before reporting where it is safe to do so. A report against an older pre-release may be answered with an upgrade rather than a fix.
- Breaking changes happen between pre-1.0 versions, including in response to a security finding, and are announced in the release notes for the release that carries them.

## Coordinated disclosure and safe harbour

Give us a reasonable opportunity to investigate and fix a reported issue before disclosing it publicly. Do not access another person's data, alter or delete data, move funds, persist beyond what is needed to demonstrate the issue, or degrade a running service.

DVM Technologies Ltd will not pursue legal action over good-faith research that stays within the scope of a report, does not access other people's data, does not degrade the service, and gives us a reasonable opportunity to fix the issue before disclosure.

We will acknowledge and assess reports as soon as we practically can. This policy does not promise a response or remediation deadline. Please do not publish until we have agreed a disclosure date, or a reasonable period has passed with no meaningful engagement from us.
