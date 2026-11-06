// Builds, simulates and sends EIP-8141 frame transactions for a WAVE account.
// Server side and scripts only. The wire format comes from @forshtat/hegota-support.
import { getProfile } from '@forshtat/hegota-support/profiles'
import * as hs from '@forshtat/hegota-support/tx'
import { toWire } from '@forshtat/hegota-support/rpc'
import { concat, encodeFunctionData, keccak256, numberToHex, pad, type Address, type Hex } from 'viem'
import { NONCE_MANAGER, RPC_URL, SIDECAR_URL, SPONSOR_KEY, CHAIN_ID, rpc, sleep, type Sponsor } from './chain'
import { WaveAccountFactoryAbi, WaveGasStationAbi } from './wave-abi'
import { verifyData } from './policy'

export const profile = getProfile('ethrex-eip8141-tracer')

export type FrameTx = ReturnType<typeof hs.newTx>
export type RootRef = { sourceId: Hex; slot: bigint; root: Hex }

export const WORLD_WITNESS_LEN = 320
export const PASSKEY_WITNESS_LEN = 512
export const AGENT_WITNESS_LEN = 65

/** The first use of a nonce key writes one NONCE_MANAGER slot: 64 state bytes at 1530 gas. */
export const KEYED_NONCE_STATE_GAS = 97_920n

/** Execution gas of the VERIFY frame. Measured values are in scripts/e2e.ts output. */
export const WORLD_VERIFY_GAS = 400_000n
export const PASSKEY_VERIFY_GAS = 80_000n
export const AGENT_VERIFY_GAS = 60_000n
/** Execution gas of the gas station frame. APPROVE writes the keyed nonce here, about 20k gas on first use. */
export const PAY_VERIFY_GAS = 60_000n

/** Entry 0 holds the method's witness. Entry 1 holds the sponsor's signature. */
export const SPONSOR_SIGNATURE_INDEX = 1

/** EIP-8250: slot(sender, key) = keccak256(left_pad_32(sender) || be32(key)). */
export function nonceSlot(sender: Address, nonceKey: bigint): Hex {
  return keccak256(concat([pad(sender, { size: 32 }), numberToHex(nonceKey, { size: 32 })]))
}

/** Reads the keyed nonce of a validator. */
export async function keyedNonce(sender: Address, validator: Address): Promise<bigint> {
  const key = BigInt(validator)
  const value = await rpc<Hex>(RPC_URL, 'eth_getStorageAt', [NONCE_MANAGER, nonceSlot(sender, key), 'latest'])
  return BigInt(value)
}

export type DeployFrame = {
  factory: Address
  implementation: Address
  args: Hex
  salt: Hex
  /** Empty for a wallet with one method. */
  setup: Hex
  /** Overrides the state gas of the DEFAULT frame. */
  state?: bigint
}

export type SenderFrame = { data: Hex; execution?: bigint; state?: bigint }

export type BuildInput = {
  account: Address
  validator: Address
  witnessLen: number
  verifyGas: bigint
  /** One entry per SENDER frame. Each one targets the account. */
  sender: SenderFrame[]
  /** Set on the local network. The gas station pays, and the account approves execution only. */
  sponsor?: Sponsor | null
  /** Set to deploy the account in a DEFAULT frame. */
  deploy?: DeployFrame
  rootRefs?: RootRef[]
  /** Overrides the sequence read from the chain. */
  nonceSeq?: bigint
  /** Overrides the default fees. */
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
}

const SENDER_EXECUTION = 300_000n
const SENDER_STATE = 1_000_000n

export async function buildTx(input: BuildInput): Promise<FrameTx> {
  const nonceSeq = input.nonceSeq ?? (await keyedNonce(input.account, input.validator))
  const frames = []
  if (input.deploy) {
    const { factory, implementation, args, salt, setup, state } = input.deploy
    frames.push(
      hs.frame(profile, 'DEFAULT', {
        target: factory,
        execution: 100_000n,
        state: state ?? BigInt(1530 * (45 + (args.length - 2) / 2)),
        data: encodeFunctionData({
          abi: WaveAccountFactoryAbi,
          functionName: 'createAccount',
          args: [implementation, args, salt, setup],
        }),
      }),
    )
  }
  // Payment approval consumes the nonce keys, so the frame that pays holds the state gas.
  const nonceState = nonceSeq === 0n ? KEYED_NONCE_STATE_GAS : 0n
  const { sponsor } = input
  frames.push(
    hs.frame(profile, 'VERIFY', {
      scope: sponsor ? 'EXECUTION' : 'EXECUTION_AND_PAYMENT',
      target: input.account,
      execution: input.verifyGas,
      state: sponsor ? 0n : nonceState,
      data: verifyData(0n),
    }),
  )
  if (sponsor) {
    frames.push(
      hs.frame(profile, 'VERIFY', {
        scope: 'PAYMENT',
        target: sponsor.station,
        execution: PAY_VERIFY_GAS,
        state: nonceState,
        data: encodeFunctionData({ abi: WaveGasStationAbi, functionName: 'pay' }),
      }),
    )
  }
  for (const s of input.sender) {
    frames.push(
      hs.frame(profile, 'SENDER', {
        target: input.account,
        execution: s.execution ?? SENDER_EXECUTION,
        state: s.state ?? SENDER_STATE,
        data: s.data,
      }),
    )
  }
  const tx = hs.newTx({
    chainId: CHAIN_ID,
    nonceKeys: [BigInt(input.validator)],
    nonceSeq,
    sender: input.account,
    frames,
    signatures: [
      { scheme: 0, signer: '0x', msg: '0x', signature: pad('0x00', { size: input.witnessLen }) },
      ...(sponsor ? [hs.secp256k1Placeholder(profile, sponsor.signer)] : []),
    ],
    fees: input.fees ?? { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  })
  tx.recentRootReferences = input.rootRefs ?? []
  return tx
}

/** The World ID signal and the WebAuthn challenge. The witness bytes are not part of it. */
export const sigHashOf = (tx: FrameTx): Hex => hs.sigHash(profile, tx)

export const withWitness = (tx: FrameTx, witness: Hex): FrameTx => ({
  ...tx,
  signatures: tx.signatures.map((entry, index) => (index === 0 ? { ...entry, signature: witness } : entry)),
})

/** Adds the sponsor's signature. It covers sig_hash, so the witness can arrive before or after it. */
export const signSponsor = (tx: FrameTx, key: Hex = SPONSOR_KEY): Promise<FrameTx> =>
  hs.signTx(profile, tx, key, SPONSOR_SIGNATURE_INDEX)

export const encodeRaw = (tx: FrameTx): Hex => hs.encodeTx(profile, tx)
export const decodeRaw = (raw: Hex): FrameTx => hs.decodeTx(profile, raw)
export const hashOf = (tx: FrameTx): Hex => hs.txHash(profile, tx)

export type SimFrame = {
  status?: string
  gasUsed?: string
  returnData?: string
  [key: string]: unknown
}

export type Simulation = {
  canonicalMempoolValid?: boolean
  canonicalMempoolViolation?: string | null
  prefixShape?: string
  maxCost?: string
  payer?: string
  failedFrameIndex?: number | null
  haltReason?: string | null
  haltDetail?: string | null
  executionStatus?: string
  executionError?: string | null
  frames?: SimFrame[]
  gasUsed?: string
  [key: string]: unknown
}

export const simulate = (tx: FrameTx, trace = false) =>
  rpc<Simulation>(RPC_URL, 'ethrex_simulateFrameTransaction', [encodeRaw(tx), 'latest', { trace }])

/**
 * Sends through the sidecar. Throws RpcError if the sidecar rejects the transaction.
 * The sidecar holds a nonce key for a short time after the transaction that used it is mined.
 * So this retries that one error.
 */
export async function sendToSidecar(tx: FrameTx): Promise<Hex> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rpc<Hex>(SIDECAR_URL, 'eth_sendFrameTransaction', [toWire(tx)])
    } catch (e) {
      if (attempt >= 15 || !/is already held by pending transaction/.test((e as Error).message)) throw e
      await sleep(2000)
    }
  }
}

export const sidecarStatus = (hash: Hex) =>
  rpc<{ status: string }>(SIDECAR_URL, 'skandha_frameTransactionStatus', [hash])

export type FrameReceipt = { status: string; gasUsed: string; stateGasUsed?: string; logs: unknown[] }
export type TxReceipt = {
  transactionHash: Hex
  status: string
  blockNumber: string
  gasUsed: string
  frameReceipts?: FrameReceipt[]
  logs: { address: Address; topics: Hex[]; data: Hex }[]
}

type TraceCall = { error?: string; output?: Hex; calls?: TraceCall[] }

function firstRevert(call: TraceCall): Hex | null {
  if (call.error && call.output && call.output.length >= 10) return call.output
  for (const child of call.calls ?? []) {
    const found = firstRevert(child)
    if (found) return found
  }
  return null
}

/**
 * The revert data of the failed frame of a mined transaction. The simulator gives revert data
 * only for prefix frames, so this reads the call trace of the node.
 */
export async function revertDataOf(hash: Hex): Promise<Hex | null> {
  const trace = await rpc<TraceCall>(RPC_URL, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }])
  return firstRevert(trace)
}

export async function waitForReceipt(hash: Hex, attempts = 60): Promise<TxReceipt> {
  for (let i = 0; i < attempts; i += 1) {
    const receipt = await rpc<TxReceipt | null>(RPC_URL, 'eth_getTransactionReceipt', [hash])
    if (receipt) return receipt
    await sleep(2000)
  }
  throw new Error(`no receipt for ${hash}`)
}

