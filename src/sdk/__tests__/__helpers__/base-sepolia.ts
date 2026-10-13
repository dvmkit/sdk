/**
 * Live Base Sepolia settlement uses a pre-funded `X402_TESTNET_PRIVATE_KEY`;
 * these helpers do not self-fund. The facilitator pays gas, so the payer
 * needs USDC but no ETH. `X402_TESTNET_RPC` supplies reachability and balance
 * checks; verification and settlement go through the facilitator.
 * Tier environment variables also enable the RPC/facilitator network guard.
 */

import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  BASE_SEPOLIA_RPC_DEFAULT,
  isNetworkGuardBlocked,
} from "../../../test-support/network-guard-policy";
import { createX402FacilitatorAuthHeaders } from "../../../lib/x402/facilitator";
import {
  buildPaymentRequirements,
  decodePayment,
  usdcContractFor,
  X402_V1_VERSION,
} from "../../../lib/x402/spec";
import {
  isExactEvmVerificationHealthy,
  loadX402TestnetFacilitatorConfig,
  payerFundingDetail,
} from "./x402-live-tier";

/** Base Sepolia chain id. */
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** CAIP-2 chain id for Base Sepolia — what the DVM's `x402.network` advertises. */
export const BASE_SEPOLIA_CAIP2 = "eip155:84532";

/**
 * Base Sepolia RPC. Defaults to the public endpoint; override with
 * `X402_TESTNET_RPC` (the env var CI sets to enable this tier).
 */
export const BASE_SEPOLIA_RPC = process.env.X402_TESTNET_RPC ?? BASE_SEPOLIA_RPC_DEFAULT;

/**
 * x402 facilitator. Local runs may use the free x402.org fallback. CI requires
 * an authenticated dedicated endpoint and complete key pair.
 */
const facilitatorConfig = loadX402TestnetFacilitatorConfig();
export const X402_FACILITATOR = facilitatorConfig.facilitator;
export const X402_FACILITATOR_AUTH = facilitatorConfig.facilitatorAuth;

/** Base Sepolia USDC contract — the single source of truth is `spec.ts`. */
export const USDC_BASE_SEPOLIA: `0x${string}` = (() => {
  const usdc = usdcContractFor("base-sepolia");
  if (!usdc) throw new Error("base-sepolia USDC contract missing from spec.ts");
  return usdc;
})();

async function rpc<T>(method: string, params: unknown[], timeoutMs = 8000): Promise<T> {
  const res = await fetch(BASE_SEPOLIA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method} → ${body.error.message ?? "rpc error"}`);
  return body.result as T;
}

/**
 * Probe `eth_chainId` on {@link BASE_SEPOLIA_RPC}. Returns false on any error,
 * timeout, or a chainId that isn't Base Sepolia — so a testnet/RPC outage skips
 * the tier cleanly rather than reddening CI.
 *
 * A vitest network-guard block is the one failure it does **not** swallow: that
 * means the tier is enabled but its host was never allowlisted, and reporting it
 * as an outage is what hid the tier's silent skip for months.
 */
export async function isBaseSepoliaReachable(): Promise<boolean> {
  try {
    const chainIdHex = await rpc<string>("eth_chainId", [], 3000);
    return Number.parseInt(chainIdHex, 16) === BASE_SEPOLIA_CHAIN_ID;
  } catch (err) {
    if (isNetworkGuardBlocked(err)) throw err;
    return false;
  }
}

/**
 * Liveness probe of the facilitator's `/supported` endpoint and its exact EVM
 * verifier. A facilitator can answer `/supported` while its chain backend is
 * unhealthy and return `invalid_*_signature` for every payment, so the probe
 * signs a reference-client payload with an unfunded throwaway key and expects
 * a balance rejection rather than a signature rejection. A network-guard block
 * rethrows, same as above.
 */
export async function isFacilitatorReachable(): Promise<boolean> {
  try {
    const facilitator = X402_FACILITATOR.replace(/\/$/, "");
    const createHeaders = createX402FacilitatorAuthHeaders({
      facilitator: X402_FACILITATOR,
      ...(X402_FACILITATOR_AUTH ? { facilitatorAuth: X402_FACILITATOR_AUTH } : {}),
    });
    const authHeaders = createHeaders ? await createHeaders() : undefined;
    const supported = await fetch(`${facilitator}/supported`, {
      headers: authHeaders?.supported,
      signal: AbortSignal.timeout(3000),
    });
    if (supported.status >= 500) return false;

    const payer = privateKeyToAccount(generatePrivateKey());
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const resource = "https://x402-testnet.integration/v1/probe";
    const requirements = buildPaymentRequirements({
      x402Config: { payTo: recipient, network: BASE_SEPOLIA_CAIP2 },
      // Match the live tier's $0.001 payment. Dedicated facilitators may reject
      // smaller requirements before signature/balance verification.
      requiredUsdcMicro: 1000n,
      resource,
      version: X402_V1_VERSION,
    });
    const referenceSigner = new ExactEvmSchemeV1({
      address: payer.address,
      signTypedData: (message) =>
        payer.signTypedData(message as Parameters<typeof payer.signTypedData>[0]),
    });
    // @x402/evm's V1 client is typed against the V2 requirements shape, but
    // its implementation reads the V1 `maxAmountRequired` field.
    const referenceRequirements = {
      ...requirements,
      amount: requirements.maxAmountRequired,
      network: requirements.network as `${string}:${string}`,
      extra: requirements.extra ?? {},
    };
    const signed = await referenceSigner.createPaymentPayload(
      X402_V1_VERSION,
      referenceRequirements
    );
    const paymentPayload = {
      x402Version: X402_V1_VERSION,
      scheme: "exact",
      network: requirements.network,
      payload: signed.payload,
    };
    const verify = await fetch(`${facilitator}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders?.verify },
      body: JSON.stringify({
        x402Version: X402_V1_VERSION,
        paymentPayload,
        paymentRequirements: requirements,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return isExactEvmVerificationHealthy(await verify.json());
  } catch (err) {
    if (isNetworkGuardBlocked(err)) throw err;
    return false;
  }
}

/** USDC balance (raw 6-decimal units) of `address` via `eth_call` balanceOf. */
export async function usdcBalance(address: string): Promise<bigint> {
  // balanceOf(address) selector 0x70a08231 + 32-byte left-padded address.
  const data = `0x70a08231${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const hex = await rpc<string>("eth_call", [{ to: USDC_BASE_SEPOLIA, data }, "latest"]);
  return BigInt(hex);
}

/**
 * Whether an exact-payment header carries a canonical Base Sepolia USDC
 * signature that recovers to the authorization's payer.
 *
 * This is independent evidence for the live tier when x402.org answers
 * `invalid_exact_evm_signature`: it fixes the EIP-712 domain to Base Sepolia's
 * known USDC contract instead of trusting the header or facilitator. A malformed
 * header, signature, or authorization returns false and therefore stays a hard
 * envelope failure.
 */
export async function isCanonicalBaseSepoliaExactSignature(
  paymentHeader: string
): Promise<boolean> {
  try {
    const payment = decodePayment(paymentHeader);
    const { authorization, signature } = payment.payload;
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "USDC",
        version: "2",
        chainId: BASE_SEPOLIA_CHAIN_ID,
        verifyingContract: USDC_BASE_SEPOLIA,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as `0x${string}`,
        to: authorization.to as `0x${string}`,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    });
    return recovered.toLowerCase() === authorization.from.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The pre-funded payer private key for the integration test, or null when
 * unset. Base Sepolia has no faucet RPC, so the test can't self-fund — it
 * spends from this long-lived key. Provisioning it (as the CI secret
 * `X402_TESTNET_PRIVATE_KEY`) is what activates the tier in CI.
 */
export function loadFundedPayerKey(): `0x${string}` | null {
  const key = process.env.X402_TESTNET_PRIVATE_KEY;
  if (!key) return null;
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

/** What the pre-flight payer-balance probe found. */
export interface PayerFunding {
  /** The shared payer address the key derives to. */
  address: `0x${string}`;
  /** Its USDC balance in 6-decimal micro-units, or null when the read failed. */
  balanceMicro: bigint | null;
  /** Whether the balance covers `minMicro` — false also when the read failed. */
  funded: boolean;
  /** The line the tier announces, naming the address and the balance. */
  detail: string;
}

/**
 * Pre-flight the shared payer's USDC balance.
 *
 * The wallet is topped up by hand and has no faucet, so it drains eventually —
 * and a drained wallet reads exactly like a protocol regression once the
 * facilitator starts rejecting on balance. Probing first lets the tier skip with
 * the address and the figure, which is also the top-up instruction.
 *
 * Costs one `eth_call` against the RPC the reachability probe just used: no ETH,
 * no additional secret. A guard block rethrows; any other RPC failure
 * is reported as unfunded, the same way the probes beside it read an error as an
 * outage rather than a regression.
 */
export async function probePayerFunding(
  key: `0x${string}`,
  minMicro: bigint
): Promise<PayerFunding> {
  // A malformed key throws here rather than being absorbed: that is a
  // misprovisioned secret of ours, not a counterparty condition.
  const address = privateKeyToAccount(key).address;
  try {
    const balanceMicro = await usdcBalance(address);
    return {
      address,
      balanceMicro,
      funded: balanceMicro >= minMicro,
      detail: payerFundingDetail({ address, balanceMicro, minMicro }),
    };
  } catch (err) {
    if (isNetworkGuardBlocked(err)) throw err;
    return {
      address,
      balanceMicro: null,
      funded: false,
      detail: payerFundingDetail({
        address,
        balanceMicro: null,
        minMicro,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}
