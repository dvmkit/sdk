# @dvmkit/sdk

Build Digital Vending Machines: accountless HTTPS services with typed inputs, jobs, and payment rails.

Requires Node.js 22 or later. This is pre-1.0 alpha software: pin the exact package version and read the [release notes](./CHANGELOG.md) before upgrading.

## Quickstart: a free DVM

Create a project and install the SDK:

```sh
mkdir hello-dvm && cd hello-dvm
npm init -y
npm install --save-exact @dvmkit/sdk@0.8.0
```

Stable releases use `latest`; prerelease candidates use `next` and must be requested explicitly. The commands here pin the stable `0.8.0` release. For an agent-guided scaffold and deployment, install the [builder CLI](https://www.npmjs.com/package/@dvmkit/dvmctl) with `npm install --global @dvmkit/dvmctl@0.8.0` and use its `build-dvm` skill. The standalone example below needs only the SDK.

Save this as `handler.mjs`:

```js
import { configureDVM, z } from "@dvmkit/sdk";

export default configureDVM({
  name: "hello",
  capability: "echo",
  input: z.object({ text: z.string().min(1) }),
  example: { text: "hello" },
  onJob(ctx) {
    ctx.artifact({ mime_type: "text/plain", data: ctx.input.text });
    ctx.complete("Echoed the input");
  },
});
```

Save this as `server.mjs`, then run it with `node server.mjs`:

```js
import { serve } from "@dvmkit/sdk/server";
import dvm from "./handler.mjs";

await serve(dvm, { devMode: true });
```

Submit a local request. `devMode` makes Postgres optional and skips payment verification only when no Cashu, x402, or Tempo rail is configured:

```sh
curl -sS http://localhost:8080/v1/job \
  -H 'content-type: application/json' \
  --data '{"capability":"echo","data":{"text":"hello"}}'
```

Test the handler without opening a port or configuring a payment rail:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createTestContext } from "@dvmkit/sdk/testing";
import dvm from "./handler.mjs";

test("echoes its input", async () => {
  const ctx = createTestContext({ input: { text: "hello" } });
  await dvm.capabilities.echo.onJob(ctx);
  assert.equal(ctx.completed, true);
  assert.equal(ctx.messages[0].content.data, "hello");
});
```

Run that file with `node --test handler.test.mjs`. The repository carries the complete version under [`examples/quickstart`](./examples/quickstart), plus runnable [signed-auth/custom-route](./examples/authenticated-route) and [payment/lifecycle](./examples/payments-and-lifecycle) examples.

## Public entry points

| Import | Use it for |
| --- | --- |
| `@dvmkit/sdk` | DVM descriptors, handler context, bundled Zod, pricing, signing and safe-fetch helpers |
| `@dvmkit/sdk/server` | Node hosting, Postgres stores, signed-request auth, compatibility gates and payment infrastructure |
| `@dvmkit/sdk/testing` | Deterministic handler contexts and in-memory stores |

The generated [API reference](./docs/API.md) lists every declaration under these three entries. Deep imports from `dist/` are unsupported.

## Verified payments in development

`serve()` returns a `paymentModes` snapshot describing whether each configured rail is verifying, unavailable, or absent. A priced development server skips verification only when it has no configured payment rail. Configuring an unusable rail fails closed instead of turning the request into a synthetic development payment.

Cashu development without Postgres is limited to known test or loopback mints. It uses a fresh lock identity and process-local accounting on every boot, so proofs, balances, and jobs do not survive restart. Production Cashu remains PostgreSQL-backed. Both paths require valid mint-provided NUT-12 DLEQ evidence on every proof before accepting its value; older tokens without that evidence must be replaced with fresh tokens from a compatible mint.

Builders can pass `onPaidJobCompleted` to observe settled customer charges after successful completion. The event contains `jobId`, verified rail, checked integer `amountMicro`, the credit currency, and whether configuration identifies test funds. Reconciliation can repeat an event, so consumers deduplicate by `jobId`. Free jobs, synthetic development payments, failed jobs, and released draws do not emit.

## Production next steps

- Use Postgres through `DATABASE_URL`; production boot refuses an in-memory job store unless you deliberately supply another durable implementation.
- Add `auth: secp256k1Auth()` for caller-owned state. The host automatically uses a Postgres replay store when one is available; a per-process replay window is unsafe across replicas.
- Configure only the rails you operate: Cashu, x402, and Tempo are job payment methods. Lightning is a receive-only prepaid-credit funding leg. Keep every private key, wallet connection, and platform token in your secret store rather than source.
- A `credit` block opts into reusable prepaid balances and their reclaim obligations. Reusable channels return undrawn collateral through their channel lifecycle; one-payment stablecoin funding is disabled unless `allowOneShotStablecoin: true` because it creates manual refunds. Run and monitor the documented reclaim/payout worker.
- Honour `ctx.signal`, use `ctx.fetch` for abortable provider calls, and declare provider cost with `ctx.cost` only after the durable step that incurred it.

Reusable x402 channels default to a 24-hour payer withdrawal grace (86400 seconds) on every network. For Base Sepolia (`eip155:84532`) acceptance tests, set `x402.batchSettlement.withdrawDelay: 900` or `DVMKIT_X402_WITHDRAW_DELAY_SECONDS=900` with `DVMKIT_X402_BATCH_SETTLEMENT=true`. Explicit delays must be integer seconds and at least 900 on Base Sepolia; Base mainnet retains the 86400 minimum even in development mode and still requires self-relay. The grace is bound into each channel's immutable configuration: changing the server setting affects new channels, not existing deposits. A shorter testnet run exercises early-withdrawal refusal and post-deadline recovery; retain a separate 24-hour run to cover next-day recovery.

For Bitcoin credit monitoring, `GET /admin/credit/bitcoin-liability` reports exact in-kind obligations in satoshis. Uncovered and basisless credits need live-rate pricing on reclaim, so their whole balances appear in `uncovered_by_currency` and `unbacked_by_currency` as `{ currency, micro, credits }` entries. Sum the credit counts if useful, but display or price each currency separately. Older consumers must replace the former `uncovered_micro` and `unbacked_micro` scalar reads; the [portable response fixture](./protocol-fixtures/bitcoin-liability.json) shows the full shape.

The public [SDK guide](https://dvmkit.com/docs/sdk) covers signed requests, custom routes, rail configuration, credit reclaim, persistence, and deployment in depth. The [protocol guide](https://dvmkit.com/docs/protocol) specifies the HTTP contract.

## Diagnostic retention

[Payment diagnostics](./docs/DIAGNOSTICS.md) documents the closed failure categories, stages, and top-up causes retained by safe logging sinks.

The SDK advertises 730 days of retention for sanitized diagnostics in every existing span dataset: `platform`, `cashu`, `lightning`, `stripe`, `x402`, `tempo`, `isolate`, `audit`, and `cron`. Dataset names, producer permissions, and query semantics remain unchanged; only operator services may write to `audit`.

This metadata describes the retention schedule. The SDK does not automatically delete diagnostics or override platform destruction or case controls. The platform must enforce the schedule and those controls.

## Repository development

Use the Node.js release in `.nvmrc` (Node 22). Install with `npm ci`, then run the same gate CI runs with `npm run verify`. The gate checks repository metadata in the checkout, copies only tracked and unignored source into an isolated directory, installs its locked dependencies, and runs lint, build, typecheck (including the release scripts under `checkJs`), unit and database tests, API, package, consumer, packed-artifact safety, and release checks there. The clean source tree owns the complete build and test pass, so verification never depends on the checkout's `node_modules` or pre-existing `dist` and does not repeat the full suite; after every check passes, its verified `dist` replaces the checkout's build output for release packaging.

`DATABASE_URL` is optional locally. Without it the database suite is skipped rather than passed, and `verify` says so in its summary, because a skipped suite verified nothing and must not be reported as green. Point `DATABASE_URL` at a scratch Postgres to run it, and pass `npm run verify -- --require-database` to make a missing one a failure, which is what CI does. That mode also requires the local test mint started by `node scripts/start-cashu-mint.mjs`.

The public surface is exactly `@dvmkit/sdk`, `@dvmkit/sdk/server`, and `@dvmkit/sdk/testing`.

When you pass `env` to `serve()` or `createDVMHost()`, that object is the complete host
environment. SDK configuration, including provenance, builder and owner identity, and
mint-health defaults, reads only from it. Omit `env` to use `process.env`.

## Terminal evidence

New job receipts keep schema version `1` and add optional signed `timing` with `accepted_at_ms`, `terminal_at_ms`, and cumulative `caller_wait_ms`. Acceptance and termination use Unix milliseconds; `issued_at` remains signing time in Unix seconds. Non-completed receipts also include SDK-derived `ended_by`: explicit caller cancellation and unanswered prompt/payment expiry are `caller`; handler failures, worker death, and idle expiry during processing or working are `provider`. Handlers cannot choose this attribution. Legacy receipts omit these fields and still verify. Jobs accepted before this change, including jobs still active during an upgrade, omit the additions and do not produce terminal reports because earlier caller waits are unknown; the SDK does not invent historical fault evidence.

Hosted servers with platform URL, token, DVM identity and durable database configured enqueue every terminal job, including free jobs, through the durable report outbox to `/_internal/job-terminal`. The payload contains the DVM/job identity, capability, outcome, attribution, payment-presence flag, timing and optional receipt sequence. It contains no caller identity, payment references or amounts, input, or output. The permanent deduplication claim and outbox insert commit together; startup and periodic recovery cover a crash after terminal persistence. Deliveries can repeat, so the platform deduplicates by DVM/job identity.

Deploy the platform endpoint before deploying report-emitting servers. These reports use the existing revenue transport policy: transport/5xx failures retry and abandon after 24 hours; 4xx responses, including 404, become permanently stale. The portable receipt and report contract is in `protocol-fixtures/job-terminal-evidence.json`; compatibility is tested with the pinned published `@dvmkit/sdk@0.1.5-rc.9` verifier.

## Compatibility and versioning

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

The [portable fixture](./protocol-fixtures/capability-rates.json) carries the same limits and the accepted and refused examples, for clients that parse the field.

## Contributing

**This repository does not accept unsolicited pull requests.** One opened without an invitation is closed automatically, with a pointer to where the report belongs.

**Issues and discussions are welcome and read.** We do not merge a change we cannot reproduce, and once we can reproduce a problem our own pipeline writes and reviews the fix. That makes a precise reproduction worth more to us than a patch, so that is what we ask for.

[CONTRIBUTING.md](./CONTRIBUTING.md) is the full policy. [SUPPORT.md](./SUPPORT.md) routes a question to the right place, [SECURITY.md](./SECURITY.md) covers vulnerability reports, which never go in a public issue, and the [Code of Conduct](./CODE_OF_CONDUCT.md) governs both trackers.

## Trademarks

The Apache License 2.0 covers the source. It grants no rights in the dvmkit name or branding, and nothing in this repository implies a trademark licence.

`dvmkit` identifies products and services of DVM Technologies Ltd. You may say truthfully that your software uses, works with, or is built on `@dvmkit/sdk`, name the package in dependency listings and documentation, and describe an unmodified official release by its name. You need written permission to name a product, service, company, domain, or account in a way likely to be read as official dvmkit work, to use dvmkit branding as your own identity, or to claim sponsorship, certification, partnership, or endorsement. A fork is yours to redistribute under the Apache licence; name and present it so that nobody mistakes it for an official release.

None of this claims exclusive rights in the phrase "digital vending machine" or in "DVM" used descriptively. Permission requests go to `support@dvmkit.com` with the subject `dvmkit trademark use request`, and nothing here limits rights you have under applicable law, including nominative fair use.

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Job content retention and case holds

`configureDVM` defaults `jobRetentionDays` to 730. Set a shorter or longer whole-day
window explicitly, or `0` to disable automatic age expiry. Only completed, failed,
and cancelled jobs are eligible. The terminal `lastActivityAt` is frozen: reads,
receipt delivery, late messages, and re-saving an outcome do not renew it. The
sweep removes input, params, summary, messages, state, caches, and bearer proofs;
it preserves durable status, signed receipts, payment amounts, and recovery linkage.

Authenticated job submit, request-result, status and JSON message responses expose
`content_expires_at` (epoch milliseconds or `null`) and `content_available` (boolean).
A null deadline means the job is active, expiry is disabled, or an active hold
suppresses it. A past deadline can still have available content until the sweep
runs. Missing fields on an older service or unsupported custom store mean unknown.
SSE messages retain their existing event format; read job status for expiry.

With durable service-admin configuration, use signed `Authorization: P2PK`
requests on the service-local routes:

| Method | Path | JSON body |
| --- | --- | --- |
| GET | `/admin/jobs/:jobId/content-holds` | none |
| POST | `/admin/jobs/:jobId/content-holds` | `purpose`, `reason`, `review_due_at` |
| POST | `/admin/jobs/:jobId/content-holds/:holdId/renew` | `reason`, `review_due_at` |
| POST | `/admin/jobs/:jobId/content-holds/:holdId/clear` | `reason` |

Purpose is `support` or `dispute`; reason is 1–1000 characters and review dates
are future epoch millisecond integers. Unknown body fields are rejected. Hold IDs,
actor public keys, and creation/clear times are server-derived. Authentication uses
the existing method/path/service-bound admin challenge, current and grace-period
keys, and atomic durable nonce consumption. A hold request does not grant access
to job content. Authentication failure returns 401 with a reason; an unsupported
store returns `content_holds_unavailable` (503), missing jobs return 404, and a
redacted job or inactive hold returns 409. Holds cannot restore redacted content.

Responses include `job_id`, caller content metadata, `baseline_content_expires_at`,
`holds`, and append-only `events`. Each hold contains `id`, `job_id`, `purpose`,
`reason`, original `actor`, `created_at`, `review_due_at`, `cleared_at`, and computed
`review_overdue`. Each event contains `id`, `hold_id`, `job_id`, `action`, `actor`,
`reason`, `at`, `review_due_at`. Renew and clear preserve the original actor and
creation date; their authenticated actors are in history. Any active hold suppresses
the effective deadline. Overdue review flags work; it does not release the hold.
The baseline remains visible for review. Clearing the last hold restores the
baseline and can make content immediately eligible for the next sweep.

`PostgresJobStore.init()` adds `job_content_holds` and `job_content_hold_events`
with job-scoped indexes; existing jobs need no expiry column or backfill. Placement
and sweep lock the same job row and check redaction/terminal activity/active holds
inside the transaction. Admin operations refuse jobs bound to another service;
legacy unbound rows belong to the local service database. A committed hold wins any later competing sweep; if
redaction wins first, placement fails. `MemoryJobStore` supplies the same contract
for development. Custom stores must implement `ContentHoldStore` and atomic
redaction fencing to support holds and truthful metadata.

Before explicitly destroying a service database, use your existing database
connection/proxy and the packaged `recipes/postgres/financial-export-v1.sql`:

```sh
psql "$DATABASE_URL" -X -q -t -A -v ON_ERROR_STOP=1 \
  -f node_modules/@dvmkit/sdk/recipes/postgres/financial-export-v1.sql \
  > financial-evidence.json
```

The versioned JSON export takes a consistent read-only snapshot and includes signed
receipt tuples, ledger balances/amounts/currencies, job/payment links, and recovery
outcomes. Funding lots preserve every deposit's original sats and credit basis,
including depleted lots. Draws retain both the original allocation and settled
amount. Refunds retain fulfilment costs and funding-lot linkage. Optional channel
projections preserve amounts and settlement links while excluding authorization
signatures and vouchers; Tempo bigint amounts are decimal strings.
Unsigned JSON blocks use typed financial projections: unsupported fields and
objects or arrays in scalar positions are excluded. Optional ledger tables absent from a service become empty arrays. It
excludes raw input/output, bearer tokens/proofs, payout descriptors, and operational
credentials. Signed receipts may retain their signed terminal reason and result
hash; supported version-1 job, funding, and drain receipts are returned unchanged.
Unsupported receipt versions, kinds, fields, or nested extensions fail the entire
export before any JSON is emitted. Update the recipe for that schema before
destruction; a failed export is not retained financial evidence. Verify receipt
signatures and check the file before destruction, then keep it securely with this recipe
and the service's public receipt-key attestation. The builder owns this export;
the platform retains its separate financial history. An export does not settle
caller balances or refunds: resolve liabilities through their existing lifecycle.
Case holds affect age expiry, not explicit erasure or contract/lifecycle destruction.
The active-service window does not extend any contractual maximum for copies after
explicit destruction, including a 90-day post-destruction limit where applicable.

The wire fields and routes are additive within protocol version 1. Existing explicit
retention settings retain their value. The new default also applies to existing
unredacted terminal rows; previously removed content stays unavailable. Upgrade
all replicas before relying on holds: older SDKs do not recognize the hold fence.
Do not downgrade or mix old replicas with active holds unless automatic sweeping
is disabled on those replicas. The SQL export format is versioned independently
of the package and is not a raw database backup or a content archive.
