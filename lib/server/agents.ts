// Agent wallets: the list, the agent's spends and the human checkpoint. Server side only.
// The contract enforces the most per day. This file adds one more gate: above the alone amount
// (`askAbove`), nothing runs until a person passes Agent Pass and then confirms the exact action in WAVE.
// World shows no action, so the first step proves the person and the second step approves.
// The demo agent key sits on this server, so this gate is a server rule, not a chain rule.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { encodePacked, keccak256, type Address, type Hex } from 'viem'
import type {
  AgentCheckpointRequest,
  AgentCheckpointResponse,
  AgentConfirmTokenResponse,
  AgentDecisionRequest,
  AgentOperationStatus,
  AgentOperationView,
  AgentPassReason,
  AgentSpendRequest,
  AgentSpendResponse,
  AgentsResponse,
  AgentView,
  DecodedAction,
  Rejection,
  TxPrepared,
  TxSendResponse,
} from '../api-types'
import { explorerLink, publicClient, type Deployment } from '../chain'
import { plainAmount } from '../ui/format'
import { WaveAccountAbi } from '../wave-abi'
import { readBalances, readRules } from './account-view'
import { agentKeyAccount } from './agent-key'
import { agentPassConfigured, cancelAttempt, deviceHandoff, startDeviceAttempt } from './agent-pass'
import {
  askAboveList,
  askAboveOf,
  identityOf,
  linkIdentity,
  readOpenSends,
  readToolAgent,
  saveOpenSends,
  saveToolAgent,
  setAskAbove,
  type Identity,
} from './agent-store'
import { tokensOf } from './decode'
import { ApiFailure, asAddress, asBaseUnits, deployment } from './http'
import { agentDeployment, prepareTx } from './prepare'
import { prepareRejection, type Decoded } from './reject'
import { sendTx, txStatus } from './send'
import { sponsorView } from './sponsor'

/**
 * The whole window: the World ID login and the confirmation. It does not move when a person tries
 * again or when a client reads the status.
 */
const OPERATION_MS = 3 * 60_000
/** Each ended operation stays visible. This cap keeps the memory small. */
const MAX_OPERATIONS = 200
/** The page asks for the token at the click on Confirm and uses it at once. */
const CONFIRM_TOKEN_MS = 30_000

const ZERO = '0x0000000000000000000000000000000000000000'

type Action =
  | { kind: 'spend'; token: Address; to: Address; amount: bigint }
  | { kind: 'raise-checkpoint'; token: Address; askAbove: bigint }

/** What a person approved. A change means that the approval is for something else. */
type Limits = { askAbove: bigint | null; rules: string | null }

type Operation = {
  id: string
  agent: Address
  master: Address
  /** Null for a record of a send from before a restart. Such a record can never run again. */
  action: Action | null
  decoded: DecodedAction
  expiresAt: number
  /** One use. A confirmation clears it, before the send starts. */
  approvalId: string | null
  status: AgentOperationStatus
  txHash: Hex | null
  refusal: AgentOperationView['refusal']
  rejection: Rejection | null
  limits: Limits
  /** The newest device attempt. */
  attemptId: string | null
  /** A device start that runs now. Two clicks share it, so World sees one start. */
  starting: Promise<void> | null
  /** The person that World ID proved. This stays on the server, out of each view. */
  identity: Identity | null
  /** The hash of the one token that can confirm this now. It stays out of each view. */
  confirmToken: { hash: Buffer; until: number } | null
}

/** These must stay in the list. A person must still act on them, or read their open result. */
const OPEN = new Set<AgentOperationStatus>(['needs-approval', 'needs-confirmation', 'sending', 'unknown'])

// Each route has its own module copy in dev, so the state lives on globalThis.
// A restart removes pending operations, so nothing can run from an old approval. A send that had
// started comes back as "unknown": it stays blocked, and the owner can see it.
const shared = globalThis as typeof globalThis & { __waveAgentOperations?: Map<string, Operation> }
const operations: Map<string, Operation> = (shared.__waveAgentOperations ??= new Map(
  readOpenSends().map((send) => [
    send.id,
    {
      ...send,
      action: null,
      approvalId: null,
      status: 'unknown',
      refusal: null,
      rejection: null,
      limits: { askAbove: null, rules: null },
      attemptId: null,
      starting: null,
      identity: null,
      confirmToken: null,
    },
  ]),
))

// Two sends at once from one wallet would take the same nonce, so one would fail. Sends of one
// agent wait in a line, which also keeps the order of "pay A, then pay B".
const lines = ((globalThis as typeof globalThis & { __waveAgentLines?: Map<string, Promise<unknown>> }).__waveAgentLines ??=
  new Map())

function inLine<T>(agent: Address, step: () => Promise<T>): Promise<T> {
  const key = agent.toLowerCase()
  const turn = (lines.get(key) ?? Promise.resolve()).then(step)
  lines.set(key, turn.catch(() => undefined))
  return turn
}

const readWallet = <T,>(address: Address, functionName: string) =>
  publicClient.readContract({ address, abi: WaveAccountAbi, functionName: functionName as never }) as Promise<T>

function addOperation(agent: Address, master: Address, action: Action, decoded: DecodedAction, limits: Limits): Operation {
  // A Map keeps its insertion order, so this removes the oldest first.
  for (const [id, old] of operations) {
    if (operations.size < MAX_OPERATIONS) break
    if (!OPEN.has(old.status)) operations.delete(id)
  }
  const operation: Operation = {
    id: randomUUID(),
    agent,
    master,
    action,
    decoded,
    expiresAt: Date.now() + OPERATION_MS,
    approvalId: randomUUID(),
    status: 'needs-approval',
    txHash: null,
    refusal: null,
    rejection: null,
    limits,
    attemptId: null,
    starting: null,
    identity: null,
    confirmToken: null,
  }
  operations.set(operation.id, operation)
  return operation
}

function expireIfDue(operation: Operation) {
  const waiting = operation.status === 'needs-approval' || operation.status === 'needs-confirmation'
  if (waiting && Date.now() > operation.expiresAt) {
    operation.status = 'expired'
    operation.approvalId = null
  }
}

function toView(operation: Operation): AgentOperationView {
  expireIfDue(operation)
  const { id, agent, status, decoded, expiresAt, txHash, refusal, rejection, attemptId, identity } = operation
  return {
    id,
    agent,
    status,
    decoded,
    expiresAt,
    txHash,
    explorerUrl: txHash ? explorerLink(txHash) : null,
    refusal,
    rejection,
    device: status === 'needs-approval' && attemptId ? deviceHandoff(attemptId) : null,
    identity: !identity ? null : identityOf(agent) ? 'matched' : 'first',
  }
}

const viewsOf = (master: Address): AgentOperationView[] =>
  [...operations.values()]
    .filter((operation) => operation.master.toLowerCase() === master.toLowerCase())
    .map(toView)
    .reverse()

/** Only the main wallet can emit this event. Anyone can deploy a clone that names a master. */
async function linkedAgents(d: Deployment, master: Address): Promise<Address[]> {
  const logs = await publicClient.getContractEvents({
    address: master,
    abi: WaveAccountAbi,
    eventName: 'AgentLinked',
    fromBlock: BigInt(d.deployedAtBlock),
    toBlock: 'latest',
  })
  return [...new Set(logs.map((log) => (log.args as { agent: Address }).agent))]
}

export async function readAgent(d: Deployment, address: Address, keyAddress: Address | null): Promise<AgentView> {
  const [balances, paused, signer, block, sponsor] = await Promise.all([
    readBalances(d, address),
    readWallet<boolean>(address, 'agentPaused'),
    readWallet<Address>(address, 'agentKey'),
    publicClient.getBlock(),
    sponsorView(d, address),
  ])
  const now = Number(block.timestamp)
  const live = signer !== ZERO
  return {
    address,
    balances,
    paused,
    signer: live ? signer : null,
    serverHoldsKey: live && keyAddress?.toLowerCase() === signer.toLowerCase(),
    rules: await Promise.all(tokensOf(d).map((token) => readRules(address, token.address, now))),
    askAbove: askAboveList(address),
    identityLinked: identityOf(address) !== null,
    sponsor,
  }
}

export async function readAgents(masterText: unknown): Promise<AgentsResponse> {
  const master = asAddress(masterText, 'master')
  const d = deployment()
  const keyAddress = agentKeyAccount()?.address ?? null
  const shape = {
    agentKey: keyAddress,
    agentPassConfigured: agentPassConfigured(),
    operations: viewsOf(master),
    toolAgent: readToolAgent(),
  }
  if (!d.agentKeyValidator) return { ...shape, supported: false, agents: [], next: null }

  const linked = await linkedAgents(d, master)
  const salt = keccak256(encodePacked(['address', 'uint256'], [master, BigInt(linked.length)]))
  const { address } = await agentDeployment(d, master, salt)
  return {
    ...shape,
    supported: true,
    agents: await Promise.all(linked.map((agent) => readAgent(d, agent, keyAddress))),
    next: { address, salt },
  }
}

/** The master of a real agent wallet, or a failure. */
async function masterOf(agent: Address): Promise<Address> {
  const code = await publicClient.getCode({ address: agent })
  const master = code && code !== '0x' ? await readWallet<Address>(agent, 'master') : ZERO
  if (master === ZERO) throw new ApiFailure('NOT_AN_AGENT', 'This address is not an agent wallet.', 404)
  return master
}

/** What stops the key from signing. The chain would refuse each of these too. */
async function keyBlock(agent: Address): Promise<Decoded | null> {
  const account = agentKeyAccount()
  if (!account) throw new ApiFailure('AGENT_KEY_MISSING', 'Set WAVE_AGENT_DEMO_KEY in .env.local, then restart the server.', 503)
  const [signer, paused] = await Promise.all([
    readWallet<Address>(agent, 'agentKey'),
    readWallet<boolean>(agent, 'agentPaused'),
  ])
  if (signer === ZERO) return { code: 'AgentRevoked' }
  if (paused) return { code: 'AgentPaused' }
  return signer.toLowerCase() === account.address.toLowerCase() ? null : { code: 'AgentKeyMismatch' }
}

type Spend = Extract<Action, { kind: 'spend' }>

/**
 * Changes when the wallet's rules change. A loosen moves `configVersion`. A tighten does not, but it
 * moves `tightenedAt`.
 */
async function ruleVersion(agent: Address, token: Address): Promise<string> {
  const [config, tightened] = await Promise.all([
    readWallet<number>(agent, 'configVersion'),
    publicClient.readContract({ address: agent, abi: WaveAccountAbi, functionName: 'tightenedAt', args: [token] }),
  ])
  return `${config}:${tightened}`
}

async function prepareSpend(agent: Address, spend: Spend) {
  return prepareTx({
    account: agent,
    method: { kind: 'agent' },
    action: { kind: 'transfer', token: spend.token, to: spend.to, amount: spend.amount.toString() },
  })
}

/** Signs a prepared transaction with the agent key and sends it. */
async function signAndSend(prepared: TxPrepared): Promise<TxSendResponse> {
  const account = agentKeyAccount()
  if (!account) throw new ApiFailure('AGENT_KEY_MISSING', 'WAVE_AGENT_DEMO_KEY is not set.', 503)
  const data = await account.sign({ hash: prepared.sigHash })
  return sendTx({ envelope: prepared.envelope, method: prepared.method, witness: { kind: 'agent', data } })
}

function spendAction(d: Deployment, body: AgentSpendRequest): Spend {
  const token = asAddress(body.token, 'token')
  if (!tokensOf(d).some((item) => item.address.toLowerCase() === token.toLowerCase())) {
    throw new ApiFailure('BAD_REQUEST', 'This token is not listed.')
  }
  const amount = asBaseUnits(body.amount, 'amount')
  if (amount === 0n) throw new ApiFailure('BAD_REQUEST', 'The amount must be above zero.')
  return { kind: 'spend', token, to: asAddress(body.to, 'to'), amount }
}

/** `beforeSend` runs just before the key signs. If it throws, nothing goes out. */
export async function requestSpend(body: AgentSpendRequest, beforeSend?: () => void): Promise<AgentSpendResponse> {
  const d = deployment()
  const agent = asAddress(body.agent, 'agent')
  const spend = spendAction(d, body)
  const master = await masterOf(agent)
  return inLine(agent, () => runSpend(agent, master, spend, beforeSend))
}

async function runSpend(agent: Address, master: Address, spend: Spend, beforeSend?: () => void): Promise<AgentSpendResponse> {
  const block = await keyBlock(agent)
  if (block) return { result: 'rejected', rejection: prepareRejection(block) }
  // The tiers run first, so nobody approves a spend that the chain would refuse.
  const prepared = await prepareSpend(agent, spend)
  if (!prepared.ok) return { result: 'rejected', rejection: prepared.rejection }

  // No stored amount means that the checkpoint covers each spend. A lost setting must not free the agent.
  const limit = askAboveOf(agent, spend.token)
  if (limit === null || spend.amount > limit) {
    const decoded = {
      ...prepared.decoded,
      lines: [
        { label: 'Agent wallet', value: agent, mono: true },
        { label: 'Token', value: spend.token, mono: true },
        ...prepared.decoded.lines,
      ],
    }
    const limits = { askAbove: limit, rules: await ruleVersion(agent, spend.token) }
    return { result: 'needs-approval', operation: toView(addOperation(agent, master, spend, decoded, limits)) }
  }

  beforeSend?.()
  const sent = await signAndSend(prepared)
  if (!sent.ok) return { result: 'rejected', rejection: sent.rejection }
  return { result: 'sent', txHash: sent.txHash, explorerUrl: explorerLink(sent.txHash), frames: sent.frames }
}

/** Saves the agent that the MCP tools use. Only a linked agent that this server can sign for passes. */
export async function chooseToolAgent(text: unknown): Promise<Address> {
  const agent = asAddress(text, 'agent')
  const linked = await linkedAgents(deployment(), await masterOf(agent))
  if (!linked.some((item) => item.toLowerCase() === agent.toLowerCase())) {
    throw new ApiFailure('NOT_AN_AGENT', 'The main wallet did not link this agent wallet.', 404)
  }
  const block = await keyBlock(agent)
  if (block) throw new ApiFailure('AGENT_NOT_READY', `This agent cannot spend now: ${block.code}.`, 409)
  saveToolAgent(agent)
  return agent
}

export async function setCheckpoint(body: AgentCheckpointRequest): Promise<AgentCheckpointResponse> {
  const d = deployment()
  const agent = asAddress(body.agent, 'agent')
  const token = asAddress(body.token, 'token')
  const info = tokensOf(d).find((item) => item.address.toLowerCase() === token.toLowerCase())
  if (!info) throw new ApiFailure('BAD_REQUEST', 'This token is not listed.')
  const askAbove = asBaseUnits(body.askAbove, 'askAbove')
  const master = await masterOf(agent)

  // A first value or a lower value gives the agent no new freedom. A higher value does.
  const current = askAboveOf(agent, token)
  if (current === null || askAbove <= current) {
    setAskAbove(agent, token, askAbove)
    return { result: 'applied' }
  }
  const text = `${plainAmount(askAbove, info.decimals)} ${info.symbol}`
  const decoded: DecodedAction = {
    title: `Let the agent send alone up to ${text}`,
    lines: [
      { label: 'Agent wallet', value: agent, mono: true },
      { label: 'Now', value: `${plainAmount(current, info.decimals)} ${info.symbol}`, mono: true },
      { label: 'New', value: text, mono: true },
    ],
  }
  const limits = { askAbove: current, rules: null }
  const operation = addOperation(agent, master, { kind: 'raise-checkpoint', token, askAbove }, decoded, limits)
  return { result: 'needs-approval', operation: toView(operation) }
}

function findOperation(id: unknown): Operation {
  const operation = typeof id === 'string' ? operations.get(id) : undefined
  if (!operation) throw new ApiFailure('OPERATION_UNKNOWN', 'The server has no such action. A restart removes them.', 404)
  return operation
}

const closed = () => new ApiFailure('OPERATION_CLOSED', 'This action cannot take this step now.', 409)

/** This read has no side effect on the action, so a client can repeat it. */
export const readOperation = (id: unknown): AgentOperationView => toView(findOperation(id))

/** Writes each send with an open result. A failed write here leaves a stale record, never a lost one. */
function saveSends() {
  saveOpenSends(
    [...operations.values()]
      .filter(({ status }) => status === 'sending' || status === 'unknown')
      .map(({ id, agent, master, decoded, expiresAt, txHash }) => ({ id, agent, master, decoded, expiresAt, txHash })),
  )
}

function fail(operation: Operation, rejection: Rejection) {
  operation.status = 'failed'
  operation.rejection = rejection
}

const limitChanged = (operation: Operation) =>
  fail(operation, { stage: 'prepare', code: 'LimitChanged', message: 'A limit changed after the request.' })

async function limitsMatch(operation: Operation, action: Action): Promise<boolean> {
  const { agent, limits } = operation
  if (askAboveOf(agent, action.token) !== limits.askAbove) return false
  return limits.rules === null || (await ruleVersion(agent, action.token)) === limits.rules
}

/** Records the result of a send that the mempool took. */
async function settle(operation: Operation, hash: Hex) {
  operation.txHash = hash
  // The send can return with no receipt. Only a read of the chain can say that the payment ran.
  const seen = await txStatus(hash).catch(() => null)
  if (seen?.state === 'included') operation.status = 'done'
  else if (seen?.state === 'failed' && seen.rejection) fail(operation, seen.rejection)
  else operation.status = 'unknown'
}

/** This runs once, after the confirmation. The stored operation is the only input. */
async function runOperation(operation: Operation, action: Action) {
  const { agent } = operation
  let handedOver = false
  try {
    if (!(await limitsMatch(operation, action))) return limitChanged(operation)
    if (action.kind === 'raise-checkpoint') {
      setAskAbove(agent, action.token, action.askAbove)
      operation.status = 'done'
      return
    }
    const block = await keyBlock(agent)
    if (block) return fail(operation, prepareRejection(block))
    const prepared = await prepareSpend(agent, action)
    if (!prepared.ok) return fail(operation, prepared.rejection)
    handedOver = true
    const sent = await signAndSend(prepared)
    if (sent.ok) await settle(operation, sent.txHash)
    else fail(operation, sent.rejection)
  } catch (error) {
    // Do not log the raw error: it can hold an RPC URL with an API key.
    console.error('[agents] the approved action failed:', error instanceof Error ? error.name : 'unknown')
    if (handedOver) operation.status = 'unknown'
    else fail(operation, { stage: 'prepare', code: 'SendFailed', message: 'The server failed before the send.' })
  }
}

/** Starts or shows the device step for one stored operation. The client names nothing else. */
export async function startDeviceApproval(id: unknown): Promise<AgentOperationView> {
  const operation = findOperation(id)
  expireIfDue(operation)
  if (operation.status !== 'needs-approval') throw closed()
  // A live code stays valid, so a repeat does not spend a World start.
  const live = operation.attemptId ? deviceHandoff(operation.attemptId) : null
  if (!live) {
    operation.starting ??= beginDevice(operation).finally(() => {
      operation.starting = null
    })
    await operation.starting
  }
  return toView(operation)
}

async function beginDevice(operation: Operation) {
  operation.refusal = null
  const attemptId = await startDeviceAttempt(operation.agent, {
    expiresAt: operation.expiresAt,
    authenticated: (identity) => {
      expireIfDue(operation)
      if (operation.status !== 'needs-approval') return false
      operation.identity = identity
      operation.status = 'needs-confirmation'
      return true
    },
    refused: (reason: AgentPassReason, detail: string) => {
      if (operation.status === 'needs-approval') operation.refusal = { reason, detail }
      expireIfDue(operation)
    },
  })
  operation.attemptId = attemptId
  // The owner can reject while this start waits for World.
  if (operation.status !== 'needs-approval') cancelAttempt(attemptId, 'The action ended.')
}

function rejectOperation(operation: Operation) {
  expireIfDue(operation)
  if (operation.status !== 'needs-approval' && operation.status !== 'needs-confirmation') throw closed()
  operation.status = 'rejected'
  operation.approvalId = null
  if (operation.attemptId) cancelAttempt(operation.attemptId, 'The owner rejected this action.')
}

const hashToken = (token: string) => createHash('sha256').update(token).digest()

/** Gives the page one token for one operation. A new token replaces the last one. */
export function issueConfirmToken(id: unknown): AgentConfirmTokenResponse {
  const operation = findOperation(id)
  expireIfDue(operation)
  if (operation.status !== 'needs-confirmation') throw closed()
  const confirmToken = randomBytes(32).toString('base64url')
  operation.confirmToken = { hash: hashToken(confirmToken), until: Date.now() + CONFIRM_TOKEN_MS }
  return { confirmToken }
}

/** Each try uses the stored token, right or wrong. So nobody can guess, and a replay finds nothing. */
function spendConfirmToken(operation: Operation, token: unknown) {
  const stored = operation.confirmToken
  operation.confirmToken = null
  const valid =
    typeof token === 'string' &&
    stored !== null &&
    Date.now() <= stored.until &&
    timingSafeEqual(stored.hash, hashToken(token))
  if (!valid) throw new ApiFailure('CONFIRM_TOKEN_INVALID', 'Press Confirm on the /agents page.', 403)
}

async function confirmOperation(operation: Operation, token: unknown) {
  expireIfDue(operation)
  const { action, agent, identity, approvalId } = operation
  if (operation.status !== 'needs-confirmation' || !action || !identity || !approvalId) throw closed()
  spendConfirmToken(operation, token)

  // No `await` comes before the send record is on disk, so only one request can use the approval.
  operation.approvalId = null
  const linked = identityOf(agent)
  if (linked && (linked.iss !== identity.iss || linked.sub !== identity.sub)) {
    return fail(operation, { stage: 'prepare', code: 'IdentityChanged', message: 'Another World ID is linked now.' })
  }
  operation.status = 'sending'
  try {
    // A crash during the send leaves this record, so a restart shows "unknown", not a lost send.
    saveSends()
    if (!linked) linkIdentity(agent, identity)
  } catch (error) {
    console.error('[agents] the send record failed:', error instanceof Error ? error.name : 'unknown')
    return fail(operation, { stage: 'prepare', code: 'SendFailed', message: 'The server could not save the send, so it sent nothing.' })
  }

  await inLine(agent, () => runOperation(operation, action))
  try {
    saveSends()
  } catch (error) {
    // The file can then show a finished send as "unknown". That is the safe error.
    console.error('[agents] the send record failed:', error instanceof Error ? error.name : 'unknown')
  }
}

/** The answer of a person on /agents. A repeat finds the action closed, so it cannot send twice. */
export async function decideOperation(body: AgentDecisionRequest): Promise<AgentOperationView> {
  const operation = findOperation(body.operationId)
  if (body.decision === 'reject') rejectOperation(operation)
  else if (body.decision === 'confirm') await confirmOperation(operation, body.confirmToken)
  else throw new ApiFailure('BAD_REQUEST', 'decision must be confirm or reject.')
  return toView(operation)
}
