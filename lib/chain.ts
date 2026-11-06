// Network settings and the JSON-RPC client. Server side and scripts only.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export type WaveNetwork = 'local' | 'devnet'

const NETWORKS: Record<WaveNetwork, { rpc: string; sidecar: string; explorer: string }> = {
  local: {
    rpc: 'http://localhost:8545',
    sidecar: 'http://localhost:14337/rpc',
    explorer: 'http://localhost:5173',
  },
  devnet: {
    rpc: 'https://altmempool.forshtat.com',
    sidecar: 'https://altmempool.forshtat.com/rpc',
    explorer: 'https://explorer.altmempool.wtf',
  },
}

/** Set WAVE_NETWORK in .env.local. Both networks use chain 1337. */
export const NETWORK: WaveNetwork = process.env.WAVE_NETWORK === 'devnet' ? 'devnet' : 'local'

export const CHAIN_ID = 1337
export const RPC_URL = process.env.WAVE_RPC_URL || NETWORKS[NETWORK].rpc
export const SIDECAR_URL = process.env.WAVE_SIDECAR_URL || NETWORKS[NETWORK].sidecar
export const EXPLORER_URL = process.env.WAVE_EXPLORER_URL || NETWORKS[NETWORK].explorer

export const NONCE_MANAGER: Address = '0x0000000000000000000000000000000000008250'
export const RECENT_ROOT_ADDRESS: Address = '0x0000000000000000000000000000000000008272'

function devKey(): Hex {
  const key = process.env.WAVE_DEV_KEY as Hex | undefined
  if (key) return key
  if (NETWORK === 'devnet') throw new Error('Set WAVE_DEV_KEY in .env.local for WAVE_NETWORK=devnet')
  return keccak256(toHex('wave local dev key'))
}

/**
 * The key that deploys, publishes roots and runs the faucet. The local default holds no real
 * value, and anyone can derive it. So the public devnet needs its own key: with a derivable
 * key, anyone could write to our root source. The sidecar bundler uses the genesis key, so this
 * key stays apart.
 */
export const DEV_KEY: Hex = devKey()

/**
 * Signs for the gas station on the local network. It holds no ETH. Anyone can derive this key,
 * so it must never protect real value. contracts/scripts/deploy.ts derives the same key.
 */
export const SPONSOR_KEY: Hex = keccak256(toHex('wave local sponsor key'))

export type Deployment = {
  chainId: number
  rpcUrl: string
  deployedAtBlock: number
  devKeyAddress: Address
  rootPublisher: Address
  rootSalt: Hex
  rootSourceId: Hex
  semaphoreVerifier: Address
  recentRootRead: Address
  worldIdValidator: Address
  passkeyValidators: [Address, Address, Address]
  implementation: Address
  factory: Address
  testUsdc: Address
  /** Absent in a deployment from before agent wallets. */
  agentKeyValidator?: Address
  /** Local network only. The devnet has no sponsor. */
  gasStation?: Address
  sponsor?: Address
}

export type Sponsor = { station: Address; signer: Address }

/** The gas sponsor of this network. Null on the devnet: there each wallet pays its own gas. */
export function sponsorOf(d: Deployment): Sponsor | null {
  if (NETWORK !== 'local' || !d.gasStation || !d.sponsor) return null
  return { station: d.gasStation, signer: d.sponsor }
}

/** Reads contracts/deployments/<network>.json. Throws if the contracts are not deployed. */
export function loadDeployment(root = process.cwd()): Deployment {
  const file = process.env.WAVE_DEPLOYMENT ?? path.join(root, `contracts/deployments/${NETWORK}.json`)
  return JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, 'utf8')) as Deployment
}

const chain = {
  id: CHAIN_ID,
  name: 'wave-local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const

export const publicClient: PublicClient = createPublicClient({ chain, transport: http(RPC_URL) })

export const devWallet = createWalletClient({
  chain,
  transport: http(RPC_URL),
  account: privateKeyToAccount(DEV_KEY),
})

/** Legacy transaction settings. 5 gwei is above the local base fee. */
export const LEGACY_TX = { type: 'legacy', gasPrice: 5_000_000_000n } as const

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
    readonly method: string,
  ) {
    super(message)
  }
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } }
  if (body.error) throw new RpcError(body.error.code, body.error.message, body.error.data, method)
  return body.result as T
}

/** The hash of block 0. A restarted chain has a new one, and an unchanged contract address may not. */
export const genesisHash = async (): Promise<Hex> =>
  (await rpc<{ hash: Hex }>(RPC_URL, 'eth_getBlockByNumber', ['0x0', false])).hash

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function explorerLink(hash: Hex): string {
  return `${EXPLORER_URL}/tx/${hash}?node=${encodeURIComponent(SIDECAR_URL)}`
}
