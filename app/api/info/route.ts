import type { InfoResponse } from "@/lib/api-types";
import { ETH_TOKEN } from "@/lib/api-types";
import { CHAIN_ID, EXPLORER_URL, NETWORK, RPC_URL, SIDECAR_URL, loadDeployment, rpc, sponsorOf } from "@/lib/chain";
import { tokensOf } from "@/lib/server/decode";
import { route } from "@/lib/server/http";
import { worldConfig } from "@/lib/server/world-config";

async function answers(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  try {
    return (await rpc(url, method, params)) ?? null;
  } catch {
    return undefined;
  }
}

async function contractState() {
  try {
    const d = loadDeployment();
    const code = await answers(RPC_URL, "eth_getCode", [d.factory, "latest"]);
    return {
      tokens: tokensOf(d),
      deployed: typeof code === "string" && code !== "0x",
      gasSponsored: sponsorOf(d) !== null,
    };
  } catch {
    return { tokens: null, deployed: false, gasSponsored: false };
  }
}

export const GET = route(async (): Promise<InfoResponse> => {
  const [chainHead, sidecarChain, contracts] = await Promise.all([
    answers(RPC_URL, "eth_blockNumber"),
    answers(SIDECAR_URL, "eth_chainId"),
    contractState(),
  ]);
  return {
    network: NETWORK,
    chainId: CHAIN_ID,
    chainOnline: chainHead !== undefined,
    sidecarOnline: sidecarChain !== undefined,
    contractsDeployed: contracts.deployed,
    explorerUrl: EXPLORER_URL,
    // The explorer reads the transaction from the sidecar.
    rpcUrl: SIDECAR_URL,
    world: worldConfig(),
    gasSponsored: contracts.gasSponsored,
    tokens: contracts.tokens ?? [
      { address: ETH_TOKEN, symbol: "ETH", name: "Ether", decimals: 18, isTest: false },
    ],
  };
});
