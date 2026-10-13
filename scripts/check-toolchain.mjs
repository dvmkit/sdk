#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const requestedNode = readFileSync(join(root, ".nvmrc"), "utf8").trim();
const expectedNpmMajor = "10";

if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(requestedNode)) {
  // A bare major floats: months later the same commit resolves a different Node and can produce a
  // different tarball. The exact release is what makes a rebuild of an old tag reproducible.
  fail(".nvmrc must name an exact Node release, for example 22.23.2");
}

const actualNode = process.versions.node;
if (actualNode !== requestedNode) {
  fail(`Node ${requestedNode} is required by .nvmrc; found ${actualNode}. Run \`nvm install\` in this directory.`);
}
const requestedMajor = requestedNode.split(".")[0];
if (manifest.engines?.node !== `>=${requestedMajor}`) {
  fail(`package.json engines.node must be ">=${requestedMajor}" so a consumer cannot install below the gated line`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) fail("run this check through npm so the active npm executable is unambiguous");
const actualNpm = execFileSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" }).trim();
if (actualNpm.split(".")[0] !== expectedNpmMajor) {
  fail(
    `npm ${expectedNpmMajor}.x is required; found ${actualNpm}. package-lock.json is maintained with the npm that ships with Node ${requestedNode}, and another major resolves optional dependencies differently.`
  );
}

console.log(`toolchain ok: Node ${actualNode}, npm ${actualNpm}`);

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`toolchain: ${message}`);
  process.exit(1);
}
