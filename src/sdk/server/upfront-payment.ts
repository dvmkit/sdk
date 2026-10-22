import type { UpfrontPayment } from "../../lib/upfront-payment";
import type { DrawResult } from "./credit-ledger";

/** Call only at acceptance, before the pending draw can grow or settle. */
export function upfrontPaymentFromDraw(draw: Omit<DrawResult, "replayed">): UpfrontPayment {
  const value = draw.railValue;
  const rail = value.rail;
  return {
    amount_msats: value.drawMsats,
    ...(value.creditCurrency !== null && {
      amount_micro: draw.amountMicro,
      currency: value.creditCurrency,
    }),
    ...(rail === "cashu" || rail === "x402" || rail === "tempo" || rail === "lightning"
      ? { rail } : {}),
    ...(value.drawNative !== null && value.nativeAsset !== null && {
      native_amount: value.drawNative,
      native_asset: value.nativeAsset,
    }),
    credit_id: draw.creditId,
    draw_id: draw.drawId,
  };
}
