// Types for the wallet UI. The data itself comes from Whitechain Sepolia (see store.tsx and
// lib/wc/). There is no sample data: every balance, transfer and queued action is onchain.
import type { Hex } from "viem";

/** USDT: Whitechain test USDT. USDC: USDC.e from the Portal bridge. tUSDT: WAVE's open-mint test token. */
export type Token = "USDC" | "USDT" | "tUSDT";
export const TOKEN_ORDER: Token[] = ["USDT", "USDC", "tUSDT"];

export type MethodId = "worldid" | "faceid" | "nfc";

export const METHOD_LABEL: Record<MethodId, string> = {
  worldid: "World ID",
  faceid: "Passkey",
  nfc: "NFC card",
};

/** The user's one WAVE wallet: a single ERC-4337 account on Whitechain Sepolia. */
export type Wallet = {
  name: string;
  address: string;
  balances: Record<Token, number>;
};

export type CardDesign = "navy" | "slate" | "midnight";

/** Each approval method is a card in the wallet's card holder. */
export type MethodKind = "worldid" | "faceid" | "passkey" | "nfc";

export type MethodCard = {
  id: string;
  kind: MethodKind;
  design: CardDesign;
  /** When the method can start approving. */
  activeAt: number;
};

export const METHOD_INFO: Record<MethodKind, { name: string; approves: string }> = {
  worldid: { name: "World ID", approves: "Owner on the WAVE frame network" },
  faceid: { name: "Passkey", approves: "Owner · every amount" },
  passkey: { name: "Second passkey", approves: "Small transfers · recovery" },
  nfc: { name: "NFC card", approves: "Small transfers · recovery" },
};

/** Methods that exist on the WAVE frame-transaction network but not on Whitechain yet. */
export const NOT_ON_WHITECHAIN: MethodKind[] = ["worldid", "passkey", "nfc"];

export type Recipient = {
  id: string;
  name: string;
  handle?: string;
  address: string;
};

export type TxKind = "out" | "in" | "cancelled" | "config";

export type Tx = {
  id: string;
  kind: TxKind;
  title: string;
  subtitle: string;
  amount?: number;
  token?: Token;
  method?: MethodId;
  /** Block explorer link. */
  href?: string;
};

export type Pending = {
  id: Hex;
  title: string;
  detail: string;
  proposedBy: MethodId;
  endsAt: number;
  /** Methods allowed to cancel. */
  cancelBy: MethodId[];
  transfer?: { token: Token; amount: number; to: string };
  /** The ERC-7579 batch that executeScheduled runs. */
  batch: Hex;
};

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
