import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

import { buildPaymentRequiredV2 } from "../../../lib/x402/spec";

const NETWORK = "eip155:84532";

// Server tests use the reference signer, so caller funding policy is not part
// of the cryptographic, verification or settlement fixture.
export async function canonicalBaseSepoliaPaymentHeader(
  privateKey: `0x${string}`,
  payTo: string,
  requiredUsdcMicro: bigint,
  resource: string
): Promise<string> {
  const required = buildPaymentRequiredV2({
    x402Config: { payTo, network: NETWORK },
    requiredUsdcMicro,
    resource,
  });
  const client = new x402Client().register(
    NETWORK,
    new ExactEvmScheme(privateKeyToAccount(privateKey))
  );
  const payment = await client.createPaymentPayload({
    ...required,
    accepts: required.accepts.map((requirement) => ({
      ...requirement,
      network: NETWORK,
      extra: requirement.extra ?? {},
    })),
  });
  const header = new x402HTTPClient(client).encodePaymentSignatureHeader(payment)["PAYMENT-SIGNATURE"];
  if (!header) throw new Error("reference client did not create a v2 payment header");
  return header;
}
