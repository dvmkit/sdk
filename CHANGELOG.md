# Changelog

## Unreleased

- Handler tests can supply `auth` and replay completed `ctx.step` work with `createTestContext({ stepCache })` and `StepCache` from `@dvmkit/sdk/testing`. Each context now caches successful steps by default; reuse a cache for the same job across recreated contexts, supplying the next response or payment, to test re-entry. Cached steps replay their cost declarations, while failed steps run again. This simulates completed-step replay, not crash durability or exactly-once side effects.
- `defineCapability` and the `CapabilityConfig` type are now exported from `@dvmkit/sdk`. Wrap individual `capabilities` entries in `defineCapability({ input, onJob, onQuote, ... })` to infer each handler's input, state, and quote data from its own schemas. Existing capability maps remain supported; `CapabilityConfig` gains an optional third type parameter for quote data. Capability maps also accept whole-schema quote transforms that produce scalar data.
- Add a single compatibility policy, per-entry-point stability levels, and a public signature gate requiring breaking-change release notes. Root and testing exports are stable; server exports are experimental. The post-trigger deprecation window spans two minor-version increments.

- Terminal reports now include `heldMicro`, the original draw hold including paid mid-job pieces, and `finishedPieceCount`, which excludes a piece stopped by cancellation. Both fields are optional for compatibility with older reports; historical jobs without piece accounting omit the count. See `protocol-fixtures/piece-settlement-v1.json`.

- Terminally refused card refunds now enter `refund_blocked` and stop consuming sweep retry slots. Signed admin routes `close-card-drain` and `replan-card-drain` require a decision id and reason; closing records the unpaid remainder as `written_off`, while replanning retains successful refunds and immediately retries only the remainder. Unknown or processing refunds refuse recovery. Postgres adds nullable `credit_drains.card_recovery`; the financial export retains structured refund/write-off amounts without operator free text. Custom card ledgers must implement serialized recovery and honor the supplied query connection. Clients must handle the two new drain states; see `protocol-fixtures/credit-drain-stripe-v1.json`.

- Caller-side credit parsing now preserves the card funding profile, minimum, and USD currency. Malformed `stripe` blocks reject the terms or menu, matching Tempo and x402 validation; unknown fields remain stripped. Operating guidance states Link's supported payer regions.

- Card-credit PaymentIntents now include server-owned Stripe metadata `dvmkit_dvm_id` from the server's canonical identity (falling back to its DVM id), including declined confirmations. Environment-created and explicit rails share this behavior; standalone servers without identity omit the field. `StripeCreditRail.charge` accepts optional server-side `canonicalDvmId`. A Stripe parameter mismatch triggers one retry without the new metadata under the same idempotency key, preserving recovery of pre-upgrade charges; existing PaymentIntents keep their original metadata. MPP challenge and idempotency formats are unchanged; no storage migration is required. See `protocol-fixtures/credit-fund-stripe-v1.json`.

### Terminal result durability

- Retry failed outgoing appends and terminal snapshots for up to 30 seconds before settling a completed credit draw. Exhausted completion retries fail the job with `terminal_persistence_failed` and release its draw when storage is reachable; refusal receipts retain their own reason after failed step writes.
- Deduplicate outgoing append retries across lost acknowledgements, including payment counters and terminal log cleanup. Postgres initialization adds `job_outgoing_appends`; custom streaming stores must honor stable `appendId` values. Existing receipt bytes remain write-once.
- Receipt persistence may lag settlement after the full result is durable. Terminal responses with receipt support expose `receipt_pending: true` until a signed receipt is stored. Later reads after restart rebuild missing receipts from the stored result and resolved draw, reuse the receipt sequence, and do not settle an already settled draw again. Historical missing output is not reconstructed.

### Security fixes

- An unsigned x402 job's output is now withheld until its payment settles. Previously a caller could read the summary, artifacts and streamed messages, then cancel the authorization or move the funds before the settlement ran, and keep the result unpaid. Reads now show `content_available: false` with `content_withheld` until the facilitator settles, a refused settlement reads as `failed` with no content, and mid-run streaming is unavailable on these jobs. A settled-as-unpaid job's receipt reports nothing paid and `onJobTerminal` reports `paid: false`. A payer is limited to one outstanding authorization (HTTP 429 `x402_payer_busy`), and `X402ExactSettlementStore.claim` takes an optional `maxOutstandingPerPayer`; Postgres adds the index `idx_x402_exact_settlement_payer`. See `docs/PROTOCOL-NOTES.md#unsigned-x402-payments`.

### Breaking changes

- Test contexts now cache successful `ctx.step` results by exact step ID, including `undefined`, instead of rerunning every call. Tests that need independent executions must create a fresh context with a fresh cache; reuse `StepCache` only for replay of the same job. `TestContextOpts` also gains optional `auth` and `stepCache` fields, and the public capability declarations accept an optional quote-data type parameter.

- The card top-up minimum now defaults to $5 instead of $0.50, so an existing card DVM's `credit.stripe.min_micro` rises from 500000 to 5000000 on upgrade and smaller card top-ups return `400 below_rail_minimum`. Builders set another minimum for card alone with `DVMKIT_STRIPE_MIN_USD` or the `minUsd` option of `createStripeCreditRail` (at least `0.50`; set `0.50` to keep the old behaviour). It is raised to `credit.min` when that is higher and capped at `credit.max`, so card stays offered on a DVM whose credit maximum is under $5; a setting above `credit.max` fails boot. Other rails' minimums are unchanged. See `docs/OPERATING.md#card-top-up-minimum`.

- Mid-job work is charged by the piece. Each payment buys the next piece of work: the upfront payment the first, each paid `ctx.requestPayment` ask the one after it, and a piece finishes when the DVM sends its next ask or completes. Every ending charges the finished pieces and releases the piece in progress, except a caller's cancel, which stops the work as before and now charges the piece in progress too; a failure no longer gives back the upfront payment for work already delivered. Every ask is new money: the upfront payment never covers an ask, so a handler that relied on that now suspends for a payment. One payment request may be open at a time (`ask_already_open`), and `ctx.complete` with one open withdraws it. `ctx.requestPayment` and `ctx.complete` take `finishedChargeMicro` to charge the finishing piece less than its price. Callers can end a job at an open ask or prompt with a new `decline` message (HTTP 409 `no_open_ask` when nothing is open). A `payment-request` carries `charged_if_declined_micro`; receipts stay `v: 1` and gain an optional `settlement` block, and `credit.amount` is now the charged amount, `0` on a draw released whole. The terminal report gains `chargedMicro`, `currency` and `stoppedPiece`. `CreditLedgerLike.resolveDraw` is required; `StreamableJobStore.appendOutgoing` refuses an ask on a terminal job with `JobEndedError`, which `@dvmkit/sdk/server` exports with the `JobPiece`, `JobSettlement`, `PieceEnding`, `PieceState` and `DeclineOutcome` types. A custom job store that saves snapshots as given settles from the settlement the SDK freezes on the terminal snapshot. Postgres initialization adds `jobs.pieces` and `jobs.settlement`; a job in flight at upgrade settles as one piece. Unsigned x402 jobs remain one piece settled only on completion. See `docs/PROTOCOL-NOTES.md#charging-by-the-piece` and `protocol-fixtures/piece-settlement-v1.json`.

- Prepaid and implicit per-call credits now default to 90 days instead of 30 days. Builders hold unspent balances longer before expiry release. Existing credits retain their stored expiry until their next top-up; funding extends expiry to the later of its current value and funding time plus the configured TTL. Set `credit: { ttl: 2_592_000 }` to keep a 30-day lifetime. Explicit TTL overrides remain supported; no database migration is required.

### Features

- Prepaid credit can be funded with a card. A DVM with `DVMKIT_STRIPE_SECRET_KEY` and `DVMKIT_STRIPE_NETWORK_ID` (or `stripeCredit: createStripeCreditRail(...)`) lists `stripe` in `credit.funding` with `credit.stripe: { network_id, min_micro, currency }` on a USD menu. A signed `fund` with `method: "stripe"` gets an MPP `method="stripe"` charge challenge; a credential built from a Stripe Shared Payment Token is charged once and booked as a funding lot keyed by the PaymentIntent id. Top-ups start at $0.50. Declines, unusable tokens, commitment mismatches and replays book nothing, and refusals carry Stripe's error codes but never its message text. When Stripe's answer is lost or the booking fails after a charge, the DVM returns a retryable 503; resending the same credential within five minutes books that charge instead of charging again. Card credit requires `DVMKIT_TEMPO_SECRET_KEY` as the MPP challenge-binding secret and honours its previous-key rotation window. Card-funded credit drains only back to the card, and the expiry sweep leaves expired card credit unreleased, so it is never reported as builder revenue. `/v1/job` never offers card payment. No storage migration: card lots reuse `credit_funding_lots` with `rail = "stripe"`. Receipts and the deposit report may now carry `rail: "stripe"` for card-funded draws and deposits. See `protocol-fixtures/credit-fund-stripe-v1.json`.

- Unused card credit is refunded to the card. A drain with `method: "stripe"` (no payout) refunds the balance as partial refunds of the funding PaymentIntents, oldest first, and returns `refund_ids` plus a `card_refund` block. The caller bears Stripe's fee in proportion to what is refunded: per PaymentIntent, refund = gross − round(fee × gross ÷ charged), so a $2.00 top-up with $0.30 used refunds $1.39 and keeps $0.31 of Stripe's $0.36 fee. The fee share is not builder revenue; the platform drain report carries the whole drained balance. Card credit drained by any other method, and `stripe` on non-card credit, are refused. A card refund sweep on the expiry cadence refunds expired card credit (the credit closes with the new status `refunded`), freezes credit whose funding payment is disputed (new status `disputed`), retries pending refunds without refunding twice, and refunds in full a charge that never reached a credit. Closed and frozen credits, and top-ups of expired card credit, answer `409 credit_closed`. A won dispute unfreezes the credit once Stripe shows no open or lost dispute on any of its top-ups; a lost one keeps it frozen. One card refund runs per credit at a time (`409 drain_conflict` with `blocking_drain_id`), and `stripe` drain ids are capped at 128 characters with the `expiry-` prefix reserved. Each sweep step fails on its own without stopping the pass. `docs/OPERATING.md` lists the Stripe permissions a restricted key needs. `mark-drain-sent` on a `stripe` drain retries the refund instead of recording an operator payout, and `pending-drains` shows each refund's state. Postgres gains `credit_drains.card_refund` (JSONB) and the `card_charge_attempts` journal, both created on init. Stripe is called over plain HTTPS, with no new dependency. See `protocol-fixtures/credit-drain-stripe-v1.json`.

- Unsigned callers can pay a capability with x402 when it sets the new `maxRuntimeSeconds` (1 to 600) on a DVM with `allowUnsignedPaid` and Postgres. The authorization is verified before the job and settled only if the job succeeds; a failed, cancelled or timed-out job is never settled, and a replayed authorization neither runs a job nor settles twice. Authorizations that would lapse before the job's bound are refused with `payment_authorization_too_short` before verification, and the 402 advertises a longer `maxTimeoutSeconds`. Exact settlement intents gain a `released` status (no DDL; the status column is unconstrained text). Tempo stays signed-only. See `docs/PROTOCOL-NOTES.md#unsigned-x402-payments`.

- Accepted job responses and request recovery now expose optional `upfront_payment` metadata with the original credit hold or rail payment, exact recorded amounts and credit/draw correlation. The snapshot survives later payments, draw growth and exchange-rate changes; historical jobs remain unknown and explicit zero stays distinct. Job stores gain an optional, insert-only `upfrontPayment` fact backed by a nullable Postgres column. See `protocol-fixtures/upfront-payment-v1.json`.

- Mid-job rail payments that fund a job's credit against its pending draw now leave signed evidence. The server fixes a `credit_fundings` row (with new nullable `job_id`, `draw_id`, `payment_seq` columns) inside the rail transaction and issues a `credit_draw_funding` receipt from it: returned as `draw_funding_receipt` on the payment `201`, on the `503` snapshot-failure and `500` unapplied bodies, on a `409 replay_rejected` for the same payment, and as `draw_funding_receipts` on every authenticated job read, including after a restart. The caller credit store admits verified evidence with `recordDrawFunding` (or inline on `applyReceiptCredit`) and compares a completed draw as prior remaining plus eligible funding minus the draw, so a self-funded grown draw no longer raises a false balance warning while a contradictory terminal balance still does. `CreditLedgerLike` gains optional `listDrawFundings` and optional `recordFunding` bindings; `FundingRecord.receipt` and `saveFundingReceipt` now carry `CreditFundingEvidence`, the union of opening and draw funding receipts discriminated by `kind`. The portable contract is `protocol-fixtures/credit-draw-funding-v1.json`.

### Bug fixes

- An ask that withheld x402 because the job's credit holds another rail used to clear the job's x402 binding, so an x402 payment sent anyway settled and landed as balance. The job now keeps a nonce nobody was shown and the payment is refused before it settles. On hosts without a database, an x402 payment bound to another job's nonce is now refused before the facilitator is called, rather than after it settled.

- `applyReceiptCredit` now checks a receipt whose `settlement.charged` is positive on every ending, not only completions, against the caller's prior balance plus verified draw funding.

- Requests with no signing envelope now receive HTTP 401 `auth_error` with `signature_required` and instructions for signing through the CLI or protocol. Malformed envelopes and wrong signatures retain `signature_invalid`; eligible unsigned paid calls retain their 402 challenge. Clients that enumerate auth sub-reasons must accept the new value. See `protocol-fixtures/signature-required-v1.json`.

- A DVM no longer crashes at startup when one of its NWC relays accepts the TCP connection but never completes the WebSocket handshake. The connection timeout used to close the still-connecting socket after its error listener had been removed, so the socket's error went unhandled and terminated the process. The relay now counts as unreachable, and the other relays carry the request.
- NWC requests now return a transport error when a relay socket closes between connection and publication, instead of leaving an unhandled rejection that can terminate the process. The pinned `nostr-tools` dependency is updated to 2.25.4, whose publish path handles send failures; Lightning invoice funding returns its existing unavailable response.

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

## [0.25.0](https://github.com/dvmkit/sdk/compare/v0.24.0...v0.25.0) (2026-11-03)

### Breaking API changes

Card top-ups now default to $5 instead of $0.50. Set `DVMKIT_STRIPE_MIN_USD` or `createStripeCreditRail({ minUsd: ... })` to choose a card-only minimum. Explicit settings must be at least $0.50 and no greater than `credit.max`; invalid settings fail boot. The effective minimum respects `credit.min` and Stripe's $0.50 floor, and the default is capped at `credit.max` so menus below $5 can still offer cards. Other rails and `credit.min` are unchanged. `CreditTerms.stripe` now preserves validated card terms when parsing a credit menu; no public export is removed or renamed.

### Migrations

To retain the previous card floor, set `DVMKIT_STRIPE_MIN_USD=0.50` before upgrading, or pass `minUsd: 0.50` to `createStripeCreditRail`. Otherwise existing card-enabled DVMs advertise the new $5 default, capped by their credit maximum. No database or wire-format migration is required.

### Compatibility requirements

Node.js 22 or newer. No dependency floor changes from 0.24.0.

### dvmctl and platform prerequisites

None. This release introduces no new minimum CLI version or platform capability requirement for the supported builder APIs.


### ⚠ BREAKING CHANGES

* **stripe:** default the card top-up minimum to $5 and let builders set it

### Features

* **stripe:** default the card top-up minimum to $5 and let builders set it ([d5ae56b](https://github.com/dvmkit/sdk/commit/d5ae56b54da732e3a1fc217df62977f9060108c5))


### Bug Fixes

* **credit:** preserve card terms in caller parsing ([f4e6507](https://github.com/dvmkit/sdk/commit/f4e650720e9893fd6029724b753756e2385b09e3))

## [0.24.0](https://github.com/dvmkit/sdk/compare/v0.23.0...v0.24.0) (2026-11-03)


### Features

* **stripe:** attribute card-credit charges to the server identity ([355ae40](https://github.com/dvmkit/sdk/commit/355ae40f1009908eb3afcb02609703bc64a5f787))


### Bug Fixes

* **nwc:** survive a relay that never completes the WebSocket handshake ([#102](https://github.com/dvmkit/sdk/issues/102)) ([177f182](https://github.com/dvmkit/sdk/commit/177f1828fb4e232f8e3f84f495ac7bc58aee402c))

## [0.23.0](https://github.com/dvmkit/sdk/compare/v0.22.0...v0.23.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* **credit:** a caller's cancel charges the paid pieces including the one in progress, and an ask is never covered by the upfront payment. CreditLedgerLike.resolveDraw is required. StreamableJobStore.appendOutgoing refuses an ask on a terminal job with JobEndedError and finishes the running piece on a payment-request; verifyAndCredit appends PaymentCreditDelta.piece; terminal writes freeze JobRecord.settlement, which the built-in stores own after insert. Postgres initialization adds jobs.pieces and jobs.settlement. A second open ask rejects with ask_already_open, and receipt credit.amount is the charged amount.
* **payment:** StreamableJobStore.verifyAndCredit takes landing options and may report creditRefused; job_messages gains the balance row status; custom job stores must implement payment intents.

### Features

* **credit:** charge mid-job work by the piece ([#100](https://github.com/dvmkit/sdk/issues/100)) ([9dd3d63](https://github.com/dvmkit/sdk/commit/9dd3d63eed096fd0872059139f7111379af222e1))
* **credit:** settle part of a credit draw ([#95](https://github.com/dvmkit/sdk/issues/95)) ([d468aac](https://github.com/dvmkit/sdk/commit/d468aacbc2eff035d7712769a1c937618478c139))


### Bug Fixes

* **credit:** release a draw held on a closed x402 channel in both ledgers ([#97](https://github.com/dvmkit/sdk/issues/97)) ([221c338](https://github.com/dvmkit/sdk/commit/221c338f80171410da9428f5be903c0031e5de65))
* **payment:** decide what a mid-job payment pays for when it arrives ([#99](https://github.com/dvmkit/sdk/issues/99)) ([f16cb02](https://github.com/dvmkit/sdk/commit/f16cb02780221977a84aafcb17e906454a6d3be2))
* **x402:** withhold an unsigned job's output until its payment settles ([1a0e693](https://github.com/dvmkit/sdk/commit/1a0e69341ecfb1ab33cc1141b043fa686c43a509))

## [0.22.0](https://github.com/dvmkit/sdk/compare/v0.21.2...v0.22.0) (2026-11-02)


### Features

* **credit:** fund prepaid credit by card through Stripe shared payment tokens ([#92](https://github.com/dvmkit/sdk/issues/92)) ([e3f9ae0](https://github.com/dvmkit/sdk/commit/e3f9ae0541f57b5dc3f00cf4775311fbdf1a9024))
* **credit:** refund card-funded credit to the card ([#94](https://github.com/dvmkit/sdk/issues/94)) ([e3259ac](https://github.com/dvmkit/sdk/commit/e3259ac26088183b6af4ac74af9b5611ab38ddaf))

## [0.21.2](https://github.com/dvmkit/sdk/compare/v0.21.1...v0.21.2) (2026-11-02)


### Bug Fixes

* **auth:** distinguish missing request signatures ([ca3ba0a](https://github.com/dvmkit/sdk/commit/ca3ba0ae72b8f5a1f6aa12c70302826eb5e77b15))

## [0.21.1](https://github.com/dvmkit/sdk/compare/v0.21.0...v0.21.1) (2026-11-02)


### Bug Fixes

* park JIT refunds without enabling Cashu receiving ([238bf6a](https://github.com/dvmkit/sdk/commit/238bf6a828664cb1803fc54f7d67a0095c3a970e))

## [0.21.0](https://github.com/dvmkit/sdk/compare/v0.20.0...v0.21.0) (2026-11-01)


### Features

* inline artifact messages on paid NUT-24 retries ([#87](https://github.com/dvmkit/sdk/issues/87)) ([64cd56a](https://github.com/dvmkit/sdk/commit/64cd56acf3c5c768090854e94be9abccc5a1556a))

## [0.20.0](https://github.com/dvmkit/sdk/compare/v0.19.1...v0.20.0) (2026-11-01)


### Features

* return short NUT-24 job results inline ([a125413](https://github.com/dvmkit/sdk/commit/a125413eb1c3ef9f41bd8ee3248f7d2f4807e11f))

## [0.19.1](https://github.com/dvmkit/sdk/compare/v0.19.0...v0.19.1) (2026-11-01)


### Bug Fixes

* contain closed NWC relay publish failures ([16e43de](https://github.com/dvmkit/sdk/commit/16e43dee923a45b61caa87cffc1c82ccd269b50c))
* persist terminal output before settling credit ([4b9f7c6](https://github.com/dvmkit/sdk/commit/4b9f7c67daf0de3a37bdc60137e4b7741045ff98))

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
