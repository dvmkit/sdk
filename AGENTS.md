# Repository instructions

This repository publishes `@dvmkit/sdk`. Work against Node 22.23.2 (`.nvmrc`), install with `npm ci`, and use `npm run verify` as the complete local gate. A database suite skipped because `DATABASE_URL` is unset verified nothing; do not describe that path as green. CI runs `npm run verify -- --require-database` against Postgres.

## Public boundary

The supported API is exactly `@dvmkit/sdk`, `@dvmkit/sdk/server`, and `@dvmkit/sdk/testing`. `@dvmkit/sdk/internal` exists for the platform, is unstable, and must not appear in builder guidance or examples. Do not use deep `dist/` imports.

When a public declaration changes, update `api-surface.json`, rebuild, and run `npm run docs:api`; the committed API reference is generated from the built declarations. Every documented import must remain exercised by the clean packed-package consumer check.

Keep repository content publishable: no private repository names, tracker identifiers, machine paths, production credentials, customer data, or first-party operational details. Use `example.com`, deterministic test keys, and fake values in examples and fixtures.

## Money and trust invariants

- Authenticate and validate before handler side effects. Signed-request replay recording occurs only after an upfront payment verifies and immediately before job creation, so an unpaid discovery request cannot burn a nonce.
- A captured signature or one-time payment credential must not be reusable on another machine. Production and multi-machine deployments require durable Postgres-backed replay, credential, job, and credit stores; in-memory stores are for tests and explicit development mode.
- Never acknowledge money movement without its durable accounting fact. Rail acceptance, credit funding/drawing, settlement evidence, and outbox/report writes must preserve their existing atomic or fail-closed ordering.
- Prices passed by builders are major currency units; durable credit and settlement amounts use checked integer micro-units. Do not introduce floating-point comparison or rounding on a money boundary.
- Completion settles a pending draw. Failure and cancellation release it. `ctx.fail(..., { refund: true })` is an annotation and must not be treated as the mechanism that moves money.
- Prepaid balances remain caller-owned until the documented expiry release. Reusable channels return undrawn collateral through their lifecycle. One-payment stablecoin credit remains opt-in because unused balances create a manual reclaim obligation.
- Cashu, x402, and Tempo are per-call payment methods. Lightning is a receive-only prepaid-credit funding leg, not an attached-proof job payment method. Never place spending credentials in a DVM process merely to make reclaim automatic.

## Contracts and tests

Portable wire contracts live in `protocol-fixtures/` and are consumed by tests. Treat a fixture change as a protocol change: update the implementation, fixture, tests, API guidance, and compatibility/release notes together. Add a fixture when independent clients need exact bytes, headers, or response shapes rather than copying a test-only object.

Prefer handler tests through `@dvmkit/sdk/testing`; use a real local host when the boundary being tested is routing, lifecycle, authentication domain binding, or transport. Examples must run without production credentials or real payments.

`npm test` runs offline, `npm run test:server` needs free local ports (name any test that opens one `*.server.test.ts`), `npm run test:db` needs Postgres, and `npm run verify` runs all of them.

## Comments and tests

Keep comments that explain a non-obvious reason, constraint, unit, lifecycle, compatibility promise, or API behavior. Remove narration that merely repeats code, review provenance, stale history, and boilerplate. Preserve JavaScript JSDoc types, licenses, tooling directives, error codes, and supported API semantics.

Exported or public status alone does not require JSDoc. Keep generated API guidance useful without repeating a declaration's signature in prose. Prose-only edits need no new test, but they still run the repository's required verification gates.

Every test must cover a production failure or independently specified contract. Do not assert fixture setup, mock output, language behavior, or a result calculated with the same implementation under test. Determinism, idempotence, round trips, and retry/replay remain valuable when a defective implementation can violate the stated property. Before deleting or combining a test, retain coverage for each distinct regression it caught. Architecture guards remain valuable when their source property is contractual; keep a negative control that the guard rejects. Do not add tests solely to preserve policy wording.

Load `.agents/skills/test-audit/SKILL.md` before authoring, changing, reviewing, or auditing tests. It defines the evidence required for a test's value, each removal decision, and preservation checks.
