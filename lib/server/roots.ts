// Root publishing under the pinned source, and the dev key lock. Server side only.
import { numberToHex, type Hex } from 'viem'
import { RPC_URL, genesisHash, rpc, sleep } from '../chain'
import type { RootRef } from '../frametx'
import { publishRoot } from '../world-dev'
import { ApiFailure, deployment } from './http'

/** A reference works for 8191 slots. WAVE publishes again before that. */
const REPUBLISH_AFTER_SLOTS = 8000n
/** Slots last 6 s. No new block in this time means that the chain stopped. */
const SLOT_WAIT_MS = 60_000

type Shared = { refs: Map<string, RootRef>; devKeyTail: Promise<unknown>; genesis?: Hex }

// Each route has its own module copy in dev, so the state lives on globalThis.
const shared = globalThis as typeof globalThis & { __waveRoots?: Shared }
const state: Shared = (shared.__waveRoots ??= { refs: new Map(), devKeyTail: Promise.resolve() })

/** Runs one user of the dev key at a time, so that two sends cannot share a nonce. */
export function withDevKey<T>(body: () => Promise<T>): Promise<T> {
  const run = state.devKeyTail.then(body, body)
  state.devKeyTail = run.catch(() => undefined)
  return run
}

export const normalizeRoot = (root: Hex): Hex => numberToHex(BigInt(root), { size: 32 })

async function currentSlot(): Promise<bigint> {
  const block = await rpc<{ slotNumber: Hex }>(RPC_URL, 'eth_getBlockByNumber', ['latest', false])
  return BigInt(block.slotNumber)
}

/** A root written in slot S can be referenced from slot S + 1. */
export async function waitForSlotAfter(slot: bigint, readSlot = currentSlot, limitMs = SLOT_WAIT_MS) {
  const end = Date.now() + limitMs
  while ((await readSlot()) <= slot) {
    // This can run inside the dev key lock, so it must end.
    if (Date.now() >= end) throw new ApiFailure('CHAIN_STALLED', 'The chain makes no new blocks.', 503)
    await sleep(1000)
  }
}

/** The source and the address stay the same on a fresh chain, so old references look valid. */
async function forgetOldChain() {
  const genesis = await genesisHash()
  if (state.genesis && state.genesis !== genesis) state.refs.clear()
  state.genesis = genesis
}

const keyOf = (sourceId: Hex, root: Hex) => `${sourceId}:${root}`

async function publishLocked(root: Hex): Promise<RootRef & { txHash: Hex }> {
  const d = deployment()
  const published = await publishRoot(BigInt(root), d.rootSalt, d.rootSourceId)
  state.refs.set(keyOf(d.rootSourceId, root), {
    sourceId: published.sourceId,
    slot: published.slot,
    root: published.root,
  })
  await waitForSlotAfter(published.slot)
  return published
}

/** Publishes `root` now, and waits until a transaction can reference it. */
export const publish = (root: Hex) => withDevKey(() => publishLocked(normalizeRoot(root)))

async function usableReference(root: Hex): Promise<RootRef | null> {
  const known = state.refs.get(keyOf(deployment().rootSourceId, root))
  if (!known) return null
  const slot = await currentSlot()
  return slot >= known.slot && slot - known.slot < REPUBLISH_AFTER_SLOTS ? known : null
}

/**
 * Returns a usable reference. It publishes only if the last one is missing or too old.
 * A known root needs no key, so it does not wait behind the faucet in the lock.
 */
export async function referenceFor(rootHex: Hex): Promise<RootRef> {
  const root = normalizeRoot(rootHex)
  await forgetOldChain()
  const ready = await usableReference(root)
  if (ready) {
    await waitForSlotAfter(ready.slot)
    return ready
  }
  return withDevKey(async () => {
    // A call in front of this one in the lock can have published the same root.
    const known = await usableReference(root)
    if (known) return known
    const { sourceId, slot, root: written } = await publishLocked(root)
    return { sourceId, slot, root: written }
  })
}
