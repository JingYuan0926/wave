// Address and configuration of a WAVE account. Safe in the browser and on the server.
import { concat, encodePacked, slice, type Address, type Hex } from 'viem'

export const APPROVAL_SCOPES = 3 // Payment and execution.
export const MODE_BITS = 0x0f // All four frame modes.
export const ROUTE_CONTRACT = 1
/** The default demo delay of the app, in seconds. */
export const DEFAULT_DEMO_DELAY = 120

export type AccountConfig = {
  worldIdValidator: Address
  ownerNullifierHash: bigint
  externalNullifierHash: bigint
  rootSourceId: Hex
  /** Seconds. 0 means real delays. */
  demoDelay: number
  /** The main wallet of an agent wallet. An agent wallet needs ownerNullifierHash 0. */
  master?: Address
}

/** validator || scopes || modeBits || route || demoDelay || initData, then master on an agent wallet. */
export function cloneArgs(c: AccountConfig): Hex {
  const args = encodePacked(
    ['address', 'uint8', 'uint8', 'uint8', 'uint32', 'uint256', 'uint256', 'bytes32'],
    [
      c.worldIdValidator,
      APPROVAL_SCOPES,
      MODE_BITS,
      ROUTE_CONTRACT,
      c.demoDelay,
      c.ownerNullifierHash,
      c.externalNullifierHash,
      c.rootSourceId,
    ],
  )
  return c.master ? concat([args, c.master]) : args
}

/** The header of the clone args: validator, scopes, modeBits, route, demoDelay. */
const CLONE_HEADER = 27

/** Reads the initial owner and root source from clone args. */
export const initialOwnerOf = (args: Hex): bigint => BigInt(slice(args, CLONE_HEADER, CLONE_HEADER + 32))
export const initialRootSourceOf = (args: Hex): Hex => slice(args, CLONE_HEADER + 64, CLONE_HEADER + 96)
