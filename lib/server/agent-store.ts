// What the server keeps per agent wallet: the alone amounts (`askAbove`) and the linked person.
// A file holds these, because a restart must not remove a checkpoint or free a linked wallet.
// Pending operations stay in server memory. A second file holds only the sends with an open
// outcome, because a restart must not make a person forget them. Two more files serve the MCP
// tools: the agent wallet that the tools use, and the clientRef of each payment. Server side only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Address, Hex } from 'viem'
import type { DecodedAction } from '../api-types'
import { NETWORK } from '../chain'

export type Identity = { iss: string; sub: string }

type Entry = { askAbove: Record<string, string>; identity?: Identity }

const stateFile = () => path.join(process.cwd(), '.wave', `agents-${NETWORK}.json`)

// Each route has its own module copy in dev, so the state lives on globalThis.
const shared = globalThis as typeof globalThis & { __waveAgentStore?: Map<string, Entry> }

function entries(): Map<string, Entry> {
  if (shared.__waveAgentStore) return shared.__waveAgentStore
  let loaded: Record<string, Entry> = {}
  try {
    loaded = JSON.parse(readFileSync(/*turbopackIgnore: true*/ stateFile(), 'utf8')) as Record<string, Entry>
  } catch {
    // No file yet. An agent with no entry asks a human for every spend.
  }
  return (shared.__waveAgentStore = new Map(Object.entries(loaded)))
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(/*turbopackIgnore: true*/ temp, JSON.stringify(value, null, 2))
  renameSync(/*turbopackIgnore: true*/ temp, file)
}

const save = () => writeJson(stateFile(), Object.fromEntries(entries()))

function entryOf(wallet: Address): Entry {
  const key = wallet.toLowerCase()
  const found = entries().get(key)
  if (found) return found
  const fresh: Entry = { askAbove: {} }
  entries().set(key, fresh)
  return fresh
}

/** Null means that no amount is set. Then every spend of this token asks a human. */
export function askAboveOf(wallet: Address, token: Address): bigint | null {
  const value = entries().get(wallet.toLowerCase())?.askAbove[token.toLowerCase()]
  return value === undefined ? null : BigInt(value)
}

export function askAboveList(wallet: Address): { token: Address; amount: string }[] {
  return Object.entries(entries().get(wallet.toLowerCase())?.askAbove ?? {}).map(([token, amount]) => ({
    token: token as Address,
    amount,
  }))
}

export function setAskAbove(wallet: Address, token: Address, amount: bigint) {
  entryOf(wallet).askAbove[token.toLowerCase()] = amount.toString()
  save()
}

export const identityOf = (wallet: Address): Identity | null => entries().get(wallet.toLowerCase())?.identity ?? null

export function linkIdentity(wallet: Address, identity: Identity) {
  entryOf(wallet).identity = identity
  save()
}

/** A send that started and has no known result. It can never run again. */
export type OpenSend = {
  id: string
  agent: Address
  master: Address
  decoded: DecodedAction
  expiresAt: number
  txHash: Hex | null
}

const sendsFile = () => path.join(process.cwd(), '.wave', `agent-sends-${NETWORK}.json`)

export function readOpenSends(): OpenSend[] {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ sendsFile(), 'utf8')) as OpenSend[]
  } catch {
    return []
  }
}

export const saveOpenSends = (sends: OpenSend[]) => writeJson(sendsFile(), sends)

const toolAgentFile = () => path.join(process.cwd(), '.wave', `tool-agent-${NETWORK}.json`)

/** The agent wallet that the MCP tools use. Null until a person sets one on the /agents page. */
export function readToolAgent(): Address | null {
  try {
    const { agent } = JSON.parse(readFileSync(/*turbopackIgnore: true*/ toolAgentFile(), 'utf8')) as { agent?: Address }
    return agent ?? null
  } catch {
    return null
  }
}

export const saveToolAgent = (agent: Address) => writeJson(toolAgentFile(), { agent })

/** What the server did for one clientRef. A send gets a record before it starts. */
export type SendRef = {
  /** The agent, token, recipient and amount. Another payment cannot use the same clientRef. */
  fingerprint: string
  /** After a restart, a record that still says "sending" has an unknown result. */
  state: 'sending' | 'sent' | 'operation'
  txHash: Hex | null
  operationId: string | null
}

/** A Map keeps its insertion order, so the oldest record leaves first. */
const MAX_SEND_REFS = 1000

const refsFile = () => path.join(process.cwd(), '.wave', `agent-send-refs-${NETWORK}.json`)

const refShared = globalThis as typeof globalThis & { __waveSendRefs?: Map<string, SendRef> }

function sendRefs(): Map<string, SendRef> {
  if (refShared.__waveSendRefs) return refShared.__waveSendRefs
  let loaded: Record<string, SendRef> = {}
  try {
    loaded = JSON.parse(readFileSync(/*turbopackIgnore: true*/ refsFile(), 'utf8')) as Record<string, SendRef>
  } catch {
    // No file yet.
  }
  return (refShared.__waveSendRefs = new Map(Object.entries(loaded)))
}

export const sendRefOf = (ref: string): SendRef | null => sendRefs().get(ref) ?? null

/** The memory changes first, so a failed write cannot make this process forget a send. */
export function saveSendRef(ref: string, record: SendRef) {
  const refs = sendRefs()
  refs.delete(ref)
  refs.set(ref, record)
  for (const oldest of refs.keys()) {
    if (refs.size <= MAX_SEND_REFS) break
    refs.delete(oldest)
  }
  writeJson(refsFile(), Object.fromEntries(refs))
}

export function dropSendRef(ref: string) {
  sendRefs().delete(ref)
  writeJson(refsFile(), Object.fromEntries(sendRefs()))
}
