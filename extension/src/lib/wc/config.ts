// Whitechain Sepolia settings for the extension. The contract addresses come from
// contracts/deployments/whitechain-sepolia.json, which `npm run deploy:wc` writes. The file is
// read at build time, so a build without a deployment shows a "not deployed yet" screen.
import { createPublicClient, defineChain, http, type Address } from "viem";
import type { Token } from "../../data";

export type WcTier = { upTo: string; cap: string; delay: number; period: number; methods: number };
export type WcDeployment = {
  chainId: number;
  rpcUrl: string;
  explorer: string;
  deployedAtBlock: number;
  entryPoint: Address;
  passkeyValidator: Address;
  implementation: Address;
  factory: Address;
  paymaster: Address;
  defaultToken: Address;
  demoDelay: number;
  tokens: { symbol: string; name: string; address: Address; decimals: number }[];
  rules: { token: Address; tiers: WcTier[] }[];
};

const found = import.meta.glob<WcDeployment>("../../../../contracts/deployments/whitechain-sepolia.json", {
  eager: true,
  import: "default",
});

/** Null until WAVE is deployed on Whitechain Sepolia and the extension is rebuilt. */
export const WC: WcDeployment | null = Object.values(found)[0] ?? null;

/** The WAVE relayer: the root Next app (`npm run dev` in the repo root). */
export const RELAYER_URL = (import.meta.env.VITE_WC_RELAYER_URL as string | undefined) ?? "http://localhost:3000";

export const CHAIN_ID = 1874;
export const EXPLORER = WC?.explorer ?? "https://explorer.testnet.whitechain.io";
export const NETWORK_NAME = "Whitechain Sepolia";

export const chain = defineChain({
  id: CHAIN_ID,
  name: NETWORK_NAME,
  nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
  rpcUrls: { default: { http: [WC?.rpcUrl ?? "https://rpc.testnet.whitechain.io"] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const publicClient = createPublicClient({ chain, transport: http() });

export type TokenInfo = { symbol: Token; name: string; address: Address; decimals: number };

/** The tokens the wallet shows, in display order. */
export const TOKENS: TokenInfo[] = (WC?.tokens ?? []).map((t) => ({ ...t, symbol: t.symbol as Token }));

export function tokenInfo(symbol: Token): TokenInfo | undefined {
  return TOKENS.find((t) => t.symbol === symbol);
}

export function tokenByAddress(address: string): TokenInfo | undefined {
  return TOKENS.find((t) => t.address.toLowerCase() === address.toLowerCase());
}

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;
