// Whitechain Sepolia settings for the phone UI. The server reads
// contracts/deployments/whitechain-sepolia.json, which `npm run deploy:wc` writes. The UI gets the
// public values from /api/wc/status at run time, so a new deployment needs no new build.
import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";

export type WcTier = { upTo: string; cap: string; delay: number; period: number; methods: number };
export type WcDeployment = {
  chainId: number;
  rpcUrl: string;
  explorer: string;
  entryPoint: Address;
  passkeyValidator: Address;
  factory: Address;
  paymaster: Address;
  rules: { token: Address; tiers: WcTier[] }[];
};
export type WcStatus = { ready: true; deployment: WcDeployment } | { ready: false; reason: string };

/** The WAVE relayer. It is the same origin as the wallet page, unless the build says otherwise. */
export const RELAYER_URL = (import.meta.env?.VITE_WC_RELAYER_URL as string | undefined) ?? "";

export const NETWORK_NAME = "Whitechain Sepolia";

/** The real Whitechain test USDT. Only this token goes through the send sheet. */
export const USDT = { symbol: "USDT", address: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" as Address, decimals: 6 } as const;

const clients = new Map<string, PublicClient>();

export function clientOf(d: WcDeployment): PublicClient {
  const found = clients.get(d.rpcUrl);
  if (found) return found;
  const chain = defineChain({
    id: d.chainId,
    name: NETWORK_NAME,
    nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
    rpcUrls: { default: { http: [d.rpcUrl] } },
    blockExplorers: { default: { name: "Blockscout", url: d.explorer } },
  });
  const client = createPublicClient({ chain, transport: http() }) as PublicClient;
  clients.set(d.rpcUrl, client);
  return client;
}

/** Never throws. A failure gives a plain reason for the switch to show. */
export async function fetchStatus(): Promise<WcStatus> {
  try {
    const res = await fetch(`${RELAYER_URL}/api/wc/status`, { cache: "no-store" });
    const body = (await res.json()) as Partial<{ ready: boolean; reason: string; deployment: WcDeployment; error: { message: string } }>;
    if (res.ok && body.ready === true && body.deployment) return { ready: true, deployment: body.deployment };
    return { ready: false, reason: body.reason ?? body.error?.message ?? `The server answered ${res.status}.` };
  } catch {
    return { ready: false, reason: "The WAVE server does not answer." };
  }
}
