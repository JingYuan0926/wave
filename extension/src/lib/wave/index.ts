/**
 * The single bridge between the phone UI and the root WAVE code. Screens import from this file,
 * so they do not reach into the root lib folder.
 */

export { ApiError, api, explorerTxUrl, isOffline } from "@/lib/api-client";
export { CREATE_SIGNAL, ETH_TOKEN, WORLD_ACTION } from "@/lib/api-types";
export type {
  AccountResponse,
  ActivityItem,
  Address,
  AgentOperationView,
  AgentPassDevice,
  AgentSpendResponse,
  AgentView,
  AgentsResponse,
  DevIdentity,
  FrameView,
  Hex,
  InfoResponse,
  MethodRef,
  MethodView,
  PendingAction,
  PlanOwner,
  Rejection,
  TokenInfo,
  TxAction,
  TxPrepared,
  WalletPlan,
  WorldConfig,
  WorldProof,
  WorldRpContextResponse,
  WorldVerifyRequest,
} from "@/lib/api-types";

export {
  ensureIdentity,
  findPasskey,
  getPasskey,
  recoveryIdentityOf,
  savePasskey,
  setWallet,
  resetLocal,
  useLocalState,
} from "@/lib/ui/local";
export type { LocalState, LocalWallet, PasskeyName } from "@/lib/ui/local";
export { enrolPasskey, passkeysSupported, signWithPasskey } from "@/lib/ui/passkey";
export type { EnrolledPasskey } from "@/lib/ui/passkey";
export { REASONS, explainAgentRejection, explainRejection } from "@/lib/ui/rejections";
export {
  changeTiming,
  compareRules,
  dailyDirection,
  freePasskeySlot,
  joinDirections,
  saveLine,
} from "@/lib/ui/rules";
export { methodLabel, nameFor, plainName } from "./names";
export type { MethodChoice } from "@/lib/ui/rules";
export { delayText, formatCountdown, formatDuration, parseTokenAmount, plainAmount, shortHex } from "@/lib/ui/format";
export { agentTier, aloneUnits, limitProblems, limitSummary } from "@/lib/ui/agents";
export {
  canUseLimit,
  dailyStop,
  defaultForm,
  fitForm,
  formDailyLimit,
  formIsValid,
  formProblems,
  formSends,
  formSummary,
  formTiers,
  leftToday,
  liveDaily,
  readForm,
  sameForm,
} from "@/lib/ui/limits";
export type { LimitForm, LimitMethod } from "@/lib/ui/limits";
export { proofFromIdkit } from "@/lib/ui/world";

export { useWaveData } from "./data";
export type { WaveData } from "./data";
export {
  errorText,
  passkeyCardId,
  passkeyErrorText,
  runErrorText,
  testToken,
  toAgent,
  toCards,
  toPending,
  toTx,
  toWallet,
  visibleActivity,
  visibleBalances,
} from "./map";
export type { AgentNames } from "./map";
export { recipientProblem, spendRule, tokenBalance, tokenRules } from "./send";
export { isWaiting, operationsOf } from "./agents";
export { WORLD_ID_SIMULATOR_URL, anyMethod, rankChoices, requireMethod, useApproval } from "./approve";
export type { Approval, ApprovalContext, ApprovalStage } from "./approve";
export {
  CONFIG_DELAY,
  RECOVERY_DELAY,
  limitChoices,
  limitView,
  ownerLimitName,
  ownerName,
  recoveryWait,
} from "./settings";
export type { LimitChoice, LimitView } from "./settings";

/* ---------- No screen yet ---------- */

// These WAVE functions have no control in the phone UI. They stay here for the fixes that come
// later.
//
// These run as a TxAction through useApproval, and they need no helper here:
// - `remove-passkey`, and `set-tiers` for limits.
// - The agent ops `revoke`, `withdraw` and `set-key`.

// Rule helpers with no screen yet.
export { matchTier, recoveryChoices, tierAmountError } from "@/lib/ui/rules";
export type { RulesChange } from "@/lib/ui/rules";
export { ruleSentences } from "@/lib/ui/limits";

export { startFallback, approveFallback, agentPassStart, agentPassStatus } from "./later";
