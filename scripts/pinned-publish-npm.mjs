#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const npmVersion = "11.16.0";
const archive = join(root, ".tooling", `npm-${npmVersion}.tgz`);
const toolRoot = join(root, ".tooling", "release-npm");
const npmCli = join(toolRoot, "package", "bin", "npm-cli.js");
const shimRoot = join(root, ".tooling", "release-bin");
const npmTarball = `https://registry.npmjs.org/npm/-/npm-${npmVersion}.tgz`;
const npmIntegrity =
  "sha512-A74XL8OxmcegZDMWPkWb5bEQppg8HdYwW3rBD2sPoS4UQHVajfaxBkqyzLeJ3wR0kZ+5xoTjItxXaF7eIXUsyw==";

if (process.argv.length < 3) fail("pass an npm command, for example: publish package.tgz --tag latest");

await installPinnedNpm();
installNpmShim();
const installedVersion = execFileSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" }).trim();
if (installedVersion !== npmVersion) fail(`expected npm ${npmVersion}; installed bootstrap reports ${installedVersion}`);

execFileSync(process.execPath, [npmCli, ...process.argv.slice(2)], {
  cwd: root,
  env: {
    ...process.env,
    PATH: `${shimRoot}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
  },
  stdio: "inherit",
});

async function installPinnedNpm() {
  mkdirSync(join(root, ".tooling"), { recursive: true });
  let bytes = existsSync(archive) ? readFileSync(archive) : undefined;
  if (!bytes || archiveIntegrity(bytes) !== npmIntegrity) {
    const response = await fetch(npmTarball, { redirect: "error" });
    if (!response.ok) fail(`could not download trusted-publishing npm (${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (archiveIntegrity(bytes) !== npmIntegrity) {
      fail("downloaded trusted-publishing npm archive failed integrity verification");
    }
    writeFileSync(archive, bytes);
  }
  rmSync(toolRoot, { recursive: true, force: true });
  mkdirSync(toolRoot, { recursive: true });
  execFileSync("tar", ["-xzf", "-", "-C", toolRoot], {
    input: bytes,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** @param {Buffer} bytes */
function archiveIntegrity(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function installNpmShim() {
  mkdirSync(shimRoot, { recursive: true });
  const shim = join(shimRoot, "npm");
  writeFileSync(
    shim,
    `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync(process.execPath, [${JSON.stringify(
      npmCli
    )}, ...process.argv.slice(2)], { env: process.env, stdio: "inherit" });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`
  );
  chmodSync(shim, 0o755);
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`release npm: ${message}`);
  process.exit(1);
}
