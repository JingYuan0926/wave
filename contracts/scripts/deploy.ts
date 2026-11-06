// Deploys the WAVE contracts and writes deployments/<network>.json.
// WAVE_NETWORK in the root .env.local selects local or devnet. Only chain 1337 is allowed here.
// Run `npm run compile` first.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodePacked,
  toHex,
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
  // The file is optional. The defaults select the local network.
}
const NETWORK = process.env.WAVE_NETWORK === 'devnet' ? 'devnet' : 'local'
const RPC_URL =
  process.env.WAVE_RPC_URL ||
  (NETWORK === 'devnet' ? 'https://altmempool.forshtat.com' : 'http://localhost:8545')
const CHAIN_ID = 1337

// The public genesis key of the local devnet. It holds no real value.
const GENESIS_KEY = '0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15'
if (NETWORK === 'devnet' && !process.env.WAVE_DEV_KEY) {
  throw new Error('Set WAVE_DEV_KEY in .env.local, and fund it, for WAVE_NETWORK=devnet')
}
// The local default is a key that anyone can derive. The sidecar bundler uses the genesis key,
// so this key does the deploys, the root publishing and the faucet. That keeps the nonces apart.
const DEV_KEY = (process.env.WAVE_DEV_KEY as Hex | undefined) || keccak256(toHex('wave local dev key'))
const ROOT_SALT = keccak256(toHex('wave-world-roots'))

// Signs for the gas station on the local network. It holds no ETH. Anyone can derive this key,
// so it must never protect real value. lib/chain.ts derives the same key.
const SPONSOR_KEY = keccak256(toHex('wave local sponsor key'))
const STATION_FUNDS = 100n * 10n ** 18n

// Creation code of src/RecentRootRead.yul.
const RECENT_ROOT_READ_INIT = '0x600c80600a5f395ff3fe5f35602035b65f5260205ff3' as Hex

const chain = {
  id: CHAIN_ID,
  name: 'wave-local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const

const legacy = { type: 'legacy', gasPrice: 5_000_000_000n, gas: 40_000_000n } as const

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const file = path.join(ROOT, 'artifacts/src', `${name}.sol`, `${name}.json`)
  return JSON.parse(readFileSync(file, 'utf8'))
}

async function main() {
  const client = createPublicClient({ chain, transport: http(RPC_URL) })
  const found = await client.getChainId()
  if (found !== CHAIN_ID) throw new Error(`refusing to deploy: chain ${found} is not ${CHAIN_ID}`)

  const genesis = createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(GENESIS_KEY) })
  const dev = createWalletClient({ chain, transport: http(RPC_URL), account: privateKeyToAccount(DEV_KEY) })
  const devAddress = dev.account.address

  if (NETWORK === 'local' && (await client.getBalance({ address: devAddress })) < 100n * 10n ** 18n) {
    const hash = await genesis.sendTransaction({ to: devAddress, value: 1000n * 10n ** 18n, ...legacy, gas: 600_000n })
    const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (r.status !== 'success') throw new Error(`funding the dev key failed: ${hash}`)
    console.log('funded dev key', devAddress)
  }

  async function raw(label: string, data: Hex): Promise<Address> {
    const hash = await dev.sendTransaction({ to: null, data, ...legacy })
    const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy ${label} failed: ${hash}`)
    console.log(label.padEnd(24), r.contractAddress, 'gas', r.gasUsed)
    return r.contractAddress
  }

  async function deploy(name: string, args: unknown[] = [], label = name): Promise<Address> {
    const { abi, bytecode } = artifact(name)
    const hash = await dev.deployContract({ abi, bytecode, args, ...legacy })
    const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (r.status !== 'success' || !r.contractAddress) throw new Error(`deploy ${label} failed: ${hash}`)
    console.log(label.padEnd(24), r.contractAddress, 'gas', r.gasUsed)
    return r.contractAddress
  }

  const testUsdc = await deploy('TestUSDC')
  const verifier = await deploy('SemaphoreVerifier')
  const recentRootRead = await raw('RecentRootRead', RECENT_ROOT_READ_INIT)
  const worldIdValidator = await deploy('WorldIDFrameValidator', [verifier, recentRootRead])
  const passkeyValidators = [
    await deploy('PasskeyFrameValidator', [1], 'PasskeyFrameValidator 1'),
    await deploy('PasskeyFrameValidator', [2], 'PasskeyFrameValidator 2'),
    await deploy('PasskeyFrameValidator', [3], 'PasskeyFrameValidator 3'),
  ]
  const agentKeyValidator = await deploy('AgentKeyFrameValidator')
  const implementation = await deploy('WaveAccount', [testUsdc, agentKeyValidator])
  const factory = await deploy('WaveAccountFactory')

  // The sponsor runs on the local network only. On the devnet each wallet pays its own gas.
  const sponsor = privateKeyToAccount(SPONSOR_KEY).address
  const gasStation = NETWORK === 'local' ? await deploy('WaveGasStation', [sponsor, devAddress]) : undefined
  if (gasStation) {
    const hash = await dev.sendTransaction({ to: gasStation, value: STATION_FUNDS, ...legacy, gas: 600_000n })
    const r = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (r.status !== 'success') throw new Error(`funding the gas station failed: ${hash}`)
    console.log('funded gas station with', STATION_FUNDS, 'wei')
  }

  const out = {
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    deployedAtBlock: Number(await client.getBlockNumber()),
    devKeyAddress: devAddress,
    rootPublisher: devAddress,
    rootSalt: ROOT_SALT,
    rootSourceId: keccak256(encodePacked(['address', 'bytes32'], [devAddress, ROOT_SALT])),
    semaphoreVerifier: verifier,
    recentRootRead,
    worldIdValidator,
    passkeyValidators,
    agentKeyValidator,
    implementation,
    factory,
    testUsdc,
    ...(gasStation ? { gasStation, sponsor } : {}),
  }
  mkdirSync(path.join(ROOT, 'deployments'), { recursive: true })
  const file = path.join(ROOT, `deployments/${NETWORK}.json`)
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
  console.log('wrote', file)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
