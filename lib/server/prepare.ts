// POST /api/tx/prepare: turns an action into a frame transaction with a placeholder witness.
// Server side only.
import { encodeFunctionData, keccak256, numberToHex, type Address, type Hex } from 'viem'
import { NO_WAIT, cloneArgs } from '../account'
import { tiersAfterRemoval } from '../limits'
import type {
  AgentAdminOp,
  AgentRule,
  DecodedAction,
  MethodRef,
  PasskeySlot,
  RecoveryChange,
  Rejection,
  Tier,
  TxAction,
  TxPrepareRequest,
  TxPrepareResponse,
  TxPrepared,
} from '../api-types'
import { ETH_TOKEN, PASSKEY_SLOTS } from '../api-types'
import { publicClient, sleep, sponsorOf, type Deployment } from '../chain'
import {
  AGENT_VERIFY_GAS,
  AGENT_WITNESS_LEN,
  buildTx,
  encodeRaw,
  sigHashOf,
  PASSKEY_VERIFY_GAS,
  PASSKEY_WITNESS_LEN,
  WORLD_VERIFY_GAS,
  WORLD_WITNESS_LEN,
  type DeployFrame,
  type SenderFrame,
} from '../frametx'
import {
  AGENT_BIT,
  agentPauseCall,
  agentRevokeCall,
  agentSetKeyCall,
  agentSetTiersCall,
  agentSetupCall,
  agentTightenCall,
  agentUnpauseCall,
  agentWithdrawCall,
  approveRecoveryData,
  cancelData,
  ETH,
  ethTransfer,
  executeData,
  installModuleCall,
  KIND_NORMAL,
  passkeyInitData,
  scheduleData,
  setOwnerCall,
  setOwnerKeyCall,
  setRootSourceCall,
  setTiersCall,
  SMALL_TIER,
  tightenData,
  transferCall,
  uninstallModuleCall,
  WaveCallAbi,
  type Call,
  type Tier as RawTier,
} from '../policy'
import { delayText, formatDuration } from '../ui/format'
import { TestUSDCAbi, WaveAccountAbi, WaveAccountFactoryAbi } from '../wave-abi'
import { agentSigner } from './agent-key'
import { describeCall, describeCalls, describeSender, frameViews, methodOf, tokensOf, validatorOf } from './decode'
import { ApiFailure, UINT96_MAX, asAddress, asBaseUnits, asHex, asInt, asWord, deployment } from './http'
import { CONFIG_DELAY, KIND_RECOVERY, RECOVERY_DELAY, STATUS_COLLECTING, queuedSource } from './pending'
import { decodeCallError, prepareRejection, type Decoded } from './reject'
import { normalizeRoot, referenceFor } from './roots'
import { deployWallet, sponsorGate } from './sponsor'
import { checkPlan, demoDelay, plannedWallet, type PlannedWallet } from './wallet-plan'
import { externalNullifier, latestWorldRoot, worldConfig } from './world-config'

export { demoDelay }

/** executeScheduled runs the stored calls, and they can write many new slots. */
const RUN_SCHEDULED_GAS = { execution: 1_500_000n, state: 3_000_000n }

/** agentSetup writes the key, the method and each tier into new slots of the agent wallet. */
const AGENT_SETUP_GAS = { execution: 1_000_000n, state: 3_000_000n }

/** One slot is 6 s. */
const BLOCK_WAIT_MS = 8000

/** The chain adds intrinsic gas to the frame limits, and the payer holds that too. */
const INTRINSIC_GAS_MARGIN = 100_000n

const UINT32_MAX = 0xffff_ffff
const UINT24_MAX = 0xff_ffff
const BURN_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD'

/** The onchain tier word holds the small flag in bit 7. */
export function toRawTier(tier: Tier, row: number): RawTier {
  const name = `limit ${row + 1}`
  return {
    upTo: asBaseUnits(tier?.upTo, `${name} upTo`, UINT96_MAX),
    cap: asBaseUnits(tier?.cap, `${name} cap`, UINT96_MAX),
    delay: asInt(tier?.delay, `${name} delay`, UINT32_MAX),
    period: asInt(tier?.period, `${name} time span`, UINT24_MAX),
    methods: (asInt(tier?.methods, `${name} methods`, 0xff) & 0x7f) | (tier?.small ? SMALL_TIER : 0),
  }
}

function rawTiers(tiers: unknown): RawTier[] {
  if (!Array.isArray(tiers)) throw new ApiFailure('BAD_REQUEST', 'The action needs a tiers list.')
  return (tiers as Tier[]).map(toRawTier)
}

/** A missing value is an error here, because 0 would remove a limit. */
const dailyLimitOf = (value: unknown): bigint => asBaseUnits(value, 'The daily limit', UINT96_MAX)

function checkMethod(method: MethodRef): MethodRef {
  if (method?.kind === 'world') return method
  if (method?.kind === 'passkey' && PASSKEY_SLOTS.includes(method.slot)) return method
  if (method?.kind === 'agent') return method
  throw new ApiFailure('BAD_REQUEST', 'The method is not valid.')
}

const passkeyValidator = (d: Deployment, slot: PasskeySlot): Address => {
  if (!PASSKEY_SLOTS.includes(slot)) throw new ApiFailure('BAD_REQUEST', 'The passkey slot is not valid.')
  return d.passkeyValidators[slot - 1]
}

/** The wallet of the first transaction. The address must match the deployment input. */
async function plannedDeploy(d: Deployment, account: Address, input: TxPrepareRequest['deployment']): Promise<PlannedWallet> {
  if (!input) {
    throw new ApiFailure('NOT_DEPLOYED', 'The account has no code. The request needs `deployment`.')
  }
  const planned = await plannedWallet(d, checkPlan(input, d))
  if (planned.address.toLowerCase() !== account.toLowerCase()) {
    throw new ApiFailure('ACCOUNT_MISMATCH', 'This wallet was made for another deployment. Create a new wallet.')
  }
  return planned
}

/** An agent wallet has no owner of its own. The address commits to its master and its salt. */
export async function agentDeployment(
  d: Deployment,
  master: Address,
  salt: Hex,
): Promise<{ address: Address; frame: DeployFrame }> {
  const args = cloneArgs({
    validator: d.worldIdValidator,
    owner: {
      kind: 'world',
      ownerNullifierHash: 0n,
      externalNullifierHash: externalNullifier(),
      rootSourceId: d.rootSourceId,
    },
    demoDelay: demoDelay(),
    master,
  })
  const address = await publicClient.readContract({
    address: d.factory,
    abi: WaveAccountFactoryAbi,
    functionName: 'predict',
    args: [d.implementation, args, salt],
  })
  return { address, frame: { factory: d.factory, implementation: d.implementation, args, salt, setup: '0x' } }
}

export type Plan = {
  route: TxPrepared['route']
  sender: SenderFrame
  decoded: DecodedAction
  /** ETH that leaves the wallet in this transaction, on top of the gas. */
  ethOut?: bigint
  /** An agent wallet that must exist before this transaction runs. */
  deployChild?: { address: Address; frame: DeployFrame }
  /** The action runs right after this approval, because the wallet has no wait. */
  runAtOnce?: boolean
  runActionId?: Hex
}

type Context = {
  d: Deployment
  account: Address
  validator: Address
  /** The owner method of this account. */
  owner: Address
  deployed: boolean
  /** The chosen wait of this account, as the clone holds it. Its address commits to the value. */
  delayLimit: number
}

/** The server can run a queued action on the local network only. */
const canRunAtOnce = (ctx: Context): boolean => ctx.delayLimit === NO_WAIT && sponsorOf(ctx.d) !== null

const newSalt = (): Hex => keccak256(crypto.getRandomValues(new Uint8Array(32)))

const isOwner = (ctx: Context): boolean => ctx.validator.toLowerCase() === ctx.owner.toLowerCase()
const ownerIsWorld = (ctx: Context): boolean => ctx.owner.toLowerCase() === ctx.d.worldIdValidator.toLowerCase()

const describe = (ctx: Context, data: Hex): DecodedAction => describeSender(ctx.d, ctx.account, data).decoded

/** Adds the delay line, in the text the spec names. */
function withDelay(ctx: Context, decoded: DecodedAction, real: number): DecodedAction {
  return { ...decoded, lines: [...decoded.lines, { label: 'Delay', value: delayText(real, ctx.delayLimit) }] }
}

function queuedPlan(ctx: Context, calls: Call[], realDelay: number): Plan {
  const data = scheduleData(KIND_NORMAL, calls, newSalt())
  const decoded = withDelay(ctx, describe(ctx, data), realDelay)
  const runAtOnce = canRunAtOnce(ctx)
  // A wallet with no wait has no queue step, so its review must not name one.
  const warning = runAtOnce
    ? decoded.warning?.replace(', so it waits in the queue', '').replace(' It waits in the queue.', '')
    : decoded.warning
  return { route: 'schedule', sender: { data }, decoded: { ...decoded, warning }, runAtOnce }
}

/** A tier delay is the owner's own rule. The chosen wait does not change it. */
function tierDelayPlan(ctx: Context, call: Call, delay: number): Plan {
  const data = scheduleData(KIND_NORMAL, [call], newSalt())
  const decoded = describe(ctx, data)
  return {
    route: 'schedule',
    sender: { data },
    decoded: { ...decoded, lines: [...decoded.lines, { label: 'Delay', value: formatDuration(delay) }] },
  }
}

/** A readable reason that needs no signature. A transfer that fails here costs no gas. */
async function previewTransfer(ctx: Context, token: Address, amount: bigint): Promise<number | Decoded> {
  if (!ctx.deployed) return 0
  try {
    return await publicClient.readContract({
      address: ctx.account,
      abi: WaveAccountAbi,
      functionName: 'checkTransfer',
      args: [ctx.validator, token, amount],
    })
  } catch (error) {
    const decoded = decodeCallError(error)
    if (decoded) return decoded
    throw error
  }
}

async function balanceOf(d: Deployment, token: Address, who: Address): Promise<bigint> {
  if (token === ETH_TOKEN) return publicClient.getBalance({ address: who })
  return publicClient.readContract({ address: token, abi: TestUSDCAbi, functionName: 'balanceOf', args: [who] })
}

async function transferPlan(ctx: Context, action: Extract<TxAction, { kind: 'transfer' }>): Promise<Plan | Rejection> {
  const token = asAddress(action.token, 'token')
  const to = asAddress(action.to, 'to')
  const amount = asBaseUnits(action.amount, 'amount')
  if (!tokensOf(ctx.d).some((item) => item.address.toLowerCase() === token.toLowerCase())) {
    throw new ApiFailure('BAD_REQUEST', 'This token is not listed.')
  }
  if ((await balanceOf(ctx.d, token, ctx.account)) < amount) {
    return prepareRejection({ code: 'InsufficientFunds' })
  }
  const preview = await previewTransfer(ctx, token, amount)
  if (typeof preview !== 'number') return prepareRejection(preview)
  const call = transferCall(token, to, amount)
  if (preview > 0) return tierDelayPlan(ctx, call, preview)
  return {
    route: 'execute',
    sender: { data: executeData([call]) },
    decoded: describeCall(ctx.d, ctx.account, call),
    ethOut: token === ETH ? amount : 0n,
  }
}

/**
 * Asks the chain with eth_call. The reason needs no signature and costs no gas. The newest block
 * can be a few seconds behind the clock. So a delay that the clock says is over waits for a block.
 */
export async function checkRunnable(
  ctx: Pick<Context, 'd' | 'account'>,
  id: Hex,
  batch: Hex,
): Promise<Decoded | null> {
  const lastTry = Date.now() + BLOCK_WAIT_MS
  for (;;) {
    try {
      await publicClient.simulateContract({
        address: ctx.account,
        abi: WaveCallAbi,
        functionName: 'executeScheduled',
        args: [id, batch],
        account: ctx.d.devKeyAddress,
      })
      return null
    } catch (error) {
      const decoded = decodeCallError(error)
      if (!decoded) throw error
      const over = decoded.code === 'TooEarly' && Number(decoded.args?.notBefore) * 1000 <= Date.now()
      if (!over || Date.now() > lastTry) return decoded
      await sleep(1000)
    }
  }
}

async function runScheduledPlan(ctx: Context, id: Hex): Promise<Plan | Rejection> {
  const source = await queuedSource(ctx.d, ctx.account, id)
  if (!source) return prepareRejection({ code: 'NotScheduled' })
  const failure = await checkRunnable(ctx, id, source.batch)
  if (failure) return prepareRejection(failure)
  const data = encodeFunctionData({
    abi: WaveAccountAbi,
    functionName: 'executeScheduled',
    args: [id, source.batch],
  })
  return { route: 'executeScheduled', sender: { data, ...RUN_SCHEDULED_GAS }, decoded: describe(ctx, data) }
}

const readAccount = <T,>(ctx: Context, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({
    address: ctx.account,
    abi: WaveAccountAbi,
    functionName: functionName as never,
    args: args as never,
  }) as Promise<T>

/** The method bit for a recovery, or the rejection that the account would give. */
async function recoveryBit(ctx: Context): Promise<number | Rejection> {
  const args = { validator: ctx.validator }
  if (isOwner(ctx)) return prepareRejection({ code: 'MethodNotAllowed', args })
  const bit = await readAccount<number>(ctx, 'methodBitOf', [ctx.validator])
  const synced = await readAccount<number>(ctx, 'syncedMask')
  return bit & synced ? prepareRejection({ code: 'SyncedNotAllowed', args }) : bit
}

function recoveryPlan(ctx: Context, change: RecoveryChange): Plan {
  let call: Call
  if (change?.kind === 'owner-key') {
    if (ownerIsWorld(ctx)) throw new ApiFailure('BAD_REQUEST', 'The owner of this wallet is World ID, not a passkey.')
    const { x, y } = change.publicKey ?? {}
    if (typeof change.backupEligible !== 'boolean') {
      throw new ApiFailure('BAD_REQUEST', 'The new passkey needs backupEligible.')
    }
    const init = passkeyInitData(asHex(x, 'public key x', 32), asHex(y, 'public key y', 32), change.backupEligible)
    call = setOwnerKeyCall(ctx.account, init)
  } else if (!ownerIsWorld(ctx)) {
    throw new ApiFailure('BAD_REQUEST', 'The owner of this wallet is a passkey. Only a new passkey can replace it.')
  } else if (change?.kind === 'owner') {
    const owner = BigInt(asWord(change.nullifierHash, 'new owner'))
    if (owner === 0n) throw new ApiFailure('BAD_REQUEST', 'The new owner is zero.')
    call = setOwnerCall(ctx.account, owner)
  } else if (change?.kind === 'root-source') {
    const source = asHex(change.sourceId, 'new root source', 32)
    if (BigInt(source) === 0n) throw new ApiFailure('BAD_REQUEST', 'The new root source is zero.')
    call = setRootSourceCall(ctx.account, source)
  } else {
    throw new ApiFailure('BAD_REQUEST', 'The recovery change is not known.')
  }
  const data = scheduleData(KIND_RECOVERY, [call], newSalt())
  return { route: 'schedule', sender: { data }, decoded: withDelay(ctx, describe(ctx, data), RECOVERY_DELAY) }
}

type PendingRow = { status: number; approvals: number; version: number }

/** The second method signs here, so it must see what the proposal changes. */
async function approveRecoveryPlan(ctx: Context, id: Hex): Promise<Plan | Rejection> {
  const { d, account } = ctx
  const source = await queuedSource(d, account, id)
  if (!source) return prepareRejection({ code: 'NotScheduled' })
  if (source.kind !== KIND_RECOVERY) return prepareRejection({ code: 'BadRecovery' })
  const bit = await recoveryBit(ctx)
  if (typeof bit !== 'number') return bit

  const row = await readAccount<PendingRow>(ctx, 'pendingOf', [id])
  if (row.status !== STATUS_COLLECTING) {
    return prepareRejection({ code: 'BadStatus', args: { id, status: String(row.status) } })
  }
  const version = await readAccount<number>(ctx, 'configVersion')
  if (row.version !== version) {
    return prepareRejection({ code: 'StaleVersion', args: { stored: String(row.version), current: String(version) } })
  }
  // The account accepts this and counts nothing. The owner would pay gas for no change.
  if (row.approvals & bit) return prepareRejection({ code: 'AlreadyApproved' })

  const text = describeCalls(d, account, source.calls)
  const proposer = methodOf(d, source.proposer)
  const lines = [
    ...text.lines,
    ...(proposer?.kind === 'passkey' ? [{ label: 'Proposed by', value: `Passkey ${proposer.slot}` }] : []),
    { label: 'Action', value: id, mono: true },
  ]
  return {
    route: 'approveRecovery',
    sender: { data: approveRecoveryData(id) },
    // The proposal counted as the first approval, so this one queues the recovery.
    runAtOnce: canRunAtOnce(ctx),
    runActionId: id,
    decoded: withDelay(
      ctx,
      {
        title: `Approve recovery: ${text.title}`,
        lines,
        warning: `${text.warning ?? ''} Approve only if you asked for this change.`.trim(),
      },
      RECOVERY_DELAY,
    ),
  }
}

async function cancelPlan(ctx: Context, id: Hex): Promise<Plan | Rejection> {
  const { d, account } = ctx
  const source = await queuedSource(d, account, id)
  if (!source) return prepareRejection({ code: 'NotScheduled' })
  if (source.kind === KIND_RECOVERY && !isOwner(ctx)) {
    return prepareRejection({ code: 'OnlyOwnerMethod' })
  }
  const text = describeCalls(d, account, source.calls)
  return {
    route: 'cancel',
    sender: { data: cancelData(id) },
    decoded: {
      title: `Cancel: ${text.title}`,
      lines: [...text.lines, { label: 'Action', value: id, mono: true }],
    },
  }
}

/**
 * A rule can name the removed method alone: an older rule, or a rule from a tighten. Such a rule
 * changes in the same action, so no step ever has no approver.
 */
async function removePlan(ctx: Context, slot: PasskeySlot): Promise<Plan> {
  const { d, account } = ctx
  const validator = passkeyValidator(d, slot)
  const removal = uninstallModuleCall(account, validator)
  const bit = ctx.deployed ? await readAccount<number>(ctx, 'methodBitOf', [validator]) : 0
  if (bit === 0) return queuedPlan(ctx, [removal], CONFIG_DELAY)
  const [enrolled, synced] = await Promise.all([readAccount<number>(ctx, 'enrolledMask'), readAccount<number>(ctx, 'syncedMask')])
  const repairs = await Promise.all(
    tokensOf(d).map(async ({ address }) => {
      const tiers = await readAccount<readonly RawTier[]>(ctx, 'tiersOf', [address])
      const fixed = tiersAfterRemoval(tiers, bit, enrolled, synced)
      if (!fixed) return []
      // A method removal must not change the hard daily total.
      const [dailyLimit] = await readAccount<readonly [bigint]>(ctx, 'dailyOf', [address])
      return [setTiersCall(account, address, fixed, dailyLimit)]
    }),
  )
  return queuedPlan(ctx, [...repairs.flat(), removal], CONFIG_DELAY)
}

function checkRules(rules: AgentRule[] | undefined): { token: Address; tiers: RawTier[] }[] {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new ApiFailure('BAD_REQUEST', 'An agent wallet needs at least one rule.')
  }
  return rules.map((rule) => {
    const tiers = rawTiers(rule?.tiers)
    if (tiers.length === 0 || tiers.some((tier) => (tier.methods & AGENT_BIT) === 0)) {
      throw new ApiFailure('BAD_REQUEST', 'Each tier of a new agent must name the agent key.')
    }
    return { token: asAddress(rule?.token, 'token'), tiers }
  })
}

async function agentCreatePlan(ctx: Context, agent: Address, op: Extract<AgentAdminOp, { kind: 'create' }>): Promise<Plan> {
  const salt = asHex(op.salt, 'salt', 32)
  const child = await agentDeployment(ctx.d, ctx.account, salt)
  if (child.address.toLowerCase() !== agent.toLowerCase()) {
    throw new ApiFailure('ACCOUNT_MISMATCH', 'This agent address does not match the main wallet and the salt.')
  }
  const call = agentSetupCall(agent, agentSigner(), checkRules(op.rules))
  return {
    route: 'execute',
    sender: { data: executeData([call]), ...AGENT_SETUP_GAS },
    decoded: describeCall(ctx.d, ctx.account, call),
    deployChild: child,
  }
}

const runNow = (ctx: Context, call: Call): Plan => ({
  route: 'execute',
  sender: { data: executeData([call]) },
  decoded: describeCall(ctx.d, ctx.account, call),
})

/** The main wallet's side of agent administration. WavePolicy._agentClass holds the same table. */
async function agentPlan(ctx: Context, action: Extract<TxAction, { kind: 'agent' }>): Promise<Plan | Rejection> {
  const agent = asAddress(action.agent, 'agent')
  const { op } = action
  const ownerOnly = op?.kind === 'unpause' || op?.kind === 'set-tiers' || op?.kind === 'set-key'
  if (ownerOnly && !isOwner(ctx)) {
    return prepareRejection({ code: 'MethodNotAllowed', args: { validator: ctx.validator } })
  }
  if (op?.kind === 'create') return agentCreatePlan(ctx, agent, op)
  if (!ctx.deployed || !(await readAccount<boolean>(ctx, 'isOwnAgent', [agent]))) {
    return prepareRejection({ code: 'NotMaster' })
  }
  switch (op?.kind) {
    case 'revoke':
      return runNow(ctx, agentRevokeCall(agent))
    case 'pause':
      return runNow(ctx, agentPauseCall(agent))
    case 'tighten':
      return runNow(ctx, agentTightenCall(agent, asAddress(op.token, 'token'), rawTiers(op.tiers)))
    case 'withdraw': {
      const token = asAddress(op.token, 'token')
      const amount = asBaseUnits(op.amount, 'amount')
      if ((await balanceOf(ctx.d, token, agent)) < amount) return prepareRejection({ code: 'InsufficientFunds' })
      return runNow(ctx, agentWithdrawCall(agent, token, amount))
    }
    case 'unpause':
      return queuedPlan(ctx, [agentUnpauseCall(agent)], CONFIG_DELAY)
    case 'set-tiers':
      return queuedPlan(ctx, [agentSetTiersCall(agent, asAddress(op.token, 'token'), rawTiers(op.tiers))], CONFIG_DELAY)
    case 'set-key':
      return queuedPlan(ctx, [agentSetKeyCall(agent, agentSigner())], CONFIG_DELAY)
    default:
      throw new ApiFailure('BAD_REQUEST', 'The agent action is not known.')
  }
}

async function planAction(ctx: Context, action: TxAction): Promise<Plan | Rejection> {
  const { d, account } = ctx
  switch (action?.kind) {
    case 'transfer':
      return transferPlan(ctx, action)
    case 'agent':
      return agentPlan(ctx, action)
    case 'install-passkey': {
      const { x, y } = action.publicKey ?? {}
      if (typeof action.backupEligible !== 'boolean') {
        throw new ApiFailure('BAD_REQUEST', 'The action needs backupEligible.')
      }
      const init = passkeyInitData(asHex(x, 'public key x', 32), asHex(y, 'public key y', 32), action.backupEligible)
      return queuedPlan(ctx, [installModuleCall(account, passkeyValidator(d, action.slot), init)], CONFIG_DELAY)
    }
    case 'remove-passkey':
      return removePlan(ctx, action.slot)
    case 'set-rules':
      return queuedPlan(
        ctx,
        [setTiersCall(account, asAddress(action.token, 'token'), rawTiers(action.tiers), dailyLimitOf(action.dailyLimit))],
        CONFIG_DELAY,
      )
    case 'tighten': {
      const data = tightenData(asAddress(action.token, 'token'), rawTiers(action.tiers), dailyLimitOf(action.dailyLimit))
      return { route: 'tighten', sender: { data }, decoded: describe(ctx, data) }
    }
    case 'cancel':
      return cancelPlan(ctx, asHex(action.actionId, 'actionId', 32))
    case 'execute-scheduled':
      return runScheduledPlan(ctx, asHex(action.actionId, 'actionId', 32))
    case 'approve-recovery':
      return approveRecoveryPlan(ctx, asHex(action.actionId, 'actionId', 32))
    case 'propose-recovery': {
      const bit = await recoveryBit(ctx)
      return typeof bit === 'number' ? recoveryPlan(ctx, action.change) : bit
    }
    case 'demo-direct-install': {
      // The key is not real. The account must stop this call before any key matters.
      const init = passkeyInitData(numberToHex(1, { size: 32 }), numberToHex(2, { size: 32 }), false)
      const data = installModuleCall(account, d.passkeyValidators[2], init).callData
      return {
        route: 'direct',
        sender: { data },
        decoded: {
          title: 'Call installModule directly',
          lines: [{ label: 'Account', value: account, mono: true }],
          warning: 'Security demo. The account must reject this.',
        },
      }
    }
    case 'demo-stranger':
      // No rule check here: the proof must fail first, whatever the rules of the wallet say.
      return {
        route: 'execute',
        sender: { data: executeData([ethTransfer(BURN_ADDRESS, 1n)]) },
        decoded: {
          title: 'Send 1 wei of ETH',
          lines: [{ label: 'To', value: BURN_ADDRESS, mono: true }],
          warning: 'Security demo. The account must reject this.',
        },
      }
    default:
      throw new ApiFailure('BAD_REQUEST', 'The action is not known.')
  }
}

async function rootFor(hint: Hex | undefined): Promise<Hex> {
  if (hint) return normalizeRoot(asWord(hint, 'rootHint'))
  const world = worldConfig()
  if (world.mode === 'idkit') return latestWorldRoot(world.environment)
  throw new ApiFailure('NO_ROOT', 'A test identity has its own root. The request needs `rootHint`.')
}

const WITNESS_LEN = { world: WORLD_WITNESS_LEN, passkey: PASSKEY_WITNESS_LEN, agent: AGENT_WITNESS_LEN }
const VERIFY_GAS = { world: WORLD_VERIFY_GAS, passkey: PASSKEY_VERIFY_GAS, agent: AGENT_VERIFY_GAS }

function isPlan(value: Plan | Rejection): value is Plan {
  return 'sender' in value
}

export async function prepareTx(body: TxPrepareRequest): Promise<TxPrepareResponse> {
  const d = deployment()
  const account = asAddress(body.account, 'account')
  const method = checkMethod(body.method)
  const validator = validatorOf(d, method)

  const code = await publicClient.getCode({ address: account })
  let deployed = code !== undefined && code !== '0x'
  const planned = deployed ? null : await plannedDeploy(d, account, body.deployment)
  const firstDeploy = planned?.frame

  const enrolled = planned
    ? planned.validators.some((item) => item.toLowerCase() === validator.toLowerCase())
    : (await publicClient.readContract({
        address: account,
        abi: WaveAccountAbi,
        functionName: 'methodBitOf',
        args: [validator],
      })) !== 0
  if (!enrolled) {
    return { ok: false, rejection: prepareRejection({ code: 'NotEnrolled', args: { validator } }) }
  }

  const sponsor = sponsorOf(d)
  // A wallet with extra methods has rules. The rule check must read them from the chain, so the
  // wallet deploys first. An abandoned review leaves a deployed wallet with no funds at risk.
  if (sponsor && firstDeploy && firstDeploy.setup !== '0x') {
    const refused = await sponsorGate(sponsor, account)
    if (refused) return { ok: false, rejection: prepareRejection(refused) }
    await deployWallet(account, firstDeploy)
    deployed = true
  }

  const owner = planned
    ? planned.owner
    : await publicClient.readContract({ address: account, abi: WaveAccountAbi, functionName: 'ownerValidator' })
  const delayLimit = deployed
    ? await publicClient.readContract({ address: account, abi: WaveAccountAbi, functionName: 'demoDelay' })
    : (planned as PlannedWallet).demoDelay
  const plan = await planAction({ d, account, validator, owner, deployed, delayLimit }, body.action)
  if (!isPlan(plan)) return { ok: false, rejection: plan }

  // On the local network the sponsor deploys the wallet with a plain transaction. A deploy frame
  // does not fit the state gas limit of the prefix: DEVIATIONS.md gives the numbers.
  if (sponsor) {
    const refused = await sponsorGate(sponsor, account)
    if (refused) return { ok: false, rejection: prepareRejection(refused) }
    if (firstDeploy) await deployWallet(account, firstDeploy)
  }
  const deploy = sponsor ? undefined : firstDeploy

  const reference = method.kind === 'world' ? await referenceFor(await rootFor(body.rootHint)) : null
  const tx = await buildTx({
    account,
    validator,
    witnessLen: WITNESS_LEN[method.kind],
    verifyGas: VERIFY_GAS[method.kind],
    sender: [plan.sender],
    deploy,
    sponsor,
    rootRefs: reference ? [reference] : [],
  })

  // The payer pays the full gas limit first, so the value must fit next to it.
  const gasLimit = tx.frames.reduce((sum, frame) => sum + frame.limits.execution + frame.limits.state, INTRINSIC_GAS_MARGIN)
  const balance = await publicClient.getBalance({ address: account })
  const gasCost = sponsor ? 0n : gasLimit * tx.fees.maxFeePerGas
  if (balance < gasCost + (plan.ethOut ?? 0n)) {
    return { ok: false, rejection: prepareRejection({ code: 'InsufficientFunds' }) }
  }
  // The dev key deploys on both networks. The child needs no ETH for this.
  if (plan.deployChild) await deployWallet(plan.deployChild.address, plan.deployChild.frame)

  return {
    ok: true,
    envelope: encodeRaw(tx),
    sigHash: sigHashOf(tx),
    method,
    route: plan.route,
    decoded: plan.decoded,
    frames: frameViews(d, account, validator, tx.frames),
    rootReference: reference
      ? { sourceId: reference.sourceId, slot: reference.slot.toString(), root: reference.root }
      : null,
    deploys: deploy !== undefined,
    sponsored: sponsor !== null,
    runAtOnce: plan.runAtOnce ?? false,
    runActionId: plan.runActionId ?? null,
  }
}

