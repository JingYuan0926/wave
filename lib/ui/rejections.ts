import type { AgentPassReason, Rejection } from "@/lib/api-types";

type Explanation = { title: string; detail: string };

/** Why a World ID approval did not pass. */
export const REASONS: Record<AgentPassReason, string> = {
  cancelled: "You cancelled at World ID. The action did not run.",
  expired: "The approval window ended. The action did not run.",
  identity_mismatch: "A different World ID signed in. This wallet is linked to another identity. The action did not run.",
  unsupported_assurance: "World ID did not give an accepted Orb result for this attempt. The action did not run.",
  invalid_token: "The response from World ID failed a check. The action did not run.",
  replayed: "This approval was used before, or the action ended. It ran nothing.",
  rate_limited: "World ID limits requests now. The action did not run. Wait, then ask for a new code.",
  provider_error: "World ID or the chain failed, so this attempt is a refusal.",
};

/** Plain text for each custom error and each validation failure. */
const EXPLANATIONS: Record<string, Explanation> = {
  // Custom errors from contracts/src.
  MethodNotAllowed: {
    title: "This method cannot approve this",
    detail: "Your limits name another method for this amount.",
  },
  SyncedNotAllowed: {
    title: "A synced passkey cannot approve this",
    detail: "A synced passkey cannot approve this amount. Use your stronger method.",
  },
  NeedsSchedule: {
    title: "This transfer must wait",
    detail: "The rule for this amount has a delay, so the transfer must go through the queue.",
  },
  NeedsQueue: {
    title: "This call must go through the queue",
    detail: "Only plain transfers can run at once. Other calls wait in the queue.",
  },
  DailyLimitReached: {
    title: "You reached your daily limit",
    detail: "No method can send more of this token until the 24 hours end. Send less, or wait. Nothing was sent.",
  },
  NoTier: {
    title: "Your limits do not allow this amount",
    detail: "Change your limits in Settings, send less, or wait for your daily limit to reset.",
  },
  OnlyOwnerMethod: {
    title: "This action needs the owner method",
    detail: "Only the owner method can do this.",
  },
  NotStricter: {
    title: "These limits are not stricter",
    detail: "A looser change needs the owner method.",
  },
  BadTiers: {
    title: "These limits are not valid",
    detail: "Each limit must be at or above the one before it.",
  },
  SenderFrameNotAllowed: {
    title: "Rejected at validation",
    detail: "A frame called a function that is not an allowed entry point. Configuration changes must go through the queue.",
  },
  SelfCall: {
    title: "The wallet cannot call itself",
    detail: "Configuration changes must go through the queue.",
  },
  NotSchedulable: {
    title: "This call cannot be queued",
    detail: "The queue rejected this target or function.",
  },
  StaleVersion: {
    title: "This action is out of date",
    detail: "The account configuration changed after this action was queued.",
  },
  RuleChanged: {
    title: "The rule for this token changed",
    detail: "The owner tightened the rule after this transfer was queued, so it cannot run.",
  },
  TooEarly: {
    title: "The delay is not over",
    detail: "Wait for the countdown to end, then try again.",
  },
  NotScheduled: {
    title: "This action is not in the queue",
    detail: "It ran, or someone cancelled it.",
  },
  BadStatus: {
    title: "This action cannot change now",
    detail: "It already ran, or someone cancelled it.",
  },
  BadRecovery: {
    title: "This recovery is not valid",
    detail: "A recovery holds exactly one owner, owner passkey or root source change.",
  },
  NotEnrolled: {
    title: "This method is not enrolled",
    detail: "Add the method in Settings first.",
  },
  ProofInvalid: {
    title: "The World ID proof is not valid",
    detail: "The proof does not verify for this transaction.",
  },
  Unauthorized: {
    title: "This caller is not allowed",
    detail: "The account accepts this call only from itself.",
  },
  ValidationFailed: {
    title: "Rejected at validation",
    detail: "The account did not approve this transaction.",
  },
  FeeTooHigh: {
    title: "The gas fee is above the wallet's limit",
    detail: "The wallet refuses a high fee, so a stolen method cannot burn its ETH as gas.",
  },
  FailedCall: {
    title: "The transfer failed",
    detail: "The wallet could not pay the amount. Send less, or use Fund.",
  },
  StaleNonce: {
    title: "This approval is out of date",
    detail: "Another transaction from this method ran first. Nothing was sent. Start again to build a new one.",
  },
  AlreadyApproved: {
    title: "This method already approved",
    detail: "A recovery needs two different methods. Approve with a second one.",
  },
  ZeroValue: {
    title: "This value is not valid",
    detail: "The new owner or root source cannot be zero.",
  },
  LimitChanged: {
    title: "A limit changed after the request",
    detail: "WAVE sent nothing, because you approved the old limits. The agent must ask again.",
  },
  IdentityChanged: {
    title: "Another World ID is linked now",
    detail: "WAVE sent nothing. The agent must ask again.",
  },
  SendFailed: {
    title: "The server failed before the send",
    detail: "The approval is used, so nothing retries this. The agent must ask again.",
  },
  AgentPaused: {
    title: "This agent wallet is paused",
    detail: "The main wallet paused it. No agent spend can run until the owner unpauses it.",
  },
  AgentRevoked: {
    title: "This agent has no key",
    detail: "The main wallet revoked the agent key. The owner must set a new key.",
  },
  AgentKeyMismatch: {
    title: "The server does not hold this agent's key",
    detail: "The chain names another key. Set WAVE_AGENT_DEMO_KEY to that key, or replace the agent key.",
  },
  NotMaster: {
    title: "Only the main wallet can do this",
    detail: "An agent wallet accepts administration only from its own main wallet.",
  },
  AlreadySetUp: {
    title: "This agent wallet is already set up",
    detail: "An agent wallet takes its first key and rules once. Use the limits or replace the key.",
  },
  WithdrawFailed: {
    title: "The withdrawal failed",
    detail: "The agent wallet could not pay this amount. Withdraw less.",
  },
  // Codes that the route sets. Validators return APPROVE_NONE with no error data.
  NullifierMismatch: {
    title: "A different human tried to approve",
    detail: "The World ID nullifier does not match the owner of this account.",
  },
  RootNotCommitted: {
    title: "The World ID root is not published",
    detail: "The transaction does not reference this root.",
  },
  RootSourceMismatch: {
    title: "The World ID root has the wrong source",
    detail: "The account accepts roots only from its pinned source.",
  },
  InsufficientFunds: {
    title: "Not enough funds",
    detail: "The wallet does not hold enough. If it pays its own gas, an ETH transfer must leave room for that. Use Fund, or send less.",
  },
  // Codes from the local gas sponsor.
  SponsorLimit: {
    title: "The daily gas budget is used up",
    detail: "The sponsor pays for a limited number of transactions per wallet per day. Try again tomorrow (UTC).",
  },
  SponsorEmpty: {
    title: "The gas sponsor is out of funds",
    detail: "The gas station cannot pay for this transaction. Fund the station or deploy the contracts again.",
  },
  SponsorFeeCap: {
    title: "The gas sponsor refused this fee",
    detail: "The fee or the gas limit of this transaction is above the sponsor's cap.",
  },
  SponsorShape: {
    title: "The gas sponsor refused this transaction",
    detail: "The sponsor pays only for WAVE wallets, in the frame order that the app builds.",
  },
  NotSponsored: {
    title: "The gas station refused this transaction",
    detail: "The transaction has no valid signature from the sponsor.",
  },
};

const STAGE_TEXT: Record<Rejection["stage"], string> = {
  prepare: "The server rejected this before signing.",
  sponsor: "The gas sponsor rejected this. Nothing was sent.",
  simulate: "The simulation rejected this. Nothing was sent.",
  sidecar: "The mempool rejected this. Nothing was mined.",
  chain: "The chain rejected this.",
};

export function explainRejection(rejection: Rejection): Explanation & { stage: string } {
  const known = EXPLANATIONS[rejection.code];
  return {
    title: known?.title ?? `Rejected: ${rejection.code}`,
    detail: known?.detail ?? rejection.message ?? "The chain gave no more detail.",
    stage: STAGE_TEXT[rejection.stage],
  };
}

/** The general text sends the owner to Settings. The limits of an agent are on its own card. */
export function explainAgentRejection(rejection: Rejection): Explanation & { stage: string } {
  const text = explainRejection(rejection);
  if (rejection.code !== "NoTier") return text;
  return {
    ...text,
    title: "This is above the agent's onchain limit",
    detail:
      "The contract refused this. It does not fit in the most per day, or it is above what one payment can send. " +
      "A World ID approval cannot change this. Nothing was sent.",
  };
}
