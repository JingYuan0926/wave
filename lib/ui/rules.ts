import type {
  Address,
  MethodRef,
  MethodView,
  PasskeySlot,
  PendingAction,
  Tier,
  TierView,
  TokenInfo,
  TokenRules,
  WorldConfig,
} from "@/lib/api-types";
import { OWNER_METHOD_MASK, PASSKEY_SLOTS } from "@/lib/api-types";
import { formatDuration, formatPeriod, parseTokenAmount, plainAmount } from "./format";
import { findPasskey, type LocalPasskey, type LocalState } from "./local";

export const WORLD_ID: MethodRef = { kind: "world" };

/** The largest amount in a tier. The contract stores it in 96 bits. */
const UINT96_MAX = (BigInt(1) << BigInt(96)) - BigInt(1);

/** Above the gas limit of a World ID send that also deploys, at the fee the app signs. */
export const ETH_GAS_RESERVE = BigInt("12000000000000000");

/** The name that the owner knows a method by: "Security key", "Passkey 1" or "World ID". */
export function plainName(
  view: MethodView,
  wallet: { address: Address } | null,
  local: LocalState | null,
  world?: WorldConfig | null,
): string {
  const held = view.ref.kind === "passkey" && wallet && local ? findPasskey(local, wallet.address, view.ref.slot) : null;
  return nameFor(view.ref, held, world);
}

export function sameMethod(a: MethodRef, b: MethodRef): boolean {
  if (a.kind === "passkey" && b.kind === "passkey") return a.slot === b.slot;
  return a.kind === b.kind;
}

export function maskHas(mask: number, view: MethodView): boolean {
  return (mask & view.mask) !== 0;
}

/** A test identity must never read as a real World ID. */
export function methodLabel(ref: MethodRef, world?: WorldConfig | null): string {
  if (ref.kind === "passkey") return `Passkey ${ref.slot}`;
  if (ref.kind === "agent") return "Agent key";
  return world?.mode === "dev" ? "Test identity" : "World ID";
}

/** A security key has its own name in this browser. The chain sees a passkey. */
export const nameFor = (ref: MethodRef, passkey?: LocalPasskey | null, world?: WorldConfig | null): string =>
  passkey?.name === "security-key" ? "Security key" : methodLabel(ref, world);

/** Text for one enrolled method, for example "Passkey 1 (synced)". */
export function methodDetail(view: MethodView, world?: WorldConfig | null, name?: string): string {
  const label = name ?? methodLabel(view.ref, world);
  const notes = [
    ...(view.owner ? ["owner method"] : []),
    ...(view.backup ? [view.backup] : []),
    ...(view.ref.kind === "world" && world?.mode === "dev" ? ["not a real World ID"] : []),
  ];
  return notes.length > 0 ? `${label} (${notes.join(", ")})` : label;
}

/**
 * Who can act on a recovery. The account accepts only device-bound methods other than the owner method.
 * `approved` lists the methods that already count: the account adds nothing for them.
 */
export function recoveryChoices(
  methods: MethodView[],
  world: WorldConfig | null | undefined,
  approved: MethodRef[] = [],
): MethodChoice[] {
  return methods.map((view) => {
    if (view.owner) {
      return { view, allowed: false, reason: `${methodLabel(view.ref, world)} is the owner method. It cannot run a recovery.` };
    }
    if (view.backup === "synced") {
      return { view, allowed: false, reason: "A synced passkey cannot run a recovery." };
    }
    if (approved.some((ref) => sameMethod(ref, view.ref))) {
      return { view, allowed: false, reason: "This method already approved. Use a second one." };
    }
    return { view, allowed: true };
  });
}

/**
 * The first slot with no passkey and no queued install. A second install in a
 * queued slot would replace the stored credential of the first install.
 */
export function freePasskeySlot(methods: MethodView[], pending: PendingAction[]): PasskeySlot | null {
  for (const slot of PASSKEY_SLOTS) {
    const queued = pending.some(
      (action) => action.status !== "stale" && action.decoded.title === `Add passkey in slot ${slot}`,
    );
    if (!queued && !methods.some((m) => sameMethod(m.ref, { kind: "passkey", slot }))) return slot;
  }
  return null;
}

export type MethodChoice = {
  view: MethodView;
  allowed: boolean;
  /** The reason a method is not allowed. */
  reason?: string;
};

export type SpendRule = {
  /** default: the token has no tiers. tier: a tier applies. none: no tier fits. */
  kind: "default" | "tier" | "none";
  tierIndex: number | null;
  tier: TierView | null;
  delay: number;
  choices: MethodChoice[];
  summary: string;
};

/**
 * Find the tier for a transfer, in the way the account does. A tier fits if
 * the amount is under its upper amount and its period cap has room. A full
 * cap moves the transfer to the next tier.
 */
export function matchTier(
  tiers: TierView[],
  amount: bigint,
): { tier: TierView; index: number } | null {
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    if (amount > BigInt(tier.upTo)) continue;
    const cap = BigInt(tier.cap);
    if (cap > BigInt(0) && BigInt(tier.spent) + amount > cap) continue;
    return { tier, index };
  }
  return null;
}

const orJoin = (names: string[]) => names.join(" or ");

/** Tell the owner which method this amount needs. `nameOf` gives each method its plain name. */
export function describeSpend(
  rules: TokenRules | undefined,
  amount: bigint,
  methods: MethodView[],
  nameOf: (view: MethodView) => string = (view) => methodLabel(view.ref),
): SpendRule {
  const tiers = rules?.tiers ?? [];
  const owner = methods.find((view) => view.owner);

  if (tiers.length === 0) {
    return {
      kind: "default",
      tierIndex: null,
      tier: null,
      delay: 0,
      summary: `Your limit needs ${owner ? nameOf(owner) : "the owner method"} for this amount.`,
      choices: methods.map((view) => ({
        view,
        allowed: view.owner,
        reason: view.owner ? undefined : "Your limits do not use this method for this token.",
      })),
    };
  }

  const match = matchTier(tiers, amount);
  if (!match) {
    return {
      kind: "none",
      tierIndex: null,
      tier: null,
      delay: 0,
      summary: "Your limits do not allow this amount. Change them in Settings, or send less.",
      choices: methods.map((view) => ({
        view,
        allowed: false,
        reason: "Your limits do not allow this amount.",
      })),
    };
  }

  const { tier, index } = match;
  const choices: MethodChoice[] = methods.map((view) => {
    if (!maskHas(tier.methods, view)) {
      return { view, allowed: false, reason: "Your limits name another method for this amount." };
    }
    // The owner bit is a full method, so a synced owner passkey has no such limit.
    if (view.backup === "synced" && !view.owner && !tier.small) {
      return { view, allowed: false, reason: "A synced passkey cannot approve this amount." };
    }
    return { view, allowed: true };
  });
  const names = choices.filter((choice) => choice.allowed).map((choice) => nameOf(choice.view));
  // An earlier step would fit this amount, so its own total moved the send here.
  const stepFull = tiers.slice(0, index).some((earlier) => amount <= BigInt(earlier.upTo));
  const needs =
    names.length > 0
      ? `Your limit needs ${orJoin(names)} for this amount.`
      : "No method can approve this amount. Change your limits in Settings.";
  const waits =
    tier.delay > 0 ? ` It waits ${formatDuration(tier.delay).toLowerCase()}, and you can cancel it.` : "";
  return {
    kind: "tier",
    tierIndex: index,
    tier,
    delay: tier.delay,
    summary: `${stepFull ? "An earlier step reached its total. " : ""}${needs}${waits}`,
    choices,
  };
}

export type RulesChange = {
  direction: "same" | "stricter" | "looser";
  changes: string[];
};

function sameTier(a: Tier, b: Tier): boolean {
  return (
    a.upTo === b.upTo &&
    a.cap === b.cap &&
    a.delay === b.delay &&
    a.period === b.period &&
    a.methods === b.methods &&
    a.small === b.small
  );
}

/** True if the new tier meets the onchain check for `tighten`. */
function isStricterTier(before: Tier, after: Tier): boolean {
  const beforeCap = BigInt(before.cap);
  const afterCap = BigInt(after.cap);
  const capStricter =
    beforeCap === BigInt(0) ? true : afterCap > BigInt(0) && afterCap <= beforeCap;
  return (
    BigInt(after.upTo) <= BigInt(before.upTo) &&
    capStricter &&
    after.delay >= before.delay &&
    after.period >= before.period &&
    (after.methods & ~before.methods) === 0 &&
    (!after.small || before.small)
  );
}

type Direction = RulesChange["direction"];

/** How a new daily limit compares with the live one. 0 means no limit, so it is the loosest value. */
export function dailyDirection(before: string, after: string): Direction {
  const [old, next] = [BigInt(before), BigInt(after)];
  if (old === next) return "same";
  if (old === BigInt(0)) return "stricter";
  return next === BigInt(0) || next > old ? "looser" : "stricter";
}

/** One save holds a rule and a daily limit. If one of them is looser, the whole save is looser. */
export function joinDirections(a: Direction, b: Direction): Direction {
  if (a === "looser" || b === "looser") return "looser";
  return a === "same" ? b : a;
}

/** The rule of a token with no tiers, as the account reads it in `tighten`. */
const DEFAULT_TIER: Tier = {
  upTo: ((BigInt(1) << BigInt(96)) - BigInt(1)).toString(),
  cap: "0",
  delay: 0,
  period: 0,
  methods: OWNER_METHOD_MASK,
  small: false,
};

function capText(tier: Tier, token: TokenInfo): string {
  if (BigInt(tier.cap) === BigInt(0)) return "no total limit";
  const amount = plainAmount(tier.cap, token.decimals);
  return `${amount} ${token.symbol} per ${formatPeriod(tier.period)}`;
}

function methodsText(mask: number, methods: MethodView[], world?: WorldConfig | null): string {
  const labels = methods.filter((view) => maskHas(mask, view)).map((view) => methodLabel(view.ref, world));
  return labels.length > 0 ? labels.join(", ") : "no method";
}

function describeTierDiff(
  row: number,
  before: Tier,
  after: Tier,
  token: TokenInfo,
  methods: MethodView[],
  world?: WorldConfig | null,
): string[] {
  const lines: string[] = [];
  const name = `Limit ${row + 1}`;
  if (before.upTo !== after.upTo) {
    lines.push(
      `${name}: upper amount ${plainAmount(before.upTo, token.decimals)} to ${plainAmount(after.upTo, token.decimals)} ${token.symbol}.`,
    );
  }
  if (before.methods !== after.methods) {
    lines.push(
      `${name}: methods ${methodsText(before.methods, methods, world)} to ${methodsText(after.methods, methods, world)}.`,
    );
  }
  if (before.delay !== after.delay) {
    lines.push(`${name}: delay ${formatDuration(before.delay)} to ${formatDuration(after.delay)}.`);
  }
  if (before.cap !== after.cap || before.period !== after.period) {
    lines.push(`${name}: ${capText(before, token)} to ${capText(after, token)}.`);
  }
  return lines;
}

function describeTier(tier: Tier, token: TokenInfo, methods: MethodView[], world?: WorldConfig | null): string {
  const delay = tier.delay > 0 ? `${formatDuration(tier.delay)} delay` : "no delay";
  return `up to ${plainAmount(tier.upTo, token.decimals)} ${token.symbol}, ${methodsText(tier.methods, methods, world)}, ${delay}, ${capText(tier, token)}`;
}

/**
 * Compare the draft with the chain. This follows `_tighten` in WavePolicy.sol.
 * Each new tier must be stricter than the old tier at the same index. A
 * shorter list is stricter. A longer list and an empty list are looser. A token
 * with no tiers counts as one tier: any amount, the owner method, no delay.
 */
export function compareRules(
  chain: Tier[],
  draft: Tier[],
  token: TokenInfo,
  methods: MethodView[],
  world?: WorldConfig | null,
): RulesChange {
  if (chain.length === draft.length && chain.every((tier, row) => sameTier(tier, draft[row]))) {
    return { direction: "same", changes: [] };
  }

  const changes: string[] = [];
  chain.slice(draft.length).forEach((tier, offset) => {
    changes.push(`Remove limit ${draft.length + offset + 1}: ${describeTier(tier, token, methods, world)}.`);
  });
  draft.slice(chain.length).forEach((tier, offset) => {
    changes.push(`Add limit ${chain.length + offset + 1}: ${describeTier(tier, token, methods, world)}.`);
  });
  chain.slice(0, draft.length).forEach((tier, row) => {
    changes.push(...describeTierDiff(row, tier, draft[row], token, methods, world));
  });

  const old = chain.length > 0 ? chain : [DEFAULT_TIER];
  const stricter =
    draft.length > 0 &&
    draft.length <= old.length &&
    draft.every((tier, row) => isStricterTier(old[row], tier));
  return { direction: stricter ? "stricter" : "looser", changes };
}

/**
 * The problem with one amount field of a tier. Null if the text is a valid amount. An empty cap
 * means "no cap", so an empty field is valid only there.
 */
export function tierAmountError(text: string, token: TokenInfo, optional: boolean): string | null {
  if (!text.trim()) return optional ? null : "Enter an amount.";
  const parsed = parseTokenAmount(text, token.decimals);
  if (parsed.error !== null) return parsed.error;
  // Onchain, a cap of 0 means no cap. Nobody means that when they type 0.
  if (optional && parsed.value === BigInt(0)) return "Leave this empty for no limit.";
  return parsed.value > UINT96_MAX ? "This amount is too large." : null;
}

/** The one line about a save. It names a wait only if the wallet has one. */
export function saveLine(
  direction: "stricter" | "looser",
  ownerName: string,
  waitSeconds: number | null,
  real: number,
): string {
  if (direction === "stricter") return "Stricter: applies at once.";
  const needs = `Looser: needs ${ownerName}.`;
  if (waitSeconds === 0) return needs;
  const applied = waitSeconds !== null && waitSeconds < real ? waitSeconds : real;
  return `${needs} It waits ${formatDuration(applied).toLowerCase()}, and you can cancel it.`;
}

/** How an owner change runs on this wallet. `waitSeconds` comes from the account. */
export function changeTiming(waitSeconds: number | null, real: number): string {
  if (waitSeconds === 0) return "It runs at once, and you cannot cancel it.";
  const applied = waitSeconds !== null && waitSeconds < real ? waitSeconds : real;
  return `It waits ${formatDuration(applied).toLowerCase()} in the queue, and you can cancel it during that time.`;
}
