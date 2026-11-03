import { Credential } from "mppx";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SignedRequestAudience } from "../../../lib/signed-request-statement";
import { configureDVM } from "../../configure";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { fundingCommitment } from "../funding";
import { createDVMHost } from "../host";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { createStripeCreditRail } from "../stripe-credit";
import { fakeStripe, HMAC, paymentChallenges, PRIVKEY, rateFx } from "./__helpers__/card-credit";

afterEach(() => vi.unstubAllGlobals());

describe("host card-credit identity wiring", () => {
  it.each(["environment", "explicit"] as const)("uses host identity with an %s rail", async (configuration) => {
    const stripe = fakeStripe();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", ((input, init) => {
      if (String(input).startsWith("https://api.stripe.com/")) return stripe.fetchImpl(input, init);
      return originalFetch(input, init);
    }) as typeof fetch);
    const canonicalDvmId = "00000000-0000-4000-8000-000000000002";
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {
        DVMKIT_CANONICAL_DVM_ID: canonicalDvmId,
        DVMKIT_DVM_ID: "legacy-host-id",
        DVMKIT_TEMPO_SECRET_KEY: HMAC,
        ...(configuration === "environment" ? {
          DVMKIT_STRIPE_SECRET_KEY: "sk_test_fake",
          DVMKIT_STRIPE_NETWORK_ID: "profile_test",
        } : {}),
      },
      fx: rateFx,
      ...(configuration === "explicit" ? {
        stripeCredit: createStripeCreditRail({
          secretKey: "sk_test_fake",
          networkId: "profile_test",
          hmacSecret: HMAC,
          fetch: stripe.fetchImpl,
        }),
      } : {}),
    });
    host.mount(configureDVM({
      name: "card-metadata",
      capability: "run",
      auth: secp256k1Auth(),
      price: "$0.10",
      credit: { min: "$0.10", max: "$5.00" },
      onJob(ctx) { ctx.complete("done"); },
    }));
    const server = await host.serve();
    try {
      const info = await (await fetch(`${server.url}/v1/info`)).json() as {
        auth_audience: SignedRequestAudience;
      };
      const signer = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);
      const fund = (credential?: string) => fetch(`${server.url}/v1/credit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(credential && { Authorization: credential }),
        },
        body: JSON.stringify(signer.signRequest(PRIVKEY, {
          op: "fund",
          fund: {
            method: "stripe",
            fund_id: "host-fund",
            amount_micro: 600_000,
            commitment: credential ? fundingCommitment(credential) : "00".repeat(32),
          },
        }, undefined, {
          audience: info.auth_audience,
          method: "POST",
          path: "/v1/credit",
          capability: null,
        })),
      });
      const discovery = await fund();
      expect(discovery.status).toBe(402);
      const [challenge] = paymentChallenges(discovery);
      const credential = Credential.serialize(Credential.from({ challenge: challenge!, payload: { spt: "spt_test" } }));
      expect((await fund(credential)).status).toBe(200);
      expect(stripe.calls).toHaveLength(1);
      expect(stripe.calls[0]!.body.get("metadata[dvmkit_dvm_id]")).toBe(canonicalDvmId);
    } finally {
      await server.close();
    }
  });
});
