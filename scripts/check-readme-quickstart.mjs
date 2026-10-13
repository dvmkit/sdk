#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

try {
  const readme = readFileSync("README.md", "utf8");
  const quickstart = /^## Quickstart[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu.exec(readme)?.[1];
  if (!quickstart) throw new Error("README.md is missing the Quickstart section (handler.ts, server.ts)");

  const markers = [...quickstart.matchAll(/^Save this as `([^`]+)`:\n/gmu)];
  const seen = new Set();
  for (const marker of markers) {
    const file = marker[1];
    if (!/^[\w-]+\.ts$/u.test(file)) throw new Error(`invalid quickstart filename: ${file}`);
    if (seen.has(file)) throw new Error(`duplicate README quickstart block for ${file}`);
    seen.add(file);
    const afterMarker = quickstart.slice(marker.index + marker[0].length);
    const block = /^\n```ts\n((?:[^\n]*\n)*?)```(?:\n|$)/u.exec(afterMarker);
    if (!block) throw new Error(`README quickstart block missing or malformed for ${file}`);
    const path = join("examples", "quickstart", file);
    let example;
    try {
      example = readFileSync(path);
    } catch {
      throw new Error(`quickstart example missing or unreadable: ${path}`);
    }
    if (!Buffer.from(block[1], "utf8").equals(example)) {
      throw new Error(`README quickstart differs from ${path}; copy the file verbatim`);
    }
  }
  for (const file of ["handler.ts", "server.ts"]) {
    if (!seen.has(file)) throw new Error(`README quickstart block missing for ${file}`);
  }
  console.log(`README quickstart matches ${seen.size} example files byte for byte`);
} catch (error) {
  console.error(`README quickstart: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
