// What the owner ticked at creation, checked and turned into a wallet address. Server side only.
import type { Address, Hex } from 'viem'
import { DEFAULT_DEMO_DELAY, buildWallet, slotsOf, type BuiltWallet } from '../account'
import type { PasskeyFacts, PlanSends, WalletPlan, WalletPlanResponse } from '../api-types'
import { PASSKEY_SLOTS, WAIT_CHOICES } from '../api-types'
import { publicClient, sponsorOf, type Deployment } from '../chain'
import type { DeployFrame } from '../frametx'
import { WaveAccountFactoryAbi } from '../wave-abi'
import { ApiFailure, UINT96_MAX, asBaseUnits, asHex, asWord } from './http'
import { externalNullifier } from './world-config'

export const demoDelay = (): number => Number(process.env.WAVE_DEMO_DELAY ?? DEFAULT_DEMO_DELAY)

function checkKey(value: PasskeyFacts | undefined, label: string): PasskeyFacts {
  if (typeof value?.backupEligible !== 'boolean') throw new ApiFailure('BAD_REQUEST', `${label} needs backupEligible.`)
  const x = asHex(value.publicKey?.x, `${label} public key x`, 32)
  const y = asHex(value.publicKey?.y, `${label} public key y`, 32)
  if (BigInt(x) === 0n && BigInt(y) === 0n) throw new ApiFailure('BAD_REQUEST', `${label} has no public key.`)
  return { publicKey: { x, y }, backupEligible: value.backupEligible }
}

/** Reads the choice from the creation screen. The same rules hold in `lib/ui/limits.ts`. */
function checkSends(input: PlanSends, extras: PasskeyFacts[]): PlanSends {
  const known = (index: unknown): index is number =>
    Number.isInteger(index) && (index as number) >= 0 && (index as number) <= extras.length
  // A synced passkey cannot approve any amount. So it cannot be the last method in a rule.
  const full = (index: number) => index === 0 || !extras[index - 1].backupEligible
  if (input.kind === 'every') {
    if (!known(input.method)) throw new ApiFailure('BAD_REQUEST', 'The plan names an unknown method.')
    if (!full(input.method)) throw new ApiFailure('BAD_REQUEST', 'A synced passkey needs a limit.')
    const daily = input.perDay == null ? 0n : asBaseUnits(input.perDay, 'The daily limit', UINT96_MAX)
    return { kind: 'every', method: input.method, ...(daily > 0n ? { perDay: daily.toString() } : {}) }
  }
  if (input.kind !== 'limit') throw new ApiFailure('BAD_REQUEST', 'The plan has an unknown send rule.')
  const { lower, upper } = input
  if (!known(lower) || !known(upper)) throw new ApiFailure('BAD_REQUEST', 'The plan names an unknown method.')
  if (lower === upper) throw new ApiFailure('BAD_REQUEST', 'Pick a different method above the limit.')
  if (!full(upper)) throw new ApiFailure('BAD_REQUEST', 'A synced passkey needs a limit.')
  const amount = asBaseUnits(input.amount, 'The limit', UINT96_MAX - 1n)
  if (amount === 0n) throw new ApiFailure('BAD_REQUEST', 'The limit must be above 0.')
  const perDay = input.perDay === null ? null : asBaseUnits(input.perDay, 'The daily limit', UINT96_MAX)
  if (perDay !== null && perDay < amount) throw new ApiFailure('BAD_REQUEST', 'The daily limit is below the limit.')
  return { kind: 'limit', amount: amount.toString(), perDay: perDay?.toString() ?? null, lower, upper }
}

/** Reads a plan from a request. The address commits to the result, so nothing here is trusted. */
export function checkPlan(input: unknown, d: Deployment): WalletPlan {
  const plan = input as WalletPlan | undefined
  const { owner } = plan ?? {}
  if (owner?.kind !== 'world' && owner?.kind !== 'passkey') {
    throw new ApiFailure('BAD_REQUEST', 'The plan needs an owner method.')
  }
  if (!Array.isArray(plan?.extras)) throw new ApiFailure('BAD_REQUEST', 'The plan needs an extras list.')

  const checkedOwner: WalletPlan['owner'] =
    owner.kind === 'world'
      ? { kind: 'world', nullifierHash: asWord(owner.nullifierHash, 'owner nullifier') }
      : { kind: 'passkey', ...checkKey(owner, 'The owner passkey') }
  const extras = plan.extras.map((extra, index) => {
    const label = `Extra method ${index + 1}`
    if (plan.sends) return checkKey(extra, label)
    const limit = asBaseUnits(extra?.limit, `${label} limit`, UINT96_MAX)
    if (limit === 0n) throw new ApiFailure('BAD_REQUEST', `${label} needs a limit above 0.`)
    return { ...checkKey(extra, label), limit: limit.toString() }
  })
  const sends = plan.sends && extras.length > 0 ? checkSends(plan.sends, extras) : undefined

  const room = PASSKEY_SLOTS.length - (checkedOwner.kind === 'passkey' ? 1 : 0)
  if (extras.length > room) throw new ApiFailure('BAD_REQUEST', `A wallet with this owner can hold ${room} extra methods.`)
  const keys = [...extras, ...(checkedOwner.kind === 'passkey' ? [checkedOwner] : [])].map((key) => key.publicKey.x)
  if (new Set(keys.map((key) => key.toLowerCase())).size !== keys.length) {
    throw new ApiFailure('BAD_REQUEST', 'Each method needs its own key.')
  }
  // The deploy frame of a wallet that pays its own gas has no room for the setup: see DEVIATIONS.md.
  if (extras.length > 0 && !sponsorOf(d)) {
    throw new ApiFailure('NO_ROOM_FOR_SETUP', 'On this network a new wallet holds one method. Add more in Settings.')
  }
  const { wait } = plan
  if (wait !== undefined && !(WAIT_CHOICES as readonly number[]).includes(wait)) {
    throw new ApiFailure('BAD_REQUEST', 'The wait is not one of the choices.')
  }
  return { owner: checkedOwner, extras, ...(wait === undefined ? {} : { wait }), ...(sends ? { sends } : {}) }
}

export type PlannedWallet = BuiltWallet & {
  address: Address
  owner: Address
  /** The owner method, then each extra method. */
  validators: Address[]
  frame: DeployFrame
}

export async function plannedWallet(d: Deployment, plan: WalletPlan): Promise<PlannedWallet> {
  const built = buildWallet({
    contracts: d,
    plan,
    demoDelay: demoDelay(),
    externalNullifierHash: externalNullifier(),
    rootSourceId: d.rootSourceId as Hex,
  })
  const address = await publicClient.readContract({
    address: d.factory,
    abi: WaveAccountFactoryAbi,
    functionName: 'predict',
    args: [d.implementation, built.args, built.salt],
  })
  const extraValidators = slotsOf(plan).extras.map((slot) => d.passkeyValidators[slot - 1])
  return {
    ...built,
    address,
    owner: built.validator,
    validators: [built.validator, ...extraValidators],
    frame: {
      factory: d.factory,
      implementation: d.implementation,
      args: built.args,
      salt: built.salt,
      setup: built.setup,
    },
  }
}

export async function planResponse(d: Deployment, input: unknown): Promise<WalletPlanResponse> {
  const plan = checkPlan(input, d)
  const { address } = await plannedWallet(d, plan)
  const slots = slotsOf(plan)
  return { address, ownerSlot: slots.owner, extraSlots: slots.extras }
}
