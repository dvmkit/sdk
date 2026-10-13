import { randomBytes } from "node:crypto";

import { Challenge, Credential } from "mppx";
import { Mppx } from "mppx/server";
import { beforeAll, describe, expect, it } from "vitest";

import { configureDVM } from "../../sdk/index";
import { servedApps } from "../../test-support/served-app";
import type { FxFetcher } from "../pricing/index";
import { createDVMServer } from "../server/app";
import {
  challengeMeta,
  createMppFromOpts,
  type MppxServer,
  TEMPO_MODERATO_CHAIN_ID,
  TEMPO_PATH_USD_MODERATO,
  wrapMppx,
} from "../server/mpp-setup";
import { MemoryKVStore } from "../store";
import { stubbedTempoCharge } from "./__helpers__/mppx-stub";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/**
 * HTTP transport emits `WWW-Authenticate: Payment` on 402 for the
 * upfront-payment path so plain MPP clients (mpp-rs, browser polyfills,
 * Cloudflare's MPP middleware) can pay a dvmkit DVM without the message
 * wrapper.
 *
 * The credential round-trip stubs the tempo `Method.verify` step so we don't
 * hit a live tempo RPC for gas estimation — same trick `payment-verification`
 * uses. The bits exercised here that the unit tests don't cover: the actual
 * Hono response shape, header structure (multiple `WWW-Authenticate` per
 * registered method), and the end-to-end flow through `handleCreateJob`.
 */
const TEMPO_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";

function makeMppxWithStubbedVerify(): MppxServer {
  // Settlement is stubbed so we never reach a live tempo RPC; the 402
  // issuance, header encoding and credential binding under test are all real
  // mppx. Same helper as `makeMppx` in payment-verification.test.ts.
  const mpp = wrapMppx(
    Mppx.create({
      methods: [stubbedTempoCharge(TEMPO_RECIPIENT).method],
      secretKey: randomBytes(32).toString("hex"),
      realm: "test.example",
    })
  );
  return mpp;
}

describe("HTTP 402 + WWW-Authenticate", () => {
  const env = { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") };
  const dvm = configureDVM({
    name: "MPP HTTP 402 Test",
    capability: "test",
    // Non-zero price required so `currentPriceMsats() > 0` and the 402 gate
    // actually triggers.
    price: "$0.10",
    async onJob(ctx) {
      ctx.complete("paid-and-done");
    },
  });

  const servers = servedApps({ teardown: "all" });
  let url: string;
  let mpp: MppxServer;

  beforeAll(async () => {
    mpp = makeMppxWithStubbedVerify();
    const { app } = await createDVMServer(dvm, {
      env,
      store: new MemoryKVStore(),
      mpp,
      fxFetcher: stubFx,
    });

    url = await servers.serve(app);
  });

  it("no auth → 402 with parseable WWW-Authenticate per registered method", async () => {
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });

    expect(res.status).toBe(402);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("payment_required");
    expect(body.required_msats).toBeTypeOf("number");

    const challenges = Challenge.fromHeadersList(res.headers);
    expect(challenges).toHaveLength(1);
    const ch = challenges[0];
    expect(ch.method).toBe("tempo");
    expect(ch.intent).toBe("charge");
    expect(ch.realm).toBe("test.example");
    expect(ch.id).toBeTruthy();
    expect(challengeMeta(ch)?.path).toBe("/v1/job");
    expect(challengeMeta(ch)?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(ch.expires).toBeTruthy();
  });

  it("retry with valid Authorization: Payment <credential> → 2xx + job runs", async () => {
    const challengeRes = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(challengeRes.status).toBe(402);
    const challenge = Challenge.fromHeadersList(challengeRes.headers)[0];

    // Build a credential against the server-issued challenge directly. The
    // `verify` stub on the registered method ignores the proof payload, so
    // a synthetic hash is enough to prove the SDK forwards a verified
    // credential through `verifyUpfrontPayment` and into `handleCreateJob`.
    const credential = Credential.from({
      challenge,
      payload: { type: "hash" as const, hash: `0x${"a".repeat(64)}` },
    });

    const retry = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: Credential.serialize(credential),
      },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });

    // Static-priced DVM with a synchronous handler completes inside the
    // request, status 200. The 202 awaiting-input path is theoretically
    // possible if a future refactor moves work off the request thread — both
    // are non-402 successes and prove the credential was accepted.
    expect([200, 202]).toContain(retry.status);
    const data = (await retry.json()) as Record<string, unknown>;
    expect(data.job_id).toBeTruthy();
  });

  it("malformed Authorization header → 402 with a fresh challenge (different id)", async () => {
    const first = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const firstId = Challenge.fromHeadersList(first.headers)[0].id;

    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Payment not-a-real-credential",
      },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });

    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("payment_invalid");

    const fresh = Challenge.fromHeadersList(res.headers);
    expect(fresh).toHaveLength(1);
    // Each issuance carries a fresh nonce → fresh HMAC-bound id, so the
    // client always retries against new server state.
    expect(fresh[0].id).not.toBe(firstId);
  });

  it("rejects the same credential on a second POST /v1/job", async () => {
    // Replay protection: a credential bound to a specific challenge.id can
    // only be redeemed once at the upfront gate, even within the `expires`
    // window. The retry returns 402 + a fresh `WWW-Authenticate` so the
    // client has something new to pay against.
    const challengeRes = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const challenge = Challenge.fromHeadersList(challengeRes.headers)[0];
    const credential = Credential.from({
      challenge,
      payload: { type: "hash" as const, hash: `0x${"b".repeat(64)}` },
    });
    const authHeader = Credential.serialize(credential);

    const first = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect([200, 202]).toContain(first.status);

    const replay = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(replay.status).toBe(402);
    const body = (await replay.json()) as Record<string, unknown>;
    expect(body.error).toBe("payment_invalid");
    expect(body.message).toMatch(/already used/);

    const fresh = Challenge.fromHeadersList(replay.headers);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).not.toBe(challenge.id);
  });

  it("re-issued challenges encode the same realm as /v1/info advertises", async () => {
    // A credential issued from either discovery path must verify on the other.
    // `/v1/info` and the 402 header both source the realm from
    // `this.opts.mpp.realm`; this assertion prevents those paths from drifting.
    const info = await fetch(`${url}/v1/info`).then(
      (r) => r.json() as Promise<Record<string, unknown>>
    );
    const advertised = (info.tempo as { realm: string }).realm;

    const challengeRes = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const ch = Challenge.fromHeadersList(challengeRes.headers)[0];
    expect(ch.realm).toBe(advertised);
  });
});

describe("Tempo Moderato HTTP 402", () => {
  const servers = servedApps({ teardown: "all" });
  const moderatoDvm = configureDVM({
    name: "Tempo Moderato Test",
    capability: "test",
    price: "$0.10",
    async onJob(ctx) {
      ctx.complete("done");
    },
  });

  it("advertises an explicit Moderato chain and pathUSD asset", async () => {
    const mpp = createMppFromOpts(
      { tempoRecipient: TEMPO_RECIPIENT, realm: "moderato.example" },
      {
        DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex"),
        DVMKIT_TEMPO_TESTNET: "true",
      }
    );
    const { app } = await createDVMServer(moderatoDvm, {
      env: {},
      store: new MemoryKVStore(),
      mpp,
      fxFetcher: stubFx,
    });
    const url = await servers.serve(app);
    const response = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(response.status).toBe(402);
    const challenge = Challenge.fromHeadersList(response.headers)[0];
    expect((challenge.request.methodDetails as { chainId?: number }).chainId).toBe(
      TEMPO_MODERATO_CHAIN_ID
    );
    expect(challenge.request.currency).toBe(TEMPO_PATH_USD_MODERATO);
  });

  it("verifies the returned credential against the Moderato route binding", async () => {
    const secretKey = randomBytes(32).toString("hex");
    const createServer = async (testnet: boolean) => {
      const mpp = createMppFromOpts(
        { tempoRecipient: TEMPO_RECIPIENT, realm: "binding.example" },
        {
          DVMKIT_TEMPO_SECRET_KEY: secretKey,
          ...(testnet && { DVMKIT_TEMPO_TESTNET: "true" }),
        }
      );
      if (!mpp) throw new Error("expected Tempo method");

      // Keep mppx's real route re-derivation and binding checks, replacing only
      // the terminal chain operation so this regression never spends funds.
      const charge = mpp.methods.find(
        (method) => method.name === "tempo" && method.intent === "charge"
      ) as unknown as {
        broadcast: () => Promise<{
          method: "tempo";
          status: "success";
          timestamp: string;
          reference: string;
        }>;
        validate?: unknown;
      };
      charge.broadcast = () =>
        Promise.resolve({
          method: "tempo",
          status: "success",
          timestamp: new Date().toISOString(),
          reference: "0xmoderato",
        });
      delete charge.validate;

      const { app } = await createDVMServer(moderatoDvm, {
        env: {},
        store: new MemoryKVStore(),
        mpp,
        fxFetcher: stubFx,
      });
      return servers.serve(app);
    };

    const moderatoUrl = await createServer(true);
    const challengeResponse = await fetch(`${moderatoUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(challengeResponse.status).toBe(402);
    const challenge = Challenge.fromHeadersList(challengeResponse.headers)[0];
    expect((challenge.request.methodDetails as { chainId?: number }).chainId).toBe(
      TEMPO_MODERATO_CHAIN_ID
    );
    const credential = Credential.from({
      challenge,
      payload: { type: "hash" as const, hash: `0x${"c".repeat(64)}` },
    });
    const authorization = Credential.serialize(credential);

    const accepted = await fetch(`${moderatoUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect([200, 202]).toContain(accepted.status);

    const mainnetUrl = await createServer(false);
    const mismatched = await fetch(`${mainnetUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(mismatched.status).toBe(402);
    const body = (await mismatched.json()) as Record<string, unknown>;
    expect(body.error).toBe("payment_invalid");
    expect(body.message).toBe("MPP credential verification failed");
  });
});

describe("exact USD Tempo HTTP 402", () => {
  const servers = servedApps({ teardown: "all" });
  const body = JSON.stringify({ capability: "test", input: "hello" });
  const headers = { "Content-Type": "application/json" };

  it("charges the original fiat microunits across retries and rejects bound-field tampering", async () => {
    const secretKey = randomBytes(32).toString("hex");
    const mpp = createMppFromOpts(
      { tempoRecipient: TEMPO_RECIPIENT, realm: "exact-usd.example" },
      { DVMKIT_TEMPO_SECRET_KEY: secretKey, DVMKIT_TEMPO_TESTNET: "true" },
    );
    if (!mpp) throw new Error("expected Tempo method");
    const charge = mpp.methods.find(
      (method) => method.name === "tempo" && method.intent === "charge",
    ) as unknown as {
      broadcast: () => Promise<{
        method: "tempo";
        status: "success";
        timestamp: string;
        reference: string;
      }>;
      validate?: unknown;
    };
    charge.broadcast = () =>
      Promise.resolve({
        method: "tempo",
        status: "success",
        timestamp: new Date().toISOString(),
        reference: "0xexact",
      });
    delete charge.validate;

    let fetchCount = 0;
    const movingFx: FxFetcher = {
      fetch: () => {
        fetchCount += 1;
        return Promise.resolve({
          rates: { usd: fetchCount === 1 ? 85_666.666_666 : 91_000 },
          as_of: "2026-09-22T00:00:00Z",
        });
      },
      supportedCurrencies: () => ["usd"],
    };
    const exactDvm = configureDVM({
      name: "Exact USD Tempo Test",
      capability: "test",
      price: "$0.01",
      async onJob(ctx) {
        ctx.complete("done");
      },
    });
    const { app } = await createDVMServer(exactDvm, {
      env: {},
      store: new MemoryKVStore(),
      mpp,
      fxFetcher: movingFx,
    });
    const url = await servers.serve(app);

    let challengeCount = 0;
    const getChallenge = async () => {
      const response = await fetch(`${url}/v1/job`, {
        method: "POST",
        headers,
        body,
      });
      expect(response.status).toBe(402);
      const paymentRequired = (await response.clone().json()) as Record<string, unknown>;
      if (challengeCount++ === 0) {
        expect(paymentRequired).toMatchObject({ required_msats: 12_000 });
      }
      const challenge = Challenge.fromHeadersList(response.headers)[0];
      expect(challenge.request.amount).toBe("10000");
      return challenge;
    };
    const authorize = (challenge: Challenge.Challenge) =>
      Credential.serialize(
        Credential.from({
          challenge,
          payload: { type: "hash" as const, hash: `0x${"d".repeat(64)}` },
        }),
      );
    const submit = (authorization: string) =>
      fetch(`${url}/v1/job`, {
        method: "POST",
        headers: { ...headers, Authorization: authorization },
        body,
      });

    const accepted = await submit(authorize(await getChallenge()));
    expect([200, 202]).toContain(accepted.status);

    const tamperCases = [
      (challenge: Challenge.Challenge) =>
        Challenge.from({
          ...challenge,
          request: { ...challenge.request, amount: "10001" },
        }),
      (challenge: Challenge.Challenge) =>
        Challenge.from({
          ...challenge,
          opaque: undefined,
          meta: { ...(challengeMeta(challenge) ?? {}), path: "/v1/credit" },
        }),
      (challenge: Challenge.Challenge) =>
        Challenge.from({
          ...challenge,
          request: { ...challenge.request, currency: TEMPO_RECIPIENT },
        }),
      (challenge: Challenge.Challenge) =>
        Challenge.from({
          ...challenge,
          request: {
            ...challenge.request,
            methodDetails: { chainId: 4217 },
          },
        }),
    ];
    for (const tamper of tamperCases) {
      const rejected = await submit(authorize(tamper(await getChallenge())));
      expect(rejected.status).toBe(402);
      await expect(rejected.json()).resolves.toMatchObject({
        error: "payment_invalid",
        message: "MPP credential verification failed",
      });
    }
  });
});
