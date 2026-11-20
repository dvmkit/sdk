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
import { epoch1 } from "./fixtures/projection/epoch-1";

type CatalogueSnapshot = Omit<DiagnosticCatalogue, "version">;

interface CorpusBatch {
  epoch: number;
  catalogue?: CatalogueSnapshot;
  rows: Record<string, readonly SpanRow[]>;
}

const corpus = {
  initial: { epoch: 1, ...epoch1 },
} satisfies Record<string, CorpusBatch>;

// A new batch extends an epoch without changing the pinned contents of any batch.
const digests: Record<keyof typeof corpus, string> = {
  initial: "b8f096c23e9fd8d08304da2b63113c642e333a6fb204967814dca17faf5d4864",
};

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

function catalogueLosses(snapshot: CatalogueSnapshot): string[] {
  const losses: string[] = [];
  for (const key of Object.keys(snapshot) as (keyof DiagnosticCatalogue)[]) {
    if (key === "version") continue;
    const before = new Set<string | number>(snapshot[key]);
    const after = new Set<string | number>(DIAGNOSTIC_CATALOGUE[key]);
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
  const active = Object.entries(batches).filter(([, batch]) => batch.epoch === DIAGNOSTIC_PROJECTION_EPOCH);

  it("has a corpus for each epoch and keeps every published batch intact", () => {
    const epochs = [...new Set(Object.values(batches).map(({ epoch }) => epoch))].sort((a, b) => a - b);
    expect(epochs).toEqual(Array.from({ length: DIAGNOSTIC_PROJECTION_EPOCH }, (_, index) => index + 1));
    expect(Object.keys(corpus)).toEqual(Object.keys(digests));
    for (const key of Object.keys(digests) as (keyof typeof digests)[]) {
      const digest = createHash("sha256").update(JSON.stringify(corpus[key])).digest("hex");
      expect(digest, `published corpus batch ${key}`).toBe(digests[key]);
    }
    for (const epoch of epochs) {
      expect(Object.values(batches).some((batch) => batch.epoch === epoch && batch.catalogue !== undefined)).toBe(true);
    }
  });

  for (const [key, batch] of active) {
    if (batch.catalogue) {
      const snapshot = batch.catalogue;
      it(`keeps catalogue admissions from ${key}`, () => {
        expect(catalogueLosses(snapshot)).toEqual([]);
      });
    }
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
