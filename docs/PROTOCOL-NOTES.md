# Protocol notes

## Terminal evidence

New job receipts keep schema version `1` and add optional signed `timing` with `accepted_at_ms`, `terminal_at_ms`, and cumulative `caller_wait_ms`. Acceptance and termination use Unix milliseconds; `issued_at` remains signing time in Unix seconds. Non-completed receipts also include SDK-derived `ended_by`: explicit caller cancellation and unanswered prompt/payment expiry are `caller`; handler failures, worker death, and idle expiry during processing or working are `provider`. Handlers cannot choose this attribution. Legacy receipts omit these fields and still verify. Jobs accepted before this change, including jobs still active during an upgrade, omit the additions and do not produce terminal reports because earlier caller waits are unknown; the SDK does not invent historical fault evidence.

Hosted servers with platform URL, token, DVM identity and durable database configured enqueue every terminal job, including free jobs, through the durable report outbox to `/_internal/job-terminal`. The payload contains the DVM/job identity, capability, outcome, attribution, payment-presence flag, timing and optional receipt sequence. It contains no caller identity, payment references or amounts, input, or output. The permanent deduplication claim and outbox insert commit together; startup and periodic recovery cover a crash after terminal persistence. Deliveries can repeat, so the platform deduplicates by DVM/job identity.

Deploy the platform endpoint before deploying report-emitting servers. These reports use the existing revenue transport policy: transport/5xx failures retry and abandon after 24 hours; 4xx responses, including 404, become permanently stale. The portable receipt and report contract is in `protocol-fixtures/job-terminal-evidence.json`; compatibility is tested with the pinned published `@dvmkit/sdk@0.1.5-rc.9` verifier.


## Tempo close terminal outcomes

A registered Tempo drain that cannot cooperatively close because its descriptor is invalid or its hosted retries are exhausted now returns HTTP 409 `tempo_channel_exit_required`, with `status: "exit_required"`, `drain_registered: true`, `drain_id`, and `channel_id`. Callers must use the channel's timed on-chain exit. A corrected credential does not reopen or debit that drain again. The debit remains reserved for the channel's refund; a late confirmed close can still fulfill it. Older callers that poll every 402 must handle this terminal 409. For a custom ledger without terminal-drain persistence, the 409 instead retains `status: "pending"` and explains that a corrected credential can retry when cooperative attempts remain. The portable response contract includes both modes in `protocol-fixtures/tempo-close-terminal.json`.

Completed Tempo drains remain readable when their credit is `unbacked`. Sweep-completed drains use the existing `sent` state and include `terminal_outcome` and `credit_unbacked` in their settlement evidence; caller liability is discharged only with sufficient refund evidence.

Hosted report searches now stop in persisted `unmatched` after a definitive empty range and require an explicit operator retry. This does not discharge the payout obligation or authorize cleanup. See [HOSTING.md](HOSTING.md) for the retry API and recovery constraints.


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


## Payment recorded before a snapshot failure

After a mid-job payment's accounting and inbound verification commit, a later snapshot failure returns HTTP 503 `job_snapshot_unavailable` with `payment_status: "recorded"`, `retryable: false`, and the `job_id` and inbound `seq`. Read the job status and messages instead of sending another payment. If the worker stopped, a non-payment message can resume the stored job using its accepted credit. An optional `credit` block retains the usual explanation of funds that did not apply to this job.

This is an additive error response for a failure that previously returned an unstructured 500. It does not change payment amounts, caller/request uniqueness, or funding and draw semantics. The portable response is in [job-snapshot-unavailable.json](../protocol-fixtures/job-snapshot-unavailable.json).


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
