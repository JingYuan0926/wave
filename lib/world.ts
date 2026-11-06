// World ID 3.0 values. Safe in the browser and on the server.
import { encodeAbiParameters, encodePacked, keccak256, toHex, type Hex } from 'viem'

export const WORLD_ACTION = 'wave-approve'
/** The app id of the dev mode. It is not a registered World app. */
export const DEV_APP_ID = 'app_staging_wave'

export const hashToField = (bytes: Hex): bigint => BigInt(keccak256(bytes)) >> 8n

export const externalNullifierHash = (appId: string, action: string): bigint =>
  hashToField(encodePacked(['uint256', 'string'], [hashToField(toHex(appId)), action]))

/** IDKit: orbLegacy({ signal: sigHash }). The contract computes the same value. */
export const signalHash = (sigHash: Hex): bigint => hashToField(sigHash)

/** root (32) || nullifierHash (32) || proof (8 * 32). */
export const encodeWorldWitness = (root: bigint, nullifierHash: bigint, proof: readonly bigint[]): Hex =>
  encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[8]' }],
    [root, nullifierHash, proof as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]],
  )
