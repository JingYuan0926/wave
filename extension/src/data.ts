// The types of the wallet UI. lib/wave/map.ts turns the WAVE API data into these types.
// Sample data stays here only where the tag "SAMPLE" says so.

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

/** The user's one WAVE wallet: a single onchain account. */
export type Wallet = {
  name: string;
  address: string;
  balances: Record<Token, number>;
};

export type CardDesign = "navy" | "slate" | "midnight";

/** Each approval method is a card in the wallet's card holder. */
export type MethodKind = "worldid" | "key" | "faceid" | "passkey" | "nfc";

export type MethodCard = {
  id: string;
  kind: MethodKind;
  design: CardDesign;
  /** When a queued method can run. It is 0 for a method on the chain. */
  activeAt: number;
  /** The install waits in the queue, so this method cannot approve yet. */
  queued?: boolean;
  /** The owner method. It approves big sends and changes to the wallet. */
  owner?: boolean;
  /** "synced" means that this method cannot run a recovery. Null for World ID. */
  backup?: "synced" | "device-bound" | null;
  /** The real name and role of this method. They replace METHOD_INFO on a real card. */
  title?: string;
  subtitle?: string;
};

// SAMPLE: no WAVE function yet. Real cards carry their own text. Previews and NFC use this text.
export const METHOD_INFO: Record<MethodKind, { name: string; approves: string }> = {
  worldid: { name: "World ID", approves: "Owner · 100+ USDC and changes" },
  key: { name: "Security key", approves: "Small transfers · recovery" },
  faceid: { name: "Face ID passkey", approves: "Under 100 USDC · at once" },
  passkey: { name: "Second passkey", approves: "Small transfers · recovery" },
  nfc: { name: "NFC card", approves: "Small transfers · recovery" },
};

// SAMPLE: no WAVE function yet. WAVE has no NFC card, so this row stays as a preview.
export const NFC_NOTE = "Sample · WAVE has no NFC card yet";

export type Recipient = {
  id: string;
  name: string;
  handle?: string;
  address: string;
};

// SAMPLE: no WAVE function yet. WAVE has no address book.
export const RECIPIENTS: Recipient[] = [
  { id: "r1", name: "Priya Sharma", handle: "priya.eth", address: "0x4B2e91c0a7D35f6e8b10C4d9A2E7f3b5c68D0a14" },
  { id: "r2", name: "Arjun Mehta", address: "0x91cd47E2B8a0F3c65d19E7a4b0c2f8e6d3a5b971" },
  { id: "r3", name: "Kavya Iyer", handle: "kavya.eth", address: "0x7a3F0C9e2d5b8146e0A7C3d1F9b4e6A2c8d05f3E" },
  { id: "r4", name: "Rohan Das", address: "0x3C8e5a1b7F0D2946b3E8c1A5d7f0E4B9a2c6d18F" },
  { id: "r5", name: "Meera Nair", handle: "meera.eth", address: "0xd05b2F8a6c1e3974A0D5B8C2e6F1A9b3c7E4D260" },
  { id: "r6", name: "Chai Point Bandra", address: "0x6e1a9D4c0B7F3528C6E1A9d4B0C7f3E5A2B8d41c" },
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
  /** The short transaction hash. */
  hash?: string;
  /** The transaction in the explorer. */
  href?: string;
};

export type Pending = {
  id: string;
  title: string;
  detail: string;
  proposedBy: MethodId;
  /** The real name of the method that proposed this action. */
  proposedName?: string;
  /** Infinity while the action has no end time, such as a recovery with one approval. */
  endsAt: number;
  /** The queue state on the chain. */
  status: "needs-approval" | "waiting" | "ready" | "stale";
  /** Distinct approvals of a recovery. */
  approvals: number;
  /** A plain warning from the server, if the action is sensitive. */
  warning?: string;
  transfer?: { token: Token; amount: number; to: string };
  /** For "add method" actions: the card that becomes active. */
  cardId?: string;
};

export type Agent = {
  id: string;
  name: string;
  purpose: string;
  limit: number;
  per: "day" | "week" | "month";
  used: number;
  /** The test USDC that the agent wallet holds now. */
  balance: number;
  active: boolean;
  state: "active" | "paused" | "revoked";
  design: CardDesign;
  /** The agent wallet on the chain. */
  address?: string;
  /** What the agent can send alone. */
  sends: string;
  /** A real reason why this agent cannot spend. */
  warning?: string;
  /** A resume waits in the queue. */
  resumeQueued: boolean;
};
