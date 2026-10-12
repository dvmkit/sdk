#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MINT_CONTAINER = "sdk-cashu-mint";
export const MINT_URL = "http://localhost:3338";

// FakeWallet mints test sats without a Lightning payment. The private key is Nutshell's documented
// test placeholder; this mint holds no value.
const dockerRun = [
  "run", "--detach", "--name", MINT_CONTAINER, "--publish", "3338:3338",
  "--env", "MINT_LISTEN_HOST=0.0.0.0",
  "--env", "MINT_LISTEN_PORT=3338",
  "--env", "MINT_BACKEND_BOLT11_SAT=FakeWallet",
  "--env", "MINT_PRIVATE_KEY=TEST_PRIVATE_KEY_DO_NOT_USE_IN_PROD",
  "--env", "MINT_INFO_NAME=sdk-test-mint",
  "--env", "MINT_INPUT_FEE_PPK=0",
  "cashubtc/nutshell:0.19.2", "poetry", "run", "mint",
];

/**
 * Start the local mint the mint-dependent suites need and return once it answers. Docker, the probe
 * and the delay are injected so the release contract can exercise a mint that never becomes ready.
 *
 * @param {{ docker: (args: string[]) => number, probe: () => Promise<boolean>, wait: (ms: number) => Promise<void>, attempts?: number, intervalMs?: number }} options
 */
export async function startCashuMint(options) {
  const { attempts = 30, intervalMs = 2_000 } = options;
  if (options.docker(dockerRun) !== 0) throw new Error(`docker could not start the ${MINT_CONTAINER} container`);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await options.probe()) return;
    if (attempt < attempts) await options.wait(intervalMs);
  }
  options.docker(["logs", MINT_CONTAINER]);
  throw new Error(`the Cashu mint did not answer ${MINT_URL}/v1/info after ${attempts} attempts`);
}

const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  try {
    await startCashuMint({
      docker: (args) => spawnSync("docker", args, { stdio: "inherit" }).status ?? 1,
      probe: async () => {
        try {
          return (await fetch(`${MINT_URL}/v1/info`, { signal: AbortSignal.timeout(2_000) })).ok;
        } catch {
          return false;
        }
      },
      wait: (ms) => new Promise((done) => setTimeout(done, ms)),
    });
    console.log(`Cashu mint ready at ${MINT_URL}`);
  } catch (error) {
    console.error(`start-cashu-mint: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
