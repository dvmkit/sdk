# Changelog

## [0.8.0](https://github.com/dvmkit/sdk/compare/v0.8.0...v0.8.0) (2026-10-13)


### Miscellaneous Chores

* configure the first stable release ([#5](https://github.com/dvmkit/sdk/issues/5)) ([b795a23](https://github.com/dvmkit/sdk/commit/b795a23775c4134124fd6da88c2f2e36bdcacd6c))

## 0.8.0

This is the first stable-channel release of `@dvmkit/sdk`, based on `0.7.0-rc.10`. It carries the prerelease runtime and supported API into `0.8.0`; the capabilities below are a summary of what this snapshot ships, not a claim that they were all added after rc.10. This remains pre-1.0 software: pin exact versions and review future release notes before upgrading.

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
