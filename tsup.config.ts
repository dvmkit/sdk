import { readFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig } from "tsup";

const packageRoot = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  exports: Record<string, { import: string }>;
  optionalDependencies?: Record<string, string>;
};
const entry = Object.fromEntries(
  Object.entries(manifest.exports)
    .filter(([exportName]) => exportName !== "./internal")
    .map(([exportName, target]) => {
      const outputName = target.import.replace(/^\.\/dist\//, "").replace(/\.js$/, "");
      const sourceName = exportName === "." ? "index.ts" : `${exportName.slice(2)}/index.ts`;
      return [outputName, join(packageRoot, "src", "sdk", sourceName)];
    })
);
entry["internal/caller"] = join(packageRoot, "src", "sdk", "internal", "caller.ts");
entry["internal/server"] = join(packageRoot, "src", "sdk", "internal", "server.ts");

export default defineConfig({
  entry,
  outDir: join(packageRoot, "dist"),
  format: "esm",
  target: "node20",
  clean: true,
  dts: true,
  external: [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ],
});
