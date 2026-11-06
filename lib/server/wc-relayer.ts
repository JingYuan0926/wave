// WAVE on Whitechain Sepolia: the relayer. Server side only.
//
// Whitechain has the EntryPoint v0.7 contract but no documented bundler, so this relayer is the
// bundler. It also signs for WavePaymaster, which pays the WBT gas. It sponsors only:
//   - WAVE accounts from our factory (the initCode or the clone code proves it),
//   - executeUserOp of plain transfers of our listed tokens, or schedule / cancel / executeScheduled,
//   - fixed gas limits and a fee cap,
//   - a daily number of operations per wallet.
// These limits reduce exposure. They do not protect against many wallets or failed operations.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  defineChain,
  http,
  isAddressEqual,
  parseAbi,
  parseAbiParameters,
  size,
  slice,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ApiFailure, asAddress, asHex } from './http'

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

export type WcTier = { upTo: string; cap: string; delay: number; period: number; methods: number }
export type WcDeployment = {
  chainId: number
  rpcUrl: string
  explorer: string
  entryPoint: Address
  passkeyValidator: Address
  implementation: Address
  factory: Address
  paymaster: Address
  relayer: Address
  tokens: { symbol: string; name: string; address: Address; decimals: number }[]
  rules: { token: Address; tiers: WcTier[] }[]
}

const DEPLOYMENT_FILE = path.join(process.cwd(), 'contracts/deployments/whitechain-sepolia.json')

export function wcDeployment(): WcDeployment {
  try {
    return JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8')) as WcDeployment
  } catch {
    throw new ApiFailure(
      'NOT_DEPLOYED',
      'WAVE is not deployed on Whitechain Sepolia yet. Run npm run deploy:wc in contracts/.',
      503,
    )
  }
}

function clients(d: WcDeployment) {
  const key = process.env.WC_RELAYER_KEY
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new ApiFailure('RELAYER_NOT_SET', 'Set WC_RELAYER_KEY in .env.local to run the relayer.', 503)
  }
  const chain = defineChain({
    id: d.chainId,
    name: 'Whitechain Sepolia',
    nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
    rpcUrls: { default: { http: [process.env.WC_RPC_URL || d.rpcUrl] } },
  })
  const account = privateKeyToAccount(key as Hex)
  if (!isAddressEqual(account.address, d.relayer)) {
    throw new ApiFailure('RELAYER_MISMATCH', 'WC_RELAYER_KEY is not the key the paymaster trusts.', 503)
  }
  const transport = http(process.env.WC_RPC_URL || d.rpcUrl)
  return {
    account,
    publicClient: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ chain, transport, account }),
  }
}

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

const PACKED_OP =
  '(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)'

export const entryPointAbi = parseAbi([
  `function handleOps(${PACKED_OP}[] ops, address beneficiary)`,
  `function getUserOpHash(${PACKED_OP} op) view returns (bytes32)`,
  'function getNonce(address sender, uint192 key) view returns (uint256)',
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  'event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)',
  'error FailedOp(uint256 opIndex, string reason)',
  'error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)',
])

const paymasterAbi = parseAbi([
  `function getHash(${PACKED_OP} userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)`,
])

const factoryAbi = parseAbi([
  'struct WaveTier { uint96 upTo; uint96 cap; uint32 delay; uint24 period; uint8 methods; }',
  'struct AgentRule { address token; WaveTier[] tiers; }',
  'function createAccount(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] rules) returns (address)',
  'function getAddress(bytes32 x, bytes32 y, bool backupEligible, bool requireUV, AgentRule[] rules) view returns (address)',
])

const accountAbi = parseAbi([
  `function executeUserOp(${PACKED_OP} userOp, bytes32 userOpHash)`,
  'function execute(bytes32 mode, bytes executionCalldata)',
  'function schedule(uint8 kind, bytes batch, bytes32 salt) returns (bytes32)',
  'function cancel(bytes32 id)',
  'function executeScheduled(bytes32 id, bytes batch)',
])

const erc20Abi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

// ---------------------------------------------------------------------------
// User operations (EntryPoint v0.7 packed form, hex strings over JSON)
// ---------------------------------------------------------------------------

export type PackedUserOp = {
  sender: Address
  nonce: Hex
  initCode: Hex
  callData: Hex
  accountGasLimits: Hex
  preVerificationGas: Hex
  gasFees: Hex
  paymasterAndData: Hex
  signature: Hex
}

const EXECUTE_USER_OP = '0x8dd7712f' // executeUserOp((...),bytes32)
const MODE_SINGLE = `0x${'00'.repeat(32)}` as Hex
const MODE_BATCH = `0x01${'00'.repeat(31)}` as Hex

/** Fixed limits. They cover a first operation that deploys the wallet. */
const VERIFICATION_GAS = 1_200_000n
const CALL_GAS = 400_000n
const PRE_VERIFICATION_GAS = 120_000n
const PAYMASTER_VERIFICATION_GAS = 120_000n
const PAYMASTER_POSTOP_GAS = 0n
const MAX_FEE_CAP = 50_000_000_000n // 50 gwei
const SPONSOR_WINDOW_S = 300

const pack128 = (hi: bigint, lo: bigint): Hex => `0x${hi.toString(16).padStart(32, '0')}${lo.toString(16).padStart(32, '0')}`

function asOp(value: unknown): PackedUserOp {
  if (typeof value !== 'object' || value === null) throw new ApiFailure('BAD_REQUEST', 'op is missing.')
  const o = value as Record<string, unknown>
  const hexOrEmpty = (v: unknown, label: string): Hex => (v === '0x' || v === undefined ? '0x' : asHex(v, label))
  return {
    sender: asAddress(o.sender, 'op.sender'),
    nonce: asHex(o.nonce, 'op.nonce'),
    initCode: hexOrEmpty(o.initCode, 'op.initCode'),
    callData: asHex(o.callData, 'op.callData'),
    accountGasLimits: hexOrEmpty(o.accountGasLimits, 'op.accountGasLimits'),
    preVerificationGas: hexOrEmpty(o.preVerificationGas, 'op.preVerificationGas'),
    gasFees: hexOrEmpty(o.gasFees, 'op.gasFees'),
    paymasterAndData: hexOrEmpty(o.paymasterAndData, 'op.paymasterAndData'),
    signature: hexOrEmpty(o.signature, 'op.signature'),
  }
}

const toAbiOp = (op: PackedUserOp) => ({
  ...op,
  nonce: BigInt(op.nonce),
  preVerificationGas: BigInt(op.preVerificationGas === '0x' ? 0 : op.preVerificationGas),
  accountGasLimits: op.accountGasLimits === '0x' ? (`0x${'00'.repeat(32)}` as Hex) : op.accountGasLimits,
  gasFees: op.gasFees === '0x' ? (`0x${'00'.repeat(32)}` as Hex) : op.gasFees,
})

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type Ctx = ReturnType<typeof clients> & { d: WcDeployment }

async function checkSender(ctx: Ctx, op: PackedUserOp): Promise<void> {
  const { d, publicClient } = ctx
  if (op.initCode !== '0x') {
    if (size(op.initCode) < 24 || !isAddressEqual(slice(op.initCode, 0, 20), d.factory)) {
      throw new ApiFailure('NOT_SPONSORED', 'initCode does not use the WAVE factory.')
    }
    const { functionName, args } = decodeFunctionData({ abi: factoryAbi, data: slice(op.initCode, 20) })
    if (functionName !== 'createAccount') throw new ApiFailure('NOT_SPONSORED', 'initCode must call createAccount.')
    const predicted = await publicClient.readContract({
      address: d.factory,
      abi: factoryAbi,
      functionName: 'getAddress',
      args,
    })
    if (!isAddressEqual(predicted, op.sender)) throw new ApiFailure('NOT_SPONSORED', 'initCode does not match the sender.')
    return
  }
  const code = (await publicClient.getCode({ address: op.sender })) ?? '0x'
  // Solady LibClone's 44-byte minimal proxy (not the EIP-1167 bytes), with our implementation.
  const impl = d.implementation.slice(2).toLowerCase()
  if (code.toLowerCase() !== `0x3d3d3d3d363d3d37363d73${impl}5af43d3d93803e602a57fd5bf3`) {
    throw new ApiFailure('NOT_SPONSORED', 'The sender is not a WAVE wallet, and the op has no initCode.')
  }
}

function checkTransfers(d: WcDeployment, calls: { target: Address; value: bigint; callData: Hex }[]): void {
  if (calls.length === 0 || calls.length > 8) throw new ApiFailure('NOT_SPONSORED', 'Send 1 to 8 transfers.')
  for (const c of calls) {
    if (c.value !== 0n) throw new ApiFailure('NOT_SPONSORED', 'The relayer sponsors token transfers only.')
    if (!d.tokens.some((t) => isAddressEqual(t.address, c.target))) {
      throw new ApiFailure('NOT_SPONSORED', 'The token is not listed.')
    }
    const { functionName } = decodeFunctionData({ abi: erc20Abi, data: c.callData })
    if (functionName !== 'transfer') throw new ApiFailure('NOT_SPONSORED', 'Only transfer() is sponsored.')
  }
}

const BATCH = parseAbiParameters('(address target, uint256 value, bytes callData)[]')

function decodeBatch(batch: Hex) {
  return [...decodeAbiParameters(BATCH, batch)[0]]
}

function checkCallData(d: WcDeployment, callData: Hex): void {
  if (size(callData) < 8 || slice(callData, 0, 4) !== EXECUTE_USER_OP) {
    throw new ApiFailure('NOT_SPONSORED', 'callData must start with executeUserOp.')
  }
  let inner
  try {
    inner = decodeFunctionData({ abi: accountAbi, data: slice(callData, 4) })
  } catch {
    throw new ApiFailure('NOT_SPONSORED', 'The account call is not one the relayer sponsors.')
  }
  if (inner.functionName === 'execute') {
    const [mode, data] = inner.args
    if (mode === MODE_SINGLE) {
      checkTransfers(d, [{ target: slice(data, 0, 20), value: BigInt(slice(data, 20, 52)), callData: slice(data, 52) }])
    } else if (mode === MODE_BATCH) {
      checkTransfers(d, decodeBatch(data))
    } else {
      throw new ApiFailure('NOT_SPONSORED', 'Unknown execution mode.')
    }
  } else if (inner.functionName === 'schedule') {
    if (inner.args[0] !== 0) throw new ApiFailure('NOT_SPONSORED', 'Only normal batches.')
    checkTransfers(d, decodeBatch(inner.args[1]))
  } else if (inner.functionName === 'executeScheduled') {
    checkTransfers(d, decodeBatch(inner.args[1]))
  } else if (inner.functionName !== 'cancel') {
    throw new ApiFailure('NOT_SPONSORED', 'The account call is not one the relayer sponsors.')
  }
}

// ---------------------------------------------------------------------------
// Budget (same shape as the local sponsor in sponsor.ts, separate counters)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000
const shared = globalThis as typeof globalThis & { __waveWcBudget?: Map<string, { day: number; used: number }> }
const budgets = (shared.__waveWcBudget ??= new Map())

function dailyLimit(): number {
  const n = Number(process.env.WC_SPONSOR_DAILY_TX)
  return Number.isInteger(n) && n >= 0 && process.env.WC_SPONSOR_DAILY_TX ? n : 30
}

function takeBudget(address: Address): boolean {
  const day = Math.floor(Date.now() / DAY_MS)
  const key = address.toLowerCase()
  const b = budgets.get(key)?.day === day ? budgets.get(key)! : { day, used: 0 }
  if (b.used >= dailyLimit()) return false
  b.used += 1
  budgets.set(key, b)
  return true
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function context(): Ctx {
  const d = wcDeployment()
  return { d, ...clients(d) }
}

/** Fills the gas fields, checks the op and signs the paymaster data. The wallet then signs
 *  the userOpHash with its passkey. The wallet computes that hash itself before it signs. */
export async function sponsor(body: { op?: unknown }) {
  const ctx = context()
  const op = asOp(body.op)
  checkCallData(ctx.d, op.callData)
  await checkSender(ctx, op)

  const nonce = await ctx.publicClient.readContract({
    address: ctx.d.entryPoint,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [op.sender, 0n],
  })
  if (BigInt(op.nonce) !== nonce) throw new ApiFailure('BAD_NONCE', `The next nonce is ${nonce}.`)

  const fees = await ctx.publicClient.estimateFeesPerGas()
  const maxFee = fees.maxFeePerGas > MAX_FEE_CAP ? MAX_FEE_CAP : fees.maxFeePerGas
  const priority = fees.maxPriorityFeePerGas > maxFee ? maxFee : fees.maxPriorityFeePerGas

  op.accountGasLimits = pack128(VERIFICATION_GAS, CALL_GAS)
  op.preVerificationGas = `0x${PRE_VERIFICATION_GAS.toString(16)}`
  op.gasFees = pack128(priority, maxFee)
  op.signature = '0x'

  if (!takeBudget(op.sender)) throw new ApiFailure('BUDGET_USED', 'This wallet used its sponsored operations for today.', 429)

  const validUntil = Math.floor(Date.now() / 1000) + SPONSOR_WINDOW_S
  const head = `${ctx.d.paymaster.toLowerCase()}${pack128(PAYMASTER_VERIFICATION_GAS, PAYMASTER_POSTOP_GAS).slice(2)}` as Hex
  const times = `${validUntil.toString(16).padStart(64, '0')}${'0'.repeat(64)}`
  op.paymasterAndData = `${head}${times}` as Hex
  const hash = await ctx.publicClient.readContract({
    address: ctx.d.paymaster,
    abi: paymasterAbi,
    functionName: 'getHash',
    args: [toAbiOp(op), validUntil, 0],
  })
  const sig = await ctx.account.signMessage({ message: { raw: hash } })
  op.paymasterAndData = `${op.paymasterAndData}${sig.slice(2)}` as Hex

  return { op, validUntil, entryPoint: ctx.d.entryPoint, chainId: ctx.d.chainId }
}

// One handleOps at a time, so the relayer's own nonce never collides.
let queue: Promise<unknown> = Promise.resolve()

/** Checks the signed op again, simulates handleOps, sends it and reports the result. */
export async function send(body: { op?: unknown }) {
  const ctx = context()
  const op = asOp(body.op)
  checkCallData(ctx.d, op.callData)
  if (size(op.paymasterAndData) < 20 || !isAddressEqual(slice(op.paymasterAndData, 0, 20), ctx.d.paymaster)) {
    throw new ApiFailure('NOT_SPONSORED', 'Ask /api/wc/sponsor first.')
  }
  const args = [[toAbiOp(op)], ctx.account.address] as const

  const run = async () => {
    try {
      await ctx.publicClient.simulateContract({
        address: ctx.d.entryPoint,
        abi: entryPointAbi,
        functionName: 'handleOps',
        args,
        account: ctx.account,
      })
    } catch (e) {
      const reason = (e as { shortMessage?: string }).shortMessage ?? 'simulation failed'
      throw new ApiFailure('OP_REJECTED', reason.slice(0, 300))
    }
    const hash = await ctx.wallet.writeContract({
      address: ctx.d.entryPoint,
      abi: entryPointAbi,
      functionName: 'handleOps',
      args,
      gas: VERIFICATION_GAS + CALL_GAS + PAYMASTER_VERIFICATION_GAS + 300_000n,
    })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
    let success = false
    let revertReason: Hex | undefined
    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, ctx.d.entryPoint)) continue
      try {
        const ev = decodeEventLog({ abi: entryPointAbi, data: log.data, topics: log.topics })
        if (ev.eventName === 'UserOperationEvent') success = ev.args.success
        if (ev.eventName === 'UserOperationRevertReason') revertReason = ev.args.revertReason
      } catch {
        // Not an EntryPoint event we read.
      }
    }
    return {
      txHash: hash,
      status: receipt.status,
      success,
      revertReason,
      explorerUrl: `${ctx.d.explorer}/tx/${hash}`,
    }
  }

  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

// ---------------------------------------------------------------------------
// Test token faucet: tUSDT is WAVE's own open-mint token, so a wallet can be tried without the
// owner-minted Whitechain test USDT. Once a day per address.
// ---------------------------------------------------------------------------

const FAUCET_AMOUNT = 500_000_000n // 500 tUSDT, 6 decimals
const mintAbi = parseAbi(['function mint(address to, uint256 amount)'])
const faucetShared = globalThis as typeof globalThis & { __waveWcFaucet?: Map<string, number> }
const faucetDays = (faucetShared.__waveWcFaucet ??= new Map())

export async function faucet(body: { address?: unknown }) {
  const ctx = context()
  const to = asAddress(body.address)
  const token = ctx.d.tokens.find((t) => t.symbol === 'tUSDT')
  if (!token) throw new ApiFailure('NO_TEST_TOKEN', 'This deployment has no test token.', 404)
  const day = Math.floor(Date.now() / DAY_MS)
  if (faucetDays.get(to.toLowerCase()) === day) {
    throw new ApiFailure('FAUCET_USED', 'This wallet already got test tokens today.', 429)
  }
  faucetDays.set(to.toLowerCase(), day)
  const run = async () => {
    const hash = await ctx.wallet.writeContract({ address: token.address, abi: mintAbi, functionName: 'mint', args: [to, FAUCET_AMOUNT] })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })
    if (receipt.status !== 'success') throw new ApiFailure('FAUCET_FAILED', 'The mint failed.', 502)
    return { txHash: hash, explorerUrl: `${ctx.d.explorer}/tx/${hash}`, amount: '500' }
  }
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result.catch((e) => {
    faucetDays.delete(to.toLowerCase())
    throw e
  })
}

// ---------------------------------------------------------------------------
// CORS: the extension calls from chrome-extension:// or from its localhost dev server.
// ---------------------------------------------------------------------------

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? ''
  const allowed =
    origin.startsWith('chrome-extension://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  return allowed
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        vary: 'origin',
      }
    : {}
}
