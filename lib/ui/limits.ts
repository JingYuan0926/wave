import { shapeTiers } from "@/lib/limits";
import { NO_LIMIT } from "@/lib/policy";
import {
  OWNER_METHOD_MASK,
  type DailyView,
  type PlanSends,
  type Tier,
  type TierView,
  type TokenInfo,
} from "@/lib/api-types";
import { formatDuration, formatPeriod, formatTime, parseTokenAmount, plainAmount } from "./format";
import { tierAmountError } from "./rules";

/** One method on the form. In Settings the ID is the method's bit. At creation it is the row. */
export type LimitMethod = {
  id: string;
  name: string;
  owner: boolean;
  /** False for a synced passkey that is not the owner. It cannot approve any amount. */
  full: boolean;
  /** Why a method cannot be the last method in a rule. */
  note?: string;
};

export type LimitForm = {
  choice: "every" | "limit";
  every: string;
  amount: string;
  /** The hard total per 24 hours, for both choices. Empty means no daily limit. */
  perDay: string;
  lower: string;
  upper: string;
};

export type LimitProblems = { amount: string | null; perDay: string | null };

const ownerOf = (methods: LimitMethod[]) => methods.find((method) => method.owner) ?? methods[0];
const nameOf = (id: string, methods: LimitMethod[]) => methods.find((method) => method.id === id)?.name ?? "no method";

/** The methods that can approve any amount. */
export const fullMethods = (methods: LimitMethod[]) => methods.filter((method) => method.full);

/** A method can sit below the limit only if another method can approve above the limit. */
export const lowerChoices = (methods: LimitMethod[]) =>
  methods.filter((method) => fullMethods(methods).some((upper) => upper.id !== method.id));

export const canUseLimit = (methods: LimitMethod[]) => lowerChoices(methods).length > 0;

/** Keeps a form valid when the methods change. No pick can name a method that is gone. */
export function fitForm(form: LimitForm, methods: LimitMethod[]): LimitForm {
  const owner = ownerOf(methods);
  const full = fullMethods(methods);
  const every = full.some((method) => method.id === form.every) ? form.every : owner.id;
  if (!canUseLimit(methods)) return { ...form, choice: "every", every };
  const upper = full.some((method) => method.id === form.upper) ? form.upper : owner.id;
  const lowers = lowerChoices(methods).filter((method) => method.id !== upper);
  const lower = lowers.some((method) => method.id === form.lower) ? form.lower : lowers[lowers.length - 1].id;
  return { ...form, every, lower, upper };
}

export function defaultForm(methods: LimitMethod[], amount: string): LimitForm {
  return fitForm({ choice: "limit", every: "", amount, perDay: "", lower: "", upper: "" }, methods);
}

/** Picks a method below the limit. Picking the upper method swaps the two. */
export function pickLower(form: LimitForm, id: string, methods: LimitMethod[]): LimitForm {
  if (id !== form.upper) return { ...form, lower: id };
  const old = methods.find((method) => method.id === form.lower);
  const other = fullMethods(methods).find((method) => method.id !== id);
  return fitForm({ ...form, lower: id, upper: old?.full ? form.lower : (other?.id ?? "") }, methods);
}

/** Picks a method above the limit. Picking the lower method swaps the two. */
export function pickUpper(form: LimitForm, id: string, methods: LimitMethod[]): LimitForm {
  return fitForm({ ...form, upper: id, lower: id === form.lower ? form.upper : form.lower }, methods);
}

const baseUnits = (text: string, token: TokenInfo) => parseTokenAmount(text, token.decimals).value ?? BigInt(0);

export function formProblems(form: LimitForm, token: TokenInfo): LimitProblems {
  if (form.choice === "every") return { amount: null, perDay: tierAmountError(form.perDay, token, true) };
  const amount = baseUnits(form.amount, token);
  const amountError =
    tierAmountError(form.amount, token, false) ??
    (amount === BigInt(0) ? "Enter an amount above 0." : amount >= NO_LIMIT ? "This amount is too large." : null);
  const perDayError =
    tierAmountError(form.perDay, token, true) ??
    (form.perDay.trim() && !amountError && baseUnits(form.perDay, token) < amount
      ? `Enter at least ${form.amount.trim()} ${token.symbol}, or leave this empty.`
      : null);
  return { amount: amountError, perDay: perDayError };
}

export const formIsValid = (form: LimitForm, token: TokenInfo) => {
  const { amount, perDay } = formProblems(form, token);
  return amount === null && perDay === null;
};

/** The rule that a form builds. Settings only: a method ID there is the method's bit. */
export function formTiers(form: LimitForm, methods: LimitMethod[], token: TokenInfo): Tier[] {
  const lower = methods.find((method) => method.id === form.lower);
  const shape =
    form.choice === "every"
      ? ({ kind: "every", method: Number(form.every) } as const)
      : ({
          kind: "limit",
          amount: baseUnits(form.amount, token),
          lower: Number(form.lower),
          upper: Number(form.upper),
          lowerSynced: lower ? !lower.full : false,
        } as const);
  return shapeTiers(shape).map((tier) => ({
    ...tier,
    upTo: tier.upTo.toString(),
    cap: tier.cap.toString(),
  }));
}

/** The hard daily total of a form, in base units. "0" means no limit. */
export const formDailyLimit = (form: LimitForm, token: TokenInfo): string => baseUnits(form.perDay, token).toString();

/** The creation choice for a plan. `indexOf` gives the plan index of a row. */
export function formSends(form: LimitForm, indexOf: (id: string) => number, token: TokenInfo): PlanSends {
  const perDay = form.perDay.trim() ? formDailyLimit(form, token) : null;
  if (form.choice === "every") return { kind: "every", method: indexOf(form.every), perDay };
  return {
    kind: "limit",
    amount: baseUnits(form.amount, token).toString(),
    perDay,
    lower: indexOf(form.lower),
    upper: indexOf(form.upper),
  };
}

/**
 * The form for a live rule. Null means that the rule has a shape the two choices cannot show:
 * a delay, a total on a step, three steps, a step with no owner method, or a rule with no approver
 * above the last amount. A removed method keeps its bit in a rule, and that bit does not count.
 * `dailyLimit` is the live hard total in base units. "0" means no limit.
 */
export function readForm(tiers: Tier[], methods: LimitMethod[], token: TokenInfo, dailyLimit = "0"): LimitForm | null {
  const perDay = dailyLimit === "0" ? "" : plainAmount(dailyLimit, token.decimals);
  const base = { amount: "", perDay, every: "", lower: "", upper: "" };
  const owner = ownerOf(methods);
  if (tiers.length === 0) return fitForm({ ...base, choice: "every", every: owner.id }, methods);
  const enrolled = methods.reduce((mask, method) => mask | Number(method.id), 0);
  /** The method that a step names next to the owner method, or the owner method alone. */
  const picked = (mask: number) => {
    const live = mask & enrolled;
    if ((live & OWNER_METHOD_MASK) === 0) return null;
    const other = live & ~OWNER_METHOD_MASK;
    return other === 0 ? owner : (methods.find((method) => Number(method.id) === other) ?? null);
  };
  const open = (tier: Tier) => BigInt(tier.upTo) >= NO_LIMIT && tier.cap === "0" && tier.delay === 0;
  const everyForm = (id: string) => fitForm({ ...base, choice: "every", every: id }, methods);
  if (tiers.length === 1) {
    const method = picked(tiers[0].methods);
    return open(tiers[0]) && method?.full ? everyForm(method.id) : null;
  }
  if (tiers.length !== 2) return null;
  const [first, last] = tiers;
  const upper = picked(last.methods);
  const lower = picked(first.methods);
  if (!open(last) || !upper?.full || !lower) return null;
  if (first.delay !== 0 || first.cap !== "0" || BigInt(first.upTo) >= NO_LIMIT) return null;
  // After a removal, both steps can name one method.
  if (lower.id === upper.id) return everyForm(upper.id);
  return {
    ...base,
    choice: "limit",
    amount: plainAmount(first.upTo, token.decimals),
    lower: lower.id,
    upper: upper.id,
  };
}

export function sameForm(a: LimitForm, b: LimitForm, token: TokenInfo): boolean {
  if (a.choice !== b.choice || baseUnits(a.perDay, token) !== baseUnits(b.perDay, token)) return false;
  if (a.choice === "every") return a.every === b.every;
  return a.lower === b.lower && a.upper === b.upper && baseUnits(a.amount, token) === baseUnits(b.amount, token);
}

/** The owner method is in each step, so a large send keeps an approver if a method is removed. */
function ownerLine(form: LimitForm, methods: LimitMethod[]): string[] {
  const owner = methods.find((method) => method.owner);
  if (!owner) return [];
  if (form.choice === "every") return form.every === owner.id ? [] : [`${owner.name} can also approve every send.`];
  if (form.lower === owner.id) return [`${owner.name} can also approve above the limit.`];
  if (form.upper === owner.id) return [`${owner.name} can also approve up to the limit.`];
  return [`${owner.name} can also approve any amount.`];
}

/** The hard daily total, in the words that the owner reads. `value` holds the amount and the symbol. */
const dailyLine = (value: string) =>
  `Most you can send per day: ${value}. After that, no method can send until the 24 hours end.`;

/** The live summary above Save. */
export function formSummary(form: LimitForm, methods: LimitMethod[], token: TokenInfo): string[] {
  const { amount, perDay } = formProblems(form, token);
  const daily = form.perDay.trim() && !perDay ? [dailyLine(`${form.perDay.trim()} ${token.symbol}`)] : [];
  if (form.choice === "every") {
    return [`Every send: ${nameOf(form.every, methods)}.`, ...daily, ...ownerLine(form, methods)];
  }
  if (amount) return ["Enter a limit to see what happens."];
  const value = `${form.amount.trim()} ${token.symbol}`;
  const upper = nameOf(form.upper, methods);
  return [`Sends up to ${value}: ${nameOf(form.lower, methods)}. Above ${value}: ${upper}.`, ...daily, ...ownerLine(form, methods)];
}

/** The window ends with no new read from the chain, so a page that stays open shows the full limit. */
export function liveDaily(daily: DailyView | null | undefined, now: number): DailyView | null {
  if (!daily) return null;
  if (daily.resetsAt === null || now === 0 || now < daily.resetsAt) return daily;
  return { ...daily, spent: "0", left: daily.limit, resetsAt: null };
}

export const leftToday = (daily: DailyView, token: TokenInfo) =>
  `${plainAmount(daily.left, token.decimals)} ${token.symbol} left today`;

/** Why a send must stop before any approval, or null if the amount fits. */
export function dailyStop(daily: DailyView | null, amount: bigint, token: TokenInfo): string | null {
  if (!daily || amount <= BigInt(daily.left)) return null;
  const left = `${plainAmount(daily.left, token.decimals)} ${token.symbol}`;
  // With no window, nothing was sent. So this one amount is above the whole limit.
  if (daily.resetsAt === null) return `This is above your daily limit. ${left} left.`;
  return `You reached your daily limit. ${left} left. It resets at ${formatTime(daily.resetsAt)}.`;
}

function maskNames(mask: number, methods: LimitMethod[]): string {
  const names = methods.filter((method) => (Number(method.id) & mask) !== 0).map((method) => method.name);
  return names.length > 0 ? names.join(" or ") : "no method";
}

/** One rule of any shape, in plain sentences. */
export function ruleSentences(tiers: TierView[], methods: LimitMethod[], token: TokenInfo, dailyLimit = "0"): string[] {
  const form = readForm(tiers, methods, token, dailyLimit);
  if (form) return formSummary(form, methods, token);
  const value = (base: string) => `${plainAmount(base, token.decimals)} ${token.symbol}`;
  const lines = tiers.map((tier, index) => {
    const open = BigInt(tier.upTo) >= NO_LIMIT;
    const from = index === 0 ? "Every send" : `Above ${value(tiers[index - 1].upTo)}`;
    const when = open ? from : `Sends up to ${value(tier.upTo)}`;
    const delay = tier.delay > 0 ? `, after ${formatDuration(tier.delay).toLowerCase()}` : "";
    const total = tier.cap !== "0" ? `, at most ${value(tier.cap)} per ${formatPeriod(tier.period)}` : "";
    return `${when}: ${maskNames(tier.methods, methods)}${delay}${total}.`;
  });
  const last = tiers[tiers.length - 1];
  if (BigInt(last.upTo) < NO_LIMIT) lines.push(`Above ${value(last.upTo)}: no method can approve. Change your limits to fix this.`);
  if (dailyLimit !== "0") lines.push(dailyLine(value(dailyLimit)));
  return lines;
}
