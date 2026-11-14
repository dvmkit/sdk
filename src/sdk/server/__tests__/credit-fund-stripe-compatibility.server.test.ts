import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { servedApps } from "../../../test-support/served-app";
import { secp256k1Auth } from "../secp256k1-auth";
import { CALLER, PRIVKEY } from "./__helpers__/card-credit";
import { checkoutServer } from "./__helpers__/stripe-checkout";

const servers = servedApps();
const run = promisify(execFile);

describe("published old card client", () => {
  it("relays the upgrade notice in its JSON instead of recommending Link", async () => {
    const manifestPath = createRequire(import.meta.url).resolve("dvm-cli-upgrade-compat/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const executable = resolve(dirname(manifestPath), manifest.bin.dvm);
    const state = await mkdtemp(join(tmpdir(), "card-client-compat-"));
    const auth = secp256k1Auth();
    const recordReplay = vi.spyOn(auth, "recordReplay");
    const { app, ledger, store, account } = await checkoutServer({ auth });
    const upgradeRequests: { headers: Record<string, string>; fund: Record<string, unknown>; nonceWrites: number }[] = [];
    const url = await servers.serve({ fetch: async (request) => {
      const body = new URL(request.url).pathname === "/v1/credit" ? await request.clone().json() : undefined;
      const nonceCount = recordReplay.mock.calls.length;
      const response = await app.fetch(request);
      if (body && response.status === 426) {
        upgradeRequests.push({ headers: Object.fromEntries(request.headers), fund: body.fund,
          nonceWrites: recordReplay.mock.calls.length - nonceCount });
      }
      return response;
    } });
    try {
      let stdout: string;
      try {
        const result = await run(process.execPath, [executable, "credit", "fund", url, "--rail", "stripe", "--amount", "$5"], {
          env: { ...process.env, DVM_CONFIG_DIR: join(state, "caller"), DVMKIT_CONFIG_DIR: join(state, "builder"),
            DVM_IDENTITY_KEY: Buffer.from(PRIVKEY).toString("hex") },
          timeout: 15_000,
        });
        stdout = result.stdout;
      } catch (error) {
        if (!(error instanceof Error) || !("stdout" in error) || typeof error.stdout !== "string") throw error;
        stdout = error.stdout;
      }
      const output = JSON.parse(stdout);
      expect(output.error).toMatchObject({ code: "client_upgrade_required", required_capabilities: [],
        minimum_client_version: "0.19.0", current_client_version: "0.15.3",
      });
      expect(output.error.hint).toContain("@dvmkit/dvm-cli@latest");
      expect(output.error.hint).toContain("no Stripe Link account is needed");
      expect(output.error.display).toContain("Nothing was charged.");
      expect(upgradeRequests).toHaveLength(1);
      expect(upgradeRequests[0]).toMatchObject({ headers: { "dvm-client": "dvm/0.15.3", "dvm-protocol-version": "1",
        "dvm-client-capabilities": "credit-recovery,request-resume" },
        fund: { method: "stripe", amount_micro: 5_000_000 }, nonceWrites: 0,
      });
      expect(upgradeRequests[0]!.fund).not.toHaveProperty("via");
      expect(await ledger.getForCaller(CALLER)).toEqual([]);
      expect(await store.get(upgradeRequests[0]!.fund.fund_id as string)).toBeUndefined();
      expect(account.forms).toEqual([]);
      console.log(JSON.stringify({ client: `@dvmkit/dvm-cli@${manifest.version}`, error: {
        code: output.error.code, hint: output.error.hint,
      } }));
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }, 20_000);
});
