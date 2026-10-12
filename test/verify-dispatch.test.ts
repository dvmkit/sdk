import { describe, expect, it } from "vitest";

import { assertCleanInstallDispatch, dispatchCleanInstall } from "../scripts/clean-install-dispatch.mjs";
import { assertReleaseDispatch, dispatchVerification } from "../scripts/verify-dispatch.mjs";

describe("verification dispatcher", () => {
  it("executes the production dispatch contract", () => {
    expect(() => assertReleaseDispatch(dispatchVerification)).not.toThrow();
    expect(() => assertCleanInstallDispatch(dispatchCleanInstall)).not.toThrow();
  });

  it("marks database tests skipped in a clean source verification without a database URL", () => {
    const steps: Parameters<typeof dispatchVerification>[0]["run"] extends (step: infer Step) => void
      ? Step[]
      : never = [];
    dispatchVerification({
      cleanSource: true,
      requireDatabase: false,
      databaseUrl: undefined,
      packedSafetyReport: undefined,
      run: (step) => steps.push(step),
    });
    expect(steps.find((step) => step.name === "database tests")).toMatchObject({
      args: ["run", "test:db"],
      skip: "DATABASE_URL is unset",
    });
  });

  it("rejects a removed command even when its name remains in a comment", () => {
    const missingLint = (options: Parameters<typeof dispatchVerification>[0]) => {
      // npm run lint
      dispatchVerification({
        ...options,
        run: (step) => {
          if (step.args[1] !== "lint") options.run(step);
        },
      });
    };
    expect(() => assertReleaseDispatch(missingLint)).toThrow("clean-source verification");
  });

  it("rejects missing database forwarding across the clean-install bridge", () => {
    const missingDatabaseForwarding = (options: Parameters<typeof dispatchVerification>[0]) => {
      dispatchVerification({
        ...options,
        run: (step) => {
          options.run({ ...step, args: step.args.filter((argument) => argument !== "--require-database") });
        },
      });
    };
    expect(() => assertReleaseDispatch(missingDatabaseForwarding)).toThrow("outer verification");

    const missingBridgeForwarding = (options: Parameters<typeof dispatchCleanInstall>[0]) => {
      options.npm(["ci"]);
      options.npm(["run", "verify", "--", "--clean-source"]);
    };
    expect(() => assertCleanInstallDispatch(missingBridgeForwarding)).toThrow("mandatory database mode");
  });

  it("rejects swapped packed-safety routing", () => {
    const swappedPackedSafety = (options: Parameters<typeof dispatchVerification>[0]) => {
      dispatchVerification({
        ...options,
        run: (step) => {
          const args = step.args.includes("--pack-only")
            ? step.args.map((argument) => (argument === "--pack-only" ? "--skip-pack" : argument))
            : step.args;
          options.run({ ...step, args });
        },
      });
    };
    expect(() => assertReleaseDispatch(swappedPackedSafety)).toThrow("clean-source verification");
  });

  it("stops dispatching when a command runner fails", () => {
    const calls: string[][] = [];
    expect(() =>
      dispatchVerification({
        cleanSource: false,
        requireDatabase: false,
        databaseUrl: undefined,
        packedSafetyReport: undefined,
        run: (step) => {
          calls.push(step.args);
          throw new Error("runner failed");
        },
      })
    ).toThrow("runner failed");
    expect(calls).toHaveLength(1);
  });
});
