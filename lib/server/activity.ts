// GET /api/activity: an index of the chain, built by reading each block once. Server side only.
import { decodeEventLog, parseAbiItem, type Address, type Hex } from 'viem'
import type { ActivityItem, MethodRef } from '../api-types'
import { ETH_TOKEN } from '../api-types'
import { RPC_URL, genesisHash, rpc, type Deployment } from '../chain'
import type { TxReceipt } from '../frametx'
import { plainAmount } from '../ui/format'
import { describeSender, methodOf, tokensOf, transferOf, validatorOfKey, type TransferFacts } from './decode'

const MAX_ITEMS = 50
const BLOCKS_AT_ONCE = 20
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const SENDER_MODE = 2

type RpcFrame = { mode: Hex; data: Hex }
type RpcTx = {
  hash: Hex
  to?: Address | null
  from: Address
  value?: Hex
  sender?: Address
  nonceKeys?: Hex[]
  frames?: RpcFrame[]
}
type RpcBlock = { timestamp: Hex; transactions: RpcTx[] }

type Index = { factory: Address; genesis: Hex; next: number; byAddress: Map<string, ActivityItem[]>; running: Promise<void> | null }

const shared = globalThis as typeof globalThis & { __waveActivity?: Index }

function add(index: Index, address: Address, item: ActivityItem) {
  const key = address.toLowerCase()
  const list = index.byAddress.get(key) ?? []
  list.unshift(item)
  index.byAddress.set(key, list)
}

function receivedItem(d: Deployment, hash: Hex, facts: TransferFacts, from: Address, timestamp: number): ActivityItem {
  const token = tokensOf(d).find((item) => item.address.toLowerCase() === facts.token.toLowerCase())
  return {
    txHash: hash,
    title: token ? `Received ${plainAmount(facts.amount, token.decimals)} ${token.symbol}` : 'Received a token',
    token: facts.token,
    amount: facts.amount.toString(),
    counterparty: from,
    direction: 'in',
    method: null,
    state: 'included',
    timestamp,
  }
}

function indexFrameTx(index: Index, d: Deployment, tx: RpcTx, receipt: TxReceipt, timestamp: number) {
  const sender = tx.sender as Address
  const failed = receipt.status !== '0x1'
  const validator = tx.nonceKeys?.[0] ? validatorOfKey(tx.nonceKeys[0]) : null
  const method: MethodRef | null = validator ? methodOf(d, validator) : null
  for (const frame of tx.frames ?? []) {
    if (Number(frame.mode) !== SENDER_MODE) continue
    const { fn, decoded, calls } = describeSender(d, sender, frame.data)
    const moves = fn === 'execute' || fn === 'executeScheduled'
    const transfers = moves ? calls.flatMap((call) => transferOf(call) ?? []) : []
    const one = transfers.length === 1 ? transfers[0] : null
    add(index, sender, {
      txHash: tx.hash,
      title: fn === 'schedule' ? `Queued: ${decoded.title}` : decoded.title,
      token: one?.token ?? null,
      amount: one?.amount.toString() ?? null,
      counterparty: one?.to ?? null,
      direction: one ? 'out' : 'none',
      method,
      state: failed ? 'failed' : 'included',
      timestamp,
    })
    // ETH leaves no log. Token transfers are read from their logs below.
    if (failed) continue
    for (const transfer of transfers) {
      if (transfer.token === ETH_TOKEN) add(index, transfer.to, receivedItem(d, tx.hash, transfer, sender, timestamp))
    }
  }
}

function indexTokenLogs(index: Index, d: Deployment, tx: RpcTx, receipt: TxReceipt, timestamp: number) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== d.testUsdc.toLowerCase()) continue
    try {
      const { args } = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics as [Hex, ...Hex[]] })
      const facts = { token: d.testUsdc, to: args.to, amount: args.value }
      add(index, args.to, receivedItem(d, tx.hash, facts, args.from, timestamp))
    } catch {
      // Another event of the token, for example Approval.
    }
  }
}

async function indexBlock(index: Index, d: Deployment, number: number) {
  const block = await rpc<RpcBlock>(RPC_URL, 'eth_getBlockByNumber', [`0x${number.toString(16)}`, true])
  const timestamp = Number(block.timestamp)
  for (const tx of block.transactions) {
    const receipt = await rpc<TxReceipt>(RPC_URL, 'eth_getTransactionReceipt', [tx.hash])
    // One transaction with odd data must not stop the index for every wallet. An RPC failure
    // above still rejects, so that block is read again.
    try {
      if (tx.frames) indexFrameTx(index, d, tx, receipt, timestamp)
      else if (tx.to && BigInt(tx.value ?? '0x0') > 0n && receipt.status === '0x1') {
        add(index, tx.to, receivedItem(d, tx.hash, { token: ETH_TOKEN, to: tx.to, amount: BigInt(tx.value as Hex) }, tx.from, timestamp))
      }
      if (receipt.status === '0x1') indexTokenLogs(index, d, tx, receipt, timestamp)
    } catch (error) {
      console.error('[wave api] activity skips', tx.hash, error)
    }
  }
}

async function catchUp(index: Index, d: Deployment) {
  const head = Number(await rpc<Hex>(RPC_URL, 'eth_blockNumber'))
  // The blocks of one batch can finish in any order, so each batch keeps block order.
  while (index.next <= head) {
    const last = Math.min(index.next + BLOCKS_AT_ONCE - 1, head)
    const pending = await Promise.all(
      Array.from({ length: last - index.next + 1 }, async (_, offset) => {
        const scratch: Index = { ...index, byAddress: new Map() }
        await indexBlock(scratch, d, index.next + offset)
        return scratch.byAddress
      }),
    )
    for (const found of pending) {
      for (const [key, items] of found) {
        index.byAddress.set(key, [...items, ...(index.byAddress.get(key) ?? [])])
      }
    }
    index.next = last + 1
  }
}

/** A restarted chain can have the same factory address, so the genesis hash decides too. */
async function indexFor(d: Deployment): Promise<Index> {
  const genesis = await genesisHash()
  const known = shared.__waveActivity
  if (known && known.factory === d.factory && known.genesis === genesis) return known
  const fresh: Index = { factory: d.factory, genesis, next: d.deployedAtBlock, byAddress: new Map(), running: null }
  shared.__waveActivity = fresh
  return fresh
}

export async function readActivity(d: Deployment, address: Address): Promise<ActivityItem[]> {
  const index = await indexFor(d)
  index.running ??= catchUp(index, d).finally(() => {
    index.running = null
  })
  await index.running
  return (index.byAddress.get(address.toLowerCase()) ?? []).slice(0, MAX_ITEMS)
}
