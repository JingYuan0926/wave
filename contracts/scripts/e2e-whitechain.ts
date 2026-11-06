// End-to-end check of WAVE on Whitechain, the same steps the extension takes, with a software
// passkey (WebCrypto P-256, BE = 0) instead of Face ID:
//   faucet -> sponsor -> getUserOpHash (from the chain) -> WebAuthn signature -> send
//   then a scheduled transfer: schedule -> wait the delay -> executeScheduled, and schedule -> cancel.
//
//   WC_RELAYER_URL=http://localhost:3100 npx tsx scripts/e2e-whitechain.ts
// Optional on a local node: WC_E2E_MINT_KEY, a funded key that mints extra tUSDT for the
// scheduled transfers, and WC_RPC_URL. Without it, the scheduled part is skipped.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { webcrypto } from 'node:crypto'
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  sha256,
  size,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { whitechainSepolia } from './deploy-whitechain'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const d = JSON.parse(readFileSync(path.join(HERE, '../deployments/whitechain-sepolia.json'), 'utf8'))
const RELAYER = process.env.WC_RELAYER_URL ?? 'http://localhost:3000'
const RPC = process.env.WC_RPC_URL ?? d.rpcUrl
const chain = { ...whitechainSepolia, rpcUrls: { default: { http: [RPC] } } }
const client = createPublicClient({ chain, transport: http(RPC) })
const isLocal = /127\.0\.0\.1|localhost/.test(RPC)

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const OP = '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)'
const factoryAbi = parseAbi([
  'struct WaveTier { uint96 upTo; uint96 cap; uint32 delay; uint24 period; uint8 methods; }',
  'struct AgentRule { address token; WaveTier[] tiers; }',
  'function createAccount(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] rules) returns (address)',
  'function getAddress(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] rules) view returns (address)',
])
const accountAbi = parseAbi([
  'struct Pending { bytes32 callsHash; uint40 notBefore; uint40 createdAt; uint32 version; uint8 status; uint8 kind; uint8 approvals; uint8 proposerBit; }',
  'function execute(bytes32 mode, bytes executionCalldata)',
  'function schedule(uint8 kind, bytes batch, bytes32 salt) returns (bytes32)',
  'function cancel(bytes32 id)',
  'function executeScheduled(bytes32 id, bytes batch)',
  'function pendingOf(bytes32 id) view returns (Pending)',
  'function configVersion() view returns (uint32)',
])
const epAbi = parseAbi([`function getUserOpHash(${OP} op) view returns (bytes32)`, 'function getNonce(address, uint192) view returns (uint256)'])
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address, uint256) returns (bool)', 'function mint(address, uint256)'])
const BATCH = parseAbiParameters('(address target, uint256 value, bytes callData)[]')
const EXECUTE_USER_OP: Hex = '0x8dd7712f'

const tusdt = d.tokens.find((t: { symbol: string }) => t.symbol === 'tUSDT').address as Address
const merchant = '0x000000000000000000000000000000000000dEaD' as Address
const rules = d.rules.map((r: { token: Address; tiers: { upTo: string; cap: string; delay: number; period: number; methods: number }[] }) => ({
  token: r.token,
  tiers: r.tiers.map((t) => ({ ...t, upTo: BigInt(t.upTo), cap: BigInt(t.cap) })),
}))

// ---- software passkey ----
const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
const rawPub = toHex(new Uint8Array(await webcrypto.subtle.exportKey('raw', key.publicKey)))
const x = `0x${rawPub.slice(4, 68)}` as Hex
const y = `0x${rawPub.slice(68)}` as Hex
const createArgs = [x, y, false, true, rules] as const

async function webauthn(challenge: Hex): Promise<Hex> {
  const authData = concat([sha256(stringToHex('wave.local')), '0x05', '0x00000001'])
  const b64 = Buffer.from(challenge.slice(2), 'hex').toString('base64url')
  const cdj = `{"type":"webauthn.get","challenge":"${b64}","origin":"chrome-extension://wave-e2e","crossOrigin":false}`
  const message = concat([authData, sha256(stringToHex(cdj))])
  const sig = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, Buffer.from(message.slice(2), 'hex')))
  const r = toHex(sig.slice(0, 32))
  let s = BigInt(toHex(sig.slice(32)))
  if (s > P256_N / 2n) s = P256_N - s
  return encodePacked(['uint16', 'bytes', 'bytes', 'uint16', 'uint16', 'bytes32', 'bytes32'], [size(authData), authData, stringToHex(cdj), 23, 1, r, toHex(s, { size: 32 })])
}

async function post(p: string, body: unknown) {
  const res = await fetch(`${RELAYER}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await res.json()
  if (!res.ok || j.error) throw new Error(`${p}: ${j.error?.code} ${j.error?.message}`)
  return j
}

const sender = await client.readContract({ address: d.factory, abi: factoryAbi, functionName: 'getAddress', args: createArgs })
const balance = () => client.readContract({ address: tusdt, abi: erc20Abi, functionName: 'balanceOf', args: [sender] })
const fmt = (n: bigint) => `${Number(n) / 1e6} tUSDT`
console.log('wallet (counterfactual)', sender)

async function submit(label: string, inner: Hex) {
  const deployed = ((await client.getCode({ address: sender })) ?? '0x') !== '0x'
  const nonce = await client.readContract({ address: d.entryPoint, abi: epAbi, functionName: 'getNonce', args: [sender, 0n] })
  const op = {
    sender,
    nonce: toHex(nonce),
    initCode: deployed ? '0x' : concat([d.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: createArgs })]),
    callData: concat([EXECUTE_USER_OP, inner]),
    accountGasLimits: '0x',
    preVerificationGas: '0x0',
    gasFees: '0x',
    paymasterAndData: '0x',
    signature: '0x',
  }
  const { op: sp } = await post('/api/wc/sponsor', { op })
  if (sp.callData !== op.callData || sp.initCode !== op.initCode) throw new Error('relayer changed the op')
  const hash = await client.readContract({
    address: d.entryPoint,
    abi: epAbi,
    functionName: 'getUserOpHash',
    args: [{ ...sp, nonce: BigInt(sp.nonce), preVerificationGas: BigInt(sp.preVerificationGas) }],
  })
  const signature = encodeAbiParameters(parseAbiParameters('address, bytes'), [d.passkeyValidator, await webauthn(hash)])
  const res = await post('/api/wc/send', { op: { ...sp, signature } })
  console.log(`${label.padEnd(26)} success=${res.success} ${res.explorerUrl}`)
  if (!res.success) throw new Error(`${label}: the account call reverted ${res.revertReason ?? ''}`)
  return res
}

const transfer = (amount: bigint) =>
  encodeFunctionData({
    abi: accountAbi,
    functionName: 'execute',
    args: [`0x${'00'.repeat(32)}`, encodePacked(['address', 'uint256', 'bytes'], [tusdt, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [merchant, amount] })])],
  })

// 1. Faucet, then a first payment that also deploys the wallet.
const f = await post('/api/wc/faucet', { address: sender })
console.log('faucet'.padEnd(26), f.explorerUrl, '->', fmt(await balance()))
await submit('pay 25 (deploys wallet)', transfer(25_000_000n))
console.log('balance', fmt(await balance()))
await submit('pay 10', transfer(10_000_000n))
console.log('balance', fmt(await balance()))

// 2. Over 1,000: the delay queue. Needs more tUSDT than the faucet gives.
const mintKey = process.env.WC_E2E_MINT_KEY as Hex | undefined
if (!mintKey) {
  console.log('skip the delay queue part: set WC_E2E_MINT_KEY to mint extra tUSDT')
} else {
  const minter = createWalletClient({ chain, transport: http(RPC), account: privateKeyToAccount(mintKey) })
  await client.waitForTransactionReceipt({ hash: await minter.writeContract({ address: tusdt, abi: erc20Abi, functionName: 'mint', args: [sender, 3_000_000_000n], chain, account: minter.account }) })
  const scheduleOf = async (amount: bigint, salt: Hex) => {
    const batch = encodeAbiParameters(BATCH, [[{ target: tusdt, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [merchant, amount] }) }]])
    const version = await client.readContract({ address: sender, abi: accountAbi, functionName: 'configVersion' })
    const id = keccak256(encodeAbiParameters(parseAbiParameters('uint256, address, uint8, bytes32, bytes32, uint32'), [1874n, sender, 0, keccak256(batch), salt, version]))
    await submit(`schedule ${Number(amount) / 1e6}`, encodeFunctionData({ abi: accountAbi, functionName: 'schedule', args: [0, batch, salt] }))
    const p = await client.readContract({ address: sender, abi: accountAbi, functionName: 'pendingOf', args: [id] })
    console.log('  queued: status', p.status, 'runs at', new Date(Number(p.notBefore) * 1000).toISOString())
    return { id, batch, notBefore: Number(p.notBefore) }
  }
  const a = await scheduleOf(1_500_000_000n, keccak256(toHex('e2e-a')))
  const b = await scheduleOf(1_200_000_000n, keccak256(toHex('e2e-b')))
  await submit('cancel the 1,200', encodeFunctionData({ abi: accountAbi, functionName: 'cancel', args: [b.id] }))
  console.log('  1,200 status', (await client.readContract({ address: sender, abi: accountAbi, functionName: 'pendingOf', args: [b.id] })).status, '(4 = cancelled)')
  if (isLocal) {
    const test = createTestClient({ chain, transport: http(RPC), mode: 'hardhat' })
    await test.increaseTime({ seconds: d.demoDelay || 86_400 })
    await test.mine({ blocks: 1 })
  } else {
    const wait = a.notBefore * 1000 - Date.now() + 5000
    console.log(`  waiting ${Math.ceil(wait / 1000)} s for the delay`)
    await new Promise((r) => setTimeout(r, Math.max(0, wait)))
  }
  const before = await balance()
  await submit('run the 1,500', encodeFunctionData({ abi: accountAbi, functionName: 'executeScheduled', args: [a.id, a.batch] }))
  console.log('  paid', fmt(before - (await balance())))
}
console.log('done. final balance', fmt(await balance()))
