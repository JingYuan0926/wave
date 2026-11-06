// The delay queue, read from logs and account storage. Server side only.
import type { Address, Hex } from 'viem'
import { appliedDelay } from '../account'
import type { MethodRef, PendingAction, PendingKind, PendingStatus } from '../api-types'
import { PASSKEY_SLOTS } from '../api-types'
import { publicClient, type Deployment } from '../chain'
import { decodeBatch, type Call } from '../policy'
import { WaveAccountAbi } from '../wave-abi'
import { describeCalls, isAgentLoosen, methodOf, transferOf } from './decode'

export const OTHER_CALL_DELAY = 86_400
export const CONFIG_DELAY = 172_800
export const RECOVERY_DELAY = 604_800

export const STATUS_COLLECTING = 1
const STATUS_QUEUED = 2
export const KIND_RECOVERY = 1

type ScheduledLog = {
  args: { id?: Hex; kind?: number; proposer?: Address; notBefore?: number; version?: number; batch?: Hex }
}

const scheduledLogs = (d: Deployment, account: Address, id?: Hex) =>
  publicClient.getContractEvents({
    address: account,
    abi: WaveAccountAbi,
    eventName: 'Scheduled',
    args: id ? { id } : undefined,
    fromBlock: BigInt(d.deployedAtBlock),
    toBlock: 'latest',
  }) as Promise<ScheduledLog[]>

export type QueuedSource = { kind: number; batch: Hex; calls: Call[]; proposer: Address }

/** The `Scheduled` event carries the batch bytes, which executeScheduled needs. */
export async function queuedSource(d: Deployment, account: Address, id: Hex): Promise<QueuedSource | null> {
  const [log] = await scheduledLogs(d, account, id)
  if (!log) return null
  const { kind, batch, proposer } = log.args
  return { kind: kind as number, batch: batch as Hex, calls: decodeBatch(batch as Hex), proposer: proposer as Address }
}

/** The account treats a transfer of an unlisted token as a sensitive call, so this does too. */
async function kindOf(account: Address, recovery: boolean, calls: Call[]): Promise<PendingKind> {
  if (recovery) return 'recovery'
  if (calls.some((call) => BigInt(call.target) === 0n || call.target.toLowerCase() === account.toLowerCase())) {
    return 'config'
  }
  if (calls.some(isAgentLoosen)) return 'config'
  for (const call of calls) {
    const transfer = transferOf(call)
    if (!transfer) return 'sensitive'
    const listed = await publicClient.readContract({
      address: account,
      abi: WaveAccountAbi,
      functionName: 'isListed',
      args: [transfer.token],
    })
    if (!listed) return 'sensitive'
  }
  return 'transfer'
}

type TierRow = { upTo: bigint; delay: number }

async function realDelayOf(account: Address, kind: PendingKind, calls: Call[], applied: number): Promise<number> {
  if (kind === 'recovery') return RECOVERY_DELAY
  if (kind === 'config') return CONFIG_DELAY
  if (kind === 'sensitive') return OTHER_CALL_DELAY
  let longest = 0
  for (const call of calls) {
    const transfer = transferOf(call)
    if (!transfer) continue
    const tiers = (await publicClient.readContract({
      address: account,
      abi: WaveAccountAbi,
      functionName: 'tiersOf',
      args: [transfer.token],
    })) as readonly TierRow[]
    const tier = tiers.find((item) => transfer.amount <= item.upTo && item.delay > 0)
    longest = Math.max(longest, tier?.delay ?? 0)
  }
  return Math.max(longest, applied)
}

const approvalsOf = (mask: number): MethodRef[] => {
  const refs: MethodRef[] = []
  for (const slot of PASSKEY_SLOTS) if (mask & (1 << slot)) refs.push({ kind: 'passkey', slot })
  return refs
}

type PendingRow = {
  notBefore: number
  createdAt: number
  version: number
  status: number
  kind: number
  approvals: number
}

/** Actions that wait, in queue order. Done and cancelled actions are left out. */
export async function readPending(
  d: Deployment,
  account: Address,
  configVersion: number,
  now: number,
): Promise<PendingAction[]> {
  const logs = await scheduledLogs(d, account)
  const limit = await publicClient.readContract({ address: account, abi: WaveAccountAbi, functionName: 'demoDelay' })
  const rows = await Promise.all(
    logs.map(async (log) => {
      const id = log.args.id as Hex
      const row = (await publicClient.readContract({
        address: account,
        abi: WaveAccountAbi,
        functionName: 'pendingOf',
        args: [id],
      })) as PendingRow
      if (row.status !== STATUS_COLLECTING && row.status !== STATUS_QUEUED) return null

      const calls = decodeBatch(log.args.batch as Hex)
      const recovery = row.kind === KIND_RECOVERY
      const kind = await kindOf(account, recovery, calls)
      // A recovery delay starts at the second approval, not at the proposal.
      const applied = recovery ? appliedDelay(RECOVERY_DELAY, limit) : row.notBefore - row.createdAt
      const realDelay = await realDelayOf(account, kind, calls, applied)

      let status: PendingStatus
      if (row.version !== configVersion) status = 'stale'
      else if (row.status === STATUS_COLLECTING) status = 'needs-approval'
      else status = now >= row.notBefore ? 'ready' : 'waiting'

      const action: PendingAction = {
        id,
        kind,
        status,
        decoded: describeCalls(d, account, calls),
        proposedBy: methodOf(d, log.args.proposer as Address) ?? { kind: 'world' },
        approvals: approvalsOf(row.approvals),
        executeAfter: row.notBefore > 0 ? row.notBefore : null,
        realDelay,
        appliedDelay: applied,
        cancelBy: recovery ? 'owner' : 'any',
      }
      return action
    }),
  )
  return rows.filter((row): row is PendingAction => row !== null)
}
