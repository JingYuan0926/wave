// Agent wallets: the list, the agent's spends and the human checkpoint. Server side only.
// The contract enforces the spending tiers. This file adds one more gate: above the "ask a human"
// amount, nothing runs until a person passes Agent Pass. The demo agent key sits on this server,
// so this gate is a server rule, not a chain rule.
import { randomUUID } from 'node:crypto'
import { encodePacked, keccak256, type Address, type Hex } from 'viem'
import type {
  AgentCheckpointRequest,
  AgentCheckpointResponse,
  AgentOperationStatus,
  AgentOperationView,
  AgentPassReason,
  AgentPassStartResponse,
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
import { agentPassConfigured, startAttempt } from './agent-pass'
import { askAboveList, askAboveOf, identityOf, setAskAbove } from './agent-store'
import { tokensOf } from './decode'
import { ApiFailure, asAddress, asBaseUnits, deployment } from './http'
import { agentDeployment, prepareTx } from './prepare'
import { prepareRejection, type Decoded } from './reject'
import { sendTx } from './send'
import { sponsorView } from './sponsor'

const OPERATION_MS = 5 * 60_000
/** Each ended operation stays visible. This cap keeps the memory small. */
const MAX_OPERATIONS = 200

const ZERO = '0x0000000000000000000000000000000000000000'

type Action =
  | { kind: 'spend'; token: Address; to: Address; amount: bigint }
  | { kind: 'raise-checkpoint'; token: Address; askAbove: bigint }

type Operation = {
  id: string
  agent: Address
  master: Address
  action: Action
  decoded: DecodedAction
  expiresAt: number
  /** One use. consume() clears it. */
  approvalId: string | null
  status: AgentOperationStatus
  txHash: Hex | null
  refusal: AgentOperationView['refusal']
  rejection: Rejection | null
}

// Each route has its own module copy in dev, so the state lives on globalThis.
// A restart removes pending operations, so nothing can run from an old approval.
const shared = globalThis as typeof globalThis & { __waveAgentOperations?: Map<string, Operation> }
const operations: Map<string, Operation> = (shared.__waveAgentOperations ??= new Map())

const readWallet = <T,>(address: Address, functionName: string) =>
  publicClient.readContract({ address, abi: WaveAccountAbi, functionName: functionName as never }) as Promise<T>

function addOperation(agent: Address, master: Address, action: Action, decoded: DecodedAction): Operation {
  // A Map keeps its insertion order, so this removes the oldest first.
  for (const [id, old] of operations) {
    if (operations.size < MAX_OPERATIONS) break
    if (old.status !== 'needs-approval' && old.status !== 'sending') operations.delete(id)
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
  }
  operations.set(operation.id, operation)
  return operation
}

function expireIfDue(operation: Operation) {
  if (operation.status === 'needs-approval' && Date.now() > operation.expiresAt) {
    operation.status = 'expired'
    operation.approvalId = null
  }
}

function toView(operation: Operation): AgentOperationView {
  expireIfDue(operation)
  const { id, agent, status, decoded, expiresAt, txHash, refusal, rejection } = operation
  return { id, agent, status, decoded, expiresAt, txHash, explorerUrl: txHash ? explorerLink(txHash) : null, refusal, rejection }
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

async function readAgent(d: Deployment, address: Address, keyAddress: Address | null): Promise<AgentView> {
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
  const shape = { agentKey: keyAddress, agentPassConfigured: agentPassConfigured(), operations: viewsOf(master) }
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

export async function requestSpend(body: AgentSpendRequest): Promise<AgentSpendResponse> {
  const d = deployment()
  const agent = asAddress(body.agent, 'agent')
  const spend = spendAction(d, body)
  const master = await masterOf(agent)

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
      lines: [{ label: 'Agent wallet', value: agent, mono: true }, ...prepared.decoded.lines],
    }
    return { result: 'needs-approval', operation: toView(addOperation(agent, master, spend, decoded)) }
  }

  const sent = await signAndSend(prepared)
  if (!sent.ok) return { result: 'rejected', rejection: sent.rejection }
  return { result: 'sent', txHash: sent.txHash, explorerUrl: explorerLink(sent.txHash), frames: sent.frames }
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
    title: `Let the agent spend up to ${text} with no approval`,
    lines: [
      { label: 'Agent wallet', value: agent, mono: true },
      { label: 'Now', value: `${plainAmount(current, info.decimals)} ${info.symbol}`, mono: true },
      { label: 'New', value: text, mono: true },
    ],
  }
  const operation = addOperation(agent, master, { kind: 'raise-checkpoint', token, askAbove }, decoded)
  return { result: 'needs-approval', operation: toView(operation) }
}

function fail(operation: Operation, rejection: Rejection) {
  operation.status = 'failed'
  operation.rejection = rejection
}

/** This runs once, after the approval is used. The stored operation is the only input. */
async function runOperation(operation: Operation): Promise<Hex | null> {
  const { action, agent } = operation
  try {
    if (action.kind === 'raise-checkpoint') {
      setAskAbove(agent, action.token, action.askAbove)
      operation.status = 'done'
      return null
    }
    const block = await keyBlock(agent)
    if (block) {
      fail(operation, prepareRejection(block))
      return null
    }
    const prepared = await prepareSpend(agent, action)
    if (!prepared.ok) {
      fail(operation, prepared.rejection)
      return null
    }
    const sent = await signAndSend(prepared)
    if (!sent.ok) {
      fail(operation, sent.rejection)
      return null
    }
    operation.status = 'done'
    operation.txHash = sent.txHash
    return sent.txHash
  } catch (error) {
    // Do not log the raw error: it can hold an RPC URL with an API key.
    console.error('[agents] the approved action failed:', error instanceof Error ? error.name : 'unknown')
    fail(operation, { stage: 'prepare', code: 'SendFailed', message: 'The server failed after the approval. Check the wallet activity.' })
    return null
  }
}

/** Starts a step-up for one stored operation. The client names the operation, and nothing else. */
export async function startOperation(id: unknown, returnUrl: string): Promise<AgentPassStartResponse> {
  const operation = typeof id === 'string' ? operations.get(id) : undefined
  if (!operation) throw new ApiFailure('OPERATION_UNKNOWN', 'The server has no such action. A restart removes them.', 404)
  expireIfDue(operation)
  if (operation.status !== 'needs-approval') {
    throw new ApiFailure('OPERATION_CLOSED', 'This action cannot take an approval now.', 409)
  }
  operation.refusal = null
  return startAttempt(operation.agent, {
    expiresAt: operation.expiresAt,
    consume: () => {
      expireIfDue(operation)
      if (operation.status !== 'needs-approval' || operation.approvalId === null) return false
      operation.approvalId = null
      operation.status = 'sending'
      return true
    },
    run: () => runOperation(operation),
    refused: (reason: AgentPassReason, detail: string) => {
      if (operation.status === 'needs-approval') operation.refusal = { reason, detail }
      expireIfDue(operation)
    },
    returnUrl,
  })
}
