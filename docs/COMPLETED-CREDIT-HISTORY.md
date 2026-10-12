# Completed credit history

The caller stores completed refund and expired implicit-credit loss facts in an owner-only
`credits-history.jsonl` beside `credits.json`. The working store keeps its eight most recent
settled bundles and eight losses per owner and DVM, after the journal is flushed. Unresolved
refund descriptors and credentials remain in the working store without this cap.

Only locally terminal records enter history. A refund's `settledAt` is the caller's unsigned
observation that the refund arrived, not the receipt collection time or a new server signature.
A loss records the existing `expired` or `not_found` transition. Still-present legacy terminal
records seed the journal on the next store read; earlier evictions cannot be reconstructed.
Legacy refund currency, amount, fee, and collection time facts that cannot be established are `null`.
The working store keeps its existing zero collection-time sentinel; history renders that sentinel
and missing legacy collection times as `collectedAt: null`. Known nonzero collection times are retained. Unknown
fees are never treated as zero. New collection snapshots the currency, and settlement can
supply the actual rail, amount and fee. Amounts and fees are integer micro-units of that currency.

The internal caller contract is `readCompletedCreditHistory(query)` with optional `limit`
(default 50, integer 1–100), `order` (`asc` by default or `desc`), `cursor`, `endpoint`, `dvmId`, and `callerPubkey`. It returns
`{ records, nextCursor? }`. Records discriminate on `kind`: `completed_refund` or
`expired_credit_loss`. Common fields include version `v: 1`, stable `id`, endpoint and aliases,
DVM and builder identity when known, caller and credit identifiers, `occurredAt`, rail,
currency, amount and fee. Refunds additionally retain the drain identifier, outcome `refunded`,
settlement and collection times, signed receipt bundle, builder advertisement when available,
and provenance. Losses retain outcome `lost`, reason, release time and job, and expiry time.
Only a complete DVM-ID and attested-builder pair authenticates identity across origins.
Same-origin partial identity can be upgraded; unknown replays retain learned identity and
accumulated aliases while admitting newer terminal facts. Conflicting complete pairs stay separate.
This API belongs to the existing internal caller entry and is not a supported builder API.

Pages default to oldest first by `occurredAt`, then by stable ID using lexical string order.
`order: "desc"` reverses both keys to return the newest page first. Endpoint
filters normalize to origins and include recorded aliases; filters combine. Treat cursors as
opaque and supply the same filters and direction on each continuation. A cursor pins an immutable journal
prefix, so later appends and evidence refreshes appear only in a fresh query. Invalid cursors,
changed filters, or a replaced journal prefix fail explicitly. Page output is bounded; the
implementation scans and materializes the journal to deduplicate revisions, so read time and
memory grow with local history size.

The journal preserves supported signed receipt and advertisement bytes exactly. Their presence
is not authentication: provenance labels them as unverified observations. Consumers must use
`verifyDrainReceiptChain` with the archived anchor and expected credit and drain identifiers
before making claims about signed evidence. Unsigned settlement metadata does not alter those
signatures. Unsupported artifact fields, malformed artifacts, or corrupt complete journal lines
make the history reader report archive unavailability and preserve the source evidence for inspection; they are never silently stripped
or copied as possible bearer credentials. Working-store secrets and pending credentials are
not journal fields.

Every archive/read operation holds the credit-store lock. Appends finish and flush before any
working projection is evicted. A crash may leave complete revisions or an incomplete final
line: retry deduplicates complete revisions and truncates only the uncommitted final fragment
before appending again. File and directory flush failures prevent projection eviction. Archive admission or I/O failure
retains the affected untrimmed completed working projection while unrelated active-credit reads
and retry writes remain available. The explicit history reader requires successful archival and
reports unavailable history. A completed receipt refresh or loss reconciliation that would
replace unarchived terminal facts is deferred until archival succeeds; an explicit forget
requires successful archival of that record's completed evidence before removal. Explicit
forget behavior for active records without completed evidence is unchanged. Replayed
legacy reads and concurrent commands preserve one logical record per completion, while new
receipt or advertisement observations append revisions instead of rewriting the journal.
