// Sample wallet data for the UI. Swap these for onchain reads when the
// contracts are deployed.

export type Token = "USDC" | "USDT";
export type MethodId = "worldid" | "faceid" | "nfc";

export const METHOD_LABEL: Record<MethodId, string> = {
  worldid: "World ID",
  faceid: "Face ID",
  nfc: "NFC card",
};

export type Tier = {
  /** Upper amount per transfer. null = no upper bound. */
  upTo: number | null;
  method: MethodId;
  delayHours: number;
  cap?: { amount: number; per: "day" | "week"; used: number };
};

export const RULES: Record<Token, Tier[]> = {
  USDC: [
    { upTo: 100, method: "faceid", delayHours: 0, cap: { amount: 300, per: "day", used: 120 } },
    { upTo: 1000, method: "worldid", delayHours: 0, cap: { amount: 2000, per: "week", used: 450 } },
    { upTo: null, method: "worldid", delayHours: 24 },
  ],
  USDT: [
    { upTo: 100, method: "faceid", delayHours: 0, cap: { amount: 300, per: "day", used: 40 } },
    { upTo: 1000, method: "worldid", delayHours: 0, cap: { amount: 2000, per: "week", used: 200 } },
    { upTo: null, method: "worldid", delayHours: 24 },
  ],
};

/**
 * Finds the tier for a transfer. Tier 0 is "under X"; later tiers are
 * "up to and including X". When a tier's period cap would be exceeded,
 * the next tier applies.
 */
export function tierFor(token: Token, amount: number) {
  const tiers = RULES[token];
  let capSkipped = false;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const inRange = t.upTo === null || (i === 0 ? amount < t.upTo : amount <= t.upTo);
    if (!inRange) continue;
    if (t.cap && t.cap.used + amount > t.cap.amount && i < tiers.length - 1) {
      capSkipped = true;
      continue;
    }
    return { tier: t, index: i, capSkipped };
  }
  return { tier: tiers[tiers.length - 1], index: tiers.length - 1, capSkipped };
}

/** The user's one WAVE wallet: a single onchain account. */
export type Wallet = {
  name: string;
  address: string;
  balances: Record<Token, number>;
};

export const WALLET: Wallet = {
  name: "Main wallet",
  address: "0x8e41C2a0b5d7F3e19A6c04B2d9E7f15a3C60bD27",
  balances: { USDC: 1034.5, USDT: 256.2 },
};

export type CardDesign = "navy" | "slate" | "midnight";

/** Each approval method is a card in the wallet's card holder. */
export type MethodKind = "worldid" | "faceid" | "passkey" | "nfc";

export type MethodCard = {
  id: string;
  kind: MethodKind;
  design: CardDesign;
  /** When the method can start approving. Adding a method waits 48 hours. */
  activeAt: number;
};

export const METHOD_INFO: Record<MethodKind, { name: string; approves: string }> = {
  worldid: { name: "World ID", approves: "Owner · 100+ USDC and changes" },
  faceid: { name: "Face ID passkey", approves: "Under 100 USDC · at once" },
  passkey: { name: "Second passkey", approves: "Small transfers · recovery" },
  nfc: { name: "NFC card", approves: "Small transfers · recovery" },
};

export const METHOD_CARDS: MethodCard[] = [
  { id: "m1", kind: "worldid", design: "navy", activeAt: 0 },
  { id: "m2", kind: "faceid", design: "slate", activeAt: 0 },
];

export type Recipient = {
  id: string;
  name: string;
  handle?: string;
  address: string;
};

export const RECIPIENTS: Recipient[] = [
  { id: "r1", name: "Priya Sharma", handle: "priya.eth", address: "0x4b2E91c0A7d35F6e8B10c4D9a2E7f3B5C68d0A14" },
  { id: "r2", name: "Arjun Mehta", address: "0x91cD47E2b8A0f3C65d19E7a4B0c2F8e6D3a5B971" },
  { id: "r3", name: "Kavya Iyer", handle: "kavya.eth", address: "0x7A3f0C9e2D5b8146E0a7C3d1F9B4e6A2c8D05f3E" },
  { id: "r4", name: "Rohan Das", address: "0x3C8e5A1b7F0d2946B3e8C1a5D7f0E4b9A2c6D18F" },
  { id: "r5", name: "Meera Nair", handle: "meera.eth", address: "0xD05b2F8a6C1e3974A0d5B8c2E6f1A9b3C7e4D260" },
  { id: "r6", name: "Chai Point Bandra", address: "0x6E1a9D4c0B7f3528C6e1A9d4B0c7F3e5A2b8D41C" },
];

export type TxKind = "out" | "in" | "cancelled" | "config";

export type Tx = {
  id: string;
  kind: TxKind;
  title: string;
  subtitle: string;
  amount?: number;
  token?: Token;
  method?: MethodId;
};

export const TRANSACTIONS: Tx[] = [
  { id: "t1", kind: "out", title: "To Priya Sharma", subtitle: "Face ID · Today, 12:41", amount: 50, token: "USDC", method: "faceid" },
  { id: "t2", kind: "in", title: "From Arjun Mehta", subtitle: "Today, 09:15", amount: 120, token: "USDC" },
  { id: "t3", kind: "out", title: "To Chai Point Bandra", subtitle: "Face ID · Yesterday", amount: 3.5, token: "USDC", method: "faceid" },
  { id: "t4", kind: "out", title: "To Kavya Iyer", subtitle: "World ID · Mon", amount: 145, token: "USDT", method: "worldid" },
  { id: "t5", kind: "config", title: "Face ID added", subtitle: "World ID · after 48h delay · Sun" },
  { id: "t6", kind: "in", title: "Account funded", subtitle: "Sat", amount: 1000, token: "USDC" },
];

export type Pending = {
  id: string;
  title: string;
  detail: string;
  proposedBy: MethodId;
  endsAt: number;
  /** Methods allowed to cancel. Fallback recovery: World ID only. */
  cancelBy: MethodId[];
  transfer?: { token: Token; amount: number; to: string };
  /** For "add method" actions: the card that becomes active. */
  cardId?: string;
};

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

export const PENDING: Pending[] = [
  {
    id: "p1",
    title: "Send 1,500 USDC",
    detail: "To Arjun Mehta · over 1,000 USDC",
    proposedBy: "worldid",
    endsAt: now + 1 * MIN + 40_000, // demo delay
    cancelBy: ["worldid", "faceid"],
    transfer: { token: "USDC", amount: 1500, to: "Arjun Mehta" },
  },
  {
    id: "p2",
    title: "Token approval",
    detail: "Uniswap can spend unlimited USDC",
    proposedBy: "worldid",
    endsAt: now + 23 * HOUR + 12 * MIN,
    cancelBy: ["worldid", "faceid"],
  },
];

export type Agent = {
  id: string;
  name: string;
  purpose: string;
  limit: number;
  per: "day" | "week" | "month";
  used: number;
  active: boolean;
  design: CardDesign;
};

export const AGENTS: Agent[] = [
  { id: "a1", name: "Grocery runner", purpose: "Reorders weekly groceries", limit: 60, per: "week", used: 38.4, active: true, design: "navy" },
  { id: "a2", name: "Subscriptions", purpose: "Pays Spotify and iCloud", limit: 25, per: "month", used: 19.99, active: true, design: "slate" },
  { id: "a3", name: "Travel booker", purpose: "Books trains and flights", limit: 400, per: "month", used: 0, active: false, design: "midnight" },
];
