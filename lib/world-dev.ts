// The dev World ID mode: a local test identity and real Groth16 proofs with the World simulator
// zkey. A test identity is NOT a real World ID. Server side and scripts only.
// Run scripts/fetch-zk.sh once to get the circuit files.
import path from 'node:path'
import { bytesToHex, encodePacked, numberToHex, type Hex } from 'viem'
import { RECENT_ROOT_ADDRESS, devWallet, LEGACY_TX, publicClient } from './chain'
import { signalHash } from './world'
import type { RootRef } from './frametx'

const DEPTH = 30

export type TestIdentity = { trapdoor: bigint; nullifier: bigint }

let poseidonPromise: Promise<(inputs: bigint[]) => bigint> | undefined

function poseidon() {
  poseidonPromise ??= (async () => {
    const { buildPoseidon } = await import('circomlibjs')
    const p = await buildPoseidon()
    return (inputs: bigint[]) => p.F.toObject(p(inputs))
  })()
  return poseidonPromise
}

export function randomIdentity(): TestIdentity {
  const word = () => BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(31))))
  return { trapdoor: word(), nullifier: word() }
}

/**
 * The tree holds the identity at index 0, so each identity has its own root. `secondLeaf`
 * fills index 1. Then the root differs and the nullifier does not, the same as when World's
 * tree grows.
 */
async function treePath(id: TestIdentity, secondLeaf = 0n) {
  const H = await poseidon()
  const secret = H([id.nullifier, id.trapdoor])
  let node = H([secret])
  let zero = 0n
  const siblings: bigint[] = []
  for (let i = 0; i < DEPTH; i += 1) {
    const sibling = i === 0 ? secondLeaf : zero
    siblings.push(sibling)
    node = H([node, sibling])
    zero = H([zero, zero])
  }
  return { root: node, siblings }
}

export const identityRoot = async (id: TestIdentity, secondLeaf = 0n): Promise<bigint> =>
  (await treePath(id, secondLeaf)).root

/** The Semaphore nullifier hash: the value that the account stores as its owner. */
export async function nullifierHashOf(id: TestIdentity, externalNullifier: bigint): Promise<bigint> {
  const H = await poseidon()
  return H([externalNullifier, id.nullifier])
}

export type DevProof = { root: bigint; nullifierHash: bigint; proof: bigint[]; publicSignals: string[]; ms: number }

/** Proves membership for the signal `sigHash`. */
export async function proveDev(
  id: TestIdentity,
  externalNullifier: bigint,
  sigHash: Hex,
  opts: { secondLeaf?: bigint; zkDir?: string } = {},
): Promise<DevProof> {
  const snarkjs = await import('snarkjs')
  const zkDir = opts.zkDir ?? path.join(process.cwd(), 'scripts/.zk')
  const { root, siblings } = await treePath(id, opts.secondLeaf)
  const start = Date.now()
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      identityNullifier: id.nullifier,
      identityTrapdoor: id.trapdoor,
      treePathIndices: Array(DEPTH).fill(0),
      treeSiblings: siblings,
      externalNullifier,
      signalHash: signalHash(sigHash),
    },
    path.join(zkDir, 'semaphore.wasm'),
    path.join(zkDir, 'semaphore.zkey'),
    undefined,
    { singleThread: true },
    { singleThread: true },
  )
  const words = [
    proof.pi_a[0],
    proof.pi_a[1],
    proof.pi_b[0][1],
    proof.pi_b[0][0],
    proof.pi_b[1][1],
    proof.pi_b[1][0],
    proof.pi_c[0],
    proof.pi_c[1],
  ].map((v) => BigInt(v))
  return { root, nullifierHash: BigInt(publicSignals[1]), proof: words, publicSignals, ms: Date.now() - start }
}

/**
 * Publishes `root` under the source of the local dev key: 64 bytes `salt || root` to 0x...8272.
 * The reference can use the root from the next slot on. Returns the reference.
 */
export async function publishRoot(root: bigint, salt: Hex, sourceId: Hex): Promise<RootRef & { txHash: Hex }> {
  const rootHex = numberToHex(root, { size: 32 })
  const hash = await devWallet.sendTransaction({
    to: RECENT_ROOT_ADDRESS,
    data: encodePacked(['bytes32', 'bytes32'], [salt, rootHex]),
    gas: 1_000_000n,
    ...LEGACY_TX,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error(`root publish reverted: ${hash}`)
  const block = await publicClient.getBlock({ blockHash: receipt.blockHash })
  const slot = BigInt((block as unknown as { slotNumber: Hex }).slotNumber)
  return { sourceId, slot, root: rootHex, txHash: hash }
}
