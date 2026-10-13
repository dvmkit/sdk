import { randomBytes } from "node:crypto";

import { Credential } from "mppx";
import { tempo as tempoClient } from "mppx/client";
import { Mppx, tempo } from "mppx/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

/**
 * End-to-end MPP round-trip exercised against the real `mppx` SDK, using a
 * zero-amount tempo `charge` proof so credential signing and verification
 * stay client/server-pure (no Tempo RPC, no on-chain transaction).
 */
describe("mppx round-trip", () => {
  it("server issues challenge → client builds credential → server verifies", async () => {
    const secretKey = randomBytes(32).toString("hex");
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const mppx = Mppx.create({
      methods: [
        tempo.charge({
          recipient: account.address,
          currency: "0x20C000000000000000000000b9537d11c60E8b50",
          decimals: 6,
        }),
      ],
      secretKey,
      realm: "test.example",
    });

    // Server issues an HMAC-bound challenge via the typed handler.
    const challenge = await mppx.challenge.tempo.charge({ amount: "0" });
    expect(challenge.method).toBe("tempo");
    expect(challenge.intent).toBe("charge");
    expect(challenge.realm).toBe("test.example");
    expect(challenge.id).toBeTruthy();

    // Client builds a structured credential against the issued challenge.
    const clientMethod = tempoClient.charge({ account });
    type ClientChallenge = Parameters<typeof clientMethod.createCredential>[0]["challenge"];
    const credString = await clientMethod.createCredential({
      challenge: challenge as ClientChallenge,
      context: { account },
    });
    const credential = Credential.deserialize(credString);
    expect(credential.challenge.id).toBe(challenge.id);

    // Server verifies — HMAC binding, payload schema, expiry, and proof
    // signature all run inside mppx.broadcastCredential.
    const receipt = await mppx.broadcastCredential(credential);
    expect(receipt.method).toBe("tempo");
    expect(receipt.status).toBe("success");
    expect(receipt.reference).toBe(challenge.id);
  });

  it("rejects a credential whose challenge.id was not HMAC-bound by this server", async () => {
    const account = privateKeyToAccount(generatePrivateKey());

    const tempoMethod = () =>
      tempo.charge({
        recipient: account.address,
        currency: "0x20C000000000000000000000b9537d11c60E8b50",
        decimals: 6,
      });

    const issuer = Mppx.create({
      methods: [tempoMethod()],
      secretKey: randomBytes(32).toString("hex"),
      realm: "test.example",
    });
    const verifier = Mppx.create({
      methods: [tempoMethod()],
      secretKey: randomBytes(32).toString("hex"),
      realm: "test.example",
    });

    const challenge = await issuer.challenge.tempo.charge({ amount: "0" });
    const clientMethod = tempoClient.charge({ account });
    type ClientChallenge = Parameters<typeof clientMethod.createCredential>[0]["challenge"];
    const credString = await clientMethod.createCredential({
      challenge: challenge as ClientChallenge,
      context: { account },
    });
    const credential = Credential.deserialize(credString);

    await expect(verifier.broadcastCredential(credential)).rejects.toThrow();
  });
});
