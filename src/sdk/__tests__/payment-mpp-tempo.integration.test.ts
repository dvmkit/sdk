import { randomBytes } from "node:crypto";

import { Credential } from "mppx";
import { tempo as tempoClient } from "mppx/client";
import { Mppx, tempo } from "mppx/server";
import { parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { announceTier } from "../../test-support/tier-announce";
import {
  fundTestnetAddress,
  isTempoTestnetReachable,
  PATH_USD,
  pathUsdBalance,
  TEMPO_TESTNET_RPC,
} from "./__helpers__/tempo-testnet";

/**
 * Nonzero testnet charge: real credential creation transfers TIP-20 value and mppx verifies
 * chain evidence. The optional testnet gate also permits its RPC through the network guard.
 */

const ENABLED = Boolean(process.env.TEMPO_TESTNET_RPC);
// A guard block throws out of the probe rather than reading as an outage, so an
// unallowlisted host fails the run here instead of quietly skipping the tier.
const REACHABLE = ENABLED && (await isTempoTestnetReachable());
if (ENABLED) {
  // An enabled tier states its verdict either way: an outage skips rather than
  // reddens, but it must never do so unnoticed.
  announceTier(
    "tempo integration",
    REACHABLE ? "ran" : "skipped",
    REACHABLE
      ? `moderato reachable at ${TEMPO_TESTNET_RPC}`
      : `TEMPO_TESTNET_RPC is set but moderato is unreachable at ${TEMPO_TESTNET_RPC}`
  );
}

// Charge amount in whole pathUSD units (mppx applies parseUnits internally).
// $0.01 — trivial next to a faucet drip, easy to assert as an on-chain delta.
const CHARGE_AMOUNT = "0.01";
const CHARGE_AMOUNT_RAW = parseUnits(CHARGE_AMOUNT, 6);
const REALM = "tempo-testnet.integration";

describe.skipIf(!REACHABLE)("MPP/Tempo testnet round-trip (real settlement)", () => {
  it("server challenge → client credential (on-chain) → server verify, with recipient delta", async () => {
    // Payer: a fresh key funded from the faucet. Recipient: a fresh address
    // whose pathUSD delta proves the charge actually settled on-chain.
    const payer = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey());
    await fundTestnetAddress(payer.address);

    const recipientBefore = await pathUsdBalance(recipient.address);

    const mppx = Mppx.create({
      methods: [
        tempo.charge({
          recipient: recipient.address,
          currency: PATH_USD,
          decimals: 6,
          testnet: true,
        }),
      ],
      secretKey: randomBytes(32).toString("hex"),
      realm: REALM,
    });

    // Server issues an HMAC-bound, non-zero challenge on the tempo method.
    const challenge = await mppx.challenge.tempo.charge({ amount: CHARGE_AMOUNT });
    expect(challenge.method).toBe("tempo");
    expect(challenge.intent).toBe("charge");
    // methodDetails is the open-union `{}` at the type level; the testnet
    // chainId is what routes the client to moderato.
    expect((challenge.request.methodDetails as { chainId?: number } | undefined)?.chainId).toBe(
      42431
    );

    // Client builds the credential — a real on-chain TIP-20 transfer against
    // moderato (gas estimation + settlement), driven entirely by the chainId
    // the server stamped into the challenge.
    const clientMethod = tempoClient.charge({ account: payer });
    type ClientChallenge = Parameters<typeof clientMethod.createCredential>[0]["challenge"];
    const credString = await clientMethod.createCredential({
      challenge: challenge as ClientChallenge,
      context: { account: payer },
    });
    const credential = Credential.deserialize(credString);
    expect(credential.challenge.id).toBe(challenge.id);

    // Server verifies against the real chain — HMAC binding, payload schema,
    // expiry, and the on-chain transfer all run inside broadcastCredential.
    const receipt = await mppx.broadcastCredential(credential, {
      request: { amount: CHARGE_AMOUNT },
    });
    expect(receipt.method).toBe("tempo");
    expect(receipt.status).toBe("success");
    // Non-zero charges settle on-chain, so `reference` is the settlement tx
    // hash (the zero-amount proof path references the challenge id instead).
    expect(receipt.reference).toMatch(/^0x[0-9a-f]{64}$/);

    // Belt-and-suspenders: the recipient actually received the charge.
    const recipientAfter = await pathUsdBalance(recipient.address);
    expect(recipientAfter - recipientBefore).toBe(CHARGE_AMOUNT_RAW);
  }, 90_000);
});
