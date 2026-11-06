// Address and configuration of a WAVE account. Safe in the browser and on the server.
import { concat, encodeAbiParameters, encodePacked, keccak256, pad, slice, type Address, type Hex } from 'viem'
import type { BaseUnits, PasskeySlot, WalletPlan, PlanSends } from './api-types'
import { PASSKEY_SLOTS } from './api-types'
import { shapeTiers } from './limits'
import { NO_LIMIT, OWNER_BIT, SMALL_TIER, passkeyBit, passkeyInitData, type Tier } from './policy'

export const APPROVAL_SCOPES = 3 // Payment and execution.
export const MODE_BITS = 0x0f // All four frame modes.
export const ROUTE_CONTRACT = 1
/** The default demo delay of the app, in seconds. */
export const DEFAULT_DEMO_DELAY = 120

/** The clone value for a wallet with no wait. 0 means real delays. WavePolicy.NO_WAIT is the same. */
export const NO_WAIT = 0xffff_ffff

/** The clone value of a wait in seconds. A wait of 0 seconds is NO_WAIT. */
export const waitWord = (seconds: number): number => (seconds === 0 ? NO_WAIT : seconds)

/** The wait of a clone value, in seconds. Null means real delays. */
export const waitSeconds = (word: number): number | null => (word === 0 ? null : word === NO_WAIT ? 0 : word)

/** The same rule as WavePolicy.effectiveDelay. Tier delays do not use it. */
export const appliedDelay = (real: number, word: number): number =>
  word === NO_WAIT ? 0 : word !== 0 && word < real ? word : real

/** The size of an EIP-1167 clone. The clone args follow these bytes. */
export const CLONE_CODE_LEN = 45

const FLAG_BE = 1n
const FLAG_UV = 2n

/** The three initData words belong to the owner method of the clone. */
export type OwnerInit =
  | { kind: 'world'; ownerNullifierHash: bigint; externalNullifierHash: bigint; rootSourceId: Hex }
  | { kind: 'passkey'; x: Hex; y: Hex; backupEligible: boolean }

export type AccountConfig = {
  /** The owner method. */
  validator: Address
  owner: OwnerInit
  /** Seconds, or NO_WAIT. 0 means real delays. */
  demoDelay: number
  /** The hash of the setup bytes, on a wallet with extra methods. */
  setupHash?: Hex
  /** The main wallet of an agent wallet. An agent wallet needs ownerNullifierHash 0. */
  master?: Address
}

function initWords(owner: OwnerInit): [bigint, bigint, Hex] {
  if (owner.kind === 'world') return [owner.ownerNullifierHash, owner.externalNullifierHash, owner.rootSourceId]
  const flags = (owner.backupEligible ? FLAG_BE : 0n) | FLAG_UV
  return [BigInt(owner.x), BigInt(owner.y), pad(`0x${flags.toString(16)}`, { size: 32 })]
}

/** validator || scopes || modeBits || route || demoDelay || initData, then setupHash or master. */
export function cloneArgs(c: AccountConfig): Hex {
  const args = encodePacked(
    ['address', 'uint8', 'uint8', 'uint8', 'uint32', 'uint256', 'uint256', 'bytes32'],
    [c.validator, APPROVAL_SCOPES, MODE_BITS, ROUTE_CONTRACT, c.demoDelay, ...initWords(c.owner)],
  )
  const tail = c.master ?? c.setupHash
  return tail ? concat([args, tail]) : args
}

/** The header of the clone args: validator, scopes, modeBits, route, demoDelay. */
const CLONE_HEADER = 27

/** Reads the initial owner and root source from clone args. */
export const initialOwnerOf = (args: Hex): bigint => BigInt(slice(args, CLONE_HEADER, CLONE_HEADER + 32))
export const initialRootSourceOf = (args: Hex): Hex => slice(args, CLONE_HEADER + 64, CLONE_HEADER + 96)

/** The first key of an owner passkey, from clone args. */
export function ownerKeyOf(args: Hex): { x: Hex; backupEligible: boolean } {
  const flags = BigInt(slice(args, CLONE_HEADER + 64, CLONE_HEADER + 96))
  return { x: slice(args, CLONE_HEADER, CLONE_HEADER + 32), backupEligible: (flags & FLAG_BE) !== 0n }
}

/** One slot per passkey. An owner passkey takes slot 1, and the extra methods take the next slots. */
export function slotsOf(plan: WalletPlan): { owner: PasskeySlot | null; extras: PasskeySlot[] } {
  const owner = plan.owner.kind === 'passkey' ? PASSKEY_SLOTS[0] : null
  const free = PASSKEY_SLOTS.filter((slot) => slot !== owner)
  return { owner, extras: plan.extras.map((_, index) => free[index]) }
}

/**
 * The first rules of a token. Each extra method approves up to its own limit, at once. The owner
 * method is in each tier, and only the owner method approves above the highest limit. The tiers
 * are marked small, so a synced passkey can use its limit.
 */
export function firstTiers(extras: { slot: PasskeySlot; limit?: BaseUnits }[]): Tier[] {
  if (extras.length === 0) return []
  const limits = [...new Set(extras.map((extra) => BigInt(extra.limit ?? 0)))].sort((a, b) => (a < b ? -1 : 1))
  const tier = (upTo: bigint, methods: number): Tier => ({ upTo, cap: 0n, delay: 0, period: 0, methods })
  return [
    ...limits.map((limit) =>
      tier(
        limit,
        extras.reduce(
          (mask, extra) => (BigInt(extra.limit ?? 0) >= limit ? mask | passkeyBit(extra.slot) : mask),
          OWNER_BIT | SMALL_TIER,
        ),
      ),
    ),
    tier(NO_LIMIT, OWNER_BIT),
  ]
}

/** The first rules from the choice on the creation screen. */
function chosenTiers(sends: PlanSends, extras: { slot: PasskeySlot; backupEligible: boolean }[]): Tier[] {
  const bit = (index: number) => (index === 0 ? OWNER_BIT : passkeyBit(extras[index - 1].slot))
  const shape =
    sends.kind === 'every'
      ? ({ kind: 'every', method: bit(sends.method) } as const)
      : ({
          kind: 'limit',
          amount: BigInt(sends.amount),
          lower: bit(sends.lower),
          upper: bit(sends.upper),
          lowerSynced: sends.lower !== 0 && extras[sends.lower - 1].backupEligible,
        } as const)
  return shapeTiers(shape).map(({ small, methods, ...tier }) => ({
    ...tier,
    methods: small ? methods | SMALL_TIER : methods,
  }))
}

const SETUP_PARAMS = [
  {
    type: 'tuple[]',
    components: [
      { name: 'validator', type: 'address' },
      { name: 'initData', type: 'bytes' },
    ],
  },
  {
    type: 'tuple[]',
    components: [
      { name: 'token', type: 'address' },
      {
        name: 'tiers',
        type: 'tuple[]',
        components: [
          { name: 'upTo', type: 'uint96' },
          { name: 'cap', type: 'uint96' },
          { name: 'delay', type: 'uint32' },
          { name: 'period', type: 'uint24' },
          { name: 'methods', type: 'uint8' },
        ],
      },
      { name: 'dailyLimit', type: 'uint96' },
    ],
  },
] as const

export type SetupMethod = { validator: Address; initData: Hex }
/** `dailyLimit` 0 means no limit. */
export type SetupRule = { token: Address; tiers: Tier[]; dailyLimit: bigint }

/** The arguments of WaveAccount.setup. The clone args hold the hash of these bytes. */
export const encodeSetup = (methods: SetupMethod[], rules: SetupRule[]): Hex =>
  encodeAbiParameters(SETUP_PARAMS, [methods, rules])

export type WalletContracts = {
  worldIdValidator: Address
  passkeyValidators: readonly Address[]
  testUsdc: Address
}

export type WalletBuildInput = {
  contracts: WalletContracts
  plan: WalletPlan
  demoDelay: number
  externalNullifierHash: bigint
  rootSourceId: Hex
}

export type BuiltWallet = {
  /** The owner method. */
  validator: Address
  args: Hex
  /** Empty for a wallet with one method. */
  setup: Hex
  salt: Hex
  tiers: Tier[]
  /** The hard daily total of the test token. 0 means no limit. */
  dailyLimit: bigint
  /** The clone value of the wait. */
  demoDelay: number
}

/** The same plan gives the same address, on each device. */
export function buildWallet({ contracts, plan, demoDelay: fallback, externalNullifierHash, rootSourceId }: WalletBuildInput): BuiltWallet {
  // The owner chooses the wait. Test scripts send no wait, so WAVE_DEMO_DELAY applies to them.
  const demoDelay = plan.wait === undefined ? fallback : waitWord(plan.wait)
  const slots = slotsOf(plan)
  const extras = plan.extras.map((extra, index) => ({ ...extra, slot: slots.extras[index] }))
  const tiers = extras.length > 0 && plan.sends ? chosenTiers(plan.sends, extras) : firstTiers(extras)
  const dailyLimit = extras.length > 0 ? BigInt(plan.sends?.perDay ?? 0) : 0n
  const setup =
    extras.length === 0
      ? '0x'
      : encodeSetup(
          extras.map(({ slot, publicKey, backupEligible }) => ({
            validator: contracts.passkeyValidators[slot - 1],
            initData: passkeyInitData(publicKey.x, publicKey.y, backupEligible),
          })),
          [{ token: contracts.testUsdc, tiers, dailyLimit }],
        )
  const setupHash = extras.length === 0 ? undefined : keccak256(setup)
  const { owner } = plan
  if (owner.kind === 'world') {
    const hash = BigInt(owner.nullifierHash)
    return {
      validator: contracts.worldIdValidator,
      args: cloneArgs({
        validator: contracts.worldIdValidator,
        owner: { kind: 'world', ownerNullifierHash: hash, externalNullifierHash, rootSourceId },
        demoDelay,
        setupHash,
      }),
      setup,
      // One human gets one address per method set, on every device.
      salt: keccak256(pad(owner.nullifierHash, { size: 32 })),
      tiers,
      dailyLimit,
      demoDelay,
    }
  }
  const validator = contracts.passkeyValidators[(slots.owner as PasskeySlot) - 1]
  const { x, y } = owner.publicKey
  return {
    validator,
    args: cloneArgs({
      validator,
      owner: { kind: 'passkey', x, y, backupEligible: owner.backupEligible },
      demoDelay,
      setupHash,
    }),
    setup,
    salt: keccak256(concat([x, y])),
    tiers,
    dailyLimit,
    demoDelay,
  }
}
