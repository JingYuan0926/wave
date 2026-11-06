import type {
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
import { PASSKEY_SLOTS, WORLD_METHOD_MASK } from "@/lib/api-types";
import { delayText, formatDuration, formatPeriod, parseTokenAmount, plainAmount } from "./format";

export const WORLD_ID: MethodRef = { kind: "world" };

/** The largest amount in a tier. The contract stores it in 96 bits. */
const UINT96_MAX = (BigInt(1) << BigInt(96)) - BigInt(1);

/** Above the gas limit of a World ID send that also deploys, at the fee the app signs. */
export const ETH_GAS_RESERVE = BigInt("12000000000000000");

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

/** Text for one enrolled method, for example "Passkey 1 (synced)". */
export function methodDetail(view: MethodView, world?: WorldConfig | null): string {
  const label = methodLabel(view.ref, world);
  if (view.backup === "synced") return `${label} (synced)`;
  if (view.backup === "device-bound") return `${label} (device-bound)`;
  return world?.mode === "dev" ? `${label} (not a real World ID)` : label;
}

/**
 * Who can act on a recovery. The account accepts only device-bound methods other than World ID.
 * `approved` lists the methods that already count: the account adds nothing for them.
 */
export function recoveryChoices(
  methods: MethodView[],
  world: WorldConfig | null | undefined,
  approved: MethodRef[] = [],
): MethodChoice[] {
  return methods.map((view) => {
    if (view.ref.kind === "world") {
      return { view, allowed: false, reason: `${methodLabel(view.ref, world)} cannot run a recovery.` };
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

/** Tell the owner which rule applies and which methods can approve it. */
export function describeSpend(
  rules: TokenRules | undefined,
  amount: bigint,
  methods: MethodView[],
  demoDelay = 0,
): SpendRule {
  const tiers = rules?.tiers ?? [];

  if (tiers.length === 0) {
    return {
      kind: "default",
      tierIndex: null,
      tier: null,
      delay: 0,
      summary: "Default rule: World ID only, no delay.",
      choices: methods.map((view) => ({
        view,
        allowed: view.ref.kind === "world",
        reason: view.ref.kind === "world" ? undefined : "This token has no rule for this method.",
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
      summary: "No rule allows this amount. Add a tier in Settings, or send less.",
      choices: methods.map((view) => ({
        view,
        allowed: false,
        reason: "No rule allows this amount.",
      })),
    };
  }

  const { tier, index } = match;
  return {
    kind: "tier",
    tierIndex: index,
    tier,
    delay: tier.delay,
    summary:
      tier.delay > 0
        ? `Tier ${index + 1} applies. The transfer waits in the queue, and you can cancel it. ${spendDelay(tier.delay, demoDelay)}.`
        : `Tier ${index + 1} applies. The transfer runs at once.`,
    choices: methods.map((view) => {
      if (!maskHas(tier.methods, view)) {
        return { view, allowed: false, reason: `Tier ${index + 1} does not name this method.` };
      }
      if (view.backup === "synced" && !tier.small) {
        return { view, allowed: false, reason: "A synced passkey approves small tiers only." };
      }
      return { view, allowed: true };
    }),
  };
}

function spendDelay(real: number, demoDelay: number): string {
  const text = delayText(real, demoDelay);
  return text.startsWith("Demo") ? text : `Delay: ${text.toLowerCase()}`;
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

/** The rule of a token with no tiers, as the account reads it in `tighten`. */
const DEFAULT_TIER: Tier = {
  upTo: ((BigInt(1) << BigInt(96)) - BigInt(1)).toString(),
  cap: "0",
  delay: 0,
  period: 0,
  methods: WORLD_METHOD_MASK,
  small: false,
};

function capText(tier: Tier, token: TokenInfo): string {
  if (BigInt(tier.cap) === BigInt(0)) return "no cap";
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
  const name = `Tier ${row + 1}`;
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
    lines.push(`${name}: cap ${capText(before, token)} to ${capText(after, token)}.`);
  }
  if (before.small !== after.small) {
    lines.push(`${name}: small tier ${after.small ? "on" : "off"}.`);
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
 * with no tiers counts as one tier: any amount, World ID, no delay.
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
    changes.push(`Remove tier ${draft.length + offset + 1}: ${describeTier(tier, token, methods, world)}.`);
  });
  draft.slice(chain.length).forEach((tier, offset) => {
    changes.push(`Add tier ${chain.length + offset + 1}: ${describeTier(tier, token, methods, world)}.`);
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
  if (optional && parsed.value === BigInt(0)) return "Leave this empty for no cap.";
  return parsed.value > UINT96_MAX ? "This amount is too large." : null;
}

/** Problems that stop a save. An empty list means that the draft is valid. */
export function validateTiers(tiers: Tier[], token: TokenInfo): string[] {
  const problems: string[] = [];
  tiers.forEach((tier, row) => {
    const name = `Tier ${row + 1}`;
    if (BigInt(tier.upTo) <= BigInt(0)) problems.push(`${name}: enter an upper amount.`);
    if (tier.methods === 0) problems.push(`${name}: pick at least one method.`);
    if (BigInt(tier.cap) > BigInt(0) && tier.period === 0) {
      problems.push(`${name}: a period cap needs a period.`);
    }
    if (row > 0 && BigInt(tier.upTo) < BigInt(tiers[row - 1].upTo)) {
      problems.push(`${name}: the upper amount must not be below tier ${row} (${token.symbol}).`);
    }
  });
  return problems;
}
