# Changelog

## Unreleased

### Breaking changes

- Prepaid and implicit per-call credits now default to 90 days instead of 30 days. Builders hold unspent balances longer before expiry release. Existing credits retain their stored expiry until their next top-up; funding extends expiry to the later of its current value and funding time plus the configured TTL. Set `credit: { ttl: 2_592_000 }` to keep a 30-day lifetime. Explicit TTL overrides remain supported; no database migration is required.

### Features

- Unsigned callers can pay a capability with x402 when it sets the new `maxRuntimeSeconds` (1 to 600) on a DVM with `allowUnsignedPaid` and Postgres. The authorization is verified before the job and settled only if the job succeeds; a failed, cancelled or timed-out job is never settled, and a replayed authorization neither runs a job nor settles twice. Authorizations that would lapse before the job's bound are refused with `payment_authorization_too_short` before verification, and the 402 advertises a longer `maxTimeoutSeconds`. Exact settlement intents gain a `released` status (no DDL; the status column is unconstrained text). Tempo stays signed-only. See `docs/PROTOCOL-NOTES.md#unsigned-x402-payments`.

- Accepted job responses and request recovery now expose optional `upfront_payment` metadata with the original credit hold or rail payment, exact recorded amounts and credit/draw correlation. The snapshot survives later payments, draw growth and exchange-rate changes; historical jobs remain unknown and explicit zero stays distinct. Job stores gain an optional, insert-only `upfrontPayment` fact backed by a nullable Postgres column. See `protocol-fixtures/upfront-payment-v1.json`.

- Mid-job rail payments that fund a job's credit against its pending draw now leave signed evidence. The server fixes a `credit_fundings` row (with new nullable `job_id`, `draw_id`, `payment_seq` columns) inside the rail transaction and issues a `credit_draw_funding` receipt from it: returned as `draw_funding_receipt` on the payment `201`, on the `503` snapshot-failure and `500` unapplied bodies, on a `409 replay_rejected` for the same payment, and as `draw_funding_receipts` on every authenticated job read, including after a restart. The caller credit store admits verified evidence with `recordDrawFunding` (or inline on `applyReceiptCredit`) and compares a completed draw as prior remaining plus eligible funding minus the draw, so a self-funded grown draw no longer raises a false balance warning while a contradictory terminal balance still does. `CreditLedgerLike` gains optional `listDrawFundings` and optional `recordFunding` bindings; `FundingRecord.receipt` and `saveFundingReceipt` now carry `CreditFundingEvidence`, the union of opening and draw funding receipts discriminated by `kind`. The portable contract is `protocol-fixtures/credit-draw-funding-v1.json`.

### Bug fixes

- Shared Postgres pools now recover through a full pool of stale idle connections after suspend/resume, including admin, job, and credit queries. Direct checkouts pass a bounded read-only probe before callers receive them, evicting detected stale connections before transaction or advisory-lock work. Recovery limits attempts by pool size and stops starting retries when the connection-timeout window expires; request-specific recovery deadlines remain supported. No API or storage migration is required.

- Explicit `paymentMethods` overrides now suppress excluded x402 and Tempo discovery blocks and prepaid-credit funding terms, including x402 batch funding. Omitted overrides retain derived defaults, and Lightning funding stays independent. A `cashu_not_advertised` boot warning identifies why configured mints do not result in a Cashu payment method. No storage migration is required; see `protocol-fixtures/payment-method-discovery-v1.json`.

- `idleTimeout` now limits only outstanding caller prompts and payment requests, starting at emission rather than job creation or the last caller message. Each request carries optional `expires_at_ms` in Unix milliseconds; unrelated messages do not extend it, and recovery preserves the original deadline. Processing uses the existing liveness watchdog. Configuration now rejects timeout values outside integer seconds 1–604800; the default remains 3600. See `protocol-fixtures/caller-deadline-v1.json`.

- Replaying an older job receipt no longer changes a newer stored credit projection. The comparison now happens inside the credit-store lock that applies the receipt, so last price, receipt attribution, flags, and update time stay with the newest settled draw, including when another process settles it mid-recovery.

## Upgrade details

The Tempo close-report routes below shipped in `0.10.0`. The completed-draw refund changes are included in `0.11.0-rc.1`.

- Add authenticated admin routes to list, retry, and write off hosted Tempo close reports, with exact native amounts and explicit refusal codes. New wire examples are in `protocol-fixtures/tempo-close-reports.json`. Existing direct write-off calls retain their boolean result; `includeDetails: true` additionally returns the amount forgone. The default list is an action queue; `all=1` exposes terminal history with per-row action flags and write-off details. Successful retries emit a catalogued audit event. Initialization adds a nullable write-off timestamp column; existing decision times remain unknown.

- Add authenticated `POST /admin/credit/refund-draw` to restore all or part of a completed credit draw to its original open credit, with durable refund IDs, original-result replay, ownership checks, and original-asset restoration. The `refund` report kind posts `/_internal/credit-draw-refund` with `dvmId`, `creditId`, `drawId`, `jobId`, `refundId`, `amountMicro`, `creditCurrency`, `ledgerSeq`, `refundedAt`, and optional `reason`. The portable fixture is `protocol-fixtures/credit-draw-refund.json`.
- Initialize the additive `credit_draw_refunds` history table, nullable `credits.last_funding_ledger_seq`, nullable `credit_draws.settled_sats` and `credit_draws.refund_dvm_id`, and `credit_funding_lots.sats_basis_known` defaulting to false. Financial evidence exports retain these facts without request or free-text reason content. Bitcoin restoration requires authoritative actual-settlement `settled_sats`, including zero. Historical `allocated_msats` markers alone are insufficient; missing basis returns `credit_refund_basis_unavailable`. Both historical evidence refusals direct an operator to inspect independent payment/funding/drain evidence before arranging a repair, because retry alone supplies no proof. Zero-sat rounding stays distinct from missing basis.
- Before the first refund, deploy the platform endpoint, pause monetary writes, and upgrade every process sharing the ledger and outbox, including funding writers and retry workers. Older writers can invalidate the funding watermark, and older readers cannot interpret the new report kind or known-zero lots. Mixed-version monetary history after new metadata is written needs a state compatibility assessment. Assess state compatibility before rolling back after refund state exists; additive DDL alone does not make rolling activation or rollback safe. Ambiguous historical full-drain reopening returns HTTP 422 `credit_refund_state_unavailable`; known closure remains `credit_not_open`, proven reopening remains eligible, and exact replay retains its original result.

### Breaking changes

- The public `CreditLedgerLike` interface now requires `refundDraw`. This is a breaking change for custom credit stores: implement transactional refund accounting and report enqueue before using this interface with the new SDK. The provided memory ledger remains development-only and cannot serve the admin refund route.

## [0.19.0](https://github.com/dvmkit/sdk/compare/v0.18.0...v0.19.0) (2026-10-30)


### Features

* settle unsigned x402 payments only after the job succeeds ([8d03541](https://github.com/dvmkit/sdk/commit/8d03541e0b33bc80dda051a87465f7331077cca1))


### Bug Fixes

* align terminal job reads with durable receipts ([1b6ffd2](https://github.com/dvmkit/sdk/commit/1b6ffd2201cd8af17a1870153fda9a8f018f88ed))
* enable browser wallet access on public routes ([d660b17](https://github.com/dvmkit/sdk/commit/d660b17695a88075e333b46adc41cef0232e776c))
* return retryable errors for temporary job-read outages ([c76edf8](https://github.com/dvmkit/sdk/commit/c76edf8e814be12fd6310ab04d6e67160196f792))

## [0.18.0](https://github.com/dvmkit/sdk/compare/v0.17.1...v0.18.0) (2026-10-29)


### Features

* let builders set the Cashu refund-locktime floor ([#71](https://github.com/dvmkit/sdk/issues/71)) ([5f09f3d](https://github.com/dvmkit/sdk/commit/5f09f3db9b8d8ed40cb6d53b9b64e1a965270f72))


### Bug Fixes

* recover stale Postgres pools on ordinary requests ([40922e6](https://github.com/dvmkit/sdk/commit/40922e6c69b89c1759af3036a6c1fb03421c2932))

## [0.17.1](https://github.com/dvmkit/sdk/compare/v0.17.0...v0.17.1) (2026-10-29)


### Bug Fixes

* book a Cashu payment after a paid ask as credit balance ([#68](https://github.com/dvmkit/sdk/issues/68)) ([ec16aeb](https://github.com/dvmkit/sdk/commit/ec16aebec75bc4f4e5b401fdb3cd60e70d3982c4))

## [0.17.0](https://github.com/dvmkit/sdk/compare/v0.16.2...v0.17.0) (2026-10-29)


### Features

* advertise Cashu payment as a NUT-24 payment request and accept NUT-24 payments ([#66](https://github.com/dvmkit/sdk/issues/66)) ([f3a5982](https://github.com/dvmkit/sdk/commit/f3a5982dd4fea16091e9965e851072b62bc81cad))
* serve unsigned paid per-call jobs behind secp256k1Auth({ allowUnsignedPaid: true }) ([#62](https://github.com/dvmkit/sdk/issues/62)) ([25b0076](https://github.com/dvmkit/sdk/commit/25b0076636e0dcde0ee1c4c89a0ab2ee4841cf4c))


### Bug Fixes

* accept unsigned paid calls on Cashu only ([#64](https://github.com/dvmkit/sdk/issues/64)) ([58904ba](https://github.com/dvmkit/sdk/commit/58904bab938e4447d2287fcd9e3ee6041d5b1a0f))
* honor explicit payment methods in discovery and credit menus ([3cd47c6](https://github.com/dvmkit/sdk/commit/3cd47c66d2dd10718ce530fa1c703af56d2b8f6e))
* recover a replayed Cashu job only under the request id its proofs were accepted with ([#65](https://github.com/dvmkit/sdk/issues/65)) ([ef7394e](https://github.com/dvmkit/sdk/commit/ef7394e9c80bd9e9def02ac452c40b6a2a4def4a))

## [0.16.2](https://github.com/dvmkit/sdk/compare/v0.16.1...v0.16.2) (2026-10-28)


### Bug Fixes

* accept only Cashu locks the DVM alone can spend and melt ([#60](https://github.com/dvmkit/sdk/issues/60)) ([b8a62b8](https://github.com/dvmkit/sdk/commit/b8a62b839dac1062e03c71322c1c56dd907bf60b))

## [0.16.1](https://github.com/dvmkit/sdk/compare/v0.16.0...v0.16.1) (2026-10-26)


### Bug Fixes

* **deps:** move Hono, Undici, and Zod to patched releases ([#59](https://github.com/dvmkit/sdk/issues/59)) ([6532767](https://github.com/dvmkit/sdk/commit/653276767dadb1a60b3f33782d2153a11738d09c))

## [0.16.0](https://github.com/dvmkit/sdk/compare/v0.15.0...v0.16.0) (2026-10-25)


### Features

* add trusted no-DVM span resolution marks ([5e0b7cf](https://github.com/dvmkit/sdk/commit/5e0b7cfd9ce290930f3a6074f9544923923149cd))

## [0.15.0](https://github.com/dvmkit/sdk/compare/v0.14.2...v0.15.0) (2026-10-23)


### Features

* expose accepted upfront payments on job responses ([5eee6e4](https://github.com/dvmkit/sdk/commit/5eee6e4d47cad4ea0d56a15e9033580ef117dc82))


### Bug Fixes

* publish payment history only after acceptance ([d818fb8](https://github.com/dvmkit/sdk/commit/d818fb8de06f82d610fd632e19e78c7809f8c28d))

## [0.14.2](https://github.com/dvmkit/sdk/compare/v0.14.1...v0.14.2) (2026-10-22)


### Bug Fixes

* limit idle timeouts to caller response windows ([2474705](https://github.com/dvmkit/sdk/commit/2474705f48215dd5eef9e61d0656e49b81965924))
* persist completed steps before returning to handlers ([8ae1591](https://github.com/dvmkit/sdk/commit/8ae1591c3c54906df522322b62e5e2a2f2eee288))
* preserve locally running jobs during stale sweeps ([297aa66](https://github.com/dvmkit/sdk/commit/297aa66b0f42e71ebcb43d2dcecfdbedd0671197))


### Continuous Integration

* upgrade artifact downloads to Node 24 ([#49](https://github.com/dvmkit/sdk/issues/49)) ([518e2c7](https://github.com/dvmkit/sdk/commit/518e2c7b1d7d81eb0f1c4a0b3a71c7c8dbb27732))

## [0.14.1](https://github.com/dvmkit/sdk/compare/v0.14.0...v0.14.1) (2026-10-22)


### Bug Fixes

* bound streamed upload memory in pinned fetch ([7a2a213](https://github.com/dvmkit/sdk/commit/7a2a2135d451624e9b5a1d23eb92fead46159a1b))


### Documentation

* clarify message acknowledgement cursor semantics ([d4a1241](https://github.com/dvmkit/sdk/commit/d4a124157b9fb51b139248fdf35513ad4dee43b4))


### Continuous Integration

* upgrade artifact uploads to Node 24 ([#46](https://github.com/dvmkit/sdk/issues/46)) ([92c0f88](https://github.com/dvmkit/sdk/commit/92c0f88551988440cf8396eed681e21f2f3f578f))

## [0.14.0](https://github.com/dvmkit/sdk/compare/v0.13.0...v0.14.0) (2026-10-21)


### Features

* sign mid-job funding evidence and reconcile funded draws ([d1aed67](https://github.com/dvmkit/sdk/commit/d1aed6734f0956197f5221c5ed0437a4f8a2221b))


### Bug Fixes

* ignore older receipt replay under the credit lock ([755d35a](https://github.com/dvmkit/sdk/commit/755d35a3ae7de8bd6734f47c5087f8671b790352))
* keep pending prompts awaiting input after duplicate rail payments ([f632c62](https://github.com/dvmkit/sdk/commit/f632c62f254ddfa9baaf0307100df8362223ee8f))
* preserve pending prompts during development payments ([35cd6ad](https://github.com/dvmkit/sdk/commit/35cd6ad537bfc830f8878728faa06863b75d8a51))

## [0.13.0](https://github.com/dvmkit/sdk/compare/v0.12.0...v0.13.0) (2026-10-20)


### ⚠ BREAKING CHANGES

* Default prepaid and implicit credit lifetimes increase from 30 to 90 days. Set credit.ttl to 2592000 seconds to retain 30 days.

### Features

* extend default prepaid credit lifetime to 90 days ([312e7ae](https://github.com/dvmkit/sdk/commit/312e7ae2df30351bd5e7666f88b2b95a30afcb9a))

## [0.12.0](https://github.com/dvmkit/sdk/compare/v0.12.0-rc.1...v0.12.0) (2026-10-20)


### Documentation

* document stable release graduation ([1a9460b](https://github.com/dvmkit/sdk/commit/1a9460be9dd700f09b5f46b6ee48156136725827))

## [0.12.0-rc.1](https://github.com/dvmkit/sdk/compare/v0.11.0-rc.1...v0.12.0-rc.1) (2026-10-20)


### Features

* pay mid-job requests from prepaid balance ([768178f](https://github.com/dvmkit/sdk/commit/768178f13297e5145b730f3d4f3fcf3fc3e4fb88))

## [0.11.0-rc.1](https://github.com/dvmkit/sdk/compare/v0.10.1...v0.11.0-rc.1) (2026-10-19)


### ⚠ BREAKING CHANGES

* Custom CreditLedgerLike stores must implement transactional refundDraw accounting and report enqueueing.

### Features

* add operator decisions for held Tempo drains ([c0e1841](https://github.com/dvmkit/sdk/commit/c0e18418df914c13633a485c8abe01621c15a3b8))
* support completed credit draw refunds ([ffd3334](https://github.com/dvmkit/sdk/commit/ffd3334101a1b9f9792a87b0b29b251906f987bd))


### Bug Fixes

* classify finalized Tempo backing loss from close evidence ([c5b17f3](https://github.com/dvmkit/sdk/commit/c5b17f3fb2ba27dc6ab62ee9b050f8082482460d))
* keep pre-1.0 releases on the development line ([aa0d33d](https://github.com/dvmkit/sdk/commit/aa0d33df14a3fdbcf70b8516a168df0e2dd2eb85))

## [1.0.0-rc.1](https://github.com/dvmkit/sdk/compare/v0.10.1...v1.0.0-rc.1) (2026-10-19) — withdrawn, unpublished

This candidate was withdrawn before the publish step ran and was never published to npm. Its immutable signed tag is retained as history. These notes retain the candidate's feature and breaking-change information; they do not describe a published package or GitHub release.

### ⚠ BREAKING CHANGES

* Custom CreditLedgerLike stores must implement transactional refundDraw accounting and report enqueueing.

### Features

* add operator decisions for held Tempo drains ([c0e1841](https://github.com/dvmkit/sdk/commit/c0e18418df914c13633a485c8abe01621c15a3b8))
* support completed credit draw refunds ([ffd3334](https://github.com/dvmkit/sdk/commit/ffd3334101a1b9f9792a87b0b29b251906f987bd))


### Bug Fixes

* classify finalized Tempo backing loss from close evidence ([c5b17f3](https://github.com/dvmkit/sdk/commit/c5b17f3fb2ba27dc6ab62ee9b050f8082482460d))

## [0.10.1](https://github.com/dvmkit/sdk/compare/v0.10.0...v0.10.1) (2026-10-18)


### Bug Fixes

* make concurrent job snapshots safe ([92a17a1](https://github.com/dvmkit/sdk/commit/92a17a1ce25fa801aa315beb90c41acd0e69c0d2))


### Continuous Integration

* validate workflows on Ubuntu 26.04 ([#19](https://github.com/dvmkit/sdk/issues/19)) ([d29a8db](https://github.com/dvmkit/sdk/commit/d29a8db95d125bebbd129e1f9ff3f5cc5039ad0d))


### Miscellaneous Chores

* **claude:** block Claude attribution in commits and PRs ([#22](https://github.com/dvmkit/sdk/issues/22)) ([cd58d28](https://github.com/dvmkit/sdk/commit/cd58d2813a96c7d176af05a538f23c7a80df6001))

## [0.10.0](https://github.com/dvmkit/sdk/compare/v0.9.0...v0.10.0) (2026-10-18)


### Features

* add admin routes for hosted Tempo close reports ([#16](https://github.com/dvmkit/sdk/issues/16)) ([a86a85d](https://github.com/dvmkit/sdk/commit/a86a85d6e2ac2d4474629d021bd05d6b88e750de))
* summarize pending implicit credit draws ([4edeae0](https://github.com/dvmkit/sdk/commit/4edeae05bacd047d0cf624882cef6db112d0ef90))


### Bug Fixes

* prevent duplicate Tempo settlements from stale reads ([12bbbe1](https://github.com/dvmkit/sdk/commit/12bbbe191306139d3b8534560973fed89a8b0995))
* recommend latest caller release in credential hint ([a3d3b0a](https://github.com/dvmkit/sdk/commit/a3d3b0a6fa9f3498236e1ed56c9ed55a35d3490d))
* require Tempo drain proof and share close searches ([#18](https://github.com/dvmkit/sdk/issues/18)) ([cb8df3e](https://github.com/dvmkit/sdk/commit/cb8df3e9eabb50d68c99419867ecc6bc86a7c5e5))
* **tempo:** honour proven charges when replay marking fails ([02292e5](https://github.com/dvmkit/sdk/commit/02292e5df9d26467f17685a7d726f8a47ba64804))

## [0.9.0](https://github.com/dvmkit/sdk/compare/v0.8.1...v0.9.0) (2026-10-16)


### Features

* terminalize hosted Tempo close obligations ([#9](https://github.com/dvmkit/sdk/issues/9)) ([3f306d4](https://github.com/dvmkit/sdk/commit/3f306d46f7a9adb378c577f6efb911de96dcc386))

## [0.8.1](https://github.com/dvmkit/sdk/compare/v0.8.0...v0.8.1) (2026-10-15)


### Bug Fixes

* bring every hosted Tempo close obligation to a terminal state ([#7](https://github.com/dvmkit/sdk/issues/7)) ([8fc12f9](https://github.com/dvmkit/sdk/commit/8fc12f9f8d10621eaeaab68a29aabc416a52d16b))

## [0.8.0](https://github.com/dvmkit/sdk/releases/tag/v0.8.0) (2026-10-13)

This is the first stable-channel release of `@dvmkit/sdk`, based on `0.7.0-rc.10`. It carries the prerelease runtime and supported API into `0.8.0`; the capabilities below are a summary of what this snapshot ships, not a claim that they were all added after rc.10. This remains pre-1.0 alpha software: pin exact versions and review future release notes before upgrading.

### Breaking API changes

None relative to `0.7.0-rc.10`. The three supported entry points (`@dvmkit/sdk`, `@dvmkit/sdk/server`, and `@dvmkit/sdk/testing`) retain the same 285 declaration names and API baseline.

### Migrations

None required when upgrading from `0.7.0-rc.10`: this stable preparation adds no configuration, database schema, stored-data, or wire-contract migration. Upgrading from older prereleases still requires the migrations documented in their historical entries. In particular, Bitcoin liability consumers must use currency-grouped balances, diagnostic consumers must use retained structured fields, and hosting controllers must understand finite admission leases and the terminal `closed` state. Upgrading cannot recreate credit recovery descriptors already lost by an older version.

### Compatibility requirements

Node.js 22 or later is required (`engines.node: >=22`). Dependency versions are unchanged from rc.10, including Hono 4.13.5 and the optional `pg` 8.20.0 and `viem` 2.55.11 packages. There are no declared peer dependencies. The default production stores and hosted control require PostgreSQL; a free standalone development server can run without it. Development mode verifies every configured payment rail rather than accepting unusable configured rails as synthetic payments.

### dvmctl and platform prerequisites

Standalone SDK use requires neither `dvmctl` nor a platform account. No new minimum CLI version or platform requirement is introduced relative to rc.10. The documented scaffold route targets the planned stable pairing with `@dvmkit/dvmctl@0.8.0` and its `build-dvm` skill. No older CLI compatibility minimum is specified here.

Opt-in hosted control requires durable PostgreSQL storage, a dedicated management secret of at least 32 bytes, a shared deployment scope, and a controller that signs version-two resumes with finite `leaseExpiresAtMs` and `deadlineMs`. Admission starts closed until resumed; draining refuses new jobs before payment. Active jobs without scoped ownership need explicit migration before shutdown. Deadline cancellation does not roll back external effects from a handler that ignores abort.

Hosted terminal reporting is enabled when platform URL, token, DVM identity, and durable database are configured. Deploy the platform's `/_internal/job-terminal` endpoint before enabling those report-emitting servers: a 404 is a permanent 4xx failure, not a retried delivery. Unmanaged servers do not need hosting control or that report endpoint.

### Included in the first stable snapshot

- Capability rate cards are published as builder-declared `pricing.rates` in `/v1/info`. Clients that do not read them are unaffected; server validation limits are documented in `protocol-fixtures/capability-rates.json`.
- Shared caller credit storage retains unresolved drain descriptors and recovery credentials, including those on replaced credits, until explicit terminal retirement. Existing stored formats remain compatible. Same-origin credit receipts must match the authenticated live DVM identity and builder key before increasing credit caps or authorizing automatic opens; offline fallback and matching history across hostnames remain supported.
- Diagnostic spans, SDK logger output, and runtime diagnostics use catalogue version 1 before stdout or transport delivery. Unapproved prose, errors, stacks, attributes, and event names are removed or normalized. Routes retain registered templates; validated DNS origins omit credentials, ports, paths, queries, and fragments, while localhost and IP origins are omitted. Capability fields require a configured definition and are omitted from direct logger rows. Consumers should read retained structured fields rather than parse prose.
- Opt-in hosted control provides durable scoped admission, bounded drain, resume, and terminal closure. Closed admission rejects direct submissions before payment; scoped jobs remain readable and reclaimable. Unfinished scoped jobs are cancelled as provider initiated at the deadline, with no guarantee of rolling back external handler effects.
- Bitcoin liability reads preserve uncovered and basisless balances by ledger currency. `/admin/credit/bitcoin-liability` uses `uncovered_by_currency` and `unbacked_by_currency`; ledger consumers use the corresponding `ByCurrency` arrays. Each entry contains `currency`, `micro`, and `credits`. Exact satoshi totals and aggregate gap counts retain their meanings; display or price each currency separately.
- Hono 4.13.5 includes the query-parsing fix that prevents URL fragment text from changing query parameters.
- Schema-version-1 job receipts support optional signed lifecycle timing and SDK-derived failure/cancellation attribution. Existing receipts remain valid, and published compatible verifiers accept the optional fields.
- Configured hosted servers report every terminal job through the durable outbox without caller identity, payment references, amounts, input, or output. Deploy `/_internal/job-terminal` first; transport/5xx failures retry under the existing policy, while 4xx responses become permanently stale.

## 0.7.0-rc.10 (2026-10-12)


### Bug Fixes

* **tempo:** complete hosted session closes and report their payout


### Miscellaneous Chores

* merge reviewed changes

## 0.7.0-rc.9 (2026-10-11)


### Bug Fixes

* **observability:** keep router identity and funded hosting fields

## 0.7.0-rc.8 (2026-10-10)


### Features

* **jobs:** state job identity in a response-head field


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes

## 0.7.0-rc.7 (2026-10-10)


### Features

* **pricing:** let a capability publish its rate card in /v1/info


### Miscellaneous Chores

* merge reviewed changes

## 0.7.0-rc.6 (2026-10-07)


### Bug Fixes

* **x402:** report only earned, unclaimed channel value as pending

## 0.7.0-rc.5 (2026-10-07)


### Features

* **observability:** keep sanctions refusal details in diagnostics


### Miscellaneous Chores

* merge reviewed changes

## 0.7.0-rc.4 (2026-10-04)


### Features

* **pricing:** expose safe exchange-rate failure observations

## 0.7.0-rc.3 (2026-10-04)


### Features

* **x402:** allow shorter testnet withdrawal delays

## 0.7.0-rc.2 (2026-10-03)

This release candidate preserves the supported builder API and shared payment, storage, signing, and recovery contracts. Builders using the supported exports can upgrade from 0.7.0-rc.1 without application changes. Provider-bound credit recovery, credit history retention, and safe diagnostics remain supported. Upgrading cannot restore records already lost by an older version.

### Breaking API changes

None. The supported `@dvmkit/sdk`, `@dvmkit/sdk/server`, and `@dvmkit/sdk/testing` exports are unchanged.

### Migrations

None. No configuration, database schema, stored data format, or wire contract migration or reset is required.

### Compatibility requirements

Node.js >=22 remains required. Dependency versions are unchanged, including optional `pg` 8.20.0 and `viem` 2.55.11. No peer dependencies are declared.

### dvmctl and platform prerequisites

None. This candidate introduces no new minimum dvmctl version or platform capability requirement for the supported builder APIs.


### Bug Fixes

* **release:** bound npm processing and consumer waits


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes


### Code Refactoring

* **internal:** remove caller workflows from shared runtime

## 0.7.0-rc.1 (2026-10-02)

This release candidate preserves the supported builder API. Builders can upgrade from 0.6.0-rc.1 without application changes. Caller credit storage now keeps separate credits and pending recovery records for distinct authenticated providers even when their caller and credit IDs match. Authenticated provider aliases and compatible legacy identity upgrades remain supported. Upgrading cannot restore records already lost by an older version.

### Breaking API changes

None. The supported `@dvmkit/sdk`, `@dvmkit/sdk/server`, and `@dvmkit/sdk/testing` exports are unchanged.

### Migrations

None. Configuration, database schemas, stored data formats, and wire contracts are unchanged.

### Compatibility requirements

Node.js >=22 remains required. Dependency versions are unchanged.

### dvmctl and platform prerequisites

None. This candidate introduces no new minimum dvmctl version or platform capability requirement.


### Features

* **internal:** expose existing migration bindings
* **internal:** expose shared channel refusal contracts

## 0.6.0-rc.1 (2026-10-02)


### Features

* **server:** retain job content with scoped admin holds


### Bug Fixes

* **observability:** advertise 730-day diagnostic retention

## 0.5.0-rc.1 (2026-10-02)


### Features

* preserve completed credit history


### Bug Fixes

* preserve caller spending history

## 0.4.0-rc.1 (2026-10-01)


### ⚠ BREAKING CHANGES

* HostingControlStatus.state now includes "closed". Consumers with exhaustive state handling must accept the terminal value.

### Features

* preserve hosted obligations through terminal cleanup

## 0.3.4-rc.10 (2026-10-01)


### Bug Fixes

* **observability:** expose trusted span authority


### Miscellaneous Chores

* merge reviewed changes

## 0.3.3-rc.10 (2026-10-01)


### Bug Fixes

* **observability:** preserve safe route and origin metadata

## 0.3.2-rc.10 (2026-10-01)


### Bug Fixes

* **observability:** project safe diagnostic fields at every sink


### Miscellaneous Chores

* merge reviewed changes

## 0.3.1-rc.10 (2026-09-29)


### Bug Fixes

* **deps:** patch undici security advisories


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes
* merge reviewed changes

## 0.3.0-rc.10 (2026-09-29)

Configured hosting control starts closed and requires a version-two signed, finite admission lease on every resume. Existing unleased accepting scopes close on upgrade while retaining pending payment and job recovery; unmanaged servers are unchanged. Management clients must send `leaseExpiresAtMs` and `deadlineMs` and reserve the completion window before resuming. The exported `HostingControlCommand` gains optional `version` and `leaseExpiresAtMs`, while `HostingControlStatus` gains a required `leaseExpiresAtMs`; update typed status values and management clients. A legacy unbounded resume returns HTTP 409.


### Bug Fixes

* require expiring hosted admission leases

## 0.3.0-rc.9 (2026-09-28)


### Features

* add durable hosting admission and draining

## 0.2.1-rc.9 (2026-09-27)


### Bug Fixes

* resolve release pull requests by tag ancestry
* update Hono query parsing


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes
* merge reviewed changes

## 0.2.0-rc.9 (2026-09-26)


### Features

* add signed terminal timing and hosted reports


### Bug Fixes

* isolate host configuration and strengthen verification


### Documentation

* clarify comments and test guidance


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes

## 0.1.5-rc.9 (2026-09-22)

- Tempo challenges for USD-priced jobs now charge the builder's exact six-decimal price instead of converting the rounded millisatoshi quote back through BTC/USD. Legacy millisatoshi and non-USD pricing keep their existing conversion behavior.


### Bug Fixes

* preserve exact USD Tempo prices

## 0.1.5-rc.8 (2026-09-22)

- Tempo Moderato servers now verify returned payment credentials against the same testnet route binding advertised in their HTTP 402 challenge. Unsupported Tempo chain IDs now fail at boot before the server can issue an unpayable challenge; explicit mainnet and Moderato selection and token overrides remain supported.


### Bug Fixes

* bind Tempo verification to the selected network

## 0.1.5-rc.7 (2026-09-21)

- Development hosts now verify every configured Cashu, x402, and Tempo rail, expose their effective payment mode, and can report settled paid completions.
- Cashu accumulator acceptance now requires valid mint-provided NUT-12 DLEQ evidence on every proof for both memory and PostgreSQL storage. Tokens from callers or mints that omit DLEQ are rejected and must be replaced with fresh compatible tokens.
- Development Cashu can use a typed, process-local atomic backend with known test or loopback mints; its identity and state are discarded on restart.


### Features

* verify local test payments across all rails


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes

## 0.1.4-rc.7 (2026-09-17)


### Dependencies

* upgrade cashu-ts for keyset rotation


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes

## 0.1.3-rc.7 (2026-09-15)


### Bug Fixes

* **release:** retry registry propagation


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes
* merge reviewed changes

## 0.1.2-rc.7 (2026-09-12)


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes
* merge reviewed changes

## 0.1.1-rc.7 (2026-09-10)


### Miscellaneous Chores

* merge reviewed changes
* merge reviewed changes
* merge reviewed changes

## 0.1.0-rc.7 (2026-09-08)


### Bug Fixes

* update Hono CORS parser

## 0.1.0-rc.6 (2026-09-05)


### Features

* export the caller's shared modules through the internal entry point

## 0.1.0-rc.5 (2026-09-05)


### Features

* export the caller credit store through the internal entry point

## 0.1.0-rc.4 (2026-09-05)


### Features

* export the remaining platform-shared symbols through the internal entry point

## 0.1.0-rc.3 (2026-09-05)


### Features

* expose the platform-shared modules through an internal entry point

## 0.1.0-rc.2 (2026-09-04)


### Features

* **server:** report payouts, sweep expired credits and keep emptied x402 channels refillable

## 0.1.0-rc.1 (2026-09-02)


### Documentation

* establish the licence and contribution policy


### Continuous Integration

* allow the published contact addresses in the public-safety scan
* verify and release the package from hosted runners


### Miscellaneous Chores

* initialize dvmkit SDK
* prepare the first release candidate
