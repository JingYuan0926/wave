// What the local MCP tools can do: read one agent wallet and ask for a payment. Server side only.
// The tools run in another process and reach this code through localhost. The agent key and the
// client secret stay here. Nothing in this file can approve: only the /agents page can confirm.
import { randomUUID } from 'node:crypto'
import type { Address } from 'viem'
import type {
  AgentOperationView,
  Rejection,
  TierView,
  TokenInfo,
  ToolAgentResponse,
  ToolAgentState,
  ToolSendRequest,
  ToolSendResponse,
} from '../api-types'
import { explorerLink, publicClient } from '../chain'
import { aloneAmount } from '../limits'
import { parseTokenAmount, plainAmount } from '../ui/format'
import { explainAgentRejection, explainRejection } from '../ui/rejections'
import { readRules } from './account-view'
import { agentKeyAccount } from './agent-key'
import {
  dropSendRef,
  readToolAgent,
  saveSendRef,
  sendRefOf,
  type SendRef,
} from './agent-store'
import { readAgent, readOperation, requestSpend, startDeviceApproval } from './agents'
import { tokensOf } from './decode'
import { ApiFailure, asAddress, deployment } from './http'
import { txStatus } from './send'

const DEFAULT_TOKEN = 'tUSDC'
const CLIENT_REF = /^[\w.:-]{1,80}$/

const UNKNOWN_RESULT = 'WAVE cannot tell if this ran. It will not send it again. Check the wallet activity on /agents.'
const NO_OPERATION = 'The server restarted, so it lost this request. It will not send it again. Check the wallet activity.'

type Payment = { clientRef: string; payment: string; repeat: boolean }
type ToolResult = ToolSendResponse

// Each route has its own module copy in dev, so the state lives on globalThis.
const running = ((globalThis as typeof globalThis & {
  __waveToolSends?: Map<string, { fingerprint: string; result: Promise<ToolResult> }>
}).__waveToolSends ??= new Map())

function toolAgent(): Address {
  const agent = readToolAgent()
  if (!agent) {
    throw new ApiFailure('NO_TOOL_AGENT', 'No agent wallet is set. Open /agents and press "Use with Claude Code".', 409)
  }
  return agent
}

function stateOf(signer: Address | null, paused: boolean, serverHoldsKey: boolean): ToolAgentState {
  if (signer === null) return 'revoked'
  if (paused) return 'paused'
  return serverHoldsKey ? 'active' : 'wrong-key'
}

/** What the most per day still allows. The tier and the wallet's daily total both count. */
function leftToday(tier: TierView | undefined, dailyLeft: bigint | null): bigint | null {
  const tierLeft = tier && BigInt(tier.cap) > 0n ? BigInt(tier.cap) - BigInt(tier.spent) : null
  if (tierLeft === null) return dailyLeft
  // A lower total can sit below the amount that the agent already sent.
  const low = dailyLeft !== null && dailyLeft < tierLeft ? dailyLeft : tierLeft
  return low > 0n ? low : 0n
}

export async function readToolAgentView(): Promise<ToolAgentResponse> {
  const d = deployment()
  const agent = toolAgent()
  const view = await readAgent(d, agent, agentKeyAccount()?.address ?? null)
  return {
    agent,
    state: stateOf(view.signer, view.paused, view.serverHoldsKey),
    tokens: tokensOf(d).map((token) => {
      const same = (address: string) => address.toLowerCase() === token.address.toLowerCase()
      const text = (value: string | bigint) => plainAmount(value, token.decimals)
      const rules = view.rules.find((rule) => same(rule.token))
      const tier = rules?.tiers[0]
      const ask = view.askAbove.find((item) => same(item.token))
      const left = leftToday(tier, rules?.daily ? BigInt(rules.daily.left) : null)
      const perDay = tier && BigInt(tier.cap) > 0n ? tier.cap : rules?.daily?.limit
      return {
        symbol: token.symbol,
        isTest: token.isTest,
        balance: text(view.balances.find((item) => same(item.token))?.amount ?? '0'),
        perTransfer: tier ? text(tier.upTo) : null,
        perDay: perDay ? text(perDay) : null,
        leftToday: left === null ? null : text(left),
        askAbove: ask ? text(tier ? aloneAmount(tier, ask.amount) : ask.amount) : null,
      }
    }),
  }
}

/** A plain reason. It leaves out the raw message, which can hold an RPC URL with an API key. */
async function reasonOf(rejection: Rejection, agent: Address, token: TokenInfo, amount: bigint): Promise<string> {
  const { title, detail, stage } = explainRejection({ ...rejection, message: undefined })
  if (rejection.code !== 'NoTier') return `${title}. ${detail} ${stage}`

  const hard = 'The onchain rule refuses this, and a human approval cannot override it. Nothing was sent.'
  const block = await publicClient.getBlock()
  const rules = await readRules(agent, token.address, Number(block.timestamp))
  const tier = rules.tiers[0]
  const text = (value: string | bigint) => `${plainAmount(value, token.decimals)} ${token.symbol}`
  const left = leftToday(tier, rules.daily ? BigInt(rules.daily.left) : null)
  if (left !== null && amount > left) return `This is above the most per day. ${text(left)} is left today. ${hard}`
  if (tier && amount > BigInt(tier.upTo)) return `One payment can send at most ${text(tier.upTo)}. ${hard}`
  return `The limits of this agent do not allow this amount. ${hard}`
}

/** The answer for an operation, also when a retry finds it later. */
function operationResult(view: AgentOperationView, base: Payment, note: string | null): ToolResult {
  const { id: operationId, status, decoded: action, expiresAt, device, txHash, explorerUrl, rejection } = view
  switch (status) {
    case 'needs-approval':
    case 'needs-confirmation':
      return {
        ...base,
        result: 'needs_approval',
        operationId,
        action,
        expiresAt,
        step: status === 'needs-approval' ? 'world-id' : 'confirm',
        device,
        note: device || status === 'needs-confirmation' ? null : (note ?? 'No World ID login is open. Start one on /agents.'),
      }
    case 'done':
      if (!txHash || !explorerUrl) return { ...base, result: 'unknown', reason: UNKNOWN_RESULT, txHash, explorerUrl }
      return { ...base, result: 'sent', txHash, explorerUrl, confirmed: true }
    case 'failed': {
      const reason = rejection ? explainAgentRejection({ ...rejection, message: undefined }) : null
      return { ...base, result: 'refused', reason: reason ? `${reason.title}. ${reason.detail}` : 'The payment did not run.' }
    }
    case 'rejected':
      return { ...base, result: 'refused', reason: 'The owner rejected this. Nothing was sent.' }
    case 'expired':
      return { ...base, result: 'refused', reason: 'The approval window ended. Nothing was sent.' }
    case 'sending':
      return { ...base, result: 'unknown', reason: 'The send runs now. Use check_approval.', txHash, explorerUrl }
    default:
      return { ...base, result: 'unknown', reason: UNKNOWN_RESULT, txHash, explorerUrl }
  }
}

/** A retry. This never sends. */
function replay(saved: SendRef, base: Payment): ToolResult {
  const { state, txHash, operationId } = saved
  if (state === 'sent' && txHash) {
    return { ...base, result: 'sent', txHash, explorerUrl: explorerLink(txHash), confirmed: true }
  }
  if (state === 'operation' && operationId) {
    try {
      return operationResult(readOperation(operationId), base, null)
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error
      return { ...base, result: 'unknown', reason: NO_OPERATION, txHash: null, explorerUrl: null }
    }
  }
  return { ...base, result: 'unknown', reason: UNKNOWN_RESULT, txHash, explorerUrl: null }
}

/** Starts the login, so that the terminal can show the code. A failure leaves the action waiting. */
async function withLogin(operation: AgentOperationView, base: Payment): Promise<ToolResult> {
  try {
    return operationResult(await startDeviceApproval(operation.id), base, null)
  } catch (error) {
    if (!(error instanceof ApiFailure)) throw error
    return operationResult(readOperation(operation.id), base, `${error.message} Try again on /agents.`)
  }
}

async function runPayment(
  agent: Address,
  token: TokenInfo,
  to: Address,
  amount: bigint,
  fingerprint: string,
  base: Payment,
): Promise<ToolResult> {
  const { clientRef } = base
  let handedOver = false
  try {
    const answer = await requestSpend({ agent, token: token.address, to, amount: amount.toString() }, () => {
      saveSendRef(clientRef, { fingerprint, state: 'sending', txHash: null, operationId: null })
      handedOver = true
    })
    if (answer.result === 'rejected') {
      // Nothing moved, so a retry can run again. It meets each check again.
      dropSendRef(clientRef)
      return { ...base, result: 'refused', reason: await reasonOf(answer.rejection, agent, token, amount) }
    }
    if (answer.result === 'needs-approval') {
      saveSendRef(clientRef, { fingerprint, state: 'operation', txHash: null, operationId: answer.operation.id })
      return await withLogin(answer.operation, base)
    }
    const { txHash, explorerUrl } = answer
    saveSendRef(clientRef, { fingerprint, state: 'sent', txHash, operationId: null })
    const seen = await txStatus(txHash).catch(() => null)
    return { ...base, result: 'sent', txHash, explorerUrl, confirmed: seen?.state === 'included' }
  } catch (error) {
    if (!handedOver) throw error
    // Do not log the raw error: it can hold an RPC URL with an API key.
    console.error('[agent tools] the send had no clear result:', error instanceof Error ? error.name : 'unknown')
    return { ...base, result: 'unknown', reason: UNKNOWN_RESULT, txHash: null, explorerUrl: null }
  }
}

/** Sends or pauses one payment from the saved agent. The same clientRef always means this payment. */
export function sendFromTool(body: ToolSendRequest): Promise<ToolResult> {
  const d = deployment()
  const agent = toolAgent()
  const symbol = body.token ?? DEFAULT_TOKEN
  const tokens = tokensOf(d)
  const token = tokens.find((item) => item.symbol.toLowerCase() === String(symbol).toLowerCase())
  if (!token) throw new ApiFailure('BAD_REQUEST', `Unknown token. Use one of: ${tokens.map((item) => item.symbol).join(', ')}.`)
  const to = asAddress(body.to, 'to')
  const { value: amount, error } = parseTokenAmount(String(body.amount), token.decimals)
  if (amount === null) throw new ApiFailure('BAD_REQUEST', error ?? 'The amount is not valid.')
  if (body.clientRef !== undefined && !CLIENT_REF.test(body.clientRef)) {
    throw new ApiFailure('BAD_REQUEST', 'clientRef must be 1 to 80 letters, digits, dots, colons, dashes or underscores.')
  }

  const clientRef = body.clientRef ?? randomUUID()
  const fingerprint = [agent, token.address, to, amount].join(':').toLowerCase()
  const base = { clientRef, payment: `${plainAmount(amount, token.decimals)} ${token.symbol} to ${to}`, repeat: false }

  // No `await` comes before `running.set`, so two calls at once cannot both start this payment.
  const earlier = running.get(clientRef)?.fingerprint ?? sendRefOf(clientRef)?.fingerprint
  if (earlier !== undefined && earlier !== fingerprint) {
    throw new ApiFailure('CLIENT_REF_USED', 'This clientRef belongs to another payment. Nothing was sent.', 409)
  }
  const active = running.get(clientRef)
  if (active) return active.result
  const saved = sendRefOf(clientRef)
  if (saved) return Promise.resolve(replay(saved, { ...base, repeat: true }))

  const result = runPayment(agent, token, to, amount, fingerprint, base).finally(() => running.delete(clientRef))
  running.set(clientRef, { fingerprint, result })
  return result
}
