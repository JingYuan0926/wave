// GET /api/account: the account as the UI reads it. Server side only.
import { encodeAbiParameters, keccak256, numberToHex, slice, stringToHex, type Address, type Hex } from 'viem'
import { CLONE_CODE_LEN, ownerKeyOf, slotsOf, waitSeconds, waitWord } from '../account'
import type {
  AccountResponse,
  DailyView,
  MethodRef,
  MethodView,
  PasskeyBackup,
  PasskeySlot,
  TierView,
  TokenBalance,
  TokenRules,
  WalletPlan,
} from '../api-types'
import { ETH_TOKEN, OWNER_METHOD_MASK, PASSKEY_SLOTS } from '../api-types'
import { publicClient, type Deployment } from '../chain'
import { SMALL_TIER } from '../policy'
import { TestUSDCAbi, WaveAccountAbi } from '../wave-abi'
import { ApiFailure } from './http'
import { methodOf, tokensOf, validatorOf } from './decode'
import { readPending } from './pending'
import { sponsorView } from './sponsor'
import { demoDelay, plannedWallet } from './wallet-plan'

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

const worldMethod = (d: Deployment): MethodView => ({
  ref: { kind: 'world' },
  validator: d.worldIdValidator,
  mask: OWNER_METHOD_MASK,
  backup: null,
  owner: true,
})

const backupOf = (eligible: boolean): PasskeyBackup => (eligible ? 'synced' : 'device-bound')

/** The namespace of PasskeyFrameValidator. Key is x, y, then the BE byte. */
const PASSKEY_NAMESPACE = keccak256(stringToHex('wave.module.passkey-frame-validator'))
const KEY_FLAGS_OFFSET = 2n

/** The key of an owner passkey: a recovery writes storage, else the clone args hold it. */
async function ownerKey(address: Address, code: Hex, validator: Address): Promise<{ x: Hex; backup: PasskeyBackup }> {
  const base = BigInt(
    keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [PASSKEY_NAMESPACE, validator])),
  )
  const word = (offset: bigint) =>
    publicClient.getStorageAt({ address, slot: numberToHex(base + offset, { size: 32 }) })
  const [x, y, flags] = await Promise.all([word(0n), word(1n), word(KEY_FLAGS_OFFSET)])
  if (BigInt(x ?? '0x0') !== 0n || BigInt(y ?? '0x0') !== 0n) {
    return { x: x as Hex, backup: backupOf((BigInt(flags ?? '0x0') & 0xffn) !== 0n) }
  }
  const first = ownerKeyOf(slice(code, CLONE_CODE_LEN))
  return { x: first.x, backup: backupOf(first.backupEligible) }
}

async function readMethods(
  d: Deployment,
  address: Address,
  syncedMask: number,
  ownerBackup: PasskeyBackup | null,
  ownerRef: MethodRef,
): Promise<MethodView[]> {
  const passkeys = await Promise.all(
    PASSKEY_SLOTS.map(async (slot): Promise<MethodView | null> => {
      const validator = d.passkeyValidators[slot - 1]
      const mask = await read<number>(address, 'methodBitOf', [validator])
      if (mask === 0) return null
      const owner = mask === OWNER_METHOD_MASK
      const backup: PasskeyBackup = owner ? (ownerBackup as PasskeyBackup) : backupOf((mask & syncedMask) !== 0)
      return { ref: { kind: 'passkey', slot }, validator, mask, backup, owner }
    }),
  )
  const views = passkeys.filter((view): view is MethodView => view !== null)
  return ownerRef.kind === 'world' ? [worldMethod(d), ...views] : views.sort((a, b) => Number(b.owner) - Number(a.owner))
}

/** A wallet with no code yet: the methods and rules that its plan commits to. */
async function plannedView(d: Deployment, plan: WalletPlan | undefined) {
  const tokens = tokensOf(d)
  const noRules = tokens.map((token) => ({ token: token.address, tiers: [] as TierView[], daily: null as DailyView | null }))
  if (!plan) {
    return { methods: [worldMethod(d)], rules: noRules, owner: { kind: 'world' } as MethodRef, ownerKeyX: null }
  }
  const slots = slotsOf(plan)
  const planned = await plannedWallet(d, plan)
  const view = (slot: PasskeySlot, backupEligible: boolean, mask: number, owner: boolean): MethodView => ({
    ref: { kind: 'passkey', slot },
    validator: validatorOf(d, { kind: 'passkey', slot }),
    mask,
    backup: backupOf(backupEligible),
    owner,
  })
  const ownerView = plan.owner.kind === 'world'
    ? worldMethod(d)
    : view(slots.owner as PasskeySlot, plan.owner.backupEligible, OWNER_METHOD_MASK, true)
  const extras = plan.extras.map((extra, index) => view(slots.extras[index], extra.backupEligible, 1 << slots.extras[index], false))
  const tiers = planned.tiers.map(
    (tier): TierView => ({
      upTo: tier.upTo.toString(),
      cap: tier.cap.toString(),
      delay: tier.delay,
      period: tier.period,
      methods: tier.methods & 0x7f,
      small: (tier.methods & SMALL_TIER) !== 0,
      spent: '0',
      periodEndsAt: null,
    }),
  )
  const limit = planned.dailyLimit.toString()
  const daily: DailyView | null = planned.dailyLimit > 0n ? { limit, spent: '0', left: limit, resetsAt: null } : null
  return {
    methods: [ownerView, ...extras],
    rules: noRules.map((rule) => (rule.token === d.testUsdc ? { ...rule, tiers, daily } : rule)),
    owner: ownerView.ref,
    ownerKeyX: plan.owner.kind === 'passkey' ? plan.owner.publicKey.x : null,
  }
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

/** A synced passkey cannot run a recovery, and the owner method cannot either. */
function recoveryOf(methods: MethodView[]) {
  const others = methods.filter((view) => !view.owner)
  return {
    recovery: {
      otherMethods: others.length,
      available: others.filter((view) => view.backup === 'device-bound').length >= 2,
    },
  }
}

type RawDaily = readonly [limit: bigint, spent: bigint, left: bigint, resetsAt: number]

async function readDaily(address: Address, token: Address): Promise<DailyView | null> {
  const [limit, spent, left, resetsAt] = await read<RawDaily>(address, 'dailyOf', [token])
  if (limit === 0n) return null
  return { limit: limit.toString(), spent: spent.toString(), left: left.toString(), resetsAt: resetsAt > 0 ? resetsAt : null }
}

export async function readRules(address: Address, token: Address, now: number): Promise<TokenRules> {
  const [tiers, daily] = await Promise.all([
    read<readonly RawTier[]>(address, 'tiersOf', [token]),
    readDaily(address, token),
  ])
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
  return { token, tiers: views, daily }
}

export async function readAccount(d: Deployment, address: Address, plan?: WalletPlan): Promise<AccountResponse> {
  const code = await publicClient.getCode({ address })
  const balances = await readBalances(d, address)
  const tokens = tokensOf(d)
  const sponsor = await sponsorView(d, address)

  if (code === undefined || code === '0x') {
    const { methods, rules, owner, ownerKeyX } = await plannedView(d, plan)
    const word = plan?.wait === undefined ? demoDelay() : waitWord(plan.wait)
    return {
      address,
      deployed: false,
      balances,
      configVersion: '0',
      demoDelay: word,
      waitSeconds: waitSeconds(word),
      ownerNullifierHash: null,
      owner,
      ownerKeyX,
      methods,
      rules,
      pending: [],
      ...recoveryOf(methods),
      sponsor,
    }
  }

  const [configVersion, delay, syncedMask, nullifier, ownerValidator, block] = await Promise.all([
    read<number>(address, 'configVersion'),
    read<number>(address, 'demoDelay'),
    read<number>(address, 'syncedMask'),
    read<bigint>(address, 'ownerNullifier'),
    read<Address>(address, 'ownerValidator'),
    publicClient.getBlock(),
  ])
  const owner = methodOf(d, ownerValidator)
  if (!owner) throw new ApiFailure('ACCOUNT_MISMATCH', 'This wallet was made for another deployment. Create a new wallet.')
  const key = owner.kind === 'passkey' ? await ownerKey(address, code, ownerValidator) : null
  const now = Number(block.timestamp)
  const [methods, rules, pending] = await Promise.all([
    readMethods(d, address, syncedMask, key?.backup ?? null, owner),
    Promise.all(tokens.map((token) => readRules(address, token.address, now))),
    readPending(d, address, configVersion, now),
  ])

  return {
    address,
    deployed: true,
    balances,
    configVersion: configVersion.toString(),
    demoDelay: delay,
    waitSeconds: waitSeconds(delay),
    ownerNullifierHash: owner.kind === 'world' ? numberToHex(nullifier, { size: 32 }) : null,
    owner,
    ownerKeyX: key?.x ?? null,
    methods,
    rules,
    pending,
    ...recoveryOf(methods),
    sponsor,
  }
}

