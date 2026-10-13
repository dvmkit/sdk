import { createHash } from "node:crypto";

import type { PendingSubmissionContext } from "./store";

/** Bind a token-dependent fund commitment into a serializable resume context. */
export function bindCashuTokenToSubmissionContext(
  context: PendingSubmissionContext | undefined,
  cashuToken: string
): PendingSubmissionContext | undefined {
  if (!context) return undefined;
  const commitment = createHash("sha256").update(cashuToken).digest("hex");

  if (context.route === "credit") {
    const fund = context.credit_body?.fund as Record<string, unknown> | undefined;
    if (!fund) return context;
    return {
      ...context,
      credit_body: {
        ...context.credit_body,
        fund: { ...fund, commitment },
      },
    };
  }

  const data = context.submit_body.data as Record<string, unknown> | undefined;
  const fund = data?.fund as Record<string, unknown> | undefined;
  if (!data || !fund) return context;
  return {
    ...context,
    submit_body: {
      ...context.submit_body,
      data: { ...data, fund: { ...fund, commitment } },
    },
  };
}
