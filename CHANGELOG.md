# Changelog

## Unreleased

- `/v1/info` capabilities may carry `pricing.rates`, a builder-declared rate card published exactly as declared (`CapabilityConfig.rates`). Clients that do not read it are unaffected; the limits the server enforces at start are in `protocol-fixtures/capability-rates.json`.
- Caller credit storage retains every unresolved drain descriptor and recovery credential, including drains on replaced credits, until explicit terminal retirement. The existing storage format remains compatible; descriptors already evicted by an older version cannot be restored by upgrading.
- Diagnostic spans, SDK logger output, and runtime diagnostics now use catalogue version 1 before stdout or transport delivery. Arbitrary messages, error text and stacks, unknown attributes, generic protocol aliases, and unrecognized event names are removed or normalized. Routes retain only an approved method plus registered template, while URL credentials, ports, paths, queries, and fragments are discarded from validated DNS origins; localhost and IP origins are omitted. Capability fields are retained only when they match a definition configured by the emitting app; direct logger rows omit them. Diagnostic consumers should use the retained event, code, status, normalized route, URL origin, and validated client compatibility fields instead of parsing prose.
- Caller credit trust now requires same-origin receipts to match the authenticated live DVM ID and builder key before increasing credit caps or authorizing automatic opens. Offline fallback and matching history across hostnames retain their behavior.
- Hosted SDK servers can opt into a dedicated HMAC-authenticated control API for durable job admission, bounded drain, and resume. Direct job submissions are refused before payment after a drain closes admission. Scoped jobs remain readable and reclaimable; unfinished scoped jobs are cancelled as provider initiated at the deadline. Active jobs created before hosting admission appear separately as unowned and require an explicit ownership migration before shutdown. A handler that ignores abort may still have external side effects, so cancellation is a durable SDK outcome rather than a rollback guarantee.
- Bitcoin credit liability reads now keep uncovered and basisless balances grouped by ledger currency. In `GET /admin/credit/bitcoin-liability`, replace `uncovered_micro` and `unbacked_micro` with `uncovered_by_currency` and `unbacked_by_currency`; ledger consumers replace `uncoveredMicro` and `unbackedMicro` with the matching `ByCurrency` arrays. Each entry carries `currency`, `micro`, and `credits`; aggregate gap counts and exact satoshi totals retain their meanings. Consumers should display or price each currency separately.
- Update Hono to 4.13.5, including the fix that prevents URL fragment text from changing request query parameters.
- Job receipts add optional signed lifecycle timing and SDK-derived failure/cancellation attribution without changing receipt version `1`. Published verifiers continue to accept these fields; existing receipts remain valid.
- Hosted servers report every terminal job through the durable outbox with no caller identity, payment reference, amount, input or output. Deploy `/_internal/job-terminal` before rolling out this SDK: 404 follows the existing permanent-4xx policy and does not retry.


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
