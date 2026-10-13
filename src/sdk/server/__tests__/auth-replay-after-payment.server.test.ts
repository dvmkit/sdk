import { randomBytes } from "node:crypto";

import { Challenge, Credential } from "mppx";
import { Mppx } from "mppx/server";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { servedApps } from "../../../test-support/served-app";
import { stubbedTempoCharge } from "../../__tests__/__helpers__/mppx-stub";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { type MppxServer, wrapMppx } from "../mpp-setup";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

/**
 * end-to-end proof that the unpaid 402-discovery hop on `/v1/job`
 * doesn't burn the replay nonce, and that the nonce IS burned on the paid
 * resubmit. Uses an MPP rail (matches the shape of `payment-mpp-http402`)
 * so we exercise the full `verifyUpfrontPayment` → `recordReplay` →
 * `jobManager.createJob` sequence in `handleCreateJob`.
 */

const sampleSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const PRIVKEY = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

const TEMPO_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-18T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

function makeMppxWithStubbedVerify(): MppxServer {
  const mpp = wrapMppx(
    Mppx.create({
      methods: [stubbedTempoCharge(TEMPO_RECIPIENT).method],
      secretKey: randomBytes(32).toString("hex"),
      realm: "test.example",
    })
  );
  return mpp;
}

const servers = servedApps();

async function startServer(): Promise<{
  url: string;
  signer: ReturnType<typeof createSignedRequestVerifier<z.infer<typeof sampleSchema>>>;
}> {
  const signer = createSignedRequestVerifier(sampleSchema);
  const dvm = configureDVM({
    name: "auth-replay-after-payment",
    capabilities: {
      do: {
        input: sampleSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.complete("ok");
        },
      },
    },
    auth: secp256k1Auth(),
  });
  const mpp = makeMppxWithStubbedVerify();
  const { app } = await createDVMServer(dvm, {
    env: { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") },
    store: new MemoryKVStore(),
    mpp,
    fxFetcher: stubFx,
  });
  return { url: await servers.serve(app), signer };
}

function buildCredentialFor(challenge: Challenge.Challenge, hashByte: string): string {
  const credential = Credential.from({
    challenge,
    payload: { type: "hash" as const, hash: `0x${hashByte.repeat(64)}` },
  });
  return Credential.serialize(credential);
}

describe("replay nonce committed on job creation, not on /v1/job entry", () => {
  let url: string;
  let signer: ReturnType<typeof createSignedRequestVerifier<z.infer<typeof sampleSchema>>>;

  beforeEach(async () => {
    ({ url, signer } = await startServer());
  });

  it("unpaid POST /v1/job → 402, same signed envelope with payment → 202 (nonce not burned by the unpaid probe)", async () => {
    const signed = signer.signRequest(PRIVKEY, { action: "publish" });

    // First hop: unpaid POST with a valid signed envelope. checkAuth passes;
    // verifyUpfrontPayment returns 402. recordReplay MUST NOT have fired.
    const probe = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect(probe.status).toBe(402);
    const challenge = Challenge.fromHeadersList(probe.headers)[0];
    expect(challenge).toBeTruthy();

    // Second hop: paid POST with the SAME signed envelope. checkAuth passes
    // again (idempotent), payment verifies, recordReplay commits the nonce,
    // job is created.
    const paid = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildCredentialFor(challenge, "a"),
      },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect([200, 202]).toContain(paid.status);
    const body = (await paid.json()) as { job_id?: string; status?: string };
    expect(body.job_id).toBeTruthy();
  });

  it("paid resubmit of a signed envelope already used in a created job rejects 401 replay_detected", async () => {
    const signed = signer.signRequest(PRIVKEY, { action: "publish" });

    // POST 1: unpaid → 402.
    const probe1 = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    const challenge1 = Challenge.fromHeadersList(probe1.headers)[0];

    // POST 2: paid against challenge1 → 202. Nonce burned at job commit.
    const paid1 = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildCredentialFor(challenge1, "a"),
      },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect([200, 202]).toContain(paid1.status);

    // POST 3: unpaid → 402, fresh challenge. checkAuth still passes (sig is
    // valid), but recordReplay won't fire on this hop because no payment.
    const probe2 = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect(probe2.status).toBe(402);
    const challenge2 = Challenge.fromHeadersList(probe2.headers)[0];

    // POST 4: paid against challenge2 with the same envelope. recordReplay
    // fires after payment, finds the nonce already committed by POST 2 → 401.
    const paid2 = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildCredentialFor(challenge2, "b"),
      },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect(paid2.status).toBe(401);
    const body = (await paid2.json()) as { error: string; sub_reason: string };
    expect(body.error).toBe("auth_error");
    expect(body.sub_reason).toBe("replay_detected");
  });

  it("concurrent paid submissions of the same envelope: one 202, one 401 replay_detected", async () => {
    const signed = signer.signRequest(PRIVKEY, { action: "publish" });

    // Pre-fetch two independent challenges so each concurrent POST has its
    // own valid (single-shot) credential to spend.
    const probeA = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    const probeB = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    const challengeA = Challenge.fromHeadersList(probeA.headers)[0];
    const challengeB = Challenge.fromHeadersList(probeB.headers)[0];
    const credA = buildCredentialFor(challengeA, "a");
    const credB = buildCredentialFor(challengeB, "b");

    const [resA, resB] = await Promise.all([
      fetch(`${url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: credA },
        body: JSON.stringify({ capability: "do", data: signed }),
      }),
      fetch(`${url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: credB },
        body: JSON.stringify({ capability: "do", data: signed }),
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    const success = statuses.find((s) => s === 200 || s === 202);
    const rejection = statuses.find((s) => s === 401);
    expect(success).toBeDefined();
    expect(rejection).toBeDefined();
    const rejected = resA.status === 401 ? resA : resB;
    const body = (await rejected.json()) as { error: string; sub_reason: string };
    expect(body.error).toBe("auth_error");
    expect(body.sub_reason).toBe("replay_detected");
  });
});
