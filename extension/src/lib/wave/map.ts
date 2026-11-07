import { ApiError, explorerTxUrl } from "@/lib/api-client";
import { ETH_TOKEN } from "@/lib/api-types";
import type {
  AccountResponse,
  ActivityItem,
  AgentView,
  Address,
  BaseUnits,
  InfoResponse,
  MethodRef,
  MethodView,
  PasskeySlot,
  PendingAction,
  TokenInfo,
} from "@/lib/api-types";
import { limitLines } from "@/lib/ui/agents";
import { plainAmount, shortHex } from "@/lib/ui/format";
import { findPasskey, type LocalState, type LocalWallet } from "@/lib/ui/local";
import { explainRejection } from "@/lib/ui/rejections";
import { methodLabel, nameFor, plainName } from "./names";
import type { Agent, CardDesign, MethodCard, MethodId, MethodKind, Pending, Recipient, Tx, Wallet } from "../../data";

/** These functions turn WAVE API data into the types of the phone UI. */

const DESIGNS: CardDesign[] = ["navy", "slate", "midnight"];

// SAMPLE: no WAVE function yet. WAVE has no USDT token, so this balance is 0 and the row stays.
const SAMPLE_USDT_BALANCE = 0;

/** A float for display only. Every amount that goes to the chain stays in base units. */
const asNumber = (value: BaseUnits, decimals: number) => {
  const amount = Number(plainAmount(value, decimals));
  return Number.isFinite(amount) ? amount : 0;
};

/** The one token that this wallet shows as USDC. */
export const testToken = (info: InfoResponse | null): TokenInfo | undefined => info?.tokens.find((token) => token.isTest);

/** A sponsored wallet pays no gas, so ETH does not matter there. */
export function visibleBalances(account: AccountResponse, info: InfoResponse) {
  return account.balances.filter((balance) => !(info.gasSponsored && balance.token === ETH_TOKEN));
}

/** A sponsored wallet shows no ETH, so its activity shows no ETH transfer either. */
export function visibleActivity(items: ActivityItem[], info: InfoResponse) {
  return items.filter((item) => !(info.gasSponsored && item.token === ETH_TOKEN));
}

export function toWallet(wallet: LocalWallet | null, account: AccountResponse | null, info: InfoResponse | null): Wallet {
  const token = testToken(info);
  const balance =
    account && info && token
      ? visibleBalances(account, info).find((item) => item.token.toLowerCase() === token.address.toLowerCase())
      : undefined;
  return {
    name: "Main wallet",
    address: wallet?.address ?? "",
    balances: { USDC: balance && token ? asNumber(balance.amount, token.decimals) : 0, USDT: SAMPLE_USDT_BALANCE },
  };
}

export const methodIdOf = (ref: MethodRef): MethodId => (ref.kind === "world" ? "worldid" : "faceid");

/** World ID first, then a security key, then a passkey. */
const RANK: Record<MethodKind, number> = { worldid: 0, key: 1, faceid: 2, passkey: 3, nfc: 4 };

function subtitleOf(view: MethodView): string {
  if (view.owner) return "Owner · big sends and changes";
  return view.backup === "synced" ? "Synced · sends under your limit" : "Device-bound · sends and recovery";
}

/** A passkey keeps this ID from the queue to the chain, so its card stays the same card. */
export const passkeyCardId = (slot: PasskeySlot) => `passkey-${slot}`;

/** The title that lib/server/decode.ts gives a queued install. freePasskeySlot reads it too. */
const INSTALL_TITLE = /^Add passkey in slot ([123])$/;

export function toCards(
  account: AccountResponse | null,
  info: InfoResponse | null,
  wallet: LocalWallet | null,
  local: LocalState | null,
): MethodCard[] {
  if (!account) return [];
  let passkeys = 0;
  const kindOf = (title: string): MethodKind =>
    title === "Security key" ? "key" : passkeys++ === 0 ? "faceid" : "passkey";

  const live = account.methods.map((view): Omit<MethodCard, "design"> => {
    const title = plainName(view, wallet, local, info?.world);
    return {
      id: view.ref.kind === "passkey" ? passkeyCardId(view.ref.slot) : view.validator,
      kind: view.ref.kind === "world" ? "worldid" : kindOf(title),
      activeAt: 0,
      owner: view.owner,
      backup: view.backup,
      title,
      subtitle: subtitleOf(view),
    };
  });

  // The chain enrols a queued passkey only when the action runs. Until then it cannot approve.
  const queued = account.pending.flatMap((action): Omit<MethodCard, "design">[] => {
    const match = INSTALL_TITLE.exec(action.decoded.title);
    if (!match || action.status === "stale") return [];
    const slot = Number(match[1]) as PasskeySlot;
    const held = wallet && local ? findPasskey(local, wallet.address, slot) : null;
    const title = nameFor({ kind: "passkey", slot }, held, info?.world);
    return [
      {
        id: passkeyCardId(slot),
        kind: kindOf(title),
        activeAt: (action.executeAfter ?? Infinity) * 1000,
        queued: true,
        backup: action.decoded.lines.some((line) => line.value === "Synced passkey") ? "synced" : "device-bound",
        title,
        subtitle: "Queued · not active yet",
      },
    ];
  });

  return [...live, ...queued]
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])
    .map((card, index) => ({ ...card, design: DESIGNS[index % DESIGNS.length] }));
}

/** The time as the friend's design shows it: "Today, 12:41" or "Mon, 3 Nov". */
function when(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (date.toDateString() === new Date().toDateString()) {
    const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `Today, ${time}`;
  }
  return date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" });
}

function txTitle(item: ActivityItem, isToken: boolean, recipients: Recipient[]): string {
  // The row shows only USDC as an amount. The title of any other token holds its amount.
  if (!isToken || !item.counterparty || item.direction === "none") return item.title;
  const counterparty = item.counterparty.toLowerCase();
  const name = recipients.find((recipient) => recipient.address.toLowerCase() === counterparty)?.name;
  return `${item.direction === "out" ? "To" : "From"} ${name ?? shortHex(item.counterparty)}`;
}

export function toTx(item: ActivityItem, info: InfoResponse, recipients: Recipient[]): Tx {
  const failed = item.state === "failed" || item.state === "dropped";
  const token = testToken(info);
  const isToken = token !== undefined && item.token?.toLowerCase() === token.address.toLowerCase();
  const parts = [
    ...(failed ? ["Failed"] : item.state === "queued" ? ["Queued"] : []),
    ...(item.method ? [methodLabel(item.method, info.world)] : []),
    when(item.timestamp),
  ];
  return {
    id: item.txHash,
    kind: failed ? "cancelled" : item.direction === "in" ? "in" : item.direction === "out" ? "out" : "config",
    title: txTitle(item, isToken, recipients),
    subtitle: parts.join(" · "),
    amount: isToken && item.amount ? asNumber(item.amount, token.decimals) : undefined,
    token: isToken ? "USDC" : undefined,
    method: item.method ? methodIdOf(item.method) : undefined,
    hash: shortHex(item.txHash, 10, 8),
    href: explorerTxUrl(info, item.txHash),
  };
}

export function toPending(action: PendingAction, info: InfoResponse | null): Pending {
  return {
    id: action.id,
    title: action.decoded.title,
    detail: action.decoded.lines.map((line) => `${line.label}: ${line.value}`).join(" · "),
    proposedBy: methodIdOf(action.proposedBy),
    proposedName: methodLabel(action.proposedBy, info?.world),
    endsAt: action.executeAfter === null ? Infinity : action.executeAfter * 1000,
    status: action.status,
    approvals: action.approvals.length,
    warning: action.decoded.warning,
  };
}

// SAMPLE: no WAVE function yet. WAVE stores no agent name or purpose, so they stay in this tab.
export type AgentNames = Record<string, { name: string; purpose: string }>;

/** A queued resume has no effect until it runs. A second one would only fill the queue. */
function resumeQueued(pending: PendingAction[], agent: Address) {
  return pending.some(
    (action) =>
      action.status !== "stale" &&
      action.decoded.title === "Unpause the agent" &&
      action.decoded.lines.some((line) => line.value.toLowerCase() === agent.toLowerCase()),
  );
}

export function toAgent(
  view: AgentView,
  index: number,
  info: InfoResponse | null,
  pending: PendingAction[],
  names: AgentNames,
): Agent {
  const token = testToken(info);
  const same = (address: string) => address.toLowerCase() === token?.address.toLowerCase();
  const tier = view.rules.find((rule) => same(rule.token))?.tiers[0];
  const ask = view.askAbove.find((item) => same(item.token))?.amount ?? null;
  const label = names[view.address.toLowerCase()];
  const state = view.signer === null ? "revoked" : view.paused ? "paused" : "active";
  return {
    id: view.address,
    name: label?.name ?? `Agent ${index + 1}`,
    purpose: label?.purpose || shortHex(view.address),
    limit: tier && token ? asNumber(tier.cap, token.decimals) : 0,
    per: "day",
    used: tier && token ? asNumber(tier.spent, token.decimals) : 0,
    balance: asNumber(view.balances.find((item) => same(item.token))?.amount ?? "0", token?.decimals ?? 0),
    active: state === "active",
    state,
    design: DESIGNS[index % DESIGNS.length],
    address: view.address,
    sends: tier && token ? limitLines(tier, ask, token)[0] : "No limits are set, so this agent cannot spend.",
    warning:
      state !== "revoked" && !view.serverHoldsKey ? "The server does not hold this agent's key, so it cannot spend." : undefined,
    resumeQueued: resumeQueued(pending, view.address),
  };
}

/** Plain text for a thrown value. */
export const errorText = (cause: unknown, fallback: string) =>
  (cause instanceof Error && cause.message) || fallback;

/** Why Run now failed. The text must not say that nothing was sent unless that is sure. */
export function runErrorText(cause: unknown): string {
  const unknown = "WAVE cannot tell if this reached the chain. Check Activity before you try again.";
  if (!(cause instanceof ApiError)) return `${errorText(cause, "WAVE could not run this action.")} ${unknown}`;
  // The message of this error holds the hash of the reverted transaction.
  if (cause.code === "RUN_FAILED") return cause.message;
  // The route checks the contract before it sends, and it sends the contract error as the code.
  if (cause.status === 409) {
    const text = explainRejection({ stage: "simulate", code: cause.code, message: cause.message });
    return `${text.title}. ${text.detail} ${text.stage}`;
  }
  if (cause.status >= 400 && cause.status < 500) return `${cause.message} Nothing reached the chain.`;
  return `${cause.message} ${unknown}`;
}

/** A closed passkey prompt is the owner's choice. It is not a fault of the wallet. */
export function passkeyErrorText(cause: unknown, fallback: string): string {
  const inner = cause instanceof Error ? cause.cause : undefined;
  const names = [cause, inner].map((item) => (item instanceof Error ? `${item.name} ${item.message}` : ""));
  if (names.some((name) => /NotAllowedError|AbortError/.test(name))) {
    return "The passkey prompt closed. Try again when you are ready.";
  }
  return errorText(cause, fallback);
}
