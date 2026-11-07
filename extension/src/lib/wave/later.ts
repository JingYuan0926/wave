import { api } from "@/lib/api-client";
import type { Address, Hex, RecoveryChange, TxAction } from "@/lib/api-types";

/**
 * Thin helpers for WAVE functions that have no control in the phone UI. Nothing here sends a
 * transaction alone. A fallback action still needs useApproval and recoveryChoices.
 */

/** Fallback recovery: one device-bound method proposes the change. */
export const startFallback = (change: RecoveryChange): TxAction => ({ kind: "propose-recovery", change });

/** Fallback recovery: a second device-bound method approves the change. */
export const approveFallback = (actionId: Hex): TxAction => ({ kind: "approve-recovery", actionId });

/** The Agent Pass test: a mint of 1 test USDC through the browser flow. */
export const agentPassStart = (wallet: Address) => api.agentPassStart(wallet);

/** The Agent Pass setup and the state of one attempt. */
export const agentPassStatus = (attemptId: string | null) => api.agentPassStatus(attemptId);
