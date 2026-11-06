// Turns revert data and viem errors into the Rejection shape. Server side only.
import type { Hex } from 'viem'
import type { FrameView, Rejection } from '../api-types'
import { decodeWaveError } from '../policy'
import { WaveAccountAbi } from '../wave-abi'

export type Decoded = { code: string; args?: Record<string, string> }

/** A token that lacks the funds is the same event for the owner as a wallet that lacks them. */
const codeOf = (name: string): string => (name === 'ERC20InsufficientBalance' ? 'InsufficientFunds' : name)

function namedArgs(name: string, args: readonly unknown[]): Record<string, string> | undefined {
  if (args.length === 0) return undefined
  const item = WaveAccountAbi.find((entry) => entry.type === 'error' && entry.name === name) as
    | { inputs: readonly { name: string }[] }
    | undefined
  return Object.fromEntries(args.map((value, index) => [item?.inputs[index]?.name || String(index), String(value)]))
}

/** The custom error in revert data. Null if the data holds no WAVE error. */
export function decodeRevert(data: Hex): Decoded | null {
  const found = decodeWaveError(data)
  return found ? { code: codeOf(found.name), args: namedArgs(found.name, found.args) } : null
}

type RevertedCall = {
  name?: string
  data?: { errorName?: string; args?: readonly unknown[] }
  walk?: (test: (cause: unknown) => boolean) => unknown
}

/** The custom error of a failed viem read. Null if the failure is not a revert. A revert with an unknown error is `Reverted`. */
export function decodeCallError(error: unknown): Decoded | null {
  const found = (error as RevertedCall).walk?.(
    (cause) => (cause as RevertedCall)?.name === 'ContractFunctionRevertedError',
  ) as RevertedCall | undefined
  if (!found) return null
  const name = found.data?.errorName
  return name ? { code: codeOf(name), args: namedArgs(name, found.data?.args ?? []) } : { code: 'Reverted' }
}

/** Sets a status on each frame: the frames before the failure ran, the frames after it did not. */
export function markFrames(frames: FrameView[], failedIndex: number | null): FrameView[] {
  return frames.map((frame) => {
    if (failedIndex === null || frame.index < failedIndex) return { ...frame, status: 'ok' as const }
    return { ...frame, status: frame.index === failedIndex ? ('failed' as const) : ('skipped' as const) }
  })
}

export const prepareRejection = (decoded: Decoded, message?: string): Rejection => ({
  stage: 'prepare',
  ...decoded,
  message,
})
