import { readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import db from "../vitest.db.config";
import unit from "../vitest.config";
import server from "../vitest.server.config";

type SuiteGlobs = { include: readonly string[]; exclude: readonly string[] };

const root = join(import.meta.dirname, "..");

function suite(config: { test?: { include?: string[]; exclude?: string[] } }): SuiteGlobs {
  return { include: config.test?.include ?? [], exclude: config.test?.exclude ?? [] };
}

/** Only the glob syntax the configs use; anything else throws instead of silently mismatching. */
function globToRegExp(glob: string): RegExp {
  if (/[{}[\]()!?+@]/.test(glob)) throw new Error(`unsupported glob syntax in ${glob}`);
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 2;
    } else if (glob[i] === "*") {
      source += "[^/]*";
    } else {
      source += glob[i]!.replace(/[.\\^$|]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function runs(globs: SuiteGlobs, file: string): boolean {
  const matches = (list: readonly string[]) => list.some((glob) => globToRegExp(glob).test(file));
  return matches(globs.include) && !matches(globs.exclude);
}

function testFiles(): string[] {
  return ["test", "src"]
    .flatMap((dir) => readdirSync(join(root, dir), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

function partition(suites: SuiteGlobs[]) {
  const unowned: string[] = [];
  const multiple: string[] = [];
  for (const file of testFiles()) {
    const owners = suites.filter((globs) => runs(globs, file)).length;
    if (owners === 0) unowned.push(file);
    if (owners > 1) multiple.push(file);
  }
  return { unowned, multiple };
}

describe("test suite partition", () => {
  const unitSuite = suite(unit);
  const serverSuite = suite(server);
  const dbSuite = suite(db);

  it("runs every test file in exactly one of the unit, server and database suites", () => {
    expect(partition([unitSuite, serverSuite, dbSuite])).toEqual({ unowned: [], multiple: [] });
  });

  it("reports a file that no suite picks up", () => {
    const withoutServerSrc = { ...serverSuite, include: serverSuite.include.filter((glob) => glob !== "src/**/*.server.test.ts") };
    expect(partition([unitSuite, withoutServerSrc, dbSuite]).unowned).toContain(
      "src/sdk/server/__tests__/host.server.test.ts"
    );
  });

  it("reports a file that the unit suite and the server suite both pick up", () => {
    const unitWithServer = { ...unitSuite, exclude: unitSuite.exclude.filter((glob) => glob !== "**/*.server.test.ts") };
    expect(partition([unitWithServer, serverSuite, dbSuite]).multiple).toContain(
      "src/sdk/server/__tests__/host.server.test.ts"
    );
  });
});

describe("unit suite listen guard", () => {
  it("refuses to open a listening socket and names the server suite", () => {
    const socketServer = createServer();
    try {
      expect(() => socketServer.listen(0, "127.0.0.1")).toThrow(/\*\.server\.test\.ts/);
    } finally {
      socketServer.close();
    }
  });
});
