// Deploys WAVE's ERC-4337 contracts to Whitechain Sepolia and writes
// deployments/whitechain-sepolia.json. Run `npm run build:wc` first.
//
// Needs in the root .env.local (never commit it, never paste keys in chat):
//   WC_DEPLOYER_KEY  a key holding Sepolia WBT (faucet: https://faucet.testnet.whitechain.io)
//   WC_RELAYER_KEY   the relayer key. Only its address is used here: the paymaster trusts it.
// Optional: WC_PAYMASTER_DEPOSIT (WBT, default 0.2), WC_DEMO_DELAY (seconds, default 0).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
try {
  process.loadEnvFile(path.resolve(ROOT, '../.env.local'))
} catch {
  // Checked below.
}

export const CHAIN_ID = 1874
export const RPC_URL = process.env.WC_RPC_URL || 'https://rpc.testnet.whitechain.io'
export const EXPLORER = 'https://explorer.testnet.whitechain.io'
/** Canonical EntryPoint v0.7. It has code on Whitechain Sepolia (checked with eth_getCode). */
export const ENTRY_POINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address

/** Whitechain test USDT named in the WAVE README. Only its owner can mint it. */
const USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as Address
/** USDC.e from the Portal bridge (docs: build/bridge/portal-bridge). */
const USDC_E = '0x5Eb541ba8A2DD841aF7864c3389162a23ddA8401' as Address

export const whitechainSepolia = defineChain({
  id: CHAIN_ID,
  name: 'Whitechain Sepolia',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } },
})

const D6 = 1_000_000n
const DAY = 86_400
const OWNER = 1 // OWNER_BIT: the owner passkey is the owner method on Whitechain.

/** The same rules as the extension's RULES: under 100 at once (300 a day), up to 1,000 at once
 *  (2,000 a week), above that a 24 hour wait. The account address commits to these values. */
function defaultTiers() {
  return [
    { upTo: 100n * D6, cap: 300n * D6, delay: 0, period: DAY, methods: OWNER },
    { upTo: 1000n * D6, cap: 2000n * D6, delay: 0, period: 7 * DAY, methods: OWNER },
    { upTo: (1n << 96n) - 1n, cap: 0n, delay: DAY, period: 0, methods: OWNER },
  ]
}

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const file = path.join(ROOT, 'artifacts-wc/whitechain/src', `${name}.sol`, `${name}.json`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

function need(name: string): Hex {
  const v = process.env[name]
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`Set ${name} (0x + 64 hex) in the root .env.local`)
  return v as Hex
}

async function main() {
  const deployer = privateKeyToAccount(need('WC_DEPLOYER_KEY'))
  const relayer = privateKeyToAccount(need('WC_RELAYER_KEY')).address
  const deposit = parseEther(process.env.WC_PAYMASTER_DEPOSIT || '0.2')
  const demoDelay = Number(process.env.WC_DEMO_DELAY || 0)

  const client = createPublicClient({ chain: whitechainSepolia, transport: http(RPC_URL) })
  const found = await client.getChainId()
  if (found !== CHAIN_ID) throw new Error(`refusing to deploy: chain ${found} is not ${CHAIN_ID}`)
  if ((await client.getCode({ address: ENTRY_POINT_V07 })) === undefined) throw new Error('EntryPoint v0.7 has no code')

  const balance = await client.getBalance({ address: deployer.address })
  console.log('deployer', deployer.address, 'balance', Number(balance) / 1e18, 'WBT')
  // The six deploy transactions use about 6.2M gas, so about 0.03 WBT at 5 gwei, plus data fees.
  if (balance < deposit + parseEther('0.05')) {
    throw new Error(`deployer needs at least ${Number(deposit) / 1e18 + 0.05} WBT (faucet: https://faucet.testnet.whitechain.io)`)
  }

  const wallet = createWalletClient({ chain: whitechainSepolia, transport: http(RPC_URL), account: deployer })
  const constructorArgs: Record<string, Hex> = {}

  async function deploy(name: string, args: unknown[] = []): Promise<Address> {
    const { abi, bytecode } = artifact(name)
    const hash = await wallet.deployContract({ abi, bytecode, args, chain: whitechainSepolia, account: deployer, type: 'eip1559' })
    const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy ${name} failed: ${hash}`)
    console.log(name.padEnd(24), r.contractAddress, `${EXPLORER}/tx/${hash}`)
    const tx = await client.getTransaction({ hash })
    constructorArgs[r.contractAddress] = `0x${tx.input.slice(bytecode.length)}` as Hex
    return r.contractAddress
  }

  // An open-mint test token, so the wallet can be tried without the owner-minted test USDT.
  const testToken = await deploy('WaveTestToken', ['WAVE Test USDT', 'tUSDT'])
  const validator = await deploy('WavePasskeyValidator')
  const implementation = await deploy('WaveAccount4337', [ENTRY_POINT_V07, validator, USDT, demoDelay])
  const factory = await deploy('WaveAccount4337Factory', [implementation])
  const paymaster = await deploy('WavePaymaster', [ENTRY_POINT_V07, relayer])

  const { abi: pmAbi } = artifact('WavePaymaster')
  const hash = await wallet.writeContract({ address: paymaster, abi: pmAbi, functionName: 'deposit', value: deposit, chain: whitechainSepolia, account: deployer })
  const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (r.status !== 'success') throw new Error(`paymaster deposit failed: ${hash}`)
  console.log('paymaster deposit', Number(deposit) / 1e18, 'WBT', `${EXPLORER}/tx/${hash}`)

  const tokens = [
    { symbol: 'USDT', name: 'Whitechain test USDT', address: USDT, decimals: 6 },
    { symbol: 'USDC', name: 'USDC.e (Portal bridge)', address: USDC_E, decimals: 6 },
    { symbol: 'tUSDT', name: 'WAVE test USDT (open mint)', address: testToken, decimals: 6 },
  ]
  const str = (t: ReturnType<typeof defaultTiers>[number]) => ({ ...t, upTo: t.upTo.toString(), cap: t.cap.toString() })
  const out = {
    network: 'whitechain-sepolia',
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    explorer: EXPLORER,
    deployedAtBlock: Number(r.blockNumber),
    entryPoint: ENTRY_POINT_V07,
    passkeyValidator: validator,
    implementation,
    factory,
    paymaster,
    relayer,
    demoDelay,
    defaultToken: USDT,
    tokens,
    rules: tokens.map((t) => ({ token: t.address, tiers: defaultTiers().map(str) })),
    constructorArgs,
  }
  mkdirSync(path.join(ROOT, 'deployments'), { recursive: true })
  const file = path.join(ROOT, 'deployments/whitechain-sepolia.json')
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log('wrote', file)
}

// Only when run directly, so other scripts can import the constants above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
