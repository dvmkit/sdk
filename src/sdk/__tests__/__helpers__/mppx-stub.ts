import type { Receipt } from "mppx";
import { tempo } from "mppx/server";

/** Tempo USDC on mainnet — the currency every MPP unit test binds challenges against. */
export const STUB_TEMPO_CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50";

/**
 * A `tempo.charge` server method whose terminal payment operation is a test
 * stub, plus the setter that swaps that stub between cases.
 */
export interface StubbedTempoCharge {
  /** Pass this straight into `Mppx.create({ methods: [method] })`. */
  method: ReturnType<typeof tempo.charge>;
  /** Replace the stub. Takes effect immediately, including after `Mppx.create`. */
  setBroadcast: (fn: () => Promise<Receipt.Receipt>) => void;
}

/**
 * Keep real mppx challenge, HMAC, amount, metadata and expiry checks while
 * replacing settlement with a stub. The credential path prefers `broadcast`
 * over `verify`; removing `validate` also avoids its live RPC call.
 * Mppx reads method hooks per call, so `setBroadcast` can change an existing
 * instance after `Mppx.create`.
 */
export function stubbedTempoCharge(
  recipient: string,
  initial: () => Promise<Receipt.Receipt> = () =>
    Promise.resolve({
      method: "tempo",
      status: "success",
      timestamp: new Date().toISOString(),
      reference: "0xref",
    })
): StubbedTempoCharge {
  let broadcast = initial;
  const method = tempo.charge({
    recipient: recipient as `0x${string}`,
    currency: STUB_TEMPO_CURRENCY,
    decimals: 6,
  });
  const mutable = method as unknown as {
    broadcast: () => Promise<Receipt.Receipt>;
    validate?: unknown;
  };
  mutable.broadcast = () => broadcast();
  delete mutable.validate;
  return {
    method,
    setBroadcast(fn) {
      broadcast = fn;
    },
  };
}
