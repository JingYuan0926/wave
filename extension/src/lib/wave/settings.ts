import { appliedDelay } from "@/lib/account";
import type { AccountResponse, BaseUnits, InfoResponse, MethodView, TierView, TokenInfo } from "@/lib/api-types";
import { formatAmount, formatDuration, formatPeriod, formatTime, plainAmount } from "@/lib/ui/format";
import type { LimitMethod } from "@/lib/ui/limits";
import type { LocalState, LocalWallet } from "@/lib/ui/local";
import { maskHas } from "@/lib/ui/rules";
import { plainName } from "./names";
import { rankChoices } from "./approve";
import type { Row } from "./create";
import { tokenRules } from "./send";

/** The Settings data of the phone UI, in the words of its pages. All values come from the chain. */

// lib/server/pending.ts holds the same two values, and that file is server side only.
export const CONFIG_DELAY = 172_800;
export const RECOVERY_DELAY = 604_800;

/** The contract stores an upper amount in 96 bits, so this value means no upper amount. */
const NO_UPPER = (BigInt(1) << BigInt(96)) - BigInt(1);
const DAY = 86_400;
const WEEK = 604_800;

export type Who = { wallet: LocalWallet | null; local: LocalState | null; info: InfoResponse | null };

export type Approver = { id: string; kind: Row; name: string };

/** One method on the limits form. Its ID is the method bit, as in components/settings/rules-editor.tsx. */
export type LimitChoice = LimitMethod & { kind: Row };

export type Meterage = {
  spent: string;
  total: string;
  window: string;
  /** Floats for the meter only. */
  value: number;
  max: number;
};

export type LimitRow = {
  id: number;
  range: string;
  /** The methods that can approve this tier, in rank order. It is empty if no method can. */
  approvers: Approver[];
  wait: string;
  cap: Meterage | null;
};

export type LimitView = {
  rows: LimitRow[];
  hasCap: boolean;
  /** Null means that this token has no daily limit. */
  daily: (Meterage & { left: string; resets: string | null }) | null;
};

const money = (value: BaseUnits, token: TokenInfo) => `${formatAmount(value, token.decimals)} ${token.symbol}`;
const float = (value: BaseUnits, token: TokenInfo) => Number(plainAmount(value, token.decimals)) || 0;

function rangeOf(tier: TierView, previous: TierView | undefined, token: TokenInfo): string {
  const last = previous && BigInt(previous.upTo) < NO_UPPER ? previous.upTo : null;
  if (BigInt(tier.upTo) >= NO_UPPER) return last ? `Over ${money(last, token)}` : "Any amount";
  // Two tiers can share an upper amount. The second one takes over when the cap of the first is full.
  if (!last || last === tier.upTo) return `Up to ${money(tier.upTo, token)}`;
  return `${formatAmount(last, token.decimals)} to ${money(tier.upTo, token)}`;
}

/** The chain sees a security key as a passkey. Only this browser knows the difference. */
function kindOf(view: MethodView, { wallet, local, info }: Who): Row {
  if (view.ref.kind === "world") return "world";
  return plainName(view, wallet, local, info?.world) === "Security key" ? "key" : "passkey";
}

/** The name on the limits page. A slot number tells the owner nothing if the wallet has one passkey. */
function limitName(view: MethodView, account: AccountResponse, who: Who): string {
  const passkeys = account.methods.filter((item) => kindOf(item, who) === "passkey");
  if (kindOf(view, who) === "passkey" && passkeys.length === 1) return "Passkey";
  return plainName(view, who.wallet, who.local, who.info?.world);
}

function approversOf(account: AccountResponse, who: Who, canApprove: (view: MethodView) => boolean): Approver[] {
  const { wallet, local, info } = who;
  const choices = account.methods.filter(canApprove).map((view) => ({ view, allowed: true }));
  return rankChoices(choices, wallet, local, info).map(({ view }) => ({
    id: view.validator,
    kind: kindOf(view, who),
    name: limitName(view, account, who),
  }));
}

/** The methods of the limits form. A synced passkey that is not the owner cannot approve any amount. */
export function limitChoices(account: AccountResponse, who: Who): LimitChoice[] {
  return account.methods.map((view) => ({
    id: String(view.mask),
    name: limitName(view, account, who),
    owner: view.owner,
    full: view.owner || view.backup !== "synced",
    kind: kindOf(view, who),
  }));
}

const windowOf = (period: number) => (period === DAY ? "today" : period === WEEK ? "this week" : `per ${formatPeriod(period)}`);

function capOf(tier: TierView, token: TokenInfo): Meterage | null {
  if (BigInt(tier.cap) === BigInt(0)) return null;
  return {
    spent: formatAmount(tier.spent, token.decimals),
    total: money(tier.cap, token),
    window: windowOf(tier.period),
    value: float(tier.spent, token),
    max: float(tier.cap, token),
  };
}

function rowsOf(account: AccountResponse, tiers: TierView[], token: TokenInfo, who: Who): LimitRow[] {
  // No tiers is the default rule of the contract: the owner method, any amount, no delay.
  if (tiers.length === 0) {
    const approvers = approversOf(account, who, (view) => view.owner);
    return [{ id: 0, range: "Any amount", approvers, wait: "Runs at once", cap: null }];
  }
  return tiers.map((tier, index) => ({
    id: index,
    range: rangeOf(tier, tiers[index - 1], token),
    // The owner bit is a full method, so a synced owner passkey has no such limit.
    approvers: approversOf(
      account,
      who,
      (view) => maskHas(tier.methods, view) && (view.owner || view.backup !== "synced" || tier.small),
    ),
    // The chain does not shorten a tier delay. The chosen wait applies only to config changes.
    wait: tier.delay === 0 ? "Runs at once" : `Waits ${formatDuration(tier.delay).toLowerCase()} · you can cancel`,
    cap: capOf(tier, token),
  }));
}

export function limitView(account: AccountResponse, token: TokenInfo, who: Who): LimitView {
  const rules = tokenRules(account, token.address);
  const tiers = rules?.tiers ?? [];
  const daily = rules?.daily ?? null;
  return {
    rows: rowsOf(account, tiers, token, who),
    hasCap: tiers.some((tier) => BigInt(tier.cap) > BigInt(0)),
    daily: daily && {
      spent: formatAmount(daily.spent, token.decimals),
      total: money(daily.limit, token),
      window: "today",
      value: float(daily.spent, token),
      max: float(daily.limit, token),
      left: money(daily.left, token),
      resets: daily.resetsAt === null ? null : formatTime(daily.resetsAt),
    },
  };
}

/** The plain name of the owner method. */
export function ownerName(account: AccountResponse, { wallet, local, info }: Who): string {
  const owner = account.methods.find((view) => view.owner);
  return owner ? plainName(owner, wallet, local, info?.world) : "the owner method";
}

/** The owner method, with the name of the limits page. */
export function ownerLimitName(account: AccountResponse, who: Who): string {
  const owner = account.methods.find((view) => view.owner);
  return owner ? limitName(owner, account, who) : "the owner method";
}

/** When a recovery can run after its second approval. */
export function recoveryWait(account: AccountResponse): string {
  const wait = appliedDelay(RECOVERY_DELAY, account.demoDelay);
  return wait === 0 ? "at once" : `after ${formatDuration(wait).toLowerCase()}`;
}
