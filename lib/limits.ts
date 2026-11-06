import { NO_LIMIT, OWNER_BIT, SMALL_TIER, type Tier } from './policy'

/** How a wallet approves sends of one token. The app builds the rule from this. */
export type SendShape =
  | { kind: 'every'; method: number }
  | {
      kind: 'limit'
      amount: bigint
      lower: number
      upper: number
      /** A synced passkey can use a rule only if the rule has the small flag. */
      lowerSynced: boolean
    }

export type ShapeTier = { upTo: bigint; cap: bigint; delay: number; period: number; methods: number; small: boolean }

/**
 * The rule of a shape. The owner method is in each step, so it can always approve. The owner
 * method cannot be removed, and the other methods can. So a large send always has an approver. The
 * last step has no upper amount. The daily limit is not in a step: it is one hard total for the
 * token, and it stops every step.
 */
export function shapeTiers(shape: SendShape): ShapeTier[] {
  if (shape.kind === 'every') {
    return [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: shape.method | OWNER_BIT, small: false }]
  }
  return [
    {
      upTo: shape.amount,
      cap: 0n,
      delay: 0,
      period: 0,
      methods: shape.lower | OWNER_BIT,
      small: shape.lowerSynced,
    },
    { upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: shape.upper | OWNER_BIT, small: false },
  ]
}

/**
 * The rule that must run with a removal, or null if the rule needs no change. An older rule, or a
 * rule from a tighten, can have a step that only the removed method approves. A step with no
 * approver left gets the owner method. `enrolled` and `synced` are the masks on the chain.
 */
export function tiersAfterRemoval(tiers: readonly Tier[], removed: number, enrolled: number, synced: number): Tier[] | null {
  const live = (enrolled & ~removed) | OWNER_BIT
  let changed = false
  const fixed = tiers.map((tier, index) => {
    if ((tier.methods & removed) === 0) return tier
    const left = tier.methods & live
    const syncedOk = index < tiers.length - 1 && (tier.methods & SMALL_TIER) !== 0
    if ((left & (syncedOk ? ~0 : ~synced)) !== 0) return tier
    changed = true
    return { ...tier, methods: (tier.methods & ~removed) | OWNER_BIT }
  })
  return changed ? fixed : null
}
