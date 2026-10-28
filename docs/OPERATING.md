# Operating a DVM

## Verified payments in development

`serve()` returns a `paymentModes` snapshot describing whether each configured rail is verifying, unavailable, or absent. A priced development server skips verification only when it has no configured payment rail. Configuring an unusable rail fails closed instead of turning the request into a synthetic development payment.

Cashu development without Postgres is limited to known test or loopback mints. It uses a fresh lock identity and process-local accounting on every boot, so proofs, balances, and jobs do not survive restart. Production Cashu remains PostgreSQL-backed. Both paths require valid mint-provided NUT-12 DLEQ evidence on every proof before accepting its value; older tokens without that evidence must be replaced with fresh tokens from a compatible mint.

Builders can pass `onPaidJobCompleted` to observe settled customer charges after successful completion. The event contains `jobId`, verified rail, checked integer `amountMicro`, the credit currency, and whether configuration identifies test funds. Reconciliation can repeat an event, so consumers deduplicate by `jobId`. Free jobs, synthetic development payments, failed jobs, and released draws do not emit.


## Production next steps

- Use Postgres through `DATABASE_URL`; production boot refuses an in-memory job store unless you deliberately supply another durable implementation.
- Add `auth: secp256k1Auth()` for caller-owned state. The host automatically uses a Postgres replay store when one is available; a per-process replay window is unsafe across replicas.
- `secp256k1Auth({ allowUnsignedPaid: true })` also serves unsigned callers when they pay per call, such as standard HTTP payment wallets. Those jobs run anonymously: no `ctx.auth`, no prepaid credit, and a failed job's released money cannot be reclaimed. See [Unsigned paid calls](PROTOCOL-NOTES.md#unsigned-paid-calls).
- Configure only the rails you operate: Cashu, x402, and Tempo are job payment methods. Lightning is a receive-only prepaid-credit funding leg. Keep every private key, wallet connection, and platform token in your secret store rather than source.
- A `credit` block opts into reusable prepaid balances and their reclaim obligations. Reusable channels return undrawn collateral through their channel lifecycle; one-payment stablecoin funding is disabled unless `allowOneShotStablecoin: true` because it creates manual refunds. Run and monitor the documented reclaim/payout worker.
- Honour `ctx.signal`, use `ctx.fetch` for abortable provider calls, and declare provider cost with `ctx.cost` only after the durable step that incurred it.

Reusable x402 channels default to a 24-hour payer withdrawal grace (86400 seconds) on every network. For Base Sepolia (`eip155:84532`) acceptance tests, set `x402.batchSettlement.withdrawDelay: 900` or `DVMKIT_X402_WITHDRAW_DELAY_SECONDS=900` with `DVMKIT_X402_BATCH_SETTLEMENT=true`. Explicit delays must be integer seconds and at least 900 on Base Sepolia; Base mainnet retains the 86400 minimum even in development mode and still requires self-relay. The grace is bound into each channel's immutable configuration: changing the server setting affects new channels, not existing deposits. A shorter testnet run exercises early-withdrawal refusal and post-deadline recovery; retain a separate 24-hour run to cover next-day recovery.

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
