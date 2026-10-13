// Server-only half of the unstable internal entry point. Keeping these exports in their own build
// entry lets caller bundles discard Hono, PostgreSQL, Undici and facilitator implementations.

export { settleWithFacilitator, verifyWithFacilitator } from "../../lib/x402/facilitator-request";
export { verifyX402Payment } from "../../lib/x402/verify";

// src/sdk/server/admin-cashu.ts
export { createAdminCashuNonceStore, installAdminCashuRoutes } from "../server/admin-cashu";

// src/sdk/server/app.ts
export {
  type AppEnv,
  type ReporterBannerOpts,
  type RevenueBootCheckOpts,
  type SDKServerOpts,
  assertRevenueReporterReady,
  createDVMServer,
  revenueReporterBannerState,
  unknownRouteNotFound,
} from "../server/app";

// src/sdk/server/btc-rate.ts
export { rateUnavailablePaymentError } from "../server/btc-rate";

// src/sdk/server/credit-lots.ts
export {
  type FundingLot,
  type LotDebit,
  type LotDepletion,
  NON_CHANNEL_BITCOIN_RAILS,
  type NonChannelBitcoinRail,
  depleteLots,
  fifoOrder,
  inKindDrawMsats,
  isInKindDepletion,
  isNonChannelBitcoinRail,
  lotOwedSats,
  netOwedSats,
} from "../server/credit-lots";

// src/sdk/server/credit-menu.ts
export { toCreditTerms } from "../server/credit-menu";

// src/sdk/server/funding.ts
export {
  type FiatDenomination,
  type FiatDenominationFailure,
  type ResolvedFx,
  derivedFundCreditId,
  fundedMicroFor,
  implicitCreditId,
  isDerivedCreditId,
  msatsToFiatMicro,
  pinAskFiat,
  priceFiatMicro,
  resolveFxSnapshot,
  resolvePriceFiat,
  x402RequiredUsdcMicro,
  x402SettledShare,
} from "../server/funding";

// src/sdk/server/instrumented-fetch.ts
export { createInstrumentedFetch } from "../server/instrumented-fetch";

// src/sdk/server/job-credential.ts
export { jobCredentialGate } from "../server/job-credential";

// src/sdk/server/job-store.ts
export { type OutgoingMessage, type StaleJobReapable, isStaleJobReapable } from "../server/job-store";

// src/sdk/server/job.ts
export {
  JobCancelledError,
  type ServerJob,
  abortJob,
  fromJobRecord,
  isTerminal,
  isYieldMessage,
  providerMessage,
  toJobRecord,
} from "../server/job";

// src/sdk/server/lock-pubkey-store.ts
// `LockPubkey` and `toLockPubkey` are aliased: this module re-exports the very symbols
// `lib/cashu/lock-pubkey.ts` exports from the caller half, and one name cannot be exported twice.
export {
  initLockPubkeyTable,
  seedLockPubkeyState,
  DEFAULT_LOCK_PUBKEY_GRACE_SECONDS,
  loadLockPubkeyState,
  rotateLockPubkey,
  toLockPubkey as lockPubkeyStoreToLockPubkey,
  type LockPubkey as LockPubkeyStoreLockPubkey,
  type LockPubkeyPool,
  type LockPubkeyState,
  type LockPubkeyStateLoader,
  type Pool,
  activePubkeySet,
  pruneRetired,
} from "../server/lock-pubkey-store";

// src/sdk/server/mint-health-tracker.ts
export { MintHealthTracker } from "../server/mint-health-tracker";

// src/sdk/server/mpp-setup.ts
export { _testing, wrapMppx, type MppxServer } from "../server/mpp-setup";

// src/sdk/server/payment.ts
export {
  type CreditFundingReport,
  type FundOnlyRequest,
  type IncomingPaymentOpts,
  PAYMENT_PROOF_KEYS,
  type PaymentErrorCode,
  type PaymentErrorDetail,
  type PaymentInfo,
  type ShortPayForfeit,
  type TempoChannelReport,
  TempoSessionChannelMismatchError,
  type UpfrontPaymentOpts,
  type VerifiedIncomingPayment,
  type VerifyIncomingSnapshot,
  applyPaymentInfoToJob,
  buildPaymentErrorResponse,
  creditDepositPayload,
  devModeSkipsPaymentVerification,
  hasPaymentProof,
  issueUpfrontChallenges,
  paymentErrorBody,
  processIncomingPayment,
  repairX402ExactSettlementEffect,
  verifyIncomingPayment,
  verifyTempoSessionManagementCredential,
  verifyUpfrontPayment,
} from "../server/payment";

// src/sdk/server/payout-reporter.ts
export { PayoutReporter, type X402TrackedChannel } from "../server/payout-reporter";

// src/sdk/server/revenue-reporter.ts
export {
  type CreditDepositPayload,
  type CreditDrainPayload,
  RevenueReporter,
} from "../server/revenue-reporter";

// src/sdk/server/signed-request.ts
export {
  SIGNED_ENVELOPE_FIELDS,
  SIGNED_ENVELOPE_TYPES,
  createDefaultReplayStore,
} from "../server/signed-request";

// src/sdk/server/tempo-charge-store.ts
export { PostgresTempoChargeStore } from "../server/tempo-charge-store";

// src/sdk/server/tempo-close-event.ts
export {
  TEMPO_CLOSE_REQUESTED_TOPIC,
  TEMPO_CLOSE_DB_RECOVERY_BUDGET_MS,
} from "../server/tempo-close-event";

// src/sdk/server/tempo-observer-health.ts
export { type TempoObserverHealth } from "../server/tempo-observer-health";

// src/sdk/server/tempo-session-store.ts
export { PostgresTempoSessionStore } from "../server/tempo-session-store";

// src/sdk/server/wallet-accumulator-store.ts
export {
  clearAccumulatorForDvm,
  initWalletAccumulatorTable,
  insertAccumulatorRows,
  type AccumulatorPool,
  hashLockKey,
} from "../server/wallet-accumulator-store";

// src/sdk/server/x402-batch-settlement.ts
export {
  type X402BatchChannelObservation,
  type X402SettlementEvidenceOutcome,
  type X402SettlementRepair,
  type X402SettlementRepairRefusal,
  type X402SettlementRepaired,
  type X402WedgedSettlement,
  type X402WedgedSettlementPage,
  X402_BATCH_SETTLEMENT_MAINNET_NETWORK,
} from "../server/x402-batch-settlement";

// src/sdk/server/x402-facilitator-support.ts
export { X402FacilitatorHealth } from "../server/x402-facilitator-support";

// src/sdk/server/zod-error.ts
export { humanizeZodError } from "../server/zod-error";
