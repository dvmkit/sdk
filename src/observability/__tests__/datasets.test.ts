import { describe, expect, it } from "vitest";

import {
  DATASET_NAMES,
  isDatasetAllowedForSpanPrincipal,
  normalizeLegacySpanIdentifiers,
  OPERATOR_ONLY_DATASETS,
  SPANS_DATASETS,
} from "../datasets";

describe("SPANS_DATASETS", () => {
  it("includes all expected dataset names", () => {
    const names = SPANS_DATASETS.map((d) => d.name);
    expect(names).toEqual([
      "platform",
      "cashu",
      "lightning",
      "stripe",
      "x402",
      "tempo",
      "isolate",
      "audit",
      "cron",
    ]);
    expect(DATASET_NAMES.has("mpp")).toBe(false);
  });

  it("advertises 730 days for every diagnostic dataset", () => {
    for (const ds of SPANS_DATASETS) {
      expect(ds.retentionDays, ds.name).toBe(730);
    }
  });

  it("DATASET_NAMES set matches SPANS_DATASETS", () => {
    expect(DATASET_NAMES.size).toBe(SPANS_DATASETS.length);
    for (const ds of SPANS_DATASETS) {
      expect(DATASET_NAMES.has(ds.name)).toBe(true);
    }
  });

  it("normalizes identifiers from pre-cutover DVM images without admitting mpp as a dataset", () => {
    const credential = { dataset: "mpp", name: "mpp.verify_credential" };
    const warning = { dataset: "mpp", name: "tempo_session_close_failed" };
    const current = { dataset: "tempo", name: "tempo.verify_credential" };

    normalizeLegacySpanIdentifiers(credential);
    normalizeLegacySpanIdentifiers(warning);
    normalizeLegacySpanIdentifiers(current);

    expect(credential).toEqual({ dataset: "tempo", name: "tempo.verify_credential" });
    expect(warning).toEqual({ dataset: "tempo", name: "tempo_session_close_failed" });
    expect(current).toEqual({ dataset: "tempo", name: "tempo.verify_credential" });
    expect(DATASET_NAMES.has("mpp")).toBe(false);
  });

  it("OPERATOR_ONLY_DATASETS contains audit", () => {
    expect(OPERATOR_ONLY_DATASETS.has("audit")).toBe(true);
    expect(OPERATOR_ONLY_DATASETS.size).toBe(1);
  });
  it.each([
    ["audit", "operator", true],
    ["audit", "dvm", false],
    ["platform", "operator", true],
    ["platform", "dvm", true],
    ["unknown", "operator", false],
    ["unknown", "dvm", false],
  ] as const)("allows %s for %s: %s", (dataset, principal, allowed) => {
    expect(isDatasetAllowedForSpanPrincipal(dataset, principal)).toBe(allowed);
  });

});
