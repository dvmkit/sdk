import {
  createNewMintKeys,
  Mint,
  type RequestFn,
  type RequestOptions,
  Wallet,
} from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

const MINT_URL = "https://rotating-mint.example";

interface SimulatedKeyset {
  id: string;
  keys: Record<string, string>;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newSimulatedKeyset(seedByte: number): SimulatedKeyset {
  const pair = createNewMintKeys(2, new Uint8Array(32).fill(seedByte));
  return {
    id: pair.keysetId,
    keys: Object.fromEntries(
      Object.entries(pair.pubKeys).map(([amount, pubkey]) => [amount, hex(pubkey)])
    ),
  };
}

describe("Cashu wallet keyset rotation", () => {
  it("refreshes its real keychain and prepares the next mint operation under the replacement keyset", async () => {
    const keysetA = newSimulatedKeyset(1);
    const keysetB = newSimulatedKeyset(2);
    let activeKeyset = keysetA;

    const request: RequestFn = async <T>({ endpoint }: RequestOptions) => {
      if (endpoint === `${MINT_URL}/v1/info`) return { nuts: {} } as T;
      if (endpoint === `${MINT_URL}/v1/keysets`) {
        return {
          keysets: [{ id: activeKeyset.id, unit: "sat", active: true }],
        } as T;
      }
      if (endpoint === `${MINT_URL}/v1/keys`) {
        return {
          keysets: [
            {
              id: activeKeyset.id,
              unit: "sat",
              active: true,
              keys: activeKeyset.keys,
            },
          ],
        } as T;
      }
      throw new Error(`Unexpected mint request: ${endpoint}`);
    };

    const wallet = new Wallet(new Mint(MINT_URL, { customRequest: request }));
    await wallet.loadMint();
    expect(wallet.keysetId).toBe(keysetA.id);

    // The mint retires A and makes B the only active keyset. `loadMint(true)`
    // must replace the snapshot and rebind an auto-bound wallet before the
    // next operation creates blinded outputs.
    activeKeyset = keysetB;
    await wallet.loadMint(true);

    expect(wallet.keysetId).toBe(keysetB.id);
    expect(wallet.keyChain.getAllKeysetIds()).toEqual([keysetB.id]);

    const preview = await wallet.prepareMint("bolt11", 3, { quote: "after-rotation" });
    expect(preview.keysetId).toBe(keysetB.id);
    expect(new Set(preview.payload.outputs.map((output) => output.id))).toEqual(new Set([keysetB.id]));
  });
});
