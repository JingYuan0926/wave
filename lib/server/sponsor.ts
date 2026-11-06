// The server half of the local gas sponsor. Server side only.
// The gas station checks one thing: the sponsor key signed. Every limit is here, before that
// signature, so validation needs no storage read and no chain read.
import { encodeFunctionData, type Address } from 'viem'
import type { SponsorView } from '../api-types'
import { LEGACY_TX, devWallet, publicClient, sponsorOf, type Deployment, type Sponsor } from '../chain'
import type { DeployFrame, FrameTx } from '../frametx'
import { WaveAccountFactoryAbi } from '../wave-abi'
import { ApiFailure } from './http'
import type { Decoded } from './reject'
import { withDevKey } from './roots'

const DEFAULT_DAILY_TX = 50
const DAY_MS = 86_400_000
/** The app signs 5 gwei. */
export const SPONSOR_MAX_FEE = 10_000_000_000n
/** The same limit as MAX_TX_COST in WaveAccount. */
export const SPONSOR_MAX_COST = 50_000_000_000_000_000n
/** A new account costs state gas under EIP-8037, on top of the execution gas. */
const DEPLOY_GAS = 1_500_000n

const FRAME_VERIFY = 1
const FRAME_SENDER = 2
const SCOPE_MASK = 3
const SCOPE_PAYMENT = 1
const SCOPE_EXECUTION = 2
const SCHEME_SECP256K1 = 1
/** The first bytes of an EIP-1167 clone. The implementation address follows them. */
const CLONE_PREFIX = '363d3d373d3d3d363d73'

type Budget = { day: number; used: number }

// Each route has its own module copy in dev, so the state lives on globalThis.
// A server restart clears it. Keep this in mind for a public sponsor: this one is local.
const shared = globalThis as typeof globalThis & { __waveSponsor?: Map<string, Budget> }
const budgets: Map<string, Budget> = (shared.__waveSponsor ??= new Map())

export function dailyLimit(): number {
  const value = Number(process.env.WAVE_SPONSOR_DAILY_TX)
  return Number.isInteger(value) && value >= 0 && process.env.WAVE_SPONSOR_DAILY_TX ? value : DEFAULT_DAILY_TX
}

function budgetOf(address: Address, now: number): Budget {
  const day = Math.floor(now / DAY_MS)
  const key = address.toLowerCase()
  const found = budgets.get(key)
  if (found?.day === day) return found
  const fresh = { day, used: 0 }
  budgets.set(key, fresh)
  return fresh
}

export const usedToday = (address: Address, now = Date.now()): number => budgetOf(address, now).used

/** Takes one transaction from the budget. False if nothing is left. No await, so no race. */
export function takeBudget(address: Address, now = Date.now()): boolean {
  const budget = budgetOf(address, now)
  if (budget.used >= dailyLimit()) return false
  budget.used += 1
  return true
}

export function releaseBudget(address: Address, now = Date.now()): void {
  const budget = budgetOf(address, now)
  budget.used = Math.max(0, budget.used - 1)
}

const hasFunds = async (sponsor: Sponsor): Promise<boolean> =>
  (await publicClient.getBalance({ address: sponsor.station })) >= SPONSOR_MAX_COST

/** Checks that need no transaction. The app calls this before the owner scans. */
export async function sponsorGate(sponsor: Sponsor, address: Address): Promise<Decoded | null> {
  if (usedToday(address) >= dailyLimit()) return { code: 'SponsorLimit' }
  return (await hasFunds(sponsor)) ? null : { code: 'SponsorEmpty' }
}

const same = (a: string | null, b: string): boolean => a?.toLowerCase() === b.toLowerCase()

/** The sponsor pays only for this order: account check, gas station, SENDER frames to the account. */
export function shapeIsSponsorable(tx: FrameTx, sponsor: Sponsor): boolean {
  const [check, pay, ...senders] = tx.frames
  const entry = tx.signatures[1]
  if (!check || !pay || senders.length === 0 || !entry) return false
  return (
    check.mode === FRAME_VERIFY &&
    (check.flags & SCOPE_MASK) === SCOPE_EXECUTION &&
    same(check.target, tx.sender) &&
    pay.mode === FRAME_VERIFY &&
    (pay.flags & SCOPE_MASK) === SCOPE_PAYMENT &&
    same(pay.target, sponsor.station) &&
    senders.every((frame) => frame.mode === FRAME_SENDER && same(frame.target, tx.sender) && frame.value === 0n) &&
    entry.scheme === SCHEME_SECP256K1 &&
    entry.msg === '0x' &&
    same(entry.signer, sponsor.signer) &&
    tx.blobVersionedHashes.length === 0
  )
}

/** The cap uses the gas limits. The chain adds intrinsic gas, and the margin of the cap covers that. */
export function feeIsSponsorable(tx: FrameTx): boolean {
  const gas = tx.frames.reduce((sum, frame) => sum + frame.limits.execution + frame.limits.state, 0n)
  return tx.fees.maxFeePerGas <= SPONSOR_MAX_FEE && gas * tx.fees.maxFeePerGas <= SPONSOR_MAX_COST
}

async function isWaveWallet(d: Deployment, address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address })
  return code?.toLowerCase().startsWith(`0x${CLONE_PREFIX}${d.implementation.slice(2).toLowerCase()}`) ?? false
}

/** All the checks before the sponsor signs. Null means that one budget unit is now taken. */
export async function reserveSponsor(d: Deployment, sponsor: Sponsor, tx: FrameTx): Promise<Decoded | null> {
  if (!shapeIsSponsorable(tx, sponsor) || !(await isWaveWallet(d, tx.sender))) return { code: 'SponsorShape' }
  if (!feeIsSponsorable(tx)) return { code: 'SponsorFeeCap' }
  if (!(await hasFunds(sponsor))) return { code: 'SponsorEmpty' }
  return takeBudget(tx.sender) ? null : { code: 'SponsorLimit' }
}

export async function sponsorView(d: Deployment, address: Address): Promise<SponsorView | null> {
  const sponsor = sponsorOf(d)
  if (!sponsor) return null
  return { used: usedToday(address), limit: dailyLimit(), stationEmpty: !(await hasFunds(sponsor)) }
}

/**
 * Deploys a wallet with a plain transaction, so the wallet needs no ETH. CREATE2 commits the
 * address to the clone args, so this key cannot change who owns the wallet.
 */
export async function deployWallet(account: Address, frame: DeployFrame): Promise<void> {
  await withDevKey(async () => {
    // A call in front of this one in the lock can have deployed the same wallet.
    const code = await publicClient.getCode({ address: account })
    if (code !== undefined && code !== '0x') return
    const hash = await devWallet.sendTransaction({
      to: frame.factory,
      data: encodeFunctionData({
        abi: WaveAccountFactoryAbi,
        functionName: 'createAccount',
        args: [frame.implementation, frame.args, frame.salt],
      }),
      gas: DEPLOY_GAS,
      ...LEGACY_TX,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (receipt.status !== 'success') throw new ApiFailure('DEPLOY_FAILED', `Deploy tx ${hash} reverted.`, 500)
  })
}
