import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  bindDiagnosticCapabilityAuthority,
  bindDiagnosticIdentityAuthority,
  createDiagnosticCapabilityAuthority,
  DIAGNOSTIC_CATALOGUE,
  DIAGNOSTIC_PROJECTION_EPOCH,
  extendDiagnosticIdentityAuthority,
  projectSpanRow,
  type DiagnosticCatalogue,
  type DiagnosticIdentityAuthority,
} from "../projection";
import type { SpanRow } from "../types";
import { chargeSettledOnRetry, durableSleep, epoch1, facilitatorTruncation, settlementUnconfirmed } from "./fixtures/projection/epoch-1";
import pins from "./fixtures/projection/batch-pins.json";

// Older snapshots predate lists that a later release may add.
type CatalogueSnapshot = Pick<DiagnosticCatalogue, "version"> & Partial<Omit<DiagnosticCatalogue, "version">>;

interface CorpusBatch {
  epoch: number;
  catalogue?: CatalogueSnapshot;
  rows: Record<string, readonly SpanRow[]>;
}

const corpus = {
  initial: { epoch: 1, ...epoch1 },
  facilitatorTruncation: { epoch: 1, ...facilitatorTruncation },
  settlementUnconfirmed: { epoch: 1, ...settlementUnconfirmed },
  chargeSettledOnRetry: { epoch: 1, ...chargeSettledOnRetry },
  durableSleep: { epoch: 1, ...durableSleep },
} satisfies Record<string, CorpusBatch>;

function projectAdmittedRow(row: SpanRow) {
  // Trusted context is process-local. Reconstitute it from the synthetic
  // identities and declared capabilities in the fixture before the first pass.
  const input = structuredClone(row);
  const { dimensions } = input;
  let identity: DiagnosticIdentityAuthority | undefined;
  for (const key of ["dvm_id", "dvm_slug", "builder_id", "dvm_resolution"]) {
    if (Object.hasOwn(dimensions, key)) {
      identity = extendDiagnosticIdentityAuthority(identity, key, dimensions[key]);
    }
  }
  bindDiagnosticIdentityAuthority(input, identity);

  const capabilities = [dimensions.capability, dimensions.capabilities]
    .flat()
    .filter((value): value is string => typeof value === "string");
  bindDiagnosticCapabilityAuthority(input, createDiagnosticCapabilityAuthority(capabilities));
  return projectSpanRow(input);
}

function catalogueLosses(previous: CatalogueSnapshot, next: CatalogueSnapshot): string[] {
  const losses: string[] = [];
  for (const key of Object.keys(previous) as (keyof DiagnosticCatalogue)[]) {
    if (key === "version") continue;
    if (!Object.hasOwn(next, key)) {
      losses.push(key);
      continue;
    }
    const before = new Set<string | number>(previous[key]);
    const after = new Set<string | number>(next[key]);
    // tokenFields is a strip list: additions withdraw an admission.
    const [required, available] = key === "tokenFields" ? [after, before] : [before, after];
    for (const entry of required) {
      if (!available.has(entry)) losses.push(`${key}: ${entry}`);
    }
  }
  return losses;
}

describe("diagnostic projection epoch", () => {
  const batches: Record<string, CorpusBatch> = corpus;
  const active = pins
    .filter(({ epoch }) => epoch === DIAGNOSTIC_PROJECTION_EPOCH)
    .map(({ id }) => [id, batches[id]] as const);

  it("records the live catalogue in the latest snapshot of the current epoch", () => {
    const snapshots = active.flatMap(([id, batch]) => batch.catalogue ? [{ id, catalogue: batch.catalogue }] : []);
    const latest = snapshots.at(-1);
    expect(latest?.catalogue).toEqual(DIAGNOSTIC_CATALOGUE);
    for (const [index, { id, catalogue }] of snapshots.slice(1).entries()) {
      expect(catalogueLosses(snapshots[index].catalogue, catalogue), `catalogue snapshot ${id}`).toEqual([]);
    }
  });

  it("has a corpus for each epoch and keeps every published batch intact", () => {
    const epochs = [...new Set(Object.values(batches).map(({ epoch }) => epoch))].sort((a, b) => a - b);
    expect(epochs).toEqual(Array.from({ length: DIAGNOSTIC_PROJECTION_EPOCH }, (_, index) => index + 1));
    expect(pins.map(({ id }) => id).sort()).toEqual(Object.keys(corpus).sort());
    for (const { id, epoch, sha256 } of pins) {
      expect(batches[id].epoch, `epoch of corpus batch ${id}`).toBe(epoch);
      const digest = createHash("sha256").update(JSON.stringify(batches[id])).digest("hex");
      expect(digest, `published corpus batch ${id}`).toBe(sha256);
    }
    for (const epoch of epochs) {
      expect(Object.values(batches).some((batch) => batch.epoch === epoch && batch.catalogue !== undefined)).toBe(true);
    }
  });

  for (const [key, batch] of active) {
    for (const [group, rows] of Object.entries(batch.rows)) {
      it(`preserves admitted rows in ${key}/${group}`, () => {
        for (const [index, row] of rows.entries()) {
          expect(projectAdmittedRow(row), `row ${index}`).toEqual({ ok: true, row });
        }
      });

      it(`projects ${key}/${group} idempotently`, () => {
        for (const [index, row] of rows.entries()) {
          const first = projectAdmittedRow(row);
          if (!first.ok) throw new Error(`row ${index} rejected: ${first.code}`);
          expect(projectSpanRow(first.row), `row ${index}`).toEqual(first);
        }
      });
    }
  }
});

it("keeps facilitator text idempotent when truncation lands on a space", () => {
  for (const canonical of facilitatorTruncation.rows.facilitatorTruncation) {
    const raw = "a".repeat(255) + " b";
    const fields = { facilitator_message: raw, extension_rejected_reason: raw };
    const first = projectSpanRow({ ...canonical, dimensions: fields, attributes: fields });
    if (!first.ok) throw new Error(`rejected facilitator span: ${first.code}`);
    expect(projectSpanRow(first.row)).toEqual(first);
    expect(first.row).toEqual(canonical);
  }
});
