import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../ownership/caller-migration.json", import.meta.url), "utf8"));
const guard = new URL("../scripts/check-caller-ownership.mjs", import.meta.url);
const { assertConsumerBinding, assertGroupedConsumerBindings, assertSharedCoreBoundary }: {
  assertConsumerBinding(binding: unknown): void;
  assertGroupedConsumerBindings(groups: unknown): void;
  assertSharedCoreBoundary(control?: string): void;
} = await import(guard.href);

describe("shared core ownership", () => {
  for (const kind of ["static", "type", "dynamic", "inline-type", "template-dynamic", "alias"]) {
    it(`rejects a caller configuration dependency through a ${kind} import`, () => {
      expect(() => execFileSync(process.execPath, [guard.pathname, `--negative-control=${kind}`], {
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow(/shared core depends on caller implementation: src\/lib\/wallet-credentials.ts -> src\/lib\/identity.ts/);
    });
  }
  for (const kind of ["static", "type", "dynamic", "inline-type", "template-dynamic", "alias"]) {
    it(`rejects caller configuration in funding contracts through a ${kind} import`, () => {
      expect(() => execFileSync(process.execPath, [guard.pathname, `--negative-control=funding-${kind}`], {
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow(/shared core depends on caller implementation: src\/lib\/credit-funding-contracts.ts -> src\/lib\/identity.ts/);
    });
  }
  for (const kind of ["static", "type", "dynamic", "inline-type", "template-dynamic", "alias"]) {
    it(`rejects caller configuration in recovery contracts through a ${kind} import`, () => {
      expect(() => execFileSync(process.execPath, [guard.pathname, `--negative-control=recovery-${kind}`], {
        encoding: "utf8",
        stdio: "pipe",
      })).toThrow(/shared core depends on caller implementation: .*src\/lib\/submission-policy.ts -> src\/lib\/identity.ts/);
    });
  }
  for (const kind of ["static", "type", "dynamic", "inline-type", "template-dynamic"]) {
    it(`rejects caller configuration in channel facts through a ${kind} dependency`, () => {
      expect(() => assertSharedCoreBoundary(`channel-${kind}`)).toThrow(/shared core depends on caller implementation: .*src\/lib\/x402\/voucher-pending.ts -> src\/lib\/identity.ts/);
    });
  }
  it("allows channel facts to reach the shared reservation and path owners", () => {
    expect(() => assertSharedCoreBoundary("channel-transitive")).not.toThrow();
  });
  it("rejects caller configuration in channel facts through an alias", () => {
    expect(() => execFileSync(process.execPath, [guard.pathname, "--negative-control=channel-alias"], {
      encoding: "utf8", stdio: "pipe",
    })).toThrow(/shared core depends on caller implementation: .*src\/lib\/x402\/voucher-pending.ts -> src\/lib\/identity.ts/);
  });
  it("rejects recovery contracts reaching caller receipt capture transitively", () => {
    expect(() => assertSharedCoreBoundary("recovery-transitive")).toThrow(/submission-policy.ts -> src\/lib\/receipt-contracts.ts -> src\/lib\/receipt-capture.ts/);
  });
  it("allows the shared recovery trust declaration", () => {
    expect(() => assertSharedCoreBoundary("recovery-shared")).not.toThrow();
  });
  it("allows funding facts to reach the shared menu and receipt contracts", () => {
    expect(() => assertSharedCoreBoundary("funding-menu")).not.toThrow();
  });
  it("rejects caller configuration in the funding amount dependency", () => {
    expect(() => assertSharedCoreBoundary("funding-transitive")).toThrow(/shared core depends on caller implementation: .*src\/lib\/payment-amounts.ts -> src\/lib\/identity.ts/);
  });
  it("rejects caller configuration in shared budget accounting", () => {
    expect(() => assertSharedCoreBoundary("budget-config")).toThrow(/shared core depends on caller implementation: src\/lib\/budget-core.ts -> src\/lib\/identity.ts/);
  });
  it("allows a supported shared currency contract dependency", () => {
    expect(() => assertSharedCoreBoundary("shared-currency")).not.toThrow();
  });
  for (const [kind, diagnostic] of [
    ["malformed-binding", "invalid consumer binding schema"],
    ["missing-binding", "consumer export is missing: ./internal#missingGetWallet"],
    ["missing-type-binding", "consumer export is missing: ./internal#missingSharedType"],
    ["wrong-origin", "consumer declaring module mismatch: ./internal#getWallet"],
    ["unknown-mode", "invalid consumer binding schema"],
    ["malformed-group", "invalid grouped consumer binding schema"],
  ]) {
    it(`rejects ${kind} consumer evidence`, () => {
      const binding = structuredClone(manifest.consumerBindings.find((row: {role: string; exportedName: string}) => row.role === "builder" && row.exportedName === "getWallet"));
      if (kind === "malformed-binding") binding.exportedName = [binding.exportedName];
      if (kind === "missing-binding") binding.exportedName = "missingGetWallet";
      if (kind === "missing-type-binding") { binding.exportedName = "missingSharedType"; binding.modes = ["type"]; }
      if (kind === "wrong-origin") binding.declaringModule = "src/lib/errors.ts";
      if (kind === "unknown-mode") binding.modes = ["unknown"];
      if (kind === "malformed-group") {
        const groups = structuredClone(manifest.consumers);
        groups[0].bindings[0].symbol = [groups[0].bindings[0].symbol];
        expect(() => assertGroupedConsumerBindings(groups)).toThrow(diagnostic);
      } else {
        expect(() => assertConsumerBinding(binding)).toThrow(diagnostic);
      }
    });
  }
  it("rejects duplicate ownership allocation", () => {
    expect(() => execFileSync(process.execPath, [guard.pathname, "--negative-control=duplicate-allocation"], {
      encoding: "utf8", stdio: "pipe",
    })).toThrow(/duplicate symbol allocation/);
  });

});
