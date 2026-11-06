// World ID mode, the app identity, Portal verification and World Chain root reads.
// Server side only. World Chain reads are the only public network reads.
import { signRequest } from '@worldcoin/idkit-server'
import { createPublicClient, http, numberToHex, parseAbi, toHex, type Address, type Hex } from 'viem'
import { worldchain, worldchainSepolia } from 'viem/chains'
import type { WorldConfig, WorldEnvironment, WorldProof, WorldRpContextResponse } from '../api-types'
import { CREATE_SIGNAL } from '../api-types'
import { publicClient } from '../chain'
import { proofFromIdkit } from '../ui/world'
import { DEV_APP_ID, WORLD_ACTION, externalNullifierHash, hashToField } from '../world'
import { ApiFailure, deployment, isOffline } from './http'

const ENVIRONMENTS: WorldEnvironment[] = ['production', 'staging', 'sandbox']

function environment(): WorldEnvironment {
  const value = process.env.NEXT_PUBLIC_WORLD_ENV
  return ENVIRONMENTS.find((item) => item === value) ?? 'staging'
}

/** `idkit` when all three values are set. `dev` otherwise. */
export function worldConfig(): WorldConfig {
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID
  const rpId = process.env.NEXT_PUBLIC_RP_ID
  if (appId?.startsWith('app_') && rpId && process.env.RP_SIGNING_KEY) {
    return { mode: 'idkit', appId: appId as `app_${string}`, rpId, environment: environment() }
  }
  return { mode: 'dev' }
}

/** The external nullifier that every account of this server stores. */
export function externalNullifier(): bigint {
  const world = worldConfig()
  return externalNullifierHash(world.mode === 'idkit' ? world.appId : DEV_APP_ID, WORLD_ACTION)
}

export function rpContext(): WorldRpContextResponse {
  const world = worldConfig()
  if (world.mode !== 'idkit') {
    throw new ApiFailure('NOT_IDKIT_MODE', 'Set the World ID values in .env.local to use IDKit.')
  }
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: process.env.RP_SIGNING_KEY as string,
    action: WORLD_ACTION,
  })
  return { rp_id: world.rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig }
}

/** The signal hash of a sig_hash (hex) or of the creation signal (text). */
export const signalHashOf = (signal: string): bigint =>
  hashToField(signal.startsWith('0x') ? (signal as Hex) : toHex(signal))

const VERIFIER_ABI = parseAbi(['function verifyProof(uint256[8] proof, uint256[4] input) view'])

/** Asks the onchain verifier with eth_call. It reverts on a bad proof. */
export async function checkProofOnchain(proof: WorldProof, words: readonly bigint[]): Promise<void> {
  const input = [
    BigInt(proof.merkleRoot),
    BigInt(proof.nullifierHash),
    signalHashOf(CREATE_SIGNAL),
    externalNullifier(),
  ] as const
  try {
    await publicClient.readContract({
      address: deployment().semaphoreVerifier,
      abi: VERIFIER_ABI,
      functionName: 'verifyProof',
      args: [words as never, input],
    })
  } catch (error) {
    // viem wraps a network failure in the same error as a revert.
    if ((error as Error).name === 'ContractFunctionExecutionError' && !isOffline(error)) {
      throw new ApiFailure('PROOF_INVALID', 'The onchain verifier rejected this proof.')
    }
    throw error
  }
}

/** Sends the raw IDKit result to the Developer Portal, as the creation scan needs. */
export async function verifyWithPortal(result: unknown): Promise<WorldProof> {
  const world = worldConfig()
  if (world.mode !== 'idkit') throw new ApiFailure('NOT_IDKIT_MODE', 'This server runs the test identity mode.')
  let proof: WorldProof
  try {
    proof = proofFromIdkit(result)
  } catch (error) {
    throw new ApiFailure('NOT_3_0_PROOF', (error as Error).message)
  }
  if (proof.signalHash !== '0x' && BigInt(proof.signalHash) !== signalHashOf(CREATE_SIGNAL)) {
    throw new ApiFailure('WRONG_SIGNAL', 'This proof does not belong to the creation scan.')
  }
  let response: Response
  try {
    response = await fetch(`https://developer.world.org/api/v4/verify/${world.rpId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    })
  } catch (error) {
    console.error('[wave api] Developer Portal', error)
    throw new ApiFailure('PORTAL_OFFLINE', 'The World Developer Portal does not answer.', 502)
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { detail?: string; code?: string }
    throw new ApiFailure(
      'PORTAL_REJECTED',
      detail.detail ?? detail.code ?? `The Developer Portal returned status ${response.status}.`,
    )
  }
  return proof
}

type RootChain = { chain: typeof worldchain | typeof worldchainSepolia; address: Address }

/** Staging also serves `sandbox`: the location of the sandbox root is not known. */
const ROOT_CHAINS: Record<WorldEnvironment, RootChain> = {
  production: { chain: worldchain, address: '0xdFCa0A882eF7793485B3d052142B60647E82009E' },
  staging: { chain: worldchainSepolia, address: '0xE177F37AF0A862A02edFEa4F59C02668E9d0aAA4' },
  sandbox: { chain: worldchainSepolia, address: '0xE177F37AF0A862A02edFEa4F59C02668E9d0aAA4' },
}

const ROOT_ABI = parseAbi(['function latestRoot() view returns (uint256)'])

/** The newest World ID root on World Chain, or World Chain Sepolia in staging. */
export async function latestWorldRoot(env: WorldEnvironment): Promise<Hex> {
  const { chain, address } = ROOT_CHAINS[env]
  const client = createPublicClient({ chain, transport: http(process.env.WORLD_CHAIN_RPC_URL) })
  try {
    const root = await client.readContract({ address, abi: ROOT_ABI, functionName: 'latestRoot' })
    return numberToHex(root, { size: 32 })
  } catch (error) {
    // The error text holds the RPC URL, and the URL can hold an API key.
    console.error('[wave api] World Chain root read', error)
    throw new ApiFailure('ROOT_READ_FAILED', 'WAVE could not read the World ID root from World Chain.', 502)
  }
}
