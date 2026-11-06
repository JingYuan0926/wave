// Plain text for frames and calls. The server reads the built calls, not the request, so the
// review shows what the transaction really does. Server side only.
import { decodeAbiParameters, decodeFunctionData, numberToHex, size, slice, type Address, type Hex } from 'viem'
import type { DecodedAction, MethodRef, PasskeySlot, TokenInfo } from '../api-types'
import { ETH_TOKEN, PASSKEY_SLOTS } from '../api-types'
import type { Deployment } from '../chain'
import { AGENT_BIT, decodeBatch, SMALL_TIER, WORLD_BIT, type Call } from '../policy'
import { formatDuration, formatPeriod, plainAmount, shortHex } from '../ui/format'
import { TestUSDCAbi, WaveAccountAbi } from '../wave-abi'
import { ApiFailure } from './http'

export const tokensOf = (d: Deployment): TokenInfo[] => [
  { address: ETH_TOKEN, symbol: 'ETH', name: 'Ether', decimals: 18, isTest: false },
  // The symbol is not plain USDC, so that every text that names the token marks it as a test token.
  { address: d.testUsdc, symbol: 'tUSDC', name: 'Test USDC', decimals: 6, isTest: true },
]

/** Compares text, because chain data can hold a value that is not a valid address. */
const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const tokenOf = (d: Deployment, address: Address): TokenInfo | undefined =>
  tokensOf(d).find((token) => sameAddress(token.address, address))

export function methodOf(d: Deployment, validator: Address): MethodRef | null {
  if (sameAddress(validator, d.worldIdValidator)) return { kind: 'world' }
  if (d.agentKeyValidator && sameAddress(validator, d.agentKeyValidator)) return { kind: 'agent' }
  const index = d.passkeyValidators.findIndex((item) => sameAddress(item, validator))
  return index < 0 ? null : { kind: 'passkey', slot: PASSKEY_SLOTS[index] }
}

/**
 * The validator in a nonce key. Null if the key cannot name one. The RPC can drop leading zeros,
 * and anyone can send a small key or a key above 160 bits.
 */
export function validatorOfKey(key: Hex | bigint): Address | null {
  const value = BigInt(key)
  if (value === 0n || value >> 160n !== 0n) return null
  return numberToHex(value, { size: 20 })
}

/** ERC7579Utils runs a call with target 0 as a call to the account. */
const isSelfCall = (account: Address, target: Address): boolean =>
  BigInt(target) === 0n || sameAddress(target, account)

export function validatorOf(d: Deployment, method: MethodRef): Address {
  if (method.kind === 'world') return d.worldIdValidator
  if (method.kind === 'passkey') return d.passkeyValidators[method.slot - 1]
  if (d.agentKeyValidator) return d.agentKeyValidator
  throw new ApiFailure('CONTRACTS_NOT_DEPLOYED', 'This deployment has no agent wallets. Deploy the contracts again.', 503)
}

const slotOfModule = (d: Deployment, module: Address): PasskeySlot | null => {
  const ref = methodOf(d, module)
  return ref?.kind === 'passkey' ? ref.slot : null
}

export type TransferFacts = { token: Address; to: Address; amount: bigint }

/** The transfer in a call, or null if the call is not a plain transfer. */
export function transferOf(call: Call): TransferFacts | null {
  if (call.callData === '0x') return { token: ETH_TOKEN, to: call.target, amount: call.value }
  if (call.value !== 0n || size(call.callData) !== 68 || slice(call.callData, 0, 4) !== '0xa9059cbb') return null
  const { args } = decodeFunctionData({ abi: TestUSDCAbi, data: call.callData })
  const [to, amount] = args as readonly [Address, bigint]
  return { token: call.target, to, amount }
}

const methodNames = (mask: number): string => {
  const names: string[] = []
  if (mask & WORLD_BIT) names.push('World ID')
  for (const slot of PASSKEY_SLOTS) if (mask & (1 << slot)) names.push(`Passkey ${slot}`)
  if (mask & AGENT_BIT) names.push('Agent key')
  return names.length > 0 ? names.join(', ') : 'no method'
}

type RawTier = { upTo: bigint; cap: bigint; delay: number; period: number; methods: number }

function tierLine(tier: RawTier, index: number, token: TokenInfo | undefined) {
  const unit = (value: bigint) =>
    token ? `${plainAmount(value, token.decimals)} ${token.symbol}` : value.toString()
  const parts = [
    `up to ${unit(tier.upTo)}`,
    methodNames(tier.methods),
    tier.delay > 0 ? `${formatDuration(tier.delay).toLowerCase()} delay` : 'no delay',
    tier.cap > 0n ? `${unit(tier.cap)} per ${formatPeriod(tier.period)}` : 'no cap',
  ]
  if (tier.methods & SMALL_TIER) parts.push('small')
  return { label: `Tier ${index + 1}`, value: parts.join(', ') }
}

type AgentCall = { fn: string; args: readonly unknown[] }

/** The agent administration function in a call, or null. */
export function agentCallOf(call: Call): AgentCall | null {
  if (call.value !== 0n || size(call.callData) < 4) return null
  try {
    const { functionName, args } = decodeFunctionData({ abi: WaveAccountAbi, data: call.callData })
    return functionName.startsWith('agent') ? { fn: functionName, args: args ?? [] } : null
  } catch {
    return null
  }
}

/** These calls give an agent more power, so the main wallet queues them for 48 hours. */
export const isAgentLoosen = (call: Call): boolean =>
  ['agentUnpause', 'agentSetTiers', 'agentSetKey'].includes(agentCallOf(call)?.fn ?? '')

function describeAgentCall(d: Deployment, account: Address, agent: Address, { fn, args }: AgentCall): DecodedAction {
  const wallet = { label: 'Agent wallet', value: agent, mono: true }
  const rulesLines = (address: Address, tiers: readonly RawTier[]) => {
    const token = tokenOf(d, address)
    return tiers.map((tier, index) => {
      const line = tierLine(tier, index, token)
      return { ...line, label: `${token?.symbol ?? shortHex(address)} ${line.label.toLowerCase()}` }
    })
  }
  switch (fn) {
    case 'agentSetup': {
      const [signer, rules] = args as readonly [Address, readonly { token: Address; tiers: readonly RawTier[] }[]]
      return {
        title: 'Create an agent wallet',
        lines: [
          wallet,
          { label: 'Agent key', value: signer, mono: true },
          ...rules.flatMap((rule) => rulesLines(rule.token, rule.tiers)),
        ],
        warning: 'The agent key can spend inside these limits with no approval from you.',
      }
    }
    case 'agentRevoke':
      return { title: 'Revoke the agent key', lines: [wallet] }
    case 'agentPause':
      return { title: 'Pause the agent', lines: [wallet] }
    case 'agentUnpause':
      return {
        title: 'Unpause the agent',
        lines: [wallet],
        warning: 'The agent key gets its power back.',
      }
    case 'agentTighten':
    case 'agentSetTiers': {
      const [address, tiers] = args as readonly [Address, readonly RawTier[]]
      const symbol = tokenOf(d, address)?.symbol ?? shortHex(address)
      return fn === 'agentTighten'
        ? { title: `Tighten the agent's ${symbol} limits`, lines: [wallet, ...rulesLines(address, tiers)] }
        : {
            title: `Change the agent's ${symbol} limits`,
            lines: [wallet, ...rulesLines(address, tiers)],
            warning: 'This change makes the limits looser, so it waits in the queue.',
          }
    }
    case 'agentSetKey':
      return {
        title: 'Replace the agent key',
        lines: [wallet, { label: 'New key', value: args[0] as Address, mono: true }],
        warning: 'The new key can spend inside the limits of this agent wallet.',
      }
    case 'agentWithdraw': {
      const [address, amount] = args as readonly [Address, bigint]
      const token = tokenOf(d, address)
      const text = token ? `${plainAmount(amount, token.decimals)} ${token.symbol}` : amount.toString()
      return {
        title: `Withdraw ${text} from the agent`,
        lines: [wallet, { label: 'To', value: account, mono: true }, { label: 'Amount', value: text, mono: true }],
      }
    }
    default:
      return { title: `Call ${fn}`, lines: [wallet] }
  }
}

export function describeCall(d: Deployment, account: Address, call: Call): DecodedAction {
  if (isSelfCall(account, call.target)) return describeConfig(d, call.callData)
  const agentCall = agentCallOf(call)
  if (agentCall) return describeAgentCall(d, account, call.target, agentCall)
  const transfer = transferOf(call)
  if (transfer) {
    const token = tokenOf(d, transfer.token)
    if (!token) {
      return {
        title: `Send token ${shortHex(transfer.token)}`,
        lines: [
          { label: 'To', value: transfer.to, mono: true },
          { label: 'Amount', value: transfer.amount.toString(), mono: true },
        ],
      }
    }
    return {
      title: `Send ${plainAmount(transfer.amount, token.decimals)} ${token.symbol}`,
      lines: [
        { label: 'To', value: transfer.to, mono: true },
        { label: 'Amount', value: `${plainAmount(transfer.amount, token.decimals)} ${token.symbol}`, mono: true },
      ],
    }
  }
  return {
    title: 'Contract call',
    lines: [
      { label: 'Contract', value: call.target, mono: true },
      ...(call.value > 0n ? [{ label: 'Value', value: `${plainAmount(call.value, 18)} ETH`, mono: true }] : []),
      { label: 'Data', value: shortHex(call.callData, 10, 8), mono: true },
    ],
    warning: 'This call is not a plain transfer. It waits in the queue.',
  }
}

/** A call to one of the account's own functions. */
export function describeConfig(d: Deployment, data: Hex): DecodedAction {
  let decoded
  try {
    decoded = decodeFunctionData({ abi: WaveAccountAbi, data })
  } catch {
    return {
      title: 'Unknown call to this wallet',
      lines: [{ label: 'Data', value: shortHex(data, 10, 8), mono: true }],
      warning: 'WAVE cannot read this call.',
    }
  }
  switch (decoded.functionName) {
    case 'installModule': {
      const [, module, initData] = decoded.args
      const slot = slotOfModule(d, module)
      let backupEligible = false
      let x: Hex = '0x'
      if (size(initData) === 128) {
        const params = decodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bool' }, { type: 'bool' }],
          initData,
        )
        x = params[0]
        backupEligible = params[2]
      }
      return {
        title: slot ? `Add passkey in slot ${slot}` : `Install module ${shortHex(module)}`,
        lines: [
          { label: 'Type', value: backupEligible ? 'Synced passkey' : 'Device-bound passkey' },
          { label: 'Public key x', value: shortHex(x), mono: true },
        ],
        warning: 'This adds a new way to approve actions for this account.',
      }
    }
    case 'uninstallModule': {
      const [, module] = decoded.args
      const slot = slotOfModule(d, module)
      return {
        title: slot ? `Remove passkey in slot ${slot}` : `Remove module ${shortHex(module)}`,
        lines: [{ label: 'Validator', value: module, mono: true }],
      }
    }
    case 'setTiers': {
      const [address, tiers] = decoded.args
      const token = tokenOf(d, address)
      return {
        title: `Change ${token?.symbol ?? shortHex(address)} rules`,
        lines: tiers.map((tier, index) => tierLine(tier, index, token)),
        warning: 'This change makes the rules looser, so it waits in the queue.',
      }
    }
    case 'setOwner':
      return {
        title: 'Change the wallet owner',
        lines: [{ label: 'New owner', value: numberToHex(decoded.args[0], { size: 32 }), mono: true }],
        warning: 'The new World ID takes control of this wallet.',
      }
    case 'setRootSource':
      return {
        title: 'Change the World ID root source',
        lines: [{ label: 'New source', value: decoded.args[0], mono: true }],
        warning: 'World ID approvals will trust this new source.',
      }
    default:
      return {
        title: `Call ${decoded.functionName} directly`,
        lines: [],
        warning: 'Security demo. The account must reject this.',
      }
  }
}

/** One call in full, or each call of a batch with its own lines: an owner must see each recipient. */
export function describeCalls(d: Deployment, account: Address, calls: readonly Call[]): DecodedAction {
  if (calls.length === 1) return describeCall(d, account, calls[0])
  const parts = calls.map((call) => describeCall(d, account, call))
  return {
    title: `${calls.length} calls`,
    lines: parts.flatMap((part, index) => [
      { label: `Call ${index + 1}`, value: part.title },
      ...part.lines.map((line) => ({ ...line, label: `Call ${index + 1} ${line.label}` })),
    ]),
    warning: parts.find((part) => part.warning)?.warning,
  }
}

/** The calls inside an `execute` argument. */
function callsOfExecute(mode: Hex, execution: Hex): Call[] {
  if (BigInt(mode) === 0n) {
    return [
      {
        target: slice(execution, 0, 20) as Address,
        value: BigInt(slice(execution, 20, 52)),
        callData: size(execution) > 52 ? slice(execution, 52) : '0x',
      },
    ]
  }
  return decodeBatch(execution)
}

export type FrameFacts = {
  /** The account function of the frame, or null if the data has no known selector. */
  fn: string | null
  decoded: DecodedAction
  /** The calls that run in this frame or later. */
  calls: Call[]
}

/**
 * Reads the data of one SENDER frame. A frame can hold any bytes, and the activity index reads
 * every frame on the chain. So bytes that do not decode give the text 'Unknown call'.
 */
export function describeSender(d: Deployment, account: Address, data: Hex): FrameFacts {
  try {
    return readSender(d, account, data)
  } catch {
    return { fn: null, calls: [], decoded: { title: 'Unknown call', lines: [] } }
  }
}

function readSender(d: Deployment, account: Address, data: Hex): FrameFacts {
  const decoded = decodeFunctionData({ abi: WaveAccountAbi, data })
  switch (decoded.functionName) {
    case 'execute': {
      const calls = callsOfExecute(decoded.args[0], decoded.args[1])
      return { fn: 'execute', calls, decoded: describeCalls(d, account, calls) }
    }
    case 'schedule': {
      const calls = decodeBatch(decoded.args[1])
      const text = describeCalls(d, account, calls)
      return {
        fn: 'schedule',
        calls,
        decoded: { ...text, title: decoded.args[0] === 1 ? `Recovery: ${text.title}` : text.title },
      }
    }
    case 'tighten': {
      const [address, tiers] = decoded.args
      const token = tokenOf(d, address)
      return {
        fn: 'tighten',
        calls: [],
        decoded: {
          title: `Tighten ${token?.symbol ?? shortHex(address)} rules`,
          lines: tiers.map((tier, index) => tierLine(tier, index, token)),
        },
      }
    }
    case 'cancel':
      return {
        fn: 'cancel',
        calls: [],
        decoded: { title: 'Cancel a queued action', lines: [{ label: 'Action', value: shortHex(decoded.args[0]), mono: true }] },
      }
    case 'approveRecovery':
      return {
        fn: 'approveRecovery',
        calls: [],
        decoded: { title: 'Approve recovery', lines: [{ label: 'Action', value: shortHex(decoded.args[0]), mono: true }] },
      }
    case 'executeScheduled': {
      const calls = decodeBatch(decoded.args[1])
      const text = describeCalls(d, account, calls)
      return { fn: 'executeScheduled', calls, decoded: { ...text, title: `Run: ${text.title}` } }
    }
    default:
      return { fn: decoded.functionName, calls: [], decoded: describeConfig(d, data) }
  }
}

const MODE_NAMES = ['DEFAULT', 'VERIFY', 'SENDER'] as const

export type FrameLike = { mode: number; target: Address | null; data: Hex }

export function frameViews(d: Deployment, sender: Address, validator: Address, frames: readonly FrameLike[]) {
  const method = methodOf(d, validator)
  return frames.map((frame, index) => {
    const mode = MODE_NAMES[frame.mode] ?? 'SENDER'
    const target = frame.target ?? sender
    let label: string
    if (mode === 'DEFAULT') label = 'Deploy account'
    else if (mode === 'VERIFY' && d.gasStation && target.toLowerCase() === d.gasStation.toLowerCase()) {
      label = 'Gas sponsor pays'
    } else if (mode === 'VERIFY') {
      if (method?.kind === 'world') label = 'World ID check'
      else if (method?.kind === 'agent') label = 'Agent key check'
      else label = method ? `Passkey ${method.slot} check` : 'Check'
    } else label = describeSender(d, sender, frame.data).fn ?? 'Unknown call'
    return { index, mode, target, label }
  })
}
