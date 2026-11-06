// What the server keeps per agent wallet: the "ask a human above" amounts and the linked person.
// A file holds these, because a restart must not remove a checkpoint or free a linked wallet.
// Pending operations stay in server memory. Server side only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Address } from 'viem'
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

function save() {
  const file = stateFile()
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(/*turbopackIgnore: true*/ temp, JSON.stringify(Object.fromEntries(entries()), null, 2))
  renameSync(/*turbopackIgnore: true*/ temp, file)
}

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
