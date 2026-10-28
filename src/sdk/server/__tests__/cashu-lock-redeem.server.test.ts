import {
  Amount,
  blindMessage,
  createRandomSecretKey,
  getPubKeyFromPrivKey,
  OutputData,
  type Proof,
  Wallet,
} from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";
import { assessCashuLock } from "../wallet-accumulator-receive";
import { acceptedLockShapes } from "./__helpers__/cashu-lock-shapes";

const live = await localMintAvailable();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

// Every lock shape the accumulator accepts must be one the DVM's key can sign
// with the cashu-ts signer the melter uses, and one the mint then redeems.
describe.skipIf(!live)("accepted Cashu locks are redeemable by the DVM key", () => {
  it("signs and swaps each accepted shape at a real mint", async () => {
    const wallet = new Wallet(LOCAL_MINT_URL);
    await wallet.loadMint();
    const keyset = wallet.getKeyset();
    const dvmPriv = createRandomSecretKey();
    const key = hex(getPubKeyFromPrivKey(dvmPriv));
    const retiredPriv = createRandomSecretKey();
    const retired = hex(getPubKeyFromPrivKey(retiredPriv));
    const active = [toLockPubkey(key), toLockPubkey(retired)];
    const nowSec = Math.floor(Date.now() / 1000);
    const shapes = acceptedLockShapes({ current: key, retired, payer: "02" + "ef".repeat(32), nowSec });

    const mintOne = async () => {
      const quote = await wallet.createMintQuoteBolt11(1);
      let paid = await wallet.checkMintQuoteBolt11(quote.quote);
      for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        paid = await wallet.checkMintQuoteBolt11(quote.quote);
      }
      const [proof] = await wallet.mintProofsBolt11(1, paid);
      return proof!;
    };

    for (const { label, data, tags, matches } of shapes) {
      const secret = JSON.stringify(["P2PK", { nonce: hex(createRandomSecretKey()).slice(0, 32), data, tags }]);
      expect(assessCashuLock(secret, active, nowSec), label).toMatchObject({ kind: "exclusive" });

      const bytes = new TextEncoder().encode(secret);
      const { r, B_ } = blindMessage(bytes);
      const output = new OutputData({ amount: Amount.from(1), B_: B_.toHex(true), id: keyset.id }, r, bytes);
      const { signatures } = await wallet.mint.swap({ inputs: [await mintOne()], outputs: [output.blindedMessage] });
      const locked: Proof = output.toProof(signatures[0]!, keyset);

      const [signed] = wallet.signP2PKProofs([locked], hex(matches === "current" ? dvmPriv : retiredPriv), []);
      expect(signed?.witness, label).toBeTruthy();
      const fresh = OutputData.createRandomData(1, keyset);
      await expect(
        wallet.mint.swap({
          inputs: [{ ...signed!, witness: typeof signed!.witness === "string" ? signed!.witness : JSON.stringify(signed!.witness) }],
          outputs: fresh.map((item) => item.blindedMessage),
        }),
        label
      ).resolves.toBeDefined();
    }
  }, 30000);
});
