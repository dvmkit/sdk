import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { Context } from "hono";

import { ADMIN_STATE_UNAVAILABLE } from "../../lib/cashu/admin-auth";
import type { LockPubkeyState, LockPubkeyStateLoader } from "./lock-pubkey-store";

export type AdminLockPubkeyStateResult = { state: LockPubkeyState } | { response: Response };

/**
 * Load the authoritative admin signer state before signature verification.
 * Failures stay fail-closed and return a retriable response without touching
 * replay state or exposing database connection details.
 */
export async function loadAdminLockPubkeyState(
  c: Context,
  opts: { dvmId: string; getLockPubkeyState: LockPubkeyStateLoader }
): Promise<AdminLockPubkeyStateResult> {
  try {
    return { state: await opts.getLockPubkeyState() };
  } catch (error) {
    const errorCode = safeErrorCode(error);
    diagnosticConsole.error(
      {
        level: "error",
        event: "admin_lock_state_unavailable",
        message: undefined,
        dvm_id: opts.dvmId,
        method: c.req.method,
        route: `${c.req.method} ${c.req.path}`,
        error_kind: error instanceof Error ? "Error" : typeof error,
        ...(errorCode ? { error_code: errorCode } : {}),
      }
    );
    return {
      response: c.json(
        {
          error: ADMIN_STATE_UNAVAILABLE,
          message:
            "Admin authentication state is temporarily unavailable. No operation was performed; retry after database availability is restored.",
        },
        503
      ),
    };
  }
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,16}$/i.test(code) ? code : undefined;
}
