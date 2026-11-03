import { readFileSync } from "node:fs";

import { Credential } from "mppx";
import { describe, expect, it, vi } from "vitest";

import { derivedFundCreditId } from "../funding";
import { createStripeCreditRail } from "../stripe-credit";
import { CALLER, cardServer, credentialFor, fakeStripe, fund, HMAC, paymentChallenges } from "./__helpers__/card-credit";
import { durableLedger } from "./__helpers__/credit-fixtures";

const { payment_intent_metadata: contract } = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/credit-fund-stripe-v1.json", import.meta.url), "utf8")
) as { payment_intent_metadata: { configured: { dvmkit_dvm_id: string } } };
const CANONICAL_ID = contract.configured.dvmkit_dvm_id;

describe("card-credit PaymentIntent identity metadata", () => {
  it.each(["succeed", "decline"] as const)("sends canonical server identity before Stripe can %s", async (mode) => {
    const stripe = fakeStripe(mode);
    const { app } = await cardServer({
      stripe,
      serverOpts: { canonicalDvmId: CANONICAL_ID, dvmId: "legacy-server-id" },
    });
    const discovery = await fund(app, { fundId: mode });
    const [challenge] = paymentChallenges(discovery);
    const credential = Credential.serialize(Credential.from({
      challenge: challenge!,
      source: "caller.example.com",
      payload: { spt: "spt_test", metadata: { dvmkit_dvm_id: "caller-spoof" } },
    }));

    const response = await fund(app, { fundId: mode, credential });
    expect(response.status).toBe(mode === "succeed" ? 200 : 402);
    expect(stripe.calls).toHaveLength(1);
    const { body, idempotencyKey } = stripe.calls[0]!;
    expect(body.get("metadata[dvmkit_dvm_id]")).toBe(CANONICAL_ID);
    expect(body.get("metadata[mpp_is_mpp]")).toBe("true");
    expect(body.get("metadata[mpp_intent]")).toBe("charge");
    expect(body.get("metadata[mpp_challenge_id]")).toBe(challenge!.id);
    expect(body.get("metadata[mpp_server_id]")).toBe(challenge!.realm);
    expect(body.get("metadata[mpp_client_id]")).toBe("caller.example.com");
    expect(idempotencyKey).toBe(`mppx_${challenge!.id}_spt_test`);
  });

  it("falls back to the configured DVM id", async () => {
    const { app, stripe } = await cardServer({ serverOpts: { dvmId: CANONICAL_ID } });
    const credential = await credentialFor(app, "fallback");
    expect((await fund(app, { fundId: "fallback", credential })).status).toBe(200);
    expect(stripe!.calls[0]!.body.get("metadata[dvmkit_dvm_id]")).toBe(CANONICAL_ID);
  });

  it("charges without identity and omits the reserved field even if the payload supplies it", async () => {
    const { app, stripe } = await cardServer();
    const discovery = await fund(app, { fundId: "standalone" });
    const [challenge] = paymentChallenges(discovery);
    const credential = Credential.serialize(Credential.from({
      challenge: challenge!,
      payload: { spt: "spt_test", metadata: { dvmkit_dvm_id: "caller-spoof" } },
    }));
    expect((await fund(app, { fundId: "standalone", credential })).status).toBe(200);
    expect(stripe!.calls).toHaveLength(1);
    expect(stripe!.calls[0]!.body.has("metadata[dvmkit_dvm_id]")).toBe(false);
  });

  it("refuses identity metadata added to a challenge by the caller before charging", async () => {
    const { app, stripe } = await cardServer({ serverOpts: { canonicalDvmId: CANONICAL_ID } });
    const original = Credential.deserialize(await credentialFor(app, "forged"));
    const credential = Credential.serialize(Credential.from({
      challenge: {
        ...original.challenge,
        request: {
          ...original.challenge.request,
          methodDetails: {
            ...(original.challenge.request.methodDetails as Record<string, unknown>),
            metadata: { dvmkit_dvm_id: "caller-spoof" },
          },
        },
      },
      payload: { spt: "spt_test" },
    }));
    const response = await fund(app, { fundId: "forged", credential });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ reason: "invalid_credential" });
    expect(stripe!.calls).toHaveLength(0);
  });

  it("retries a lost response with identical metadata and books the charge once", async () => {
    const stripe = fakeStripe("lose-first-response");
    const { app, ledger } = await cardServer({ stripe, serverOpts: { canonicalDvmId: CANONICAL_ID } });
    const credential = await credentialFor(app, "lost-identity");
    expect((await fund(app, { fundId: "lost-identity", credential })).status).toBe(503);
    const retried = await fund(app, { fundId: "lost-identity", credential });
    expect(retried.status).toBe(200);
    const { credit } = await retried.json();
    expect(stripe.calls).toHaveLength(2);
    expect(stripe.calls[0]!.body.get("metadata[dvmkit_dvm_id]")).toBe(CANONICAL_ID);
    expect(stripe.calls[1]!.body.toString()).toBe(stripe.calls[0]!.body.toString());
    expect(stripe.calls[1]!.idempotencyKey).toBe(stripe.calls[0]!.idempotencyKey);
    expect(await ledger.listFundingLots(credit.credit_id)).toHaveLength(1);
  });

  it.each(["response", "booking"] as const)("recovers a legacy charge whose %s was lost before identity was enabled", async (lost) => {
    const stripe = fakeStripe(lost === "response" ? "lose-first-response" : "succeed");
    const ledger = durableLedger();
    const { app: legacy } = await cardServer({ stripe, ledger });
    const credential = await credentialFor(legacy, "upgrade");
    if (lost === "response") {
      const failed = await fund(legacy, { fundId: "upgrade", credential });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ reason: "indeterminate" });
    } else {
      // Stop after the real rail charges, as a crash before ledger booking would.
      const legacyRail = createStripeCreditRail({
        secretKey: "sk_test_fake", networkId: "profile_test", hmacSecret: HMAC, fetch: stripe.fetchImpl,
      });
      expect(await legacyRail.charge(credential, { amountMicro: 600_000, resourcePath: "/v1/credit" }))
        .toMatchObject({ ok: true, paymentIntentId: "pi_test_1" });
    }
    const creditId = derivedFundCreditId(CALLER, "upgrade");
    expect(await ledger.get(creditId)).toBeUndefined();

    const { app: upgraded } = await cardServer({ stripe, ledger, serverOpts: { canonicalDvmId: CANONICAL_ID } });
    const recovered = await fund(upgraded, { fundId: "upgrade", credential });
    const recoveredBody = await recovered.json();
    expect(recovered.status, JSON.stringify(recoveredBody)).toBe(200);
    expect(recoveredBody.credit.balance_micro).toBe(600_000);
    expect(stripe.calls).toHaveLength(3);
    expect(stripe.calls[0]!.body.has("metadata[dvmkit_dvm_id]")).toBe(false);
    expect(stripe.calls[1]!.body.get("metadata[dvmkit_dvm_id]")).toBe(CANONICAL_ID);
    expect(stripe.calls[2]!.body.toString()).toBe(stripe.calls[0]!.body.toString());
    expect(new Set(stripe.calls.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(1);
    expect(await ledger.listFundingLots(creditId)).toMatchObject([
      { fundingRef: "pi_test_1", creditedMicro: 600_000 },
    ]);
    expect((await fund(upgraded, { fundId: "upgrade-replay", credential })).status).toBe(409);
    expect(await ledger.get(derivedFundCreditId(CALLER, "upgrade-replay"))).toBeUndefined();
    expect(await ledger.listFundingLots(creditId)).toHaveLength(1);
  });

  it.each([undefined, CANONICAL_ID])("bounds retries and books nothing for a persistent mismatch with identity %s", async (canonicalDvmId) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { type: "idempotency_error" } }, { status: 400 })
    );
    const { app, ledger } = await cardServer({
      stripe: null,
      serverOpts: {
        canonicalDvmId,
        stripeCredit: createStripeCreditRail({
          secretKey: "sk_test_fake",
          networkId: "profile_test",
          hmacSecret: HMAC,
          fetch: fetchImpl,
        }),
      },
    });
    const credential = await credentialFor(app, "persistent-mismatch");
    const refused = await fund(app, { fundId: "persistent-mismatch", credential });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ reason: "indeterminate" });
    expect(fetchImpl).toHaveBeenCalledTimes(canonicalDvmId ? 2 : 1);
    expect(await ledger.get(derivedFundCreditId(CALLER, "persistent-mismatch"))).toBeUndefined();
  });
});
