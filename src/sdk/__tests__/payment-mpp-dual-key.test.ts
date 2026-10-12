import { randomBytes } from "node:crypto";

import { Credential, Errors as MppxErrors, Store } from "mppx";
import { tempo as tempoClient } from "mppx/client";
import { Mppx, tempo } from "mppx/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import type { MppSecretState } from "../server/mpp-secret-state";
import type { PostgresTempoChargeStore } from "../server/tempo-charge-store";
import {
  createDualKeyMppxFromOpts,
  installHostedTempoChargeGuard,
  type MppOpts,
  type MppxServer,
} from "../server/mpp-setup";

// Allow time for real secp256k1/HMAC work across several credentials per case.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

function asMpp(handle: MppxServer | undefined): MppxServer {
  if (!handle) throw new Error("expected mpp handle to be defined");
  return handle;
}

/**
 * End-to-end coverage for the SDK's dual-key verify wrapper.
 *
 * Uses real mppx for issuance, signing, and verification. The
 * `stateLoader` is a plain in-memory closure — the persistence layer
 * (`mpp_secret_state` table) is exercised separately in
 * `__tests__/mpp-secret-state.test.ts` and its real-pg counterpart. This
 * file focuses on the verify-time behaviour: which secret accepts what,
 * and how the rapid-rotation flag rides through.
 */
describe("createDualKeyMppxFromOpts — verify roundtrip", () => {
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const opts: MppOpts = { tempoRecipient: recipient, realm: "test.example" };
  const activeSecret = randomBytes(32).toString("hex");
  const previousSecret = randomBytes(32).toString("hex");

  async function buildCredential(secret: string): Promise<Credential.Credential> {
    const issuer = Mppx.create({
      methods: [
        tempo.charge({
          recipient,
          currency: "0x20C000000000000000000000b9537d11c60E8b50",
          decimals: 6,
        }),
      ],
      secretKey: secret,
      realm: "test.example",
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const challenge = await issuer.challenge.tempo.charge({ amount: "0" });
    const clientMethod = tempoClient.charge({ account });
    type ClientChallenge = Parameters<typeof clientMethod.createCredential>[0]["challenge"];
    const credString = await clientMethod.createCredential({
      challenge: challenge as ClientChallenge,
      context: { account },
    });
    return Credential.deserialize(credString);
  }

  it("accepts a credential signed with the active secret", async () => {
    const loader = async (): Promise<MppSecretState> => ({
      active: activeSecret,
      previous: null,
      rapidRotationAtMs: null,
    });
    const mpp = createDualKeyMppxFromOpts(
      opts,
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      loader
    );
    expect(mpp).toBeDefined();
    const cred = await buildCredential(activeSecret);
    const receipt = await asMpp(mpp).broadcastCredential(cred);
    expect(receipt.status).toBe("success");
  });

  it("accepts a credential signed with the previous secret within the rotation window", async () => {
    const loader = async (): Promise<MppSecretState> => ({
      active: activeSecret,
      previous: { secret: previousSecret, expiresAtMs: Date.now() + 60_000 },
      rapidRotationAtMs: null,
    });
    const mpp = createDualKeyMppxFromOpts(
      opts,
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      loader
    );
    const cred = await buildCredential(previousSecret);
    const receipt = await asMpp(mpp).broadcastCredential(cred);
    expect(receipt.status).toBe("success");
  });

  it("prevalidates active and rotated credentials without broadcasting and rejects an unknown key", async () => {
    const mpp = asMpp(createDualKeyMppxFromOpts(
      opts,
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      async () => ({
        active: activeSecret,
        previous: { secret: previousSecret, expiresAtMs: Date.now() + 60_000 },
        rapidRotationAtMs: null,
      })
    ));
    expect(mpp.validateCredential).toBeDefined();
    for (const secret of [activeSecret, previousSecret]) {
      await expect(mpp.validateCredential!(await buildCredential(secret))).resolves.toBeDefined();
    }
    await expect(mpp.validateCredential!(await buildCredential(randomBytes(32).toString("hex"))))
      .rejects.toBeInstanceOf(MppxErrors.InvalidChallengeError);
  });

  it("reserves the exact mppx proof replay key before active and rotated broadcasts", async () => {
    const store = Store.memory();
    const reserveHostedCharge = vi.fn().mockResolvedValue(undefined);
    const mpp = asMpp(createDualKeyMppxFromOpts(
      { ...opts, tempoCharge: { store } },
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      async () => ({
        active: activeSecret,
        previous: { secret: previousSecret, expiresAtMs: Date.now() + 60_000 },
        rapidRotationAtMs: null,
      })
    ));
    installHostedTempoChargeGuard(mpp, {
      reserveHostedCharge,
      completeHostedCharge: vi.fn().mockResolvedValue(undefined),
    } as unknown as PostgresTempoChargeStore);
    for (const secret of [activeSecret, previousSecret]) {
      const credential = await buildCredential(secret);
      const admissionId = `admission-${credential.challenge.id}`;
      const receipt = await mpp.broadcastCredential(credential, {
        hostedPaymentIntent: { admissionId, jobId: `job-${credential.challenge.id}` },
      });
      expect(receipt.status).toBe("success");
      expect(reserveHostedCharge).toHaveBeenLastCalledWith(
        Credential.serialize(credential), expect.objectContaining({ admissionId })
      );
    }
  });

  it("rejects a previous-signed credential after the rotation window has expired", async () => {
    const loader = async (): Promise<MppSecretState> => ({
      active: activeSecret,
      previous: null, // loadMppSecretState filters expired previous → null
      rapidRotationAtMs: null,
    });
    const mpp = createDualKeyMppxFromOpts(
      opts,
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      loader
    );
    const cred = await buildCredential(previousSecret);
    await expect(asMpp(mpp).broadcastCredential(cred)).rejects.toBeInstanceOf(
      MppxErrors.InvalidChallengeError
    );
  });

  it("rejects an unknown-secret credential when no state row exists", async () => {
    const loader = async (): Promise<MppSecretState | null> => null;
    const mpp = createDualKeyMppxFromOpts(
      opts,
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      loader
    );
    const cred = await buildCredential(previousSecret);
    await expect(asMpp(mpp).broadcastCredential(cred)).rejects.toBeInstanceOf(
      MppxErrors.InvalidChallengeError
    );
  });

  it("flags rapid_rotation=true when verify fails with a recent dropped-oldest rotation", async () => {
    const droppedSecret = randomBytes(32).toString("hex");
    const loader = async (): Promise<MppSecretState> => ({
      active: activeSecret,
      previous: { secret: previousSecret, expiresAtMs: Date.now() + 60_000 },
      rapidRotationAtMs: Date.now() - 5_000,
    });
    const mpp = createDualKeyMppxFromOpts(
      opts,
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      loader
    );
    const cred = await buildCredential(droppedSecret);
    await expect(asMpp(mpp).broadcastCredential(cred)).rejects.toThrow(/rapid_rotation=true/);
  });

  it("dual-keys mppx's deprecated verifyCredential alias too", async () => {
    // mppx assigns one function reference to both `broadcastCredential` and
    // the deprecated `verifyCredential` on an unfrozen handle, so overriding
    // only the former would leave a live door onto the un-dual-keyed path.
    const loader = async (): Promise<MppSecretState> => ({
      active: activeSecret,
      previous: { secret: previousSecret, expiresAtMs: Date.now() + 60_000 },
      rapidRotationAtMs: null,
    });
    const mpp = createDualKeyMppxFromOpts(
      opts,
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      loader
    );
    const alias = (asMpp(mpp) as unknown as Record<string, MppxServer["broadcastCredential"]>)
      .verifyCredential;
    expect(typeof alias).toBe("function");
    const cred = await buildCredential(previousSecret);
    const receipt = await alias(cred);
    expect(receipt.status).toBe("success");
  });

  it("non-HMAC failures (e.g. expiry) are not retried against previous secret", async () => {
    const activeMppx = Mppx.create({
      methods: [
        tempo.charge({
          recipient,
          currency: "0x20C000000000000000000000b9537d11c60E8b50",
          decimals: 6,
        }),
      ],
      secretKey: activeSecret,
      realm: "test.example",
    });
    const account = privateKeyToAccount(generatePrivateKey());
    // Issue with a stale-in-the-past expiry so mppx's `Expires.assert`
    // throws after the HMAC check passes against the active secret.
    const challenge = await activeMppx.challenge.tempo.charge({
      amount: "0",
      expires: new Date(Date.now() - 60_000).toISOString(),
    });
    const clientMethod = tempoClient.charge({ account });
    type ClientChallenge = Parameters<typeof clientMethod.createCredential>[0]["challenge"];
    const credString = await clientMethod.createCredential({
      challenge: challenge as ClientChallenge,
      context: { account },
    });
    const cred = Credential.deserialize(credString);

    let loaderCalls = 0;
    const loader = async (): Promise<MppSecretState> => {
      loaderCalls += 1;
      return {
        active: activeSecret,
        previous: { secret: previousSecret, expiresAtMs: Date.now() + 60_000 },
        rapidRotationAtMs: null,
      };
    };
    const mpp = createDualKeyMppxFromOpts(
      opts,
      { DVMKIT_TEMPO_SECRET_KEY: activeSecret } as NodeJS.ProcessEnv,
      loader
    );
    await expect(asMpp(mpp).broadcastCredential(cred)).rejects.toThrow();
    // Loader is only consulted on HMAC-mismatch — expiry shouldn't reach
    // the previous-secret retry branch.
    expect(loaderCalls).toBe(0);
  });
});
