---
name: test-audit
description: >
  Use when adding or changing tests, reviewing their value, or auditing a
  suite for tautologies, redundant coverage, brittle assertions, and unused
  test support. Requires evidence for every removal and preserves distinct
  regression protection.
---

# Test value

Apply repository verification and ownership rules first. Tests protect behavior or an independent contract; counts and coverage percentages do not establish that protection.

## Before writing a test

Identify the behavior, a plausible defect, and why existing tests miss it. Choose the cheapest boundary that exposes that defect. A second layer needs a distinct failure to catch. Mock external inputs, not the behavior being asserted. Prefer extending existing cases when they own the same contract.

Expected results must come from a specification, independently derived example, or meaningful property. Fixture self-checks, configured mock output, self-comparisons, and expected values computed by the same implementation do not qualify. Determinism, round trips, idempotence and retry/replay are valid when a production defect can violate the property.

For a bug fix, demonstrate that the test fails for the intended reason without the fix, then passes with it. If that control cannot run, state the missing evidence. Avoid production exports, switches, or indirection used only to reach implementation details; first seek an existing observable boundary.

## Audit an existing suite

1. **Set the boundary.** Pin the baseline revision. Inventory owned test files, support code, generated tests and CI routing. Name which files receive a full semantic review and which receive only candidate searches. Record baseline test results and existing failures separately. Use available coverage tooling as supporting evidence; do not install a coverage or mutation framework merely for cleanup.
2. **Read before judging.** Read candidate tests including tables, their production owner, callers and relevant history. Identify what each assertion actually detects. Look for vacuous negatives, fixtures doing the work, assertions weaker than their names, repeated proof at multiple layers, and source-spelling checks. These are candidates, not automatic deletions.
3. **Record decisions.** For each declaration in the fully reviewed group, mark retain, repair, consolidate or delete, with a short reason. For each proposed removal/repair, record location, credible defect, remaining proof or absence of a meaningful contract, history, affected support code and focused validation. Group repetitive retained cases only when they share the same reasoning; account for distinct table rows.
4. **Compare layers.** Name the retained suite for each contract before editing. Move unique assertions into it before retiring duplicates. Remove support or production access points only after checking all callers and supported API obligations. Similar syntax or a slower test does not prove redundancy.
5. **Apply a coherent batch.** Preserve separate money, recovery, lifecycle, package/release, security and architecture protection. Source inspection can be appropriate when a source property is itself the contract; check a deliberately invalid example. Treat failing baseline tests as possible product defects, never cleanup opportunities. Keep substantial unrelated fixes separate.
6. **Verify preservation.** Run affected retained tests and required repository gates after edits. Use a deliberate defect or invalid input to show changed protection fails for the intended reason; restore any temporary source change exactly before continuing. Do not edit a checkout during its test run. Have an independent reviewer compare removed assertions with retained proof and resolve gaps before landing.

Keep a compact audit record with scope, decisions, evidence, baseline/final test and support size, separately counted production changes, actual checks and skips. Rerun discovery when upstream changes the audited owner. No deletion target, weaker gate, increased timeout, or acceptable coverage drop authorizes losing a distinct contract. A justified retention is a completed audit decision.

## Comments and scope

Do not add tests solely for prose or policy wording. Preserve useful rationale, API semantics, functional annotations and tooling directives while removing comment noise. Tests do not justify otherwise dead production paths. Follow normal review, delivery and CI ownership rules; this skill grants no publication or permission changes.

Method informed by [OpenClaw's test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md), adapted to local verification and test-ownership rules.
