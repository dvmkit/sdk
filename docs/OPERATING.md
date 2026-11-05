# Operating a DVM

## Verified payments in development

`serve()` returns a `paymentModes` snapshot describing whether each configured rail is verifying, unavailable, or absent. A priced development server skips verification only when it has no configured payment rail. Configuring an unusable rail fails closed instead of turning the request into a synthetic development payment.

Cashu development without Postgres is limited to known test or loopback mints. It uses a fresh lock identity and process-local accounting on every boot, so proofs, balances, and jobs do not survive restart. Production Cashu remains PostgreSQL-backed. Both paths require valid mint-provided NUT-12 DLEQ evidence on every proof before accepting its value; older tokens without that evidence must be replaced with fresh tokens from a compatible mint.

Builders can pass `onPaidJobCompleted` to observe settled customer charges after successful completion. The event contains `jobId`, verified rail, checked integer `amountMicro`, the credit currency, and whether configuration identifies test funds. Reconciliation can repeat an event, so consumers deduplicate by `jobId`. Free jobs, synthetic development payments, failed jobs, and released draws do not emit.


## Production next steps

- Use Postgres through `DATABASE_URL`; production boot refuses an in-memory job store unless you deliberately supply another durable implementation.
- Add `auth: secp256k1Auth()` for caller-owned state. The host automatically uses a Postgres replay store when one is available; a per-process replay window is unsafe across replicas.
- `secp256k1Auth({ allowUnsignedPaid: true })` also serves unsigned callers when they pay per call with Cashu, such as standard HTTP payment wallets, or with x402 on a capability that sets `maxRuntimeSeconds` (needs Postgres; the payment is settled only if the job succeeds, and the output is withheld until it settles); Tempo stays signed-only. Those jobs run anonymously: no `ctx.auth`, no prepaid credit, and a failed job's released money cannot be reclaimed. See [Unsigned paid calls](PROTOCOL-NOTES.md#unsigned-paid-calls).
- `cashu.unsignedResultWaitSeconds` holds an unsigned NUT-24 paid submit open for a short result, including an identical payment retry. Default 10 seconds; integer 0 to 20, with 0 disabling the wait. Completion returns 200 inline, including the durable `messages` array for artifacts when its serialized UTF-8 size is at most 1,048,576 bytes and content is available. Larger results keep `payload_in: "messages"` for a separate fetch; the fixed cap limits server memory and client buffering. A running job returns the usual 202 for polling, and an input prompt returns immediately. The ceiling leaves room for a cold machine wake under common HTTP proxy deadlines. See [NUT-24 payment requests](PROTOCOL-NOTES.md#nut-24-payment-requests).
- A `cashu` block sets the refund-locktime floors Cashu payments must meet: `minLocktimeSeconds` for callers that read `cashu.min_locktime` and send `X-Cashu-Request-Id` (default 7 days, at least 25 hours, enforced less a 24-hour resume margin) and `unsignedMinLocktimeSeconds` for unsigned NUT-24 wallets that pay without a request id and cannot be told the floor (at least 1 hour, enforced exactly, and no longer than the signed value less 24 hours, since an unsigned payer that sends a request id takes the signed floor instead). Shortening either is safe only if you melt banked proofs more often than the floor: once a proof's locktime passes, the payer can take an unmelted proof back through its refund key, or, when the proof names no refund key, anyone holding it can spend it. See [Refund-locktime floors](PROTOCOL-NOTES.md#refund-locktime-floors).
- Configure only the rails you operate: Cashu, x402, and Tempo are job payment methods. Lightning and card (`stripe`) are prepaid-credit funding legs only; see [Card-funded credit](#card-funded-credit). Keep every private key, wallet connection, and platform token in your secret store rather than source.
- A `credit` block opts into reusable prepaid balances and their reclaim obligations. Reusable channels return undrawn collateral through their channel lifecycle; one-payment stablecoin funding is disabled unless `allowOneShotStablecoin: true` because it creates manual refunds. Run and monitor the documented reclaim/payout worker.
- Honour `ctx.signal`, use `ctx.fetch` for abortable provider calls, and declare provider cost with `ctx.cost` only after the durable step that incurred it.

An explicit `paymentMethods` list restricts the advertised job methods, x402/Tempo metadata, and credit funding terms, even when another rail is wired through host configuration. For example, `paymentMethods: ["cashu"]` suppresses x402 and Tempo discovery and funding; an empty list advertises no job payment methods. Lightning credit funding still follows its receive wallet independently.

When `paymentMethods` is omitted, methods are derived from ready configuration. Cashu requires accepted mints, `p2pk-accumulator` mode, a lock public key, and either Postgres or the explicit development Cashu store. Configuring mints alone does not advertise Cashu. The boot event `cashu_not_advertised` identifies missing prerequisites or an explicit exclusion; see [diagnostics](DIAGNOSTICS.md#cashu-advertisement).

Reusable x402 channels default to a 24-hour payer withdrawal grace (86400 seconds) on every network. For Base Sepolia (`eip155:84532`) acceptance tests, set `x402.batchSettlement.withdrawDelay: 900` or `DVMKIT_X402_WITHDRAW_DELAY_SECONDS=900` with `DVMKIT_X402_BATCH_SETTLEMENT=true`. Explicit delays must be integer seconds and at least 900 on Base Sepolia; Base mainnet retains the 86400 minimum even in development mode and still requires self-relay. The grace is bound into each channel's immutable configuration: changing the server setting affects new channels, not existing deposits. A shorter testnet run exercises early-withdrawal refusal and post-deadline recovery; retain a separate 24-hour run to cover next-day recovery.

## Browser access

Public `/v1/*` routes enable CORS in production and development with `Access-Control-Allow-Origin: *`, no `Access-Control-Allow-Credentials`, and `X-Cashu` exposed so browser wallets can read the unpaid 402 payment request. Preflights allow the requested headers, including payment, signature, and job-token headers. Access still requires the route's signature, job token, or payment; cookies do not authorize these routes. Admin, internal, health, and development helper routes have no CORS headers.

## Card-funded credit

Card payers must be in a region where Link supports connecting agents: the United States and Canada as of November 2026. Stripe's broader country availability does not establish support for this Link flow.

Set `DVMKIT_STRIPE_SECRET_KEY` (the Stripe account the charge lands in) and `DVMKIT_STRIPE_NETWORK_ID` (your Stripe profile id, `profile_…`) to let callers top up prepaid credit with a card. The caller's human approves the top-up in Link, which gives the agent a Shared Payment Token; the DVM charges it once and books the PaymentIntent as the funding. Card credit also needs `DVMKIT_TEMPO_SECRET_KEY`, which binds MPP challenges for both Tempo and card credit; boot fails if it is missing or if only one of the two Stripe variables is set. Builders constructing a server directly pass `stripeCredit: createStripeCreditRail({ ... })` instead.

Card-credit PaymentIntent creation includes Stripe metadata `dvmkit_dvm_id` from the server's `canonicalDvmId`, falling back to its `dvmId`. The host resolves these from `DVMKIT_CANONICAL_DVM_ID` and `DVMKIT_DVM_ID`, respectively, for both environment-created and explicitly supplied rails. The field is sent before confirmation, so declined attempts carry the same attribution. It is server-owned: credential metadata cannot replace it, and existing `mpp_*` metadata is preserved. Standalone servers with neither identity still charge normally and omit the field; no identity is inferred from a URL or display name. Direct users of `StripeCreditRail.charge` can pass the resolved identity as `canonicalDvmId` in its server-side arguments. See [the card-funding contract](../protocol-fixtures/credit-fund-stripe-v1.json).

An in-flight charge made before identity metadata was enabled can still be recovered after an upgrade. If Stripe refuses the added metadata with HTTP 400 `idempotency_error`, the rail retries once with only `dvmkit_dvm_id` removed, under the same idempotency key. This recovers the original charge after a lost response or a crash before booking; the existing PaymentIntent keeps its original metadata. A persistent mismatch remains a payment failure and does not book credit.

The menu advertises `stripe` in `credit.funding` with `credit.stripe: { network_id, min_micro, currency }`, only on a USD credit menu and independently of `paymentMethods`. Card top-ups start at $5 unless you set another minimum (see [Card top-up minimum](#card-top-up-minimum)), or at `credit.min` when that is higher. Amounts are charged in whole cents, and a credit whose `max` is below $0.50 does not offer cards. A declined card books nothing and returns a `hint` for the agent to relay. Rotating `DVMKIT_TEMPO_SECRET_KEY` keeps the previous key valid for card challenges during the same window as Tempo, when the host has Postgres. Wire details are in [Card-funded credit](PROTOCOL-NOTES.md#card-funded-credit).

### Card top-up minimum

Card top-ups start at $5 by default. Set `DVMKIT_STRIPE_MIN_USD` (a decimal dollar amount such as `5` or `2.50`) or pass `minUsd` to `createStripeCreditRail` to change it. It changes the card minimum only: other rails and `credit.min` are untouched, and the advertised `credit.stripe.min_micro` is the larger of your setting, `credit.min` and Stripe's $0.50 floor, capped at the credit's `max` so a DVM whose `max` is under $5 still offers cards. A setting under $0.50, one that is not a number, or one above `credit.max` fails boot with an error naming the variable.

Why it exists: Stripe charges about 2.9% plus 30 cents per card payment, so a small top-up mostly pays Stripe. You bear that fee on credit that gets spent; the caller bears the fee's share of any refund of unused credit (see the refund arithmetic in [Card-funded credit](PROTOCOL-NOTES.md#card-funded-credit)).

| Top-up | Stripe fee | Share of the top-up |
| --- | --- | --- |
| $0.50 | about $0.31 | about 63% |
| $5 | about $0.45 | about 9% |
| $20 | about $0.88 | about 4.4% |

A higher minimum shrinks Stripe's share of each top-up; a lower one lets a caller try your DVM for less. Choose by job price: a minimum around ten jobs' worth means a first top-up covers real use, so the fee is spread over many jobs instead of one. A DVM that charges $0.10 a job can keep $1; one that charges $2 a job suits $20. Raise it if fees eat your margin; lower it if callers abandon at the first top-up. The $5 default suits most small DVMs.

`DVMKIT_STRIPE_SECRET_KEY` can be a restricted key (`rk_live_…`), and should be. Give it exactly these permissions, named as the Stripe dashboard names them:

| Dashboard permission | Access | Requests it covers |
| --- | --- | --- |
| Payment Intents | Write | `POST /v1/payment_intents` (charging a top-up with its `shared_payment_granted_token`), `GET /v1/payment_intents/:id` (sizing a refund), `GET /v1/payment_intents/search` (finding a charge that never reached a credit) |
| Charges and Refunds | Write | the charge expanded on that PaymentIntent read; `POST /v1/refunds`, `GET /v1/refunds?payment_intent=…` and `GET /v1/refunds/:id` (making, finding and following card refunds) |
| Balance | Read | the charge's balance transaction, expanded for its fee |
| Payment Disputes | Read | `GET /v1/disputes?created[gte]=…` (recent disputes, each pass) and `GET /v1/disputes?payment_intent=…` (every dispute on one top-up, before a freeze is lifted) |

A missing permission does not stop the rest of the card refund sweep, but it disables that part: without Payment Disputes, for instance, disputed credit is never frozen. Stripe's 403 names the permission it wanted, and the key's request log in the dashboard shows each failure. Prove a restricted key in test mode first: the live test-mode test (`STRIPE_TEST_SECRET_KEY=rk_test_… npm test -- src/sdk/server/__tests__/credit-fund-stripe.integration.test.ts`) charges, refunds and reads the fee with it. That test also mints the caller's token through Stripe's test helper, so the test key additionally needs Shared Payment Token Test Helpers: Write; a live key never does.

Unused card credit goes back to the card, never to another rail and never to you. A caller drains it with `method: "stripe"`; the DVM refunds the remaining balance as partial refunds of the original PaymentIntents and records each Stripe refund id (`re_…`) on the drain. Oldest top-ups are refunded first, because Stripe refunds a charge only for a limited time after it was made. A credit has at most one card refund in progress: a second `stripe` drain while one is pending is refused with `drain_conflict` naming the pending one (`blocking_drain_id`), and drain ids starting `expiry-` are reserved for the sweep's own refunds. Card refund drain ids are at most 128 characters. An expired card credit cannot be topped up (`credit_closed`), so its balance cannot be revived before the sweep refunds it. An expired card balance is refunded the same way by the card refund sweep, which runs on the expiry sweep's hourly cadence when the host has Postgres; the credit then closes for good (`status: "refunded"`) and is never released to you. Each refund is reported to the platform as a `stripe` drain of the whole balance it extinguished, so none of it counts as your revenue.

Stripe keeps its processing fee when it refunds, so the caller bears the share of that fee that matches what comes back. For each PaymentIntent, refund = amount owed − round(Stripe fee × amount owed ÷ amount charged), in cents. Example: a $2.00 top-up costs a $0.36 fee; after $0.30 of use, $1.70 is owed, the fee share is $0.31 (36 × 170 ÷ 200, rounded), and the card gets $1.39 back. A credit spent in full costs the caller nothing, because nothing is refunded. With several top-ups, the fee shares follow the refund order: the balance comes back from the oldest top-ups first, so a caller can bear part of an older top-up's fee even though their spending, in their own reckoning, used it up. When your Stripe account settles in another currency, the fee and the charge are both read in that currency, so the fee share is the same fraction: a $2.00 charge settled as £1.49 with a £0.28 fee gives a fee share of 32 cents on $1.70. Stripe records the fee a few seconds after the charge; a drain made before then stays `pending` until the caller polls it or the sweep runs. The drain response and its record state the refund and the fee share in dollars. The fee share is Stripe's, not yours: it is not revenue and is not reported as such. A balance below one cent cannot go back to a card; it is reported as `sub_cent_micro` and closed with the drain.

A transient refusal or refund that is still processing leaves the drain `pending`. It shows up in `GET /admin/credit/pending-drains` with its refund state, the sweep retries it, the caller's next poll of the drain retries it, and `POST /admin/credit/mark-drain-sent` on a `stripe` drain retries it on demand instead of recording an operator payout (any `sent_ref` you pass is ignored). Retries never refund twice: before creating a refund the DVM looks for one it already made for that drain and top-up. A dispute on a funding PaymentIntent freezes the whole remaining balance of the credit it funded (`status: "disputed"`), including balance from its other top-ups, while the dispute is open. When a dispute is won (or an inquiry is closed), the sweep asks Stripe for every dispute on each of the credit's top-ups, however old, and unfreezes the credit only if all of them are won or closed: it is then `active` again and refundable, including at expiry. A lost dispute keeps the credit frozen. A card drain blocked by that dispute can be closed through the recovery actions below; this resolves only its reserved debit, not other disputed credit or chargeback accounting. Freezing reads the last 180 days of disputes each pass. A charge that Stripe completed but that no credit booked (the booking failed and the caller never resent) is found by the sweep from the DVM's charge journal after 30 minutes and refunded in full; only charges this DVM journaled are considered, so several DVMs can share one Stripe account. An attempt Stripe's search does not show is searched again each pass for a day, in case the search index lags, and then dropped. Each sweep step (disputes, expiry refunds, retries, stranded charges), and each credit within the expiry step, fails on its own: the failure is logged (`card_refund_sweep_step_failed` with the step, or `card_refund_expiry_failed` with the credit) and the rest of the pass runs.

### Blocked card refunds

A permanent refusal (`charges_exhausted`, `charge_not_refundable`, `amount_too_large`, `charge_already_refunded`, or a lost dispute) puts a card drain in `refund_blocked`. Its debit remains reserved and its liability stays in `GET /admin/credit/pending-drains`, including the failure code. Caller polls, `mark-drain-sent`, and subsequent sweep passes make no refund calls for it. The sweep excludes blocked drains before its 200-item retry limit.

Use the existing signed admin authentication with either `POST /admin/credit/close-card-drain` or `POST /admin/credit/replan-card-drain`. Both take `{ "credit_id": "example-card-credit", "drain_id": "refund-1", "decision_id": "review-1", "reason": "Reviewed refund evidence" }`. The decision id is 1–128 characters and the trimmed reason is 1–2000 characters. Repeat the same id, action, and reason after a lost answer; the response has `replayed: true`. A different action or reason under that id is a conflict. A later distinct decision needs a fresh id.

Closing retains completed refunds and books only the unpaid gross credit as `writtenOffMicro`, alongside `refundedGrossMicro`, the reason, and decision time. The terminal state is `written_off`; the debit is neither restored to spendable credit nor represented as a successful refund or builder revenue. Write-offs remain local durable accounting evidence and are not sent through the successful-refund reporting contract. Reconcile that evidence with your accounting records. If all refunds have since succeeded, closing instead books the ordinary `sent` outcome and its report. Once resolved, the drain no longer blocks expiry refunds of a later balance, including released job holds; a separately disputed credit stays frozen.

Replanning keeps the balance reserved and immediately constructs a new plan for the unpaid portion using current charge capacity. Successful allocations and their fee shares remain fixed; new allocations use a new persisted revision and different idempotency keys. If capacity is still insufficient, the drain becomes blocked again. Expiry-created drains use the same recovery actions without reopening their closed credit.

Both decisions first reconcile refund evidence. A pending or ambiguous refund returns `409 card_refund_uncertain`; unavailable evidence returns 503 and changes no decision. Concurrent recovery or payout returns `409 card_refund_busy`. Resolve uncertain submissions in Stripe before another decision. The financial export preserves monetary amounts and decision actions/times while excluding reasons and arbitrary decision ids.

## Prepaid credit lifetime

Prepaid balances and implicit per-call credits default to 90 days from funding. A builder can override the lifetime in seconds with `credit.ttl`; for example, `credit: { ttl: 2_592_000 }` retains 30 days. An upgrade preserves existing stored expiries. Each top-up extends expiry to the later of the current expiry and funding time plus the configured lifetime.

Expiry refuses new draws. Caller balances remain reclaimable until the durable expiry sweep commits a release; increasing the default delays that release and keeps unspent balances as builder liabilities longer. Tempo-backed credits follow their channel exit lifecycle instead of expiry release. Pending draws can still settle or release after expiry.

## Refunding a completed credit-funded job

Use the authenticated `POST /admin/credit/refund-draw` route to return all or part of a completed charge to its original credit. Choose a refund ID once and reuse the exact arguments after a lost response. The caller sees the restored credit through existing balance status and can spend or drain it. The [protocol notes](PROTOCOL-NOTES.md#completed-credit-draw-refunds) specify the wire contract, original Bitcoin value policy, refusals, and fleet upgrade requirements. The route requires both a durable credit ledger and the configured platform refund reporter. It refuses channel-backed credit and older Bitcoin draws missing authoritative actual-settlement basis, including draws with only a historical repricing marker. Historical credits whose closure or reopening cannot be established return `credit_refund_state_unavailable`. Both historical-evidence refusals require operator inspection before arranging a repair; retrying alone does not supply proof.

## Pending implicit draws

To inspect held per-call payments while the service is stopped, use an existing Postgres
connection to the service's database and `readPendingImplicitDraws` from the server entry point:

```ts
import { readPendingImplicitDraws } from "@dvmkit/sdk/server";

const summary = await readPendingImplicitDraws({ db });
```

The connection uses the same database credentials as `DATABASE_URL`; a role with `SELECT`
access to `credits` and `credit_draws` suffices. The query requires the existing SDK schema
and runs one read-only `SELECT`, without starting a host, initializing tables, or opening a
write transaction. Database failures propagate rather than returning a zero balance.

`drawCount` counts all pending draws on implicit credits (`imp:`), including unfinished jobs
and holds without a job record. The ledger is database-wide: the result includes every mount
sharing it and is not filtered by cancellation or stop reason. `oldestDrawAt` is the earliest
draw creation time in epoch milliseconds, or `null` when empty. `byRailCurrency` contains
`rail`, `currency`, `drawCount`, integer `amountMicro`, and `oldestDrawAt` for each group,
ordered by rail then currency, with an unknown historical rail represented by `null` last.
Amounts are millionths of the recorded currency; keep currencies separate. Unsafe integer
totals fail instead of rounding. The result contains no caller or payment identifiers.

These are held draws awaiting settlement or release, rather than a total of payable refunds
or all caller balances. Settled and released draws, explicit prepaid credits, and registered
drain payouts are excluded. This query does not release holds or move money.

## Bitcoin liability

For Bitcoin credit monitoring, `GET /admin/credit/bitcoin-liability` reports exact in-kind obligations in satoshis. Uncovered and basisless credits need live-rate pricing on reclaim, so their whole balances appear in `uncovered_by_currency` and `unbacked_by_currency` as `{ currency, micro, credits }` entries. Sum the credit counts if useful, but display or price each currency separately. Older consumers must replace the former `uncovered_micro` and `unbacked_micro` scalar reads; the [portable response fixture](../protocol-fixtures/bitcoin-liability.json) shows the full shape.

The public [SDK guide](https://dvmkit.com/docs/sdk) covers signed requests, custom routes, rail configuration, credit reclaim, persistence, and deployment in depth. The [protocol guide](https://dvmkit.com/docs/protocol) specifies the HTTP contract.


## KV storage retention

`ctx.store.set(key, value, { ttl })` makes an entry unreadable once its TTL passes. With the Postgres store, which the host uses whenever it has a database, the expired row is then physically deleted from `kv_store` within one minute of expiry while a host is running; a stopped or suspended service deletes it within one minute of its next start. A sweep runs when the host starts and every minute after, in batches of 1,000 rows and at most 100,000 rows per sweep; if more than 100,000 entries expire in one minute, the backlog drains at that rate. A retention period you state for TTL data is therefore the TTL plus one minute of host running time at that volume. Hosts sharing one database may sweep concurrently. A failed sweep logs `kv_expiry_sweep_failed` and is retried at the next interval; reads and writes are unaffected. Entries written without a TTL are kept until deleted with `ctx.store.delete`. `PostgresKVStore` accepts `sweepIntervalMs` when constructed directly, and the bound scales with it; call `close()` before ending its pool, or each later sweep logs `kv_expiry_sweep_failed`. The in-memory development store drops expired entries on read and on a write at least a minute after its last sweep.

## Diagnostic retention

[Payment diagnostics](./DIAGNOSTICS.md) documents the closed failure categories, stages, and top-up causes retained by safe logging sinks.

The SDK advertises 730 days of retention for sanitized diagnostics in every existing span dataset: `platform`, `cashu`, `lightning`, `stripe`, `x402`, `tempo`, `isolate`, `audit`, and `cron`. Dataset names, producer permissions, and query semantics remain unchanged; only operator services may write to `audit`.

This metadata describes the retention schedule. The SDK does not automatically delete diagnostics or override platform destruction or case controls. The platform must enforce the schedule and those controls.


## Repository development

Use the Node.js release in `.nvmrc` (Node 22). Install with `npm ci`, then run the same gate CI runs with `npm run verify`. The gate checks repository metadata in the checkout, copies only tracked and unignored source into an isolated directory, installs its locked dependencies, and runs lint, build, typecheck (including the release scripts under `checkJs`), unit and database tests, API, package, consumer, packed-artifact safety, and release checks there. The clean source tree owns the complete build and test pass, so verification never depends on the checkout's `node_modules` or pre-existing `dist` and does not repeat the full suite; after every check passes, its verified `dist` replaces the checkout's build output for release packaging.

`DATABASE_URL` is optional locally. Without it the database suite is skipped rather than passed, and `verify` says so in its summary, because a skipped suite verified nothing and must not be reported as green. Point `DATABASE_URL` at a scratch Postgres to run it, and pass `npm run verify -- --require-database` to make a missing one a failure, which is what CI does. That mode also requires the local test mint started by `node scripts/start-cashu-mint.mjs`.

The public surface is exactly `@dvmkit/sdk`, `@dvmkit/sdk/server`, and `@dvmkit/sdk/testing`.

When you pass `env` to `serve()` or `createDVMHost()`, that object is the complete host environment. SDK configuration, including provenance, builder and owner identity, and mint-health defaults, reads only from it. Omit `env` to use `process.env`.


## Job content retention and case holds

`configureDVM` defaults `jobRetentionDays` to 730. Set a shorter or longer whole-day window explicitly, or `0` to disable automatic age expiry. Only completed, failed, and cancelled jobs are eligible. The terminal `lastActivityAt` is frozen: reads, receipt delivery, late messages, and re-saving an outcome do not renew it. The sweep removes input, params, summary, messages, state, caches, and bearer proofs; it preserves durable status, signed receipts, payment amounts, and recovery linkage.

Authenticated job submit, request-result, status and JSON message responses expose `content_expires_at` (epoch milliseconds or `null`) and `content_available` (boolean). A null deadline means the job is active, expiry is disabled, or an active hold suppresses it. A past deadline can still have available content until the sweep runs. Missing fields on an older service or unsupported custom store mean unknown. SSE messages retain their existing event format; read job status for expiry.

With durable service-admin configuration, use signed `Authorization: P2PK` requests on the service-local routes:

| Method | Path | JSON body |
| --- | --- | --- |
| GET | `/admin/jobs/:jobId/content-holds` | none |
| POST | `/admin/jobs/:jobId/content-holds` | `purpose`, `reason`, `review_due_at` |
| POST | `/admin/jobs/:jobId/content-holds/:holdId/renew` | `reason`, `review_due_at` |
| POST | `/admin/jobs/:jobId/content-holds/:holdId/clear` | `reason` |

Purpose is `support` or `dispute`; reason is 1–1000 characters and review dates are future epoch millisecond integers. Unknown body fields are rejected. Hold IDs, actor public keys, and creation/clear times are server-derived. Authentication uses the existing method/path/service-bound admin challenge, current and grace-period keys, and atomic durable nonce consumption. A hold request does not grant access to job content. Authentication failure returns 401 with a reason; an unsupported store returns `content_holds_unavailable` (503), missing jobs return 404, and a redacted job or inactive hold returns 409. Holds cannot restore redacted content.

Responses include `job_id`, caller content metadata, `baseline_content_expires_at`, `holds`, and append-only `events`. Each hold contains `id`, `job_id`, `purpose`, `reason`, original `actor`, `created_at`, `review_due_at`, `cleared_at`, and computed `review_overdue`. Each event contains `id`, `hold_id`, `job_id`, `action`, `actor`, `reason`, `at`, `review_due_at`. Renew and clear preserve the original actor and creation date; their authenticated actors are in history. Any active hold suppresses the effective deadline. Overdue review flags work; it does not release the hold. The baseline remains visible for review. Clearing the last hold restores the baseline and can make content immediately eligible for the next sweep.

`PostgresJobStore.init()` adds `job_content_holds` and `job_content_hold_events` with job-scoped indexes; existing jobs need no expiry column or backfill. Placement and sweep lock the same job row and check redaction/terminal activity/active holds inside the transaction. Admin operations refuse jobs bound to another service; legacy unbound rows belong to the local service database. A committed hold wins any later competing sweep; if redaction wins first, placement fails. `MemoryJobStore` supplies the same contract for development. Custom stores must implement `ContentHoldStore` and atomic redaction fencing to support holds and truthful metadata.

Before explicitly destroying a service database, use your existing database connection/proxy and the packaged `recipes/postgres/financial-export-v1.sql`:

```sh
psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
  -f node_modules/@dvmkit/sdk/recipes/postgres/financial-export-v1.sql \
  > financial-evidence.json
```

The versioned JSON export takes a consistent read-only snapshot and includes signed receipt tuples, ledger balances/amounts/currencies, job/payment links, and recovery outcomes. Funding lots preserve every deposit's original sats and credit basis, including depleted lots. Draws retain both the original allocation and settled amount. Refunds retain fulfilment costs and funding-lot linkage. Optional channel projections preserve amounts and settlement links while excluding authorization signatures and vouchers; Tempo bigint amounts are decimal strings. Unsigned JSON blocks use typed financial projections: unsupported fields and objects or arrays in scalar positions are excluded. Optional ledger tables absent from a service become empty arrays. It excludes raw input/output, bearer tokens/proofs, payout descriptors, and operational credentials. Signed receipts may retain their signed terminal reason and result hash; supported version-1 job, funding, and drain receipts are returned unchanged. Unsupported receipt versions, kinds, fields, or nested extensions fail the entire export before any JSON is emitted. Update the recipe for that schema before destruction; a failed export is not retained financial evidence. Verify receipt signatures and check the file before destruction, then keep it securely with this recipe and the service's public receipt-key attestation. The builder owns this export; the platform retains its separate financial history. An export does not settle caller balances or refunds: resolve liabilities through their existing lifecycle. Case holds affect age expiry, not explicit erasure or contract/lifecycle destruction. The active-service window does not extend any contractual maximum for copies after explicit destruction, including a 90-day post-destruction limit where applicable.

The wire fields and routes are additive within protocol version 1. Existing explicit retention settings retain their value. The new default also applies to existing unredacted terminal rows; previously removed content stays unavailable. Upgrade all replicas before relying on holds: older SDKs do not recognize the hold fence. Do not downgrade or mix old replicas with active holds unless automatic sweeping is disabled on those replicas. The SQL export format is versioned independently of the package and is not a raw database backup or a content archive.
