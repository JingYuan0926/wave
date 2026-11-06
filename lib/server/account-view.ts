// GET /api/account: the account as the UI reads it. Server side only.
import { encodeAbiParameters, keccak256, numberToHex, type Address, type Hex } from 'viem'
import type { AccountResponse, MethodView, PasskeyBackup, TierView, TokenBalance, TokenRules } from '../api-types'
import { ETH_TOKEN, PASSKEY_SLOTS, WORLD_METHOD_MASK } from '../api-types'
import { publicClient, type Deployment } from '../chain'
import { SMALL_TIER } from '../policy'
import { TestUSDCAbi, WaveAccountAbi } from '../wave-abi'
import { tokensOf } from './decode'
import { readPending } from './pending'
import { demoDelay } from './prepare'
import { sponsorView } from './sponsor'

/** The erc7201 base of WavePolicy.Layout. `periods` is the mapping at offset 3. */
const POLICY_SLOT = 0x53224122d2a8b23658e8a1b8823e5e85ffcbf5d30e66c1092815ce1714f78c00n
const PERIODS_OFFSET = 3n
const START_MASK = (1n << 40n) - 1n

export async function readBalances(d: Deployment, address: Address): Promise<TokenBalance[]> {
  const [eth, usdc] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: d.testUsdc, abi: TestUSDCAbi, functionName: 'balanceOf', args: [address] }),
  ])
  return [
    { token: ETH_TOKEN, amount: eth.toString() },
    { token: d.testUsdc, amount: usdc.toString() },
  ]
}

const read = <T,>(address: Address, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({
    address,
    abi: WaveAccountAbi,
    functionName: functionName as never,
    args: args as never,
  }) as Promise<T>

async function readMethods(d: Deployment, address: Address, syncedMask: number): Promise<MethodView[]> {
  const worldMethod: MethodView = {
    ref: { kind: 'world' },
    validator: d.worldIdValidator,
    mask: WORLD_METHOD_MASK,
    backup: null,
  }
  const passkeys = await Promise.all(
    PASSKEY_SLOTS.map(async (slot): Promise<MethodView | null> => {
      const validator = d.passkeyValidators[slot - 1]
      const mask = await read<number>(address, 'methodBitOf', [validator])
      if (mask === 0) return null
      const backup: PasskeyBackup = mask & syncedMask ? 'synced' : 'device-bound'
      return { ref: { kind: 'passkey', slot }, validator, mask, backup }
    }),
  )
  return [worldMethod, ...passkeys.filter((view): view is MethodView => view !== null)]
}

/** The start of the current window. WavePolicy has no view for it, so this reads the slot. */
async function periodStart(address: Address, token: Address, tierIndex: number): Promise<number> {
  const periodKey = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [token, BigInt(tierIndex)]),
  )
  const slot = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [periodKey, POLICY_SLOT + PERIODS_OFFSET]),
  )
  const word = await publicClient.getStorageAt({ address, slot })
  return Number(BigInt((word ?? '0x0') as Hex) & START_MASK)
}

type RawTier = { upTo: bigint; cap: bigint; delay: number; period: number; methods: number }

export async function readRules(address: Address, token: Address, now: number): Promise<TokenRules> {
  const tiers = await read<readonly RawTier[]>(address, 'tiersOf', [token])
  const views = await Promise.all(
    tiers.map(async (tier, index): Promise<TierView> => {
      const spent = await read<bigint>(address, 'spentOf', [token, BigInt(index)])
      const start = tier.period > 0 ? await periodStart(address, token, index) : 0
      const end = start + tier.period
      return {
        upTo: tier.upTo.toString(),
        cap: tier.cap.toString(),
        delay: tier.delay,
        period: tier.period,
        methods: tier.methods & 0x7f,
        small: (tier.methods & SMALL_TIER) !== 0,
        spent: spent.toString(),
        periodEndsAt: start > 0 && end > now ? end : null,
      }
    }),
  )
  return { token, tiers: views }
}

export async function readAccount(d: Deployment, address: Address): Promise<AccountResponse> {
  const code = await publicClient.getCode({ address })
  const balances = await readBalances(d, address)
  const tokens = tokensOf(d)
  const sponsor = await sponsorView(d, address)

  if (code === undefined || code === '0x') {
    return {
      address,
      deployed: false,
      balances,
      configVersion: '0',
      demoDelay: demoDelay(),
      ownerNullifierHash: null,
      methods: [{ ref: { kind: 'world' }, validator: d.worldIdValidator, mask: WORLD_METHOD_MASK, backup: null }],
      rules: tokens.map((token) => ({ token: token.address, tiers: [] })),
      pending: [],
      recovery: { otherMethods: 0, available: false },
      sponsor,
    }
  }

  const [configVersion, delay, syncedMask, owner, block] = await Promise.all([
    read<number>(address, 'configVersion'),
    read<number>(address, 'demoDelay'),
    read<number>(address, 'syncedMask'),
    read<bigint>(address, 'ownerNullifier'),
    publicClient.getBlock(),
  ])
  const now = Number(block.timestamp)
  const [methods, rules, pending] = await Promise.all([
    readMethods(d, address, syncedMask),
    Promise.all(tokens.map((token) => readRules(address, token.address, now))),
    readPending(d, address, configVersion, now),
  ])
  // A synced passkey cannot run a recovery, so only device-bound methods count.
  const otherMethods = methods.filter((view) => view.ref.kind !== 'world').length
  const deviceBound = methods.filter((view) => view.backup === 'device-bound').length

  return {
    address,
    deployed: true,
    balances,
    configVersion: configVersion.toString(),
    demoDelay: delay,
    ownerNullifierHash: numberToHex(owner, { size: 32 }),
    methods,
    rules,
    pending,
    recovery: { otherMethods, available: deviceBound >= 2 },
    sponsor,
  }
}

