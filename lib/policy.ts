// Encoders and decoders for the WaveAccount policy. Safe in the browser and on the server.
import {
  concat,
  decodeAbiParameters,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  numberToHex,
  type Address,
  type Hex,
} from 'viem'
import { TestUSDCAbi, WaveAccountAbi, WaveGasStationAbi } from './wave-abi'

export const ETH: Address = '0x0000000000000000000000000000000000000000'
export const KIND_NORMAL = 0
export const KIND_RECOVERY = 1
export const STATUS = ['none', 'collecting', 'queued', 'done', 'cancelled'] as const
export const MODULE_TYPE_FRAME_VALIDATOR = 11n

/** The owner method: World ID or a passkey. */
export const OWNER_BIT = 1
export const SMALL_TIER = 0x80
/** The method bit of passkey slot N is bit N. */
export const passkeyBit = (slot: number) => 1 << slot
/** The agent key of an agent wallet. */
export const AGENT_BIT = 0x40

export const NO_LIMIT = 2n ** 96n - 1n
export const HOUR = 3600
export const DAY = 24 * HOUR

export type Tier = { upTo: bigint; cap: bigint; delay: number; period: number; methods: number }
export type Call = { target: Address; value: bigint; callData: Hex }

const EXECUTION_TUPLE = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
] as const

const MODE_SINGLE: Hex = `0x${'00'.repeat(32)}`
const MODE_BATCH: Hex = `0x01${'00'.repeat(31)}`

export const erc20Transfer = (token: Address, to: Address, amount: bigint): Call => ({
  target: token,
  value: 0n,
  callData: concat([
    '0xa9059cbb',
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [to, amount]),
  ]),
})

export const ethTransfer = (to: Address, amount: bigint): Call => ({ target: to, value: amount, callData: '0x' })

export const transferCall = (token: Address, to: Address, amount: bigint): Call =>
  token === ETH ? ethTransfer(to, amount) : erc20Transfer(token, to, amount)

/** The ERC-7579 batch encoding. `schedule` and `executeScheduled` take this. */
export const encodeBatch = (calls: Call[]): Hex => encodeAbiParameters(EXECUTION_TUPLE, [calls])

export const decodeBatch = (batch: Hex): Call[] => [...decodeAbiParameters(EXECUTION_TUPLE, batch)[0]]

export function executeData(calls: Call[]): Hex {
  if (calls.length === 1) {
    const [c] = calls
    return encodeFunctionData({
      abi: WaveAccountAbi,
      functionName: 'execute',
      args: [MODE_SINGLE, encodePacked(['address', 'uint256', 'bytes'], [c.target, c.value, c.callData])],
    })
  }
  return encodeFunctionData({ abi: WaveAccountAbi, functionName: 'execute', args: [MODE_BATCH, encodeBatch(calls)] })
}

export const scheduleData = (kind: number, calls: Call[], salt: Hex): Hex =>
  encodeFunctionData({ abi: WaveAccountAbi, functionName: 'schedule', args: [kind, encodeBatch(calls), salt] })

export const executeScheduledData = (id: Hex, calls: Call[]): Hex =>
  encodeFunctionData({ abi: WaveAccountAbi, functionName: 'executeScheduled', args: [id, encodeBatch(calls)] })

export const cancelData = (id: Hex): Hex => encodeFunctionData({ abi: WaveAccountAbi, functionName: 'cancel', args: [id] })

export const approveRecoveryData = (id: Hex): Hex =>
  encodeFunctionData({ abi: WaveAccountAbi, functionName: 'approveRecovery', args: [id] })

/** `dailyLimit` is the whole value, not a change: send the current limit to keep it. 0 means no limit. */
export const tightenData = (token: Address, tiers: Tier[], dailyLimit: bigint): Hex =>
  encodeFunctionData({ abi: WaveAccountAbi, functionName: 'tighten', args: [token, tiers, dailyLimit] })

/** frame data of the VERIFY frame: the index of the ARBITRARY signature entry. */
export const verifyData = (signatureIndex = 0n): Hex =>
  encodeFunctionData({
    abi: WaveAccountAbi,
    functionName: 'verify',
    args: [numberToHex(signatureIndex, { size: 32 })],
  })

// Configuration calls. They reach the account only through the queue.

const selfCall = (account: Address, callData: Hex): Call => ({ target: account, value: 0n, callData })

export const passkeyInitData = (x: Hex, y: Hex, backupEligible: boolean, requireUV = true): Hex =>
  encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bool' }, { type: 'bool' }],
    [x, y, backupEligible, requireUV],
  )

export const installModuleCall = (account: Address, module: Address, initData: Hex): Call =>
  selfCall(
    account,
    encodeFunctionData({
      abi: WaveAccountAbi,
      functionName: 'installModule',
      args: [MODULE_TYPE_FRAME_VALIDATOR, module, initData],
    }),
  )

export const uninstallModuleCall = (account: Address, module: Address): Call =>
  selfCall(
    account,
    encodeFunctionData({
      abi: WaveAccountAbi,
      functionName: 'uninstallModule',
      args: [MODULE_TYPE_FRAME_VALIDATOR, module, '0x'],
    }),
  )

/** `dailyLimit` is the whole value, not a change: send the current limit to keep it. 0 removes the limit. */
export const setTiersCall = (account: Address, token: Address, tiers: Tier[], dailyLimit: bigint): Call =>
  selfCall(account, encodeFunctionData({ abi: WaveAccountAbi, functionName: 'setTiers', args: [token, tiers, dailyLimit] }))

export const setOwnerCall = (account: Address, ownerNullifierHash: bigint): Call =>
  selfCall(account, encodeFunctionData({ abi: WaveAccountAbi, functionName: 'setOwner', args: [ownerNullifierHash] }))

/** A recovery of an owner passkey. */
export const setOwnerKeyCall = (account: Address, initData: Hex): Call =>
  selfCall(account, encodeFunctionData({ abi: WaveAccountAbi, functionName: 'setOwnerKey', args: [initData] }))

export const setRootSourceCall = (account: Address, sourceId: Hex): Call =>
  selfCall(account, encodeFunctionData({ abi: WaveAccountAbi, functionName: 'setRootSource', args: [sourceId] }))

// Agent administration. The main wallet sends these calls to its own agent wallet.

type AgentFunction =
  | 'agentSetup'
  | 'agentRevoke'
  | 'agentPause'
  | 'agentUnpause'
  | 'agentTighten'
  | 'agentSetTiers'
  | 'agentSetKey'
  | 'agentWithdraw'

const agentCall = (agent: Address, functionName: AgentFunction, args: unknown[] = []): Call => ({
  target: agent,
  value: 0n,
  callData: encodeFunctionData({ abi: WaveAccountAbi, functionName, args } as never),
})

export const agentSetupCall = (agent: Address, signer: Address, rules: { token: Address; tiers: Tier[] }[]): Call =>
  agentCall(agent, 'agentSetup', [signer, rules])
export const agentRevokeCall = (agent: Address): Call => agentCall(agent, 'agentRevoke')
export const agentPauseCall = (agent: Address): Call => agentCall(agent, 'agentPause')
export const agentUnpauseCall = (agent: Address): Call => agentCall(agent, 'agentUnpause')
export const agentTightenCall = (agent: Address, token: Address, tiers: Tier[]): Call =>
  agentCall(agent, 'agentTighten', [token, tiers])
export const agentSetTiersCall = (agent: Address, token: Address, tiers: Tier[]): Call =>
  agentCall(agent, 'agentSetTiers', [token, tiers])
export const agentSetKeyCall = (agent: Address, signer: Address): Call => agentCall(agent, 'agentSetKey', [signer])
export const agentWithdrawCall = (agent: Address, token: Address, amount: bigint): Call =>
  agentCall(agent, 'agentWithdraw', [token, amount])

/** The account ABI plus the token errors. A queued call can revert inside a token. */
export const WaveCallAbi = [...WaveAccountAbi, ...TestUSDCAbi.filter((item) => item.type === 'error')]

export type DecodedError = { name: string; args: readonly unknown[] }

/** Decodes a custom error of the account from revert data. Null if the data is no such error. */
export function decodeWaveError(data: Hex): DecodedError | null {
  try {
    const { errorName, args } = decodeErrorResult({ abi: [...WaveCallAbi, ...WaveGasStationAbi], data })
    return { name: errorName, args: (args ?? []) as readonly unknown[] }
  } catch {
    return null
  }
}
