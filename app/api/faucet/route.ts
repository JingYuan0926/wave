import { encodeFunctionData, type Hex } from "viem";
import type { FaucetRequest, FaucetResponse } from "@/lib/api-types";
import { ETH_TOKEN } from "@/lib/api-types";
import { LEGACY_TX, devWallet, publicClient } from "@/lib/chain";
import { ApiFailure, asAddress, deployment, readBody, requireLocal, route } from "@/lib/server/http";
import { withDevKey } from "@/lib/server/roots";
import { TestUSDCAbi } from "@/lib/wave-abi";

const ETH_AMOUNT = BigInt(10) ** BigInt(18);
const USDC_AMOUNT = BigInt(1_000_000_000);
// A new account costs more than a plain transfer under EIP-8037.
const FUND_GAS = BigInt(600_000);
const MINT_GAS = BigInt(500_000);
// The same key pays for root publishing. If it runs out, World ID approvals stop.
const KEY_RESERVE = BigInt(10) * ETH_AMOUNT;
const COOLDOWN_MS = 30_000;

/** One faucet call at a time, so faucet calls cannot fill the dev key lock. */
type FaucetState = { busy: boolean; lastAt: Map<string, number> };
const shared = globalThis as typeof globalThis & { __waveFaucet?: FaucetState };
const state: FaucetState = (shared.__waveFaucet ??= { busy: false, lastAt: new Map() });

async function mined(hash: Hex): Promise<Hex> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new ApiFailure("FAUCET_FAILED", `Faucet tx ${hash} reverted.`, 500);
  return hash;
}

async function fund(address: `0x${string}`, testUsdc: `0x${string}`): Promise<Hex[]> {
  return withDevKey(async () => {
    const eth = await devWallet.sendTransaction({
      to: address,
      value: ETH_AMOUNT,
      gas: FUND_GAS,
      ...LEGACY_TX,
    });
    await mined(eth);
    const usdc = await devWallet.sendTransaction({
      to: testUsdc,
      data: encodeFunctionData({ abi: TestUSDCAbi, functionName: "mint", args: [address, USDC_AMOUNT] }),
      gas: MINT_GAS,
      ...LEGACY_TX,
    });
    await mined(usdc);
    return [eth, usdc];
  });
}

export const POST = route(async (request): Promise<FaucetResponse> => {
  requireLocal(request);
  const body = await readBody<FaucetRequest>(request);
  const address = asAddress(body.address);
  const d = deployment();

  if (state.busy) throw new ApiFailure("FAUCET_BUSY", "The faucet is busy. Try again soon.", 429);
  const key = address.toLowerCase();
  const wait = (state.lastAt.get(key) ?? 0) + COOLDOWN_MS - Date.now();
  if (wait > 0) {
    throw new ApiFailure("FAUCET_COOLDOWN", `This wallet got funds a moment ago. Wait ${Math.ceil(wait / 1000)} seconds.`, 429);
  }

  state.busy = true;
  try {
    const left = await publicClient.getBalance({ address: d.devKeyAddress });
    if (left < KEY_RESERVE + ETH_AMOUNT) {
      throw new ApiFailure("FAUCET_EMPTY", "The faucet keeps its last ETH for root publishing.", 503);
    }
    const txHashes = await fund(address, d.testUsdc);
    state.lastAt.set(key, Date.now());
    return {
      txHashes,
      funded: [
        { token: ETH_TOKEN, amount: ETH_AMOUNT.toString() },
        { token: d.testUsdc, amount: USDC_AMOUNT.toString() },
      ],
    };
  } finally {
    state.busy = false;
  }
});
