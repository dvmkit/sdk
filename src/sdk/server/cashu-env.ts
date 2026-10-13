import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { Pool } from "pg";

import type { CashuMode } from "../types";
import {
  DEFAULT_LOCK_PUBKEY_GRACE_SECONDS,
  initLockPubkeyTable,
  seedLockPubkeyState,
} from "./lock-pubkey-store";
import { initWalletAccumulatorTable } from "./wallet-accumulator-store";

export interface ResolvedCashuOpts {
  cashuMode: CashuMode | undefined;
  lockPubkey: string | undefined;
  lockPubkeyGraceSeconds: number;
  db: Pool | undefined;
  dvmId: string | undefined;
  canonicalDvmId: string | undefined;
}

/**
 * Resolves the builder-lock and Cashu accumulator opts from environment
 * variables, initializing DB tables when their prerequisites are met.
 * Extracted from serve() so DVMs that call createDVMServer directly (cast,
 * scrape) can wire Cashu and the builder admin surface without using the
 * serve() wrapper.
 *
 * @param pool - existing Postgres pool to reuse; pass undefined when no DB is available
 * @param cashuModeHint - programmatic override for cashu mode (serve()'s opts.cashuMode)
 */
export async function resolveCashuOptsFromEnv(
  env: Record<string, string>,
  pool?: Pool,
  cashuModeHint?: CashuMode
): Promise<ResolvedCashuOpts> {
  const envMaybe = env as Record<string, string | undefined>;

  // BUILDER_LOCK_PRIVKEY must never live on a DVM machine. Melting is
  // builder-local via `dvmctl melt-pending`; the DVM only ever holds the lock
  // pubkey. Fail loud at boot rather than silently degrading.
  if (envMaybe.BUILDER_LOCK_PRIVKEY) {
    throw new Error(
      "BUILDER_LOCK_PRIVKEY must not be set on a DVM machine. " +
        "The lock privkey is builder-local — use `dvmctl melt-pending` on your own machine."
    );
  }

  // Only `p2pk-accumulator` is supported. Auto-default whenever DVMKIT_CASHU_MINTS
  // is set; programmatic opts.mints callers are expected to pass `cashuModeHint`
  // explicitly if they want accumulator mode.
  const mintsConfigured = Boolean(envMaybe.DVMKIT_CASHU_MINTS);
  const cashuMode: CashuMode | undefined =
    cashuModeHint ?? (mintsConfigured ? "p2pk-accumulator" : undefined);
  if (cashuModeHint === undefined && mintsConfigured) {
    diagnosticConsole.log(
      { level: "info", message: undefined }
    );
  }

  const lockPubkey = envMaybe.DVMKIT_CASHU_LOCK_PUBKEY;
  const dvmId = envMaybe.DVMKIT_DVM_ID;
  // Lock provenance is org treasury key -> deployed DVM snapshot ->
  // `DVMKIT_CASHU_LOCK_PUBKEY`. The value is not derived from the builder's
  // identity key. The SDK uses the snapshot only to seed its per-DVM
  // `dvm_lock_pubkeys` state; the database's current key and rotation history
  // are authoritative once bootstrapped.
  // Per-DVM canonical_id. Defaults to DVMKIT_DVM_ID for
  // platform-hosted DVMs; self-hosted DVMs set DVMKIT_CANONICAL_DVM_ID to the
  // UUIDv4 they generated via `dvmctl init --self-hosted`.
  const canonicalDvmId = envMaybe.DVMKIT_CANONICAL_DVM_ID ?? dvmId;

  // Rotation grace window. Default 24h; operators tune by setting
  // `BUILDER_LOCK_PUBKEY_GRACE_SECONDS` on the DVM.
  const lockPubkeyGraceSecondsRaw = envMaybe.BUILDER_LOCK_PUBKEY_GRACE_SECONDS;
  let lockPubkeyGraceSeconds = DEFAULT_LOCK_PUBKEY_GRACE_SECONDS;
  if (lockPubkeyGraceSecondsRaw) {
    const parsed = Number(lockPubkeyGraceSecondsRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      lockPubkeyGraceSeconds = Math.floor(parsed);
    } else {
      diagnosticConsole.warn(
        {
          level: "lock_pubkey_grace_seconds_invalid",
          message: undefined,
        }
      );
    }
  }

  const missingAdminConfig = [
    ...(!lockPubkey ? ["DVMKIT_CASHU_LOCK_PUBKEY"] : []),
    ...(!dvmId ? ["DVMKIT_DVM_ID"] : []),
    ...(!pool ? ["DATABASE_URL"] : []),
  ];

  // A Lightning-funded credit can enter a blocked settlement state whose only
  // recovery path is the signed builder admin surface. Make a partial setup
  // loud at boot rather than leaving the operator to discover a 404 during an
  // incident.
  if (
    envMaybe.DVMKIT_NWC_RECEIVE_URI &&
    cashuMode !== "p2pk-accumulator" &&
    missingAdminConfig.length > 0
  ) {
    diagnosticConsole.warn(
      {
        level: "admin_surface_missing_config",
        message:
          undefined,
        missing: missingAdminConfig,
      }
    );
  }

  let db: Pool | undefined;

  if (cashuMode === "p2pk-accumulator" && missingAdminConfig.length > 0) {
    diagnosticConsole.warn(
      {
        level: "accumulator_mode_missing_config",
        message:
          undefined,
        missing: missingAdminConfig,
      }
    );
  }

  // The lock identity authenticates every builder admin route, not only the
  // Cashu accumulator routes. Bootstrap it whenever its own three
  // prerequisites are present. `seedLockPubkeyState` deliberately tolerates a
  // missing wallet_accumulator table, so Lightning-only boots retain the same
  // idempotent rotation semantics without creating accumulator storage.
  if (lockPubkey && dvmId && pool) {
    db = pool;
    try {
      if (cashuMode === "p2pk-accumulator") {
        await initWalletAccumulatorTable(db);
      }
      await initLockPubkeyTable(db);
      // `dvmId` scopes the persisted lock state to this DVM. First-boot
      // seeding is idempotent, so a stale environment snapshot on a later
      // redeploy cannot roll back the database's current key or rotation
      // history.
      await seedLockPubkeyState(db, dvmId, lockPubkey);
    } catch (err) {
      diagnosticConsole.error(
        {
          level:
            cashuMode === "p2pk-accumulator"
              ? "accumulator_table_init_failed"
              : "admin_lock_table_init_failed",
          error: undefined,
        }
      );
      if (cashuMode === "p2pk-accumulator") throw err;
      db = undefined;
    }
  }

  return { cashuMode, lockPubkey, lockPubkeyGraceSeconds, db, dvmId, canonicalDvmId };
}
