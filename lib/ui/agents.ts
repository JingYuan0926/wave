import { AGENT_METHOD_MASK, type Tier, type TokenInfo } from "@/lib/api-types";
import { parseTokenAmount } from "./format";
import { tierAmountError } from "./rules";

const DAY = 86400;

export type LimitDraft = { perTransfer: string; perDay: string };

/** The problem with a draft, or null. An empty daily limit means no daily limit. */
export function limitError(draft: LimitDraft, token: TokenInfo): string | null {
  return tierAmountError(draft.perTransfer, token, false) ?? tierAmountError(draft.perDay, token, true);
}

/** One spending tier for the agent key, with no delay. Call this after limitError returns null. */
export function agentTier(draft: LimitDraft, token: TokenInfo): Tier {
  const amount = (text: string) => parseTokenAmount(text, token.decimals).value ?? BigInt(0);
  const cap = draft.perDay.trim() ? amount(draft.perDay) : BigInt(0);
  return {
    upTo: amount(draft.perTransfer).toString(),
    cap: cap.toString(),
    delay: 0,
    period: cap > BigInt(0) ? DAY : 0,
    methods: AGENT_METHOD_MASK,
    small: false,
  };
}
