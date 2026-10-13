import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/check-readme-quickstart.mjs");
const directories: string[] = [];
const handler = 'export default "hello";\n';
const server = 'import handler from "./handler.ts";\n';
const readme = `## Quickstart: a free DVM\n\nSave this as \`handler.ts\`:\n\n\`\`\`ts\n${handler}\`\`\`\n\nSave this as \`server.ts\`:\n\n\`\`\`ts\n${server}\`\`\`\n\n## Next steps\n`;

function check(content: string, missingFile?: string) {
  const root = mkdtempSync(join(tmpdir(), "sdk-readme-quickstart-"));
  directories.push(root);
  mkdirSync(join(root, "examples/quickstart"), { recursive: true });
  writeFileSync(join(root, "README.md"), content);
  for (const [file, code] of [["handler.ts", handler], ["server.ts", server]]) {
    if (file !== missingFile) writeFileSync(join(root, "examples/quickstart", file), code);
  }
  return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("README quickstart check", () => {
  it("accepts byte-identical mapped files", () => {
    const result = check(readme);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("matches 2 example files byte for byte");
  });

  it.each([
    ["handler.ts", readme.replace('"hello"', '"hallo"')],
    ["server.ts", readme.replace(server, server.replace(";", "; "))],
    ["handler.ts", readme.replace(handler, handler + "\n")],
  ])("rejects byte drift and names %s", (file, content) => {
    const result = check(content);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`differs from examples/quickstart/${file}`);
  });

  it.each(["handler.ts", "server.ts"])("rejects a missing example file: %s", (file) => {
    const result = check(readme, file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing or unreadable: examples/quickstart/${file}`);
  });

  it.each([
    ["handler.ts", readme.replace("Save this as `handler.ts`:", "Handler:")],
    ["handler.ts", readme.replace(`\`\`\`ts\n${handler}\`\`\``, "")],
    ["server.ts", readme.slice(0, readme.indexOf("Save this as `server.ts`:"))],
  ])("rejects a missing marker or block for %s", (file, content) => {
    const result = check(content);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
    expect(result.stderr).toContain("missing");
  });

  it("rejects an absent quickstart section", () => {
    const result = check("## Next steps\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing the Quickstart section");
  });
});
