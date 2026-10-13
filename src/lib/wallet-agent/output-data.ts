/**
 * Serialize / rehydrate cashu-ts {@link OutputData} blobs for crash-recovery
 * persistence. The agent wallet writes these to disk as the
 * `PendingMint.minting.outputs` sub-state between `prepareMint` and
 * `completeMint`, so a crash that loses the proofs can replay against the
 * NUT-09 `/v1/restore` endpoint with the same blinded outputs and unblind the
 * mint's signatures locally.
 *
 * Hex encoding is used for both `blindingFactor` (bigint) and `secret`
 * (Uint8Array) to keep the wallet JSON pure-ASCII. NUT-11 P2PK secrets are
 * UTF-8 envelopes — preserving the exact bytes is required so the resulting
 * proof secret matches what the mint signed.
 */

import { Amount, OutputData, type OutputDataLike, type Proof, type Wallet } from "@cashu/cashu-ts";

import type { PersistedOutputData } from "./store";

/**
 * Convert an array of cashu-ts {@link OutputDataLike} into the on-disk
 * {@link PersistedOutputData} shape. Lossless round-trip with
 * {@link rehydrateOutputData} for the fields the NUT-09 restore path needs:
 * blinded message, blinding factor, secret, and optional ephemeral E.
 */
export function serializeOutputData(data: OutputDataLike[]): PersistedOutputData[] {
  return data.map((d) => ({
    blinded_message: {
      amount: Amount.from(d.blindedMessage.amount).toNumber(),
      B_: d.blindedMessage.B_,
      id: d.blindedMessage.id,
    },
    blinding_factor: bigintToHex(d.blindingFactor),
    secret: bytesToHex(d.secret),
    ...(d.ephemeralE !== undefined ? { ephemeral_e: d.ephemeralE } : {}),
  }));
}

/**
 * Rebuild concrete {@link OutputData} instances (with a working `toProof`
 * method) from previously persisted state. Throws on malformed input rather
 * than silently dropping outputs — partial recovery is worse than a clean
 * error the operator can act on.
 */
export function rehydrateOutputData(persisted: PersistedOutputData[]): OutputData[] {
  return persisted.map((p) => {
    const blindedMessage = {
      amount: Amount.from(p.blinded_message.amount),
      B_: p.blinded_message.B_,
      id: p.blinded_message.id,
    };
    return new OutputData(
      blindedMessage,
      hexToBigint(p.blinding_factor),
      hexToBytes(p.secret),
      p.ephemeral_e
    );
  });
}

function bigintToHex(n: bigint): string {
  if (n < 0n) throw new Error(`blinding factor must be non-negative, got ${n.toString()}`);
  const raw = n.toString(16);
  return raw.length % 2 === 0 ? raw : "0" + raw;
}

function hexToBigint(hex: string): bigint {
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`invalid hex: ${hex}`);
  return hex.length === 0 ? 0n : BigInt("0x" + hex);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex string must have even length: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Replay persisted blinded outputs against the mint's NUT-09 `/v1/restore`
 * endpoint and unblind the signatures locally — the recovery half of the
 * write-before-`completeMint` discipline.
 *
 * Every caller of this is recovering a mint whose outputs are **P2PK-locked**,
 * which is why the DLEQ verification `Wallet.completeMint` runs is skipped
 * here: a forged signature on a locked output is unspendable without the
 * matching privkey, so the worst case is a junk proof that fails at spend time
 * rather than a loss. Restoring unlocked outputs on this path would need a
 * DLEQ check added first.
 */
export async function restoreProofsFromOutputs(
  wallet: Wallet,
  keysetId: string,
  persisted: PersistedOutputData[]
): Promise<Proof[]> {
  const data = rehydrateOutputData(persisted);
  const keyset = wallet.keyChain.getKeyset(keysetId);
  const restored = await wallet.mint.restore({ outputs: data.map((d) => d.blindedMessage) });
  if (restored.outputs.length !== restored.signatures.length) {
    throw new Error(
      `mint returned mismatched outputs (${restored.outputs.length}) and signatures (${restored.signatures.length}) — NUT-09 requires parallel arrays`
    );
  }
  const byB = new Map(data.map((d) => [d.blindedMessage.B_, d]));
  const proofs: Proof[] = [];
  for (let i = 0; i < restored.signatures.length; i++) {
    const owner = byB.get(restored.outputs[i].B_);
    if (!owner) {
      throw new Error(
        `mint returned a signature for an unknown blinded output: ${restored.outputs[i].B_}`
      );
    }
    proofs.push(owner.toProof(restored.signatures[i], keyset));
  }
  return proofs;
}
