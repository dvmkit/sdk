import { generateKeyPairSync } from "node:crypto";

import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createX402FacilitatorAuthHeaders } from "../../../lib/x402/facilitator";
import { encodePayment, type PaymentPayload } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { verifyX402Payment } from "../../../lib/x402/verify";
import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";
import { probeX402FacilitatorSupport } from "../x402-facilitator-support";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const FACILITATOR = "https://facilitator.test/platform/v2/x402";
const KEY_ID = "organizations/test/apiKeys/test";
const SELF_RELAY_KEY = `0x${"11".repeat(32)}`;
const AUTHORIZER_KEY = `0x${"22".repeat(32)}`;
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY_SECRET = privateKey.export({ format: "pem", type: "sec1" }).toString();

describe("x402 facilitator authentication", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("authenticates supported, verify, and settle with CDP's SEC1 EC secret", async () => {
    const calls: { path: string; authorization?: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(requestUrl(input));
      const authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
      // This spy is global, and `host.serve()` now warms the fx snapshot at boot
      // when a rail is wired — an x402 host qualifies. The assertions
      // below are about the facilitator leg, so record only that host; the fx
      // call falls through to the 401 and the warm-up silently gives up.
      if (url.origin === new URL(FACILITATOR).origin) {
        calls.push({ path: url.pathname, ...(authorization ? { authorization } : {}) });
      }
      if (!authorization?.startsWith("Bearer ")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const claims = decodeJwt(authorization.slice("Bearer ".length));
      expect(claims.sub).toBe(KEY_ID);
      expect(claims.uris).toEqual([`${init?.method} ${url.host}${url.pathname}`]);

      if (url.pathname.endsWith("/supported")) {
        return Response.json({
          kinds: [
            { x402Version: 2, scheme: "exact", network: "eip155:8453" },
            {
              x402Version: 2,
              scheme: "batch-settlement",
              network: "eip155:8453",
              extra: { receiverAuthorizer: "0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb" },
            },
          ],
          extensions: [],
          signers: {},
        });
      }
      if (url.pathname.endsWith("/verify")) {
        return Response.json({ isValid: true });
      }
      if (url.pathname.endsWith("/settle")) {
        return Response.json({ success: true, transaction: "0xsettled" });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });

    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        DVMKIT_X402_PAY_TO: PAY_TO,
        DVMKIT_X402_NETWORK: "eip155:8453",
        DVMKIT_X402_FACILITATOR: FACILITATOR,
        DVMKIT_X402_FACILITATOR_KEY_ID: KEY_ID,
        DVMKIT_X402_FACILITATOR_KEY_SECRET: KEY_SECRET,
      },
    });
    host.mount(testDvm());
    const server = await host.serve();

    try {
      const config = authenticatedConfig();
      const receipt = await verifyX402Payment(
        paymentHeader("1000000"),
        config,
        1_000_000n,
        "/v1/job",
        60_000
      );

      expect(receipt).toMatchObject({ verified: true, txHash: "0xsettled" });
      expect(calls.map((call) => call.path)).toEqual([
        "/platform/v2/x402/supported",
        "/platform/v2/x402/verify",
        "/platform/v2/x402/settle",
      ]);
      expect(calls.every((call) => call.authorization?.startsWith("Bearer "))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("keeps public-facilitator requests unauthenticated when credentials are absent", async () => {
    const requests: { path: string; authorization: string | null }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(requestUrl(input));
      requests.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    });

    const config: X402Config = {
      payTo: PAY_TO,
      network: "eip155:8453",
      facilitator: FACILITATOR,
    };
    const support = await probeX402FacilitatorSupport(config);
    const receipt = await verifyX402Payment(
      paymentHeader("1000000"),
      config,
      1_000_000n,
      "/v1/job",
      60_000
    );

    expect(support).toMatchObject({ available: false, reason: "probe_failed" });
    expect(receipt).toEqual({
      verified: false,
      amountMsats: 0,
      invalidReason: "facilitator_status_401",
    });
    expect(requests).toEqual([
      { path: "/platform/v2/x402/supported", authorization: null },
      { path: "/platform/v2/x402/verify", authorization: null },
    ]);
  });

  it("accepts CDP's base64 Ed25519 key format", async () => {
    const { privateKey: edPrivateKey } = generateKeyPairSync("ed25519");
    const jwk = edPrivateKey.export({ format: "jwk" });
    if (!jwk.d || !jwk.x) throw new Error("generated Ed25519 key did not export private material");
    const keySecret = Buffer.concat([
      Buffer.from(jwk.d, "base64url"),
      Buffer.from(jwk.x, "base64url"),
    ]).toString("base64");
    const createAuthHeaders = createX402FacilitatorAuthHeaders({
      facilitator: FACILITATOR,
      facilitatorAuth: { keyId: KEY_ID, keySecret },
    });

    if (!createAuthHeaders) throw new Error("authenticated config did not create headers");
    const authorization = (await createAuthHeaders()).supported?.Authorization;
    if (!authorization) throw new Error("supported auth header was not generated");
    const token = authorization.slice("Bearer ".length);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: KEY_ID });
    expect(decodeJwt(token).uris).toEqual(["GET facilitator.test/platform/v2/x402/supported"]);
  });

  it.each([
    ["key id", { DVMKIT_X402_FACILITATOR_KEY_ID: KEY_ID }],
    ["key secret", { DVMKIT_X402_FACILITATOR_KEY_SECRET: KEY_SECRET }],
  ])("refuses a partial facilitator credential pair containing only %s", async (_, authEnv) => {
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        DVMKIT_X402_PAY_TO: PAY_TO,
        DVMKIT_X402_FACILITATOR: FACILITATOR,
        ...authEnv,
      },
    });
    host.mount(testDvm());

    await expect(host.serve()).rejects.toThrow(
      "DVMKIT_X402_FACILITATOR_KEY_ID and DVMKIT_X402_FACILITATOR_KEY_SECRET must be configured together."
    );
  });

  it.each([
    [
      "batch settlement",
      { DVMKIT_X402_SELF_RELAY_KEY: SELF_RELAY_KEY },
      "requires DVMKIT_X402_BATCH_SETTLEMENT=true",
    ],
    [
      "an explicit RPC",
      {
        DVMKIT_X402_BATCH_SETTLEMENT: "true",
        DVMKIT_X402_SELF_RELAY_KEY: SELF_RELAY_KEY,
      },
      "requires an explicit DVMKIT_X402_RPC_URL",
    ],
    [
      "a separate receiver authorizer",
      {
        DVMKIT_X402_BATCH_SETTLEMENT: "true",
        DVMKIT_X402_SELF_RELAY_KEY: SELF_RELAY_KEY,
        DVMKIT_X402_RPC_URL: "https://base.example.invalid",
      },
      "requires DVMKIT_X402_RECEIVER_AUTHORIZER_KEY",
    ],
  ])("refuses a self-relay without %s", async (_, relayEnv, message) => {
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: { DVMKIT_X402_PAY_TO: PAY_TO, ...relayEnv },
    });
    host.mount(testDvm());

    await expect(host.serve()).rejects.toThrow(message);
  });

  it("refuses a relay balance floor when no relay is configured", async () => {
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        DVMKIT_X402_PAY_TO: PAY_TO,
        DVMKIT_X402_BATCH_SETTLEMENT: "true",
        DVMKIT_X402_RECEIVER_AUTHORIZER_KEY: AUTHORIZER_KEY,
        DVMKIT_X402_SELF_RELAY_MIN_BALANCE_WEI: "1000",
      },
    });
    host.mount(testDvm());

    await expect(host.serve()).rejects.toThrow(
      "DVMKIT_X402_SELF_RELAY_MIN_BALANCE_WEI requires DVMKIT_X402_SELF_RELAY_KEY"
    );
  });
});

function authenticatedConfig(): X402Config {
  return {
    payTo: PAY_TO,
    network: "eip155:8453",
    facilitator: FACILITATOR,
    facilitatorAuth: { keyId: KEY_ID, keySecret: KEY_SECRET },
  };
}

function paymentHeader(value: string): string {
  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0xfrom",
        to: PAY_TO,
        value,
        validAfter: "0",
        validBefore: "999999999",
        nonce: "0xnonce",
      },
    },
  };
  return encodePayment(payload);
}

function testDvm() {
  return configureDVM({
    name: "x402-facilitator-auth",
    capability: "test",
    tag: "test",
    onJob(ctx) {
      ctx.complete("ok");
    },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}
