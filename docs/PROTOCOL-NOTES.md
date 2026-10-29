# Protocol notes

## Payment method discovery

An explicit `paymentMethods` list bounds `payment.methods` on `/v1/info` and `/v1/quote`, the top-level `x402` and `tempo` info blocks, and credit funding rails and terms on info, quotes, and unpaid job responses. Excluded x402 and Tempo blocks are omitted rather than emitted empty. Lightning remains an independent receive-only credit funding leg. The [portable example](../protocol-fixtures/payment-method-discovery-v1.json) describes an x402/Tempo-wired DVM restricted to Cashu.

Omitting the override preserves derived defaults, including independent x402 batch credit funding when hosted exact payment is unavailable. Availability, currency support, and stablecoin-credit opt-in still filter the allowed methods. This corrects discovery on older servers that could expose excluded rails; it adds no wire fields or storage migration.

## Payment message history

Requester `payment` messages in `GET /v1/job/:id/messages` (JSON or SSE) and saved job history are published only after the server accepts the payment through its verification and accounting flow. Pending and rejected attempts are omitted, including attempts that fail signature verification. A rejected attempt does not satisfy the outstanding payment request; a later valid payment can still be accepted. Explicit development-mode acceptance follows the same history rule even when verification is bypassed.

An unsupported payment method is rejected with HTTP 402 `payment_invalid`, rather than acknowledged without verification. While a payment is pending, message reads and streams hold later output behind it so an `after` cursor cannot skip a payment that is accepted later. Every host, including the active worker, uses the shared store's message sequences and delivery cutoff. Rejection releases that output without publishing the rejected attempt; completion, failure and cancellation release final output immediately. Payment sequence bindings remain unchanged.

Terminal snapshots retain every verified message, including accepted payments beyond an unresolved earlier attempt. `StreamableJobStore.getMessages` accepts an optional third argument `{ includeHeld: true }` for this complete verified read; custom stores that implement the delivery cutoff must honor this option when building terminal snapshots. Incremental reads retain the cutoff by default, and terminal history remains readable after incremental rows are cleaned up.

Message sequences can have gaps where attempts were rejected. A history entry records acceptance, not final job settlement, and does not by itself prove that all funding was applied to the job: retain any credit explanation and signed funding or settlement evidence returned by the server. An absent entry alone does not authorize another spend after an unknown outcome; use the payment method's recovery evidence. Older servers and snapshots created before this fix may contain rejected payment attempts without a rejection marker; those entries cannot establish acceptance under this contract. No wire fields or storage migrations are added, and old snapshots are not rewritten.

## Accepted upfront payments

Successful submit (`POST /v1/job`), request-resume and request-result responses, and authenticated job reads, may carry `upfront_payment`. It records the original accepted payment before the handler runs. `amount_msats` is an integer millisatoshi value from the accepted payment or committed credit allocation, not a new quote or conversion at the current exchange rate. When a draw exists, `amount_micro` and `currency` preserve its exact credit denomination in integer millionths; `native_amount` and `native_asset`, when present, describe its allocated rail-native atomic units. A funding deposit may exceed all of these job amounts.

`credit_id` and `draw_id` together identify credit consumption, including an implicit credit opened by a per-call payment. `rail` identifies the rail that funded that credit, not a fresh payment on recovery. Without a credit draw, the block reports the verified per-call rail payment. No payment credentials are included. The portable examples are in [upfront-payment-v1.json](../protocol-fixtures/upfront-payment-v1.json).

For a credit-backed job the block describes the **hold at acceptance**. Completion settles the draw; failure or cancellation releases it. Later top-ups, draw growth, settlement repricing, refunds and exchange-rate changes do not rewrite the acceptance snapshot. It is neither a current balance nor a signed terminal receipt. Use the terminal receipt for final settlement evidence; do not count the funding deposit and its job draw as two payments for the same service.

An explicit `amount_msats: 0` is known zero in that unit; a positive `amount_micro` can still describe a credit hold whose allocated millisatoshi value rounded to zero. An absent block means unknown, including jobs accepted by older servers and development submissions that bypass verification. Callers must not substitute zero for absence. Caller transport result types expose this block as optional `upfrontPayment`, retaining snake_case inside the block.

The additive nullable `jobs.upfront_payment` column is written only when the job is first inserted. Existing records are not backfilled from cumulative totals or current draws. Custom job stores must preserve this field through reads and snapshot saves without replacing the first stored value, including its absence. Deploy the upgraded writer to obtain the field on new jobs; older writers and older job records can still omit it.

The supported public type is available without a deep import:

```ts
import type { JobRecord, UpfrontPayment } from "@dvmkit/sdk";

function originalHold(job: JobRecord): UpfrontPayment | undefined {
  return job.upfrontPayment;
}
```

## Cashu lock requirements

A Cashu payment on `X-Cashu`, a mid-job `payment` message or `POST /v1/credit` must be spendable only by the DVM until the batch melt, and in a form the DVM can sign and the mint can redeem. Each proof must be NUT-11 P2PK-locked with `data` set to one of `cashu.lock_pubkeys` from `/v1/info` (the first entry is current; later ones are retired keys still in grace), written as a 33-byte compressed hex key (66 hex characters, `02` or `03` prefix, no whitespace); x-only keys are refused. The only tags allowed are `locktime`, `refund`, `pubkeys`, `n_sigs`, `sigflag` and `n_sigs_refund`. Each may appear at most once and must carry at least one value; `locktime`, `n_sigs`, `sigflag` and `n_sigs_refund` carry exactly one. Any other tag is refused. A `pubkeys` tag may name only other `cashu.lock_pubkeys` entries, with no key repeated across `data` and `pubkeys`. `n_sigs`, if present, must be `1`, and `sigflag`, if present, must be `SIG_INPUTS`. `refund` keys must be distinct compressed keys, and `n_sigs_refund` must be a positive integer no larger than the number of refund keys. A `locktime` tag must be a plain decimal unix-seconds value, with or without `refund`, and at least `cashu.min_locktime` minus 24 hours after the moment the DVM receives the payment. An unsigned `POST /v1/job` payment sent without `X-Cashu-Request-Id` ([NUT-24 payment requests](#nut-24-payment-requests)) is held instead to the unsigned floor, with no 24-hour margin: `cashu.unsigned_min_locktime` seconds after receipt when `/v1/info` advertises it, otherwise `cashu.min_locktime` minus 24 hours ([Refund-locktime floors](#refund-locktime-floors)). A proof with no `locktime` is accepted. A secret the cashu-ts signer cannot parse is refused. A `data` key that is not a DVM key in that form returns HTTP 402 `wrong_lock_pubkey`; any other refused lock returns HTTP 402 `lock_not_exclusive`. Both answer 400 instead for a `POST /v1/job` payment sent without `X-Cashu-Request-Id` ([NUT-24 payment requests](#nut-24-payment-requests)). Both are decided before the mint is contacted or anything is recorded. The refusal's `hint` names the floor that applied: `cashu.min_locktime` minus 24 hours, or `cashu.unsigned_min_locktime`. A retry of a payment the DVM already banked still returns `409 replay_rejected` after its locktime has dropped below whichever floor applies to the retry. An `X-Cashu-Request-Id` (or a mid-job payment's `cashu_request_id`) belongs, per DVM, to the first proof set banked under it. A payment whose proofs are all new to the DVM but whose request id is already used, upfront on `/v1/job`, in a mid-job `payment` message or on `POST /v1/credit`, is refused with HTTP 409 `request_id_reused` before anything is recorded, so nothing is charged and the same proofs can be sent again under a new request id. A `POST /v1/job` retry with already banked proofs gets the original job's response back, `job_token` included, only when every presented proof was accepted under the retry's `X-Cashu-Request-Id`, the body matches the paid request and, on a signed DVM, the same key signs it. Any other presentation of banked proofs, including proofs accepted under different request ids, gets `409 replay_rejected` with no job and changes nothing.

## NUT-24 payment requests

A `POST /v1/job` that needs no signature (any request to a DVM without auth, or an unsigned request to a DVM built with `secp256k1Auth({ allowUnsignedPaid: true })`) can be paid the [NUT-24](https://github.com/cashubtc/nuts/blob/main/24.md) way. When such a request needs a payment and carries none, a DVM that takes P2PK-locked Cashu answers its HTTP 402 `payment_required` with an `X-Cashu` header holding a NUT-18 `creqA` payment request: `a` is `required_msats / 1000` rounded up, `u` is `"sat"`, `m` is the mint list `/v1/info` advertises as `cashu.mints`, and `nut10` is `{ kind: "P2PK", data: cashu.lock_pubkeys[0], tags: [] }`. It names no id, description, single-use flag, transport or `locktime`, so payment is in-band. As NUT-18 specifies, `a` is what the DVM must receive net of the mint's NUT-02 input fee: the payment counts as its proofs' face value minus the fee to spend them, so the wallet adds that fee on top of `a`. At a mint with no input fee the two are equal. No other response carries `X-Cashu`: not a refused payment, not a 409, not `POST /v1/credit`, and not a signed request's 402, which still needs `X-Cashu-Request-Id` to pay. A development host's CORS policy exposes the header to browser wallets.

The wallet retries with only `X-Cashu: cashuB…`. The token must meet the [Cashu lock requirements](#cashu-lock-requirements). With no `X-Cashu-Request-Id`, the payment is bound to `nut24-` followed by the hex SHA-256 of its JSON-encoded, sorted proof secrets, and that id takes the place of a request id everywhere: in the accumulator's replay binding, as the job's payment reference and as the implicit credit's funding id. Retrying the same token with the same body returns the original job, `job_token` included, and records nothing new; the same token with another body gets `409 replay_rejected` and no job. A header-less payment refused for a reason the payer can fix answers HTTP 400 with the usual JSON body: `invalid_token` (a mint outside `m`, a unit other than sat, missing DLEQ evidence or an unreadable token), `not_p2pk_locked`, `wrong_lock_pubkey`, `lock_not_exclusive` and `payment_insufficient`. Other refusals keep their status, including `proof_not_unspent` (402), `proof_pending` and `mint_unreachable` (402), `mint_health_pending` and `cashu_mint_sick` (503), and `replay_rejected` (409). A short header-less payment is kept, exactly as a short payment with a request id is, and answers 400. Requests that send `X-Cashu-Request-Id` answer as before, except that an id starting with `nut24-` is reserved for derived ids: `POST /v1/job` refuses it with HTTP 400 `reserved_request_id` before pricing or recording anything, with or without a token, and the receive path refuses it the same way on a mid-job payment's `cashu_request_id` and on `POST /v1/credit`. Without that refusal a caller could claim another payer's derived id first and have the honest payment turned away.

A USD price is converted to sats from a rate the DVM refreshes every few minutes, so the `a` a wallet was shown can fall short a moment later. A header-less payment that covers the price at the rates the current ones replaced, but not at the current ones, is accepted and valued at the earlier rates while those rates last priced something (a quote or a 402) less than 10 minutes ago: long enough for a wallet to read the 402, prepare proofs at its mint and resend, short enough that an old quote does not stay payable for the life of the next one, and a DVM that sat idle through a rate change honours no hold when it wakes. The hold is taken from the rates this request was priced at, so a refresh landing while the payment is verified does not move it. One that covers neither is short. A payment sent with `X-Cashu-Request-Id` gets no hold.

## Caller response deadlines

Every newly emitted `prompt` and `payment-request` carries `content.expires_at_ms`, an integer Unix millisecond deadline equal to emission time plus the DVM's `idleTimeout` in milliseconds. The window starts when the handler asks, and ends when the matching response or verified payment satisfies that ask. Text and unrelated responses do not extend it. This includes event-driven requests emitted through `ctx.sendMessage`, which keep callback dispatch semantics. Processing without an outstanding ask has no idle timer; worker liveness remains governed by `processingWatchdog`.

`configureDVM` accepts `idleTimeout` as a whole number of seconds from 1 through 604800 (seven days), defaulting to 3600. Replayed requests retain their original deadline and payment challenge. With concurrent prompts, the earliest outstanding deadline governs cancellation; answering one does not extend the others. Expiry is attributed to the caller.

If a worker dies after input verifies but before claiming it, recovery can fail the abandoned job as a provider failure and release its pending draw. This waits for both the stale-wait threshold and processing watchdog grace period; verified input remains in the terminal history.

The wire field is optional for compatibility with older servers; callers may ignore it. Legacy persisted waits without a stamp retain their timeout fallback, and older server versions cannot enforce the new semantics during a mixed-version rollout. No storage migration is required. Portable examples are in `protocol-fixtures/caller-deadline-v1.json`.

## Durable steps

`ctx.step(id, fn)` caches a completed operation's result and cost declarations for handler replay. With Postgres, or a custom `JobStore` implementing optional `saveStep`, the SDK waits for the step record's durable write before resolving the step. Each write updates only the step cache; it does not rewrite the message log. Writes are attempted at most three times, with 50 ms and 100 ms backoffs. If all attempts fail, the SDK emits `step_persist_failed` and returns the result anyway: the external action may already have happened. That result remains available to later yield and terminal snapshots, but is not yet guaranteed durable. Custom stores without `saveStep` retain yield/terminal snapshot persistence. In-memory stores cannot survive process death.

Steps have **at-least-once** execution semantics. A body can run more than once if the process dies mid-body, after an external side effect but before the result is stored, or after exhausted persistence retries. For irreversible actions, pass `${ctx.jobId}:${stepId}` as an idempotency key to an external API that honours it, or check that system for a prior result before acting:

```ts
const stepId = "reserve-instrument";
const reservation = await ctx.step(stepId, () =>
  instrument.reserve({
    idempotencyKey: `${ctx.jobId}:${stepId}`,
  })
);
```

The job id and step id stay stable across replay. A cached step returns its stored value and replays its cost declarations without calling the body. Step ids must be unique within a job. This does not add recovery of abandoned processing jobs; their existing watchdog behavior is unchanged.

Compatibility: `JobStore.saveStep` is additive and optional, and uses the existing `step_cache` column without a migration. Implementations preserve the first stored record for each step id, keep those records through later snapshots, and reject writes to missing, terminal or redacted jobs.

## Balance-backed mid-job payments

A server advertising `credit.balance_payment: true` accepts a signed balance authorization on the existing `POST /v1/job/:id/messages` endpoint with the existing job token. This capability requires the SDK's Postgres job store and credit ledger on the same database, descriptor authentication, and an audience verified from the builder attestation. The normal Postgres host wires these together. In-memory development stores and custom job stores withhold the capability; ordinary messages and rail payments keep their existing contract. The memory ledger enforces expiry and its configured x402 refund gate for `growDraw({ spendExistingBalance: true })`. Fresh growth on Tempo-bound memory credit returns `tempo_channel_closing` because this store cannot verify the durable channel lifecycle; ordinary accepted rail growth retains its existing behavior.

A `payment-request` may include `content.credit: { amount_micro, currency }`. These are the exact uncovered ask in integer millionths of the credit denomination, pinned when the ask is persisted. Use the enclosing message's `seq` as `request_seq`. If exact denomination is unavailable, this field is absent and callers must use an offered rail.

Send `{ type: "payment", content: { credit: authorization } }`. The authorization contains `credit_id`, `draw_id`, `payment_id`, `request_seq`, `amount_micro`, `currency`, and the existing `pubkey`, `signature`, `timestamp`, `nonce`, `auth_statement` envelope. Sign it with the existing caller signing API. Its audience is the verified service identity, method is `POST`, path is the concrete messages path including the job ID, and capability is `null`. No rail credential or other payment content may accompany `credit`. Currency names are lowercase ISO 4217 codes. A zero-upfront job can bind its first draw; a job already holding a draw must name that same credit and draw.

Success is HTTP 201 `{ seq }`, naming the durable verified inbound message. `payment_id` is a separate host-wide identity, independent of funding, draw and drain IDs. Reusing an accepted identity with identical monetary fields, owner, job and signing domain returns the original status and body, even after completion, restart or expiration of the signature's freshness window. A newly signed envelope for the same accepted intent also recovers that result. Altered reuse returns HTTP 409 `credit_payment_conflict`. Retain the exact authorization and identity through ambiguous delivery; never create another spend to recover a lost response.

Fresh authorization still checks signature freshness, job ownership, credit ownership, draw binding, and the persisted outstanding ask before holding money. Competing IDs for one ask serialize; once one pays it, another receives HTTP 409 `credit_payment_ask_mismatch`. That same error covers a stale sequence, changed amount or changed ask currency. HTTP 409 `credit_payment_currency_mismatch` means the named credit has a different denomination; `credit_payment_owner_mismatch` means it does not belong to this caller and job. These refusals move no money: refresh the job or refuse locally. They do not authorize an invented rail fallback. Existing authentication errors and job-token refusals remain unchanged. Expired, closed or settlement-blocked credit returns its existing ledger error with HTTP 409 and no debit.

HTTP 402 `{ error: "insufficient_credit", remaining_micro, shortfall_micro }` moves no money and keeps the ask available for an ordinary rail payment. It does not reserve the payment ID; the same intent may be retried after funding. HTTP 400 `invalid_message` refuses mixed credit and rail content. Unsupported storage returns HTTP 409 `balance_payment_unavailable`.

Fresh balance growth also uses the existing hosted obligation fence, so a closed host cannot acquire a new hold. The credit/channel locks, draw placement or growth, job accounting, verified inbound and original response commit together. Completion settles the complete draw and includes its total in the existing receipt credit block. Failure or cancellation releases the whole hold to caller-owned spendable credit, available to the existing drain lifecycle. Balance spending creates no funding deposit and retains one draw and one revenue basis per job.

### Release compatibility

- **Breaking API changes:** none. `PaymentContent.credit`, `PaymentRequestContent.credit`, `CreditTerms.balance_payment`, the optional `JobCounters.balancePaymentSatisfied` field, and `growDraw`’s `spendExistingBalance` / `hostingPaymentSeq` options are additive. Generated declarations and the API reference record them; exported names are unchanged.
- **Migrations:** Postgres initialization adds `credit_balance_payments`. Keep its payment identities for durable retry recovery. No caller or builder configuration migration is required.
- **Compatibility requirements:** unchanged Node and dependency requirements. Callers must negotiate `balance_payment: true` before using this authorization; older clients continue sending rail payments.
- **Builder CLI and platform prerequisites:** none. Custom storage implementations do not acquire this capability automatically.

Deploy all workers that share a job database before enabling this capability. An older worker does not understand the exact balance-paid wake signal; it may leave its original handler waiting or race a newer reactivation on a later ask. Payment IDs still prevent another debit, but mixed-version handler continuation is not a supported rollout. Set `DVMKIT_BALANCE_PAYMENTS=false` on upgraded workers during the rollout: it removes advertisement and refuses new balance-payment requests without debiting. After every worker is upgraded, remove the setting and restart them to enable support. Advertisement is per process; do not enable it on only part of a shared worker fleet. Ordinary rail payments continue throughout. Accepted payment identities remain recoverable through the switch; it blocks fresh spends only.

The portable signing bytes and responses are in `protocol-fixtures/balance-payment-v1.json`.

## Mid-job draw funding evidence

A rail payment accepted on `POST /v1/job/:id/messages` while a job runs funds the job's credit and grows its pending draw in one ledger step that allocates no sequence. The terminal receipt's `credit.balance_after` therefore includes that money while a caller projection anchored before the draw does not. The server now records every such funding as a `credit_fundings` row keyed on the rail payment id, with the job, draw and accepted payment message sequence, inside the same transaction as the processed-payment marker, the fund and the growth, and signs a `credit_draw_funding` receipt from that row with the per-DVM receipt key.

The artifact is `{ v: 1, kind: "credit_draw_funding", credit_id, job_id, draw_id, fund_id, payment_seq?, currency, funded_micro, balance_after_micro, ledger_seq, issued_at, caller_pubkey, dvm_id, dvm, receipt_pubkey, signature }`. `fund_id` is the rail payment id. `funded_micro` is the provider's credited amount after its own denomination and fee rules, never the caller's request figure. `ledger_seq` is the draw's own sequence, the value the terminal `credit.ledger_seq` names; `balance_after_micro` is the spendable balance immediately after the funding and any growth committed. Signing and verification use the existing receipt canonicalisation and attestation chain. Opening and `/v1/credit` funding receipts keep `kind: "credit_funding"` and their meaning; a job-bound funding row is never signed as one, so a fund replay that names a mid-job payment id carries no `funding_receipt` and the draw funding artifact stays issuable. `payment_seq` is the accepted inbound payment sequence, fixed in the signed funding evidence; it is omitted when the job store does not number inbound messages.

The successful payment response is HTTP 201 `{ seq, credit?, draw_funding_receipt? }`. The same artifact rides the `503 job_snapshot_unavailable` and `500 payment_unapplied` bodies, because the funding committed before those failures. A replayed x402, Tempo or Cashu payment returns its existing `409 replay_rejected` with `draw_funding_receipt` when the DVM can name the payment it collided on; a replayed exact x402 settlement recovers as before and carries it on the 201. Authenticated `GET /v1/job/:id` returns `draw_funding_receipts`, oldest first, reissued from the committed rows when an acknowledgement was lost or the process restarted; the key is omitted when there are none. Balance-paid asks fund nothing and produce no artifact. Free-then-paid jobs open an implicit credit and produce none either. Payments that grew nothing still produce one, because the balance moved.

In the successful standard message response, acknowledgement `seq` is the latest message position observed after dispatch. Provider messages emitted during dispatch can advance this cursor, so it can equal or exceed the accepted payment's sequence. It does not replace signed `payment_seq` or the credit draw's `ledger_seq`. Separately, `503 job_snapshot_unavailable.seq` identifies the recorded inbound payment, not a post-dispatch cursor.

For example, a payment accepted at message sequence 8 retains signed `payment_seq: 8`. If the provider emits message 9 during dispatch, the acknowledgement returns `seq: 9`. This 8/9 pair is valid when all existing funding verification requirements pass: cursor equality is not required, and neither equality nor a cursor value alone establishes validity. A larger acknowledgement cursor relaxes none of the signature verification or caller, service, credit, job, draw, payment, currency, and ledger binding checks.

Caller reconciliation: admit each artifact through `recordDrawFunding`, or pass it to `applyReceiptCredit` as `drawFundings` so admission and comparison share one lock. Admission verifies the signature, the caller, the credit, the currency and the provider chain; an attested record requires the artifact to chain to its own builder. The completed-draw comparison becomes `remaining + sum(funded_micro of facts bound to the receipt's draw_id and ledger_seq) − amount`. A fact applies once, only to that receipt, and is refused as already reflected when the projection is anchored at or beyond its sequence. Absent, invalid, wrong-bound or duplicate evidence leaves the existing comparison and warning in force.

### Release compatibility

- **Breaking API changes:** none. New `./internal` names: `DrawFundingReceipt`, `UnsignedDrawFundingReceipt`, `signDrawFundingReceipt`, `isDrawFundingReceipt`, `verifyDrawFundingReceipt`, `verifyDrawFundingReceiptChain`, `DrawFundingReceiptChecks`, `DrawFundingReceiptVerifyResult`, `recordDrawFunding`, `RecordDrawFundingResult`, `DrawFundingRejection`, `StoredDrawFunding`, `SendMessageResult`. New `./server` name: `CreditFundingEvidence`. `FundingRecord.receipt` and `saveFundingReceipt` now carry that union; narrow on `kind`. `CreditLedgerLike.listDrawFundings` and the `recordFunding` bindings are optional; a ledger without them issues evidence only on the original acknowledgement. `Transport.sendMessage` may resolve a `SendMessageResult`; existing implementations resolving `void` remain valid.
- **Migrations:** Postgres initialization adds nullable `job_id`, `draw_id` and `payment_seq` columns to `credit_fundings`. Existing rows are unaffected; a persisted exact x402 settlement effect from before this release reads the draw's sequence off the draw.
- **Compatibility requirements:** unchanged Node and dependency requirements. Older callers ignore the new fields; newer callers degrade to the existing comparison when a server issues no evidence.
- **Builder CLI and platform prerequisites:** none.

The portable artifact, canonical bytes and response shapes are in `protocol-fixtures/credit-draw-funding-v1.json`.

## Completed credit draw refunds

`POST /admin/credit/refund-draw` uses the existing signed builder-admin authentication. Its JSON body names either `jobId` or `creditId` plus `drawId`, a required caller-chosen `refundId`, an optional positive safe-integer `amountMicro`, and an optional `reason` of at most 280 characters. Omitting the amount means the draw's remaining unrefunded charge. The amount is in millionths of the original credit currency. A refund restores spendable credit; the caller can spend it again or reclaim it through the existing drain.

The server entry point also exposes `CreditDrawRefundArgs` and `CreditDrawRefundResult`. Custom `CreditLedgerLike` stores must implement `refundDraw`; production implementations must commit accounting and the outbox atomically. `MemoryCreditLedger` provides development accounting only and is refused by the admin route.

The success response contains `status: "refunded"`, `refund_id`, `credit_id`, `draw_id`, `job_id`, `amount_micro`, `currency`, `ledger_seq`, `refunded_at`, `balance_after_micro`, and `replayed`. Repeating the same ID and arguments returns the persisted original amount, currency, sequence, timestamp, and balance after that refund. That balance is historical, rather than the caller's current balance. An omitted amount stays the same remainder intent on retry; changing it to an explicit amount is a conflict even when the numbers match.

Eligibility refusals carry relayable `hint` text: `draw_not_found` (404), `draw_not_completed`, `refund_exceeds_draw`, `credit_not_open`, `credit_refund_channel_unsupported`, `credit_refund_state_unavailable`, and `credit_refund_basis_unavailable` (422). A changed-argument reuse returns `refund_conflict` (409). Missing persistent accounting or platform reporting returns `credit_refund_unavailable` (503) before any money changes. Existing malformed-request and authentication conventions remain. Tempo and reusable x402 channel credits cannot back a refund of already settled spending; unused channel collateral returns through its channel lifecycle.

The credit balance, rail remainder, refund history, funding lots, and report outbox row commit together. A failed enqueue rolls everything back. The new outbox kind `refund` sends `POST /_internal/credit-draw-refund` with `dvmId`, `creditId`, `drawId`, `jobId`, `refundId`, `amountMicro`, `creditCurrency`, `ledgerSeq`, `refundedAt`, and optional `reason`, authenticated with the existing DVM bearer token. The platform deduplicates by refund identity. A missing original revenue event returns 409 and remains queued for retry; cumulative excess returns 422 and becomes stale for operator inspection. Existing transport backoff and 24-hour abandonment remain. The [portable fixture](../protocol-fixtures/credit-draw-refund.json) pins the request, success, report, and historical-evidence refusal shapes.

Bitcoin refunds restore the original settled sats, never a current exchange rate or the draw's pooled forecast. For original micro amount `M`, proven settled sats `S`, and cumulative refunded micro `R`, restored sats total `floor(S * R / M)`. Each refund restores only the increase, so a full refund returns exactly `S` regardless of partial-refund sizes. Integer rounding may produce a valid zero-sat lot. Such a lot stays explicitly known-zero through later settlement, liability reporting, and reclaim; it never triggers live-rate pricing.

Schema initialization adds nullable `credits.last_funding_ledger_seq`, `credit_draw_refunds`, nullable `credit_draws.settled_sats` and `credit_draws.refund_dvm_id`, and `credit_funding_lots.sats_basis_known` defaulting to false. Historical positive lots remain priced; historical zero-sat lots remain unknown. New fully priced settlements record their authoritative sats even when equal to their forecast. Only an authoritative actual-settlement `settled_sats` value, including zero, authorizes Bitcoin restoration. An old `allocated_msats` repricing marker alone does not independently establish the original payment value. Retained funding receipts establish deposits rather than a completed draw's consumed lot allocation, so this route has no automatic proof path for older completed Bitcoin rows missing `settled_sats`. Those rows, retained forecasts, missing/basisless lots, and absent rail identity refuse with `credit_refund_basis_unavailable`. An operator must inspect independent original-payment evidence before arranging a repair; retrying alone does not establish it. The route accepts no caller-supplied proof or asset-basis override and never infers basis from timestamps, the installed SDK version, or current FX.

Refunds also require immutable DVM ownership evidence from the job, its verified retained receipt signed by the DVM's configured receipt key, or its durable terminal-report claim. A receipt with a valid signature under its own embedded key proves no DVM identity unless that key matches trusted server configuration. Without a configured receipt key, that receipt is ignored as ownership proof. Conflicting or absent ownership evidence refuses before accounting. The first accepted refund persists that owner on the draw, preserving later refunds after job retention. A refund-ID replay remains bound to that same configured DVM and survives receipt-key rotation through its persisted owner.

A successful positive funding records the current ledger sequence as an internal funding watermark without allocating a new sequence. Refund eligibility combines that order with drain balance-after and subsequent positive draws; free draws alone do not reopen a drained credit. The financial evidence export adds `draw_refunds` and these funding, ownership, and basis fields while excluding the request and free-text reason. For an active zero-balance credit, a latest non-released full drain with no evidence of later positive funding or activity is closed when the recorded funding watermark proves that order. It refuses with `credit_not_open`. If that watermark is absent and retained facts cannot distinguish closure from reopening, it refuses with `credit_refund_state_unavailable`. An operator must inspect independent funding and drain evidence before arranging a repair; retrying alone does not establish order. Proven reopened credits remain eligible, and exact refund-ID replay returns its original facts before either historical-evidence check.

Deploy the platform report endpoint first. Upgrade **every SDK process sharing the credit ledger and report outbox before issuing the first refund**, including retry workers. Pause monetary writes during this upgrade, and resume only after every ledger/outbox reader and writer uses the new version. Older funding writers do not maintain the funding-order watermark; mixed-version monetary writes after new metadata is first recorded require a state compatibility assessment before activation. Older processes do not recognize the new outbox kind or known-zero lot marker. Keep the upgraded readers while refund history and lots remain; an old process can misprice those lots. Rolling back to an older SDK after refund state exists requires an explicit state compatibility assessment. Additive schema changes alone do not make rollback or a mixed-version fleet safe. The schema additions are idempotent, and running initialization twice preserves recorded refunds. No caller protocol change is required: restored balance appears through existing credit status.

## Held Tempo drain operator decisions

The signed admin routes `/admin/credit/book-tempo-drain` and `/admin/credit/release-tempo-drain` add explicit immutable decisions for `pending` and `exit_required` Tempo session drains. They preserve the original held debit, the terminal compare-and-set boundary, and channel-before-credit locking. Booking attests the full off-path refund without manufacturing chain evidence; release restores the recorded value without reopening the channel or clearing its separate close-report obligations. The existing drain report wire shape is unchanged. Release additionally refuses non-final matching close intents unless the forecast is provably pending and both broadcast marker and transaction hash are absent. Legacy ready intents and current ready-but-not-yet-broadcast intents conservatively refuse until close/exit resolution. Any retained positive refund/payment fact also refuses release. Exact receipt zero and unknown are distinct. Payer-exit lower bounds never enter the exact amount: positive bounds retain only a sticky payment fact, while nonpositive bounds leave proof unknown. Monetary proof survives failed booking transactions and later missing reads. The admin list explicitly includes held write-offs while background payout lists retain their prior filter. Hosted bookings require the actual transactional reporter, and standalone reporting remains optional. Decision diagnostics add a labelled stable SHA-256 drain reference without exposing arbitrary caller IDs. Neither decision supports a partial amount. Request and response examples are in [the portable fixture](../protocol-fixtures/tempo-drain-decisions.json); validation, replay, and migration details are in [Hosting](HOSTING.md#held-tempo-drain-decisions).

## Terminal evidence

New job receipts keep schema version `1` and add optional signed `timing` with `accepted_at_ms`, `terminal_at_ms`, and cumulative `caller_wait_ms`. Acceptance and termination use Unix milliseconds; `issued_at` remains signing time in Unix seconds. Non-completed receipts also include SDK-derived `ended_by`: explicit caller cancellation and unanswered prompt/payment expiry are `caller`; handler failures, worker death, and idle expiry during processing or working are `provider`. Handlers cannot choose this attribution. Legacy receipts omit these fields and still verify. Jobs accepted before this change, including jobs still active during an upgrade, omit the additions and do not produce terminal reports because earlier caller waits are unknown; the SDK does not invent historical fault evidence.

Hosted servers with platform URL, token, DVM identity and durable database configured enqueue every terminal job, including free jobs, through the durable report outbox to `/_internal/job-terminal`. The payload contains the DVM/job identity, capability, outcome, attribution, payment-presence flag, timing and optional receipt sequence. It contains no caller identity, payment references or amounts, input, or output. The permanent deduplication claim and outbox insert commit together; startup and periodic recovery cover a crash after terminal persistence. Deliveries can repeat, so the platform deduplicates by DVM/job identity.

Deploy the platform endpoint before deploying report-emitting servers. These reports use the existing revenue transport policy: transport/5xx failures retry and abandon after 24 hours; 4xx responses, including 404, become permanently stale. The portable receipt and report contract is in `protocol-fixtures/job-terminal-evidence.json`; compatibility is tested with the pinned published `@dvmkit/sdk@0.1.5-rc.9` verifier.


## Tempo close terminal outcomes

A registered Tempo drain that cannot cooperatively close because its descriptor is invalid or its hosted retries are exhausted now returns HTTP 409 `tempo_channel_exit_required`, with `status: "exit_required"`, `drain_registered: true`, `drain_id`, and `channel_id`. Callers must use the channel's timed on-chain exit. A corrected credential does not reopen or debit that drain again. The debit remains reserved for the channel's refund; a late confirmed close can still fulfill it. Older callers that poll every 402 must handle this terminal 409. For a custom ledger without terminal-drain persistence, the 409 instead retains `status: "pending"` and explains that a corrected credential can retry when cooperative attempts remain. The portable response contract includes both modes in `protocol-fixtures/tempo-close-terminal.json`.

Completed Tempo drains remain readable when their credit is `unbacked`. Sweep-completed drains use the existing `sent` state and include `terminal_outcome` and `credit_unbacked` in their settlement evidence; caller liability is discharged only with sufficient refund evidence. Verified cooperative-close refunds now offset voucher headroom before any permanent loss row, credit status, or completion diagnostic is written. Missing proof defers classification while retaining finalized-channel spending restrictions and sweep retries. Partial refunds retain only the residual loss; verified payer exits retain only unpaid successful consumption, so unused voucher authority never adds a loss. Existing permanent losses are not reversed. The loss listing adds nullable decimal-string `refunded_to_payer_native` and `loss_native` fields, plus nullable `loss_basis` identifying cooperative receipt, payer exit, or caller assertion; old rows remain unknown, and financial export version 1 preserves exact new values and old schemas. See [Hosting](HOSTING.md) for the evidence and migration boundary.

Hosted report searches now stop in persisted `unmatched` after a definitive empty range and require an explicit operator retry. Automatic unproven loss-history discovery for the same hosted close honors that stop while retaining finalized spending restrictions and pending classification; known transactions and verified receipts remain usable. This does not discharge the payout obligation or authorize cleanup. See [HOSTING.md](HOSTING.md) for the retry API and recovery constraints.


## Compatibility and versioning

Custom credit stores built against SDK 0.10.x must add `recordTempoDrainRefund` and `recordTempoDrainPayment` before they can complete held Tempo drains with this release. These optional interface members are required when the host has a matching open Tempo drain: the first retains exact cooperative refund amounts, including zero; the second retains positive payer-exit payment proof without inventing an exact amount. Advertising `tempoCreditLossEvidenceVersion: 1` alone is insufficient. A missing or failing writer leaves that channel finalized and pending for retry, without completing its drain or preventing unrelated channels from settling. Operator decision and cosmetic held-reason capabilities remain optional. See [Hosting](HOSTING.md) for the custom-store evidence and transaction contract.

This is pre-1.0 alpha software and the promises match that. Breaking changes can land in any release, they are announced in the release notes for the release that carries them, and there is no long-term support release. Security fixes are made on the latest published release rather than backported.

Nothing reachable only through a deep path into `dist/` is public. `npm run check:api` pins every exported declaration name against `api-surface.json` and the generated API reference, so a change to the supported surface is a deliberate, reviewed act rather than a side effect.

Wire compatibility with callers is separate from the package version and is declared per endpoint. A server built on this SDK answers `DVM-Protocol-Version: 1`, and an individual endpoint may require a set of named capability tokens the caller advertises, a minimum caller version, or both. Capability tokens are additive, so an endpoint that declares no requirement stays reachable by a caller that sends no compatibility headers at all. A caller that cannot meet what an endpoint declares gets HTTP 426 naming the required capabilities and, where one is declared, the minimum version. The protocol is specified at [dvmkit.com/docs/protocol](https://dvmkit.com/docs/protocol).


## Job credentials

An unauthenticated `POST /v1/job` returns a one-time `job_token` alongside the `job_id`. Callers must send it as the `X-Job-Token` header on subsequent status reads, message reads (JSON or SSE), message writes, and cancellation. A request with no credential gets a 401 `job_credential_required`; a wrong credential remains the opaque 404 `Job not found` response.

When a caller has lost its local job record, the standalone `@dvmkit/dvm-cli` can use the provider endpoint and token explicitly. Prefer environment variables so the bearer token does not enter shell history or the process list:

```sh
DVM_JOB_ENDPOINT=https://provider.example \
  DVM_JOB_TOKEN=<64-character-hex-token> \
  dvm status <job-id>
```

The same values are accepted as `--endpoint <url>` and `--job-token <hex>`. These overrides are request-scoped and are not saved; `dvm pay` still requires the local pending request and spending policy, so an endpoint and token alone cannot authorize a payment.

If an upgrade broke something for you, an [API compatibility report](https://github.com/dvmkit/sdk/issues/new/choose) is the most useful thing you can send us. It tells us which parts of the published surface people actually build on, which no test of ours can.


## Payment recorded before a snapshot failure

After a mid-job payment's accounting and inbound verification commit, a later snapshot failure returns HTTP 503 `job_snapshot_unavailable` with `payment_status: "recorded"`, `retryable: false`, and the `job_id` and inbound `seq`. Read the job status and messages instead of sending another payment. If the worker stopped, a non-payment message can resume the stored job using its accepted credit. An optional `credit` block retains the usual explanation of funds that did not apply to this job.

This is an additive error response for a failure that previously returned an unstructured 500. It does not change payment amounts, caller/request uniqueness, or funding and draw semantics. The portable response is in [job-snapshot-unavailable.json](../protocol-fixtures/job-snapshot-unavailable.json).


## Unsigned paid calls

A DVM built with `secp256k1Auth({ allowUnsignedPaid: true })` advertises `/v1/info.auth` as `["secp256k1-schnorr-v2", "none"]`, signed scheme first, and also accepts an unsigned `POST /v1/job` when the job requires a per-call payment made with Cashu. This lets a standard HTTP payment wallet, which attaches a payment but never signs, call the DVM. Without the option the list stays `["secp256k1-schnorr-v2"]` and nothing changes.

A body whose structured input carries none of `pubkey`, `signature`, `timestamp`, `nonce` or `auth_statement` is unsigned. Any one of those fields makes the body signed, and it is verified exactly as before: a bad signature returns its `auth_error` and never falls back to the unsigned path. An unsigned body is validated against the capability schema without the envelope fields and runs as the anonymous requester, with the usual one-time `job_token` as its only handle for status reads, messages, mid-job payments and cancellation. The handler sees no `ctx.auth`. No replay entry is written; the payment's own replay protection stops reuse. An unsigned payer whose response is lost recovers the job, `job_token` included, by retrying with the same Cashu proofs, `X-Cashu-Request-Id` and body, under the binding described for [Cashu payments](#cashu-lock-requirements), or with the same token and body when it paid without a request id ([NUT-24 payment requests](#nut-24-payment-requests)); any other retry with an accepted payment is refused with HTTP 409 and returns neither the job nor its token. A signed caller's job never recovers for an unsigned retry, or the reverse. Hosting control's recovery, which requires the exact same payment artifact (see [Hosting](HOSTING.md)), is unchanged. If the job fails, released money lands on the shared anonymous requester, which no caller can claim.

Unsigned calls take Cashu only. With Cashu (NUT-24) the token is the payment, so a failed job keeping it is how Cashu payment already behaves. Standard x402 settles only after the work succeeds, but this SDK settles x402 before the job runs, so an unsigned x402 payer, who holds no credit to reclaim, would lose money on a failed job, which falls short of x402's own standard. Tempo stays signed-only until its failure behaviour has been checked the same way. An unsigned request that needs payment but carries none gets an HTTP 402 `payment_required` challenge offering Cashu alone: the amount and the accepted mints, plus the `X-Cashu` payment request described under [NUT-24 payment requests](#nut-24-payment-requests), with no x402 `accepts` list, no Tempo `WWW-Authenticate` challenge and no prepaid-credit menu. No `/v1/quote` call is needed; `/v1/quote` stays signed-only. A dynamic-priced capability is priced from the unsigned input with the envelope fields removed, so its `onQuote` handler runs for anonymous callers with no caller pubkey. An unsigned request that resolves to no required payment, or reaches a DVM that does not take Cashu, receives the same `auth_error` a signed-only DVM returns, so free capabilities stay signed-only. An unsigned submit carrying an x402 payment (`PAYMENT-SIGNATURE` or `X-PAYMENT`) or a Tempo credential (`Authorization: Payment`) is refused with HTTP 402 `payment_method_requires_signature` before any settlement or credit write, and so is an x402 or Tempo `payment` message on an unsigned job; pay with Cashu or sign the request. A mid-job `payment-request` on an unsigned job offers Cashu alone, with no `x402` or `tempo` option, because a push-mode Tempo wallet broadcasts its transfer before the DVM sees the credential and could not be refused in time. Signed callers keep every rail. An unsigned body carrying `credit_id`, `draw_id` or `fund` is refused with HTTP 400 `invalid_credit_fields`, and one carrying `request_id` with HTTP 400 `request_recovery_unsupported`: prepaid credit and request recovery belong to a verified pubkey. `POST /v1/credit` and balance-backed mid-job payments stay signed-only. A capability whose input schema is not a plain object schema stays signed-only.

### Refund-locktime floors

`/v1/info.cashu.min_locktime` is the shortest refund `locktime`, in seconds from now, a caller should lock to; the DVM enforces it less 24 hours so a caller resuming an unacknowledged payment still clears it. It is 604800 (7 days) unless the builder sets `cashu.minLocktimeSeconds` in `configureDVM`, as a whole number of seconds of at least 90000 (25 hours), so the enforced floor always lies at least an hour ahead.

A NUT-24 wallet cannot be told this value: the payment request carries no `locktime`, and a wallet such as Nutshell locks a refund path to itself opening after 24 hours by default. A builder who wants to take those payments sets `cashu.unsignedMinLocktimeSeconds`, a whole number of seconds of at least 3600, enforced exactly with no margin, because such a wallet never resumes a payment. A DVM that sets a `cashu` block and serves unsigned paid calls (no auth, or `allowUnsignedPaid`) advertises it as `/v1/info.cashu.unsigned_min_locktime`; otherwise the field is absent and the unsigned floor is `cashu.min_locktime` minus 24 hours. `configureDVM` throws on a value outside either rule.

Which floor applies depends on how the payment arrives, not on the kind of DVM:

| Payment | Floor |
| --- | --- |
| `POST /v1/job` with no signature and no `X-Cashu-Request-Id` (a NUT-24 wallet), on a DVM without auth or with `allowUnsignedPaid` | unsigned: `cashu.unsigned_min_locktime` seconds after receipt |
| Any `POST /v1/job` carrying `X-Cashu-Request-Id`, signed or not, on any DVM | signed: `cashu.min_locktime` minus 24 hours |
| A signed `POST /v1/job`, a mid-job `payment` message, `POST /v1/credit` | signed |

A payer that sends `X-Cashu-Request-Id` reads `cashu.min_locktime` before locking and may re-send the same payment after a lost response, so it keeps the 24-hour margin even on a DVM without auth. Because the header picks the floor, an unsigned payer always gets the shorter of the two, so `configureDVM` refuses an `unsignedMinLocktimeSeconds` longer than `minLocktimeSeconds` less 24 hours. A `lock_not_exclusive` refusal's `hint` names `cashu.unsigned_min_locktime` only on the unsigned path of a DVM that advertises it.

A floor shorter than the default is safe only if the builder melts banked proofs more often than the floor. Banked proofs wait unswapped for the batch melt, and once a proof's `locktime` passes and it is still unmelted, NUT-11 lets the payer take it back through its `refund` key, or, when the proof names no `refund` key, lets anyone holding the proof spend it. The accumulator monitor's `wallet_accumulator_batch_expiring_soon` event fires 36 hours before a batch's earliest locktime, or at half the shortest enforced floor when that is shorter, so a payment at the floor does not raise it on arrival.


## Job identity field

Every 200 or 202 response to `POST /v1/job`, `POST /v1/request-resume/:id` and `POST /v1/request-result/:id` carries a `DVM-Job-Identity-V1` response-head field whose value is the body's `job_id`, byte for byte, so a router or caller can learn which job a response names without reading a body of any size. No other status carries it. The value grammar is `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; a server whose job ID falls outside it sends no field. A reader takes the value from `Headers.get`, trims nothing and never folds case: a repeated field (joined with `", "`), an empty value or any other character is invalid, and a trailer of the same name is never identity. The portable contract and its classification vectors are in `protocol-fixtures/job-identity-v1.json`. Hosting control's status reports `jobIdentityHeader: "v1"` when the deployment emits the field.


## Per-job costs

A handler can declare what a job cost **you**, the builder, to serve — a vendor API call, a GPU minute, a per-request licence fee — and the SDK reports it to the platform alongside what the caller paid, so your dashboard can state a margin instead of guessing at one.

```ts
const transcript = await ctx.step("transcribe", async () => {
  const result = await whisper(audio);
  ctx.cost({ amount: result.seconds * 0.0001, currency: "usd" });
  return result;
});
ctx.artifact({ mime_type: "text/plain", data: transcript.text });
```

`amount` is in whole currency units, like every other money figure you hand the SDK. Call it once per cost you incur; the declarations for one job are summed, and only the total is rounded, to a millionth of a unit. That ordering is what makes fine-grained declarations safe: a per-token charge of $0.0000003 is below the reported resolution on its own, but a thousand of them still add up to $0.0003 rather than to nothing. Every call in a job must name the same currency.

Three things worth knowing:

- **Declaring nothing is not declaring zero.** A job whose handler never calls `ctx.cost` reports no cost at all, and the dashboard says the margin is unknown rather than showing it as 100%. `ctx.cost({ amount: 0, currency: "usd" })` is how you say a job genuinely cost you nothing.
- **Declare the cost where you incur it, including inside `ctx.step`.** The step cache carries those declarations with the result and applies them once when a replay skips the body.
- **Every terminal job reports its declared cost.** A paid completion carries the cost on its revenue report. A free completion, failure, or cancellation sends a separate cost-only report and does not create revenue.

The cost is yours, never the caller's: it is recorded separately from what the caller paid and is never netted against it. Both report shapes use the same durable outbox. Cost-only reports are keyed on the job id and revisioned, so retries and cross-machine updates converge on the latest cumulative value. With the Postgres job store, boot-time and periodic reconciliation enqueue any terminal cost revision that a process exited before reporting. Other job stores get no reconciliation: their cost-only report is durable only once the outbox insert commits, so an exit between the terminal save and that insert loses it.


## Rate cards

A priced capability can tell callers what it charges per unit, so an agent can explain the price before it asks for a quote. Declare `rates` next to `price` or `onQuote`, in the flat shape or on an entry in `capabilities`:

```ts
capabilities: {
  synthesise: {
    onQuote: { schema, handler: quoteBySize },
    rates: [
      { label: "balanced", amount: "0.00015", currency: "USD", per: "character" },
      { label: "expressive", amount: "0.00030", currency: "USD", per: "character" },
    ],
    onJob,
  },
},
```

`/v1/info` publishes the list as `capabilities.<name>.pricing.rates`, exactly as you wrote it: same order, same strings. A capability without `rates` publishes nothing extra. For a quoted capability the rates describe how your quote is computed; the SDK does not compute or check quotes against them, so keep the two in step yourself.

The server refuses to start, naming the capability and the entry, when a rate card breaks one of these limits:

- 1 to 5 entries, on a capability with `price` or `onQuote`. A free capability cannot declare rates.
- `amount` is decimal dollars as a string, above zero and at most 12 characters: `"0.00015"`, not `0.00015` or `"$0.00015"`.
- `currency` is `"USD"`.
- `per` names the unit (`"character"`, `"episode"`, `"GB per day stored"`) and `label`, which is optional, names a tier. Each is 1 to 24 characters with no leading or trailing spaces.
- No other keys.

The [portable fixture](../protocol-fixtures/capability-rates.json) carries the same limits and the accepted and refused examples, for clients that parse the field.
