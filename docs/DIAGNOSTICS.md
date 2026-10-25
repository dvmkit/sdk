# Payment diagnostics

Payment diagnostics retain fixed SDK categories so operators can distinguish a skipped credit leg from a credential, persistence, or accounting failure. Categories identify what the SDK observed; they do not establish that a service is down or that money moved.

Every diagnostic sink uses the same catalogue projection: console loggers, span stdout, emitters, buffering, HTTP transport, and database insertion. Category fields retain only primitive strings in these closed enums; `source_status` retains only integer HTTP statuses from 100 through 599. Unknown strings, nested objects, arrays, accessors, and coercible values are omitted; unclassified exceptions produce `unknown`. Exception names, messages, stacks, causes, provider response bodies, headers, credentials, proofs, and payment identifiers are excluded from these fields.

| Field | Allowed values | Meaning |
| --- | --- | --- |
| `reason` | `credit_or_draw_missing`, `draw_not_pending`, `draw_job_mismatch`, `rail_mismatch`, `channel_binding_mismatch`, `denomination_unavailable`, `topup_cap_unavailable`, `topup_cap_currency_mismatch`, `unknown` | The existing `credit_topup_skipped` reason. Cap reasons describe an unenforced ceiling; the credit leg may still proceed. |
| `cause` | `no_msats`, `sub_micro`, `unsupported_currency`, `rate_unavailable`, `rate_stale_refused`, `unknown` | The denomination failure behind `denomination_unavailable`. |
| `job_id_hash` | SHA-256 hex digest of the UTF-8 job ID | Binds top-up warnings to the server-owned job without retaining raw job, credit, or draw IDs. Absent when no job ID is available. |
| `source_failure` | `network_error`, `http_error`, `invalid_body`, `no_usable_rate`, `missing_currency`, `unknown` | The last source attempt failed at transport, HTTP response, body parsing/shape, or usable-rate collection; `missing_currency` means a successful snapshot omitted an advertised currency with no cached rate. `unknown` means no typed source observation is available. |
| `source_status` | Integer from 100 through 599 | The HTTP status observed for an `http_error`, when available. It does not contain provider text. |
| `failure_category` | `invalid_challenge`, `malformed_credential`, `payment_expired`, `verification_failed`, `insufficient_funds`, `invalid_signature`, `unsupported_method`, `replay_detected`, `ledger_refused`, `settlement_failed`, `unsupported_version`, `unknown` | A recognized typed exception or an SDK-observed verifier/settlement rejection. |
| `failure_stage` | `verifier`, `broadcast`, `verifier_broadcast`, `replay_store`, `funding_ledger`, `unknown` | The narrowest observable operation that failed. |
| `phase` | `upfront`, `mid-job` | The job payment phase, when the emitting path knows it. |
| `transaction_hash` | `0x` followed by exactly 64 hexadecimal digits | The transaction reference from a successful Tempo charge receipt, retained when its subsequent consumed-credential mark fails. |

If a one-shot Tempo charge succeeds with a valid transaction hash but its consumed-credential mark fails, the SDK emits `tempo_replay_mark_failed` at error level for operator alerting, including `transaction_hash`. The call continues through the required accounting commit instead of returning a payment refusal solely for the failed mark. The rail's transaction-hash replay guard and the processed-payment accounting marker remain in force. Receipts without a valid transaction hash, including zero-dollar proofs, retain fail-closed replay marking. This event is a narrow exception to payment-identifier exclusion; it contains no credential, challenge ID, or exception text.

`tempo_session_close_report_written_off`, `tempo_session_close_report_reopened`, and `tempo_session_close_exit_resolved` are a narrow exception to payment-identifier exclusion. Only these three events on the Tempo dataset retain `channel_id` (a 32-byte hex channel ID) and `obligation_id` (a UUID). Write-off and reopen retain the decimal-string native token amounts `amount_native` and `amount_forgone_native`; payer-exit resolution retains only its `amount_at_stake_native` amount field. The money rule requires an operator to see which channel's builder payout report was forgone and how much, including when a payer exit resolves the obligation without a report; the reopen event records when the operator resumes that report search. Other Tempo events continue to omit these identifiers and amounts, even when they pass well-formed values. These events retain no drain ID, credential, write-off note, or exception text.

`verifier_broadcast` means the payment adapter combines validation and settlement and exposes no narrower failure boundary. `replay_store` covers consumed-credential reads/writes and processed-payment marker transactions. `funding_ledger` covers the accounting operation inside that transaction, including funding, draw growth, and deposit enqueue. An opaque acceptance transaction that fails outside those observable callbacks reports `unknown`.

Typed challenge errors do not distinguish expiry, a bad binding, or a missing challenge unless the dependency exposes a dedicated error type. Generic `Error`, `TypeError`, forged exception names, and nested causes do not imply RPC, rate, database, or network unavailability. x402 boolean rejection results distinguish verifier and settlement rejection without interpreting provider prose.

For example, an accepted Cashu top-up whose credit leg cannot find a usable rate emits:

```json
{"event":"credit_topup_skipped","level":"warn","rail":"cashu","reason":"denomination_unavailable","cause":"rate_unavailable","currency":"usd","source_failure":"http_error","source_status":429}
```

A Tempo adapter exception may instead emit:

```json
{"event":"tempo_credential_rejected","level":"warn","rail":"tempo","phase":"upfront","failure_category":"unknown","failure_stage":"verifier_broadcast"}
```

Diagnostics are best-effort and cannot change the payment outcome. Existing sanitized origin fields retain their established privacy rules; payment failure fields never retain URLs or arbitrary text.

## Trusted DVM resolution

Catalogue version 1 includes the additive identity field `dvm_resolution`, whose only accepted value is the primitive string `"none"`. It positively records that a request resolved no DVM; an absent DVM identity alone makes no such statement.

Trusted instrumentation sets the mark with `pinDimension("dvm_resolution", "none")` inside a trace context, or extends and binds a process-local `DiagnosticIdentityAuthority` with `extendDiagnosticIdentityAuthority`. Ordinary dimensions and attributes cannot grant this authority. Projection ignores input values and retains only the bound authority's value; it drops the field when authority is missing, forged, or does not carry the mark. Authority bindings survive in-process projection and buffering, but do not serialize: receiving a JSON row with the mark grants no authority to retain it.

When an authority carries both `dvm_id` and `dvm_resolution`, projection retains the DVM identity and omits `dvm_resolution` from dimensions and attributes, regardless of pinning order or whether the input includes `dvm_id`. All diagnostic sinks apply this rule, including stdout, HTTP serialization, and direct PostgreSQL insertion. Invalid mark values do not extend or replace the existing authority.
