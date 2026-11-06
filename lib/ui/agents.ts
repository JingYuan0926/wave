import { aloneAmount } from "@/lib/limits";
import { AGENT_METHOD_MASK, type Tier, type TierView, type TokenInfo } from "@/lib/api-types";
import { parseTokenAmount, plainAmount } from "./format";
import { tierAmountError, type RulesChange } from "./rules";

const DAY = 86400;

/**
 * The two limits of an agent, as the owner types them. `alone` is the human checkpoint, which the
 * server enforces. `perDay` is the hard total, which the contract enforces.
 */
export type LimitDraft = { alone: string; perDay: string };

export type LimitProblems = { alone: string | null; perDay: string | null };

const unitsOf = (text: string, token: TokenInfo) => parseTokenAmount(text, token.decimals).value ?? BigInt(0);

/** The problem with each field. An empty field is a problem, because both limits are required. */
export function limitProblems(draft: LimitDraft, token: TokenInfo): LimitProblems {
  const alone = tierAmountError(draft.alone, token, false);
  const perDay =
    tierAmountError(draft.perDay, token, false) ??
    (unitsOf(draft.perDay, token) === BigInt(0) ? "Enter an amount above 0." : null);
  if (alone || perDay) return { alone, perDay };
  if (unitsOf(draft.alone, token) <= unitsOf(draft.perDay, token)) return { alone: null, perDay: null };
  return { alone: `This must be ${draft.perDay.trim()} ${token.symbol} or less, the most per day.`, perDay: null };
}

export function limitsValid(draft: LimitDraft, token: TokenInfo): boolean {
  const { alone, perDay } = limitProblems(draft, token);
  return alone === null && perDay === null;
}

/** The checkpoint amount in base units. Call this after limitsValid returns true. */
export const aloneUnits = (draft: LimitDraft, token: TokenInfo): bigint => unitsOf(draft.alone, token);

/**
 * The spending tier for the agent key, with no delay. One payment can use the whole daily total, so
 * a payment that a human approves can go above the alone amount, and nothing goes above the total.
 * Call this after limitsValid returns true.
 */
export function agentTier(draft: LimitDraft, token: TokenInfo): Tier {
  const total = unitsOf(draft.perDay, token).toString();
  return { upTo: total, cap: total, delay: 0, period: DAY, methods: AGENT_METHOD_MASK, small: false };
}

/** The live summary below the fields. Null until both fields are valid. */
export function limitSummary(draft: LimitDraft, token: TokenInfo): string | null {
  if (!limitsValid(draft, token)) return null;
  const [alone, perDay] = [draft.alone.trim(), draft.perDay.trim()];
  const total = `Most per day: ${perDay} ${token.symbol}.`;
  const units = aloneUnits(draft, token);
  if (units === BigInt(0)) return `Every payment: you approve with World ID. ${total}`;
  const sends = `Up to ${alone} ${token.symbol}: the agent sends alone.`;
  if (units === unitsOf(draft.perDay, token)) return `${sends} ${total}`;
  return `${sends} Above that: you approve with World ID. ${total}`;
}

/** The form values for an agent. They show what the agent can do now, also for an older shape. */
export function limitDraftOf(tier: Tier | undefined, ask: string | null, token: TokenInfo): LimitDraft {
  const text = (value: string | bigint) => plainAmount(value, token.decimals);
  if (!tier) return { alone: ask === null ? "" : text(ask), perDay: "" };
  return { alone: text(aloneAmount(tier, ask)), perDay: BigInt(tier.cap) > BigInt(0) ? text(tier.cap) : "" };
}

const unitText = (value: string | bigint, token: TokenInfo) => `${plainAmount(value, token.decimals)} ${token.symbol}`;

/** The real limits of an agent, in the words of the form. */
export function limitLines(tier: TierView, ask: string | null, token: TokenInfo): string[] {
  const alone = aloneAmount(tier, ask);
  const cap = BigInt(tier.cap);
  const left = cap - BigInt(tier.spent);
  const sends =
    alone === BigInt(0)
      ? "You approve every payment with World ID"
      : `Sends alone up to ${unitText(alone, token)}`;
  // At the top of the onchain rule, no payment can ask for approval.
  const above = alone > BigInt(0) && alone < BigInt(tier.upTo) ? ". You approve above that with World ID" : "";
  const total =
    cap > BigInt(0)
      ? `Most per day: ${unitText(cap, token)}. ${unitText(left > BigInt(0) ? left : BigInt(0), token)} left today`
      : "No most per day is set";
  return [`${sends}${above}`, total];
}

/** What an older shape does differently, or null for the two-limit shape. */
export function limitShapeNote(tier: Tier, ask: string | null, token: TokenInfo): string | null {
  const upTo = unitText(tier.upTo, token);
  if (ask !== null && BigInt(ask) > BigInt(tier.upTo)) {
    return `The saved alone amount is ${unitText(ask, token)}, but the chain stops one payment at ${upTo}. Save in Limits fixes this.`;
  }
  if (tier.upTo === tier.cap) return null;
  return `One payment can send at most ${upTo}, also when you approve. Save in Limits changes this.`;
}

/** What a save does to the alone amount. */
export type AloneStep = "none" | "applies" | "needs-approval";

/** This repeats the rule of the checkpoint route, so the page can say what will happen. */
export function aloneStep(stored: string | null, next: bigint): AloneStep {
  if (stored === null) return next === BigInt(0) ? "none" : "applies";
  if (next === BigInt(stored)) return "none";
  return next < BigInt(stored) ? "applies" : "needs-approval";
}

const ALONE_TEXT: Record<AloneStep, string | null> = {
  none: null,
  applies: "The alone amount applies at once.",
  "needs-approval": "The higher alone amount needs your approval with World ID.",
};

export function tierSaveLine(direction: RulesChange["direction"], timing: string): string | null {
  if (direction === "same") return null;
  if (direction === "stricter") return "The new onchain limit applies at once.";
  return `The new onchain limit needs the owner method. ${timing}`;
}

/** The one line above Save. `timing` says how an owner change runs on this wallet. */
export function limitSaveLine(step: AloneStep, direction: RulesChange["direction"], timing: string): string | null {
  const parts = [ALONE_TEXT[step], tierSaveLine(direction, timing)].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}
