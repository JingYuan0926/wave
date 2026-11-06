// POST /api/tx/send and GET /api/tx/status. Server side only.
import { decodeAbiParameters, decodeFunctionData, getAbiItem, size, toEventSelector, type Address, type Hex } from 'viem'
import { initialOwnerOf, initialRootSourceOf } from '../account'
import type { FrameView, Rejection, TxSendRequest, TxSendResponse, TxStatusResponse, TxState, TxWitness } from '../api-types'
import { CHAIN_ID, RPC_URL, RpcError, SIDECAR_URL, publicClient, rpc, sleep, sponsorOf, type Deployment } from '../chain'
import {
  AGENT_WITNESS_LEN,
  decodeRaw,
  PASSKEY_WITNESS_LEN,
  revertDataOf,
  sendToSidecar,
  signSponsor,
  simulate,
  withWitness,
  type FrameTx,
  type Simulation,
  type TxReceipt,
} from '../frametx'
import { encodeWorldWitness } from '../world'
import { WaveAccountAbi, WaveAccountFactoryAbi } from '../wave-abi'
import { frameViews, methodOf, validatorOfKey, type FrameLike } from './decode'
import { ApiFailure, asHex, asWord, deployment } from './http'
import { decodeRevert, markFrames, type Decoded } from './reject'
import { releaseBudget, reserveSponsor } from './sponsor'

const VERIFY_MODE = 1
const SENDER_MODE = 2
/** A bundle runs each 10 s, and a block takes 6 s. */
const RECEIPT_WAIT_MS = 45_000

const PROOF_WORDS = [{ type: 'uint256[8]' }] as const

type WorldFacts = { root: bigint; nullifier: bigint }

function witnessBytes(witness: TxWitness): { bytes: Hex; world?: WorldFacts } {
  if (witness?.kind === 'world') {
    const root = BigInt(asWord(witness.root, 'root'))
    const nullifier = BigInt(asWord(witness.nullifierHash, 'nullifierHash'))
    const [words] = decodeAbiParameters(PROOF_WORDS, asHex(witness.proof, 'proof', 256))
    return { bytes: encodeWorldWitness(root, nullifier, words), world: { root, nullifier } }
  }
  if (witness?.kind === 'passkey') return { bytes: asHex(witness.data, 'passkey witness', PASSKEY_WITNESS_LEN) }
  if (witness?.kind === 'agent') return { bytes: asHex(witness.data, 'agent witness', AGENT_WITNESS_LEN) }
  throw new ApiFailure('BAD_REQUEST', 'The witness is not valid.')
}

async function accountHasCode(address: Address): Promise<boolean> {
  const code = await publicClient.getCode({ address })
  return code !== undefined && code !== '0x'
}

/** The owner and root source that the validator compares with. */
async function identityOf(tx: FrameTx): Promise<{ owner: bigint; source: Hex }> {
  if (await accountHasCode(tx.sender)) {
    const [owner, source] = await Promise.all([
      publicClient.readContract({ address: tx.sender, abi: WaveAccountAbi, functionName: 'ownerNullifier' }),
      publicClient.readContract({ address: tx.sender, abi: WaveAccountAbi, functionName: 'rootSource' }),
    ])
    return { owner, source }
  }
  const { args } = decodeFunctionData({ abi: WaveAccountFactoryAbi, data: tx.frames[0].data })
  const cloneArgs = args?.[1] as Hex
  return { owner: initialOwnerOf(cloneArgs), source: initialRootSourceOf(cloneArgs) }
}

/**
 * A validator returns APPROVE_NONE with no reason, and the account reverts ValidationFailed.
 * So this compares the witness with the account to name the reason.
 */
async function worldFailureCode(tx: FrameTx, world: WorldFacts): Promise<string> {
  const { owner, source } = await identityOf(tx)
  if (world.nullifier !== owner) return 'NullifierMismatch'
  const sameRoot = tx.recentRootReferences.filter((ref) => BigInt(ref.root) === world.root)
  if (sameRoot.length === 0) return 'RootNotCommitted'
  if (!sameRoot.some((ref) => BigInt(ref.sourceId) === BigInt(source))) return 'RootSourceMismatch'
  return 'ProofInvalid'
}

/** The failure of a simulation before any SENDER frame ran. Null if the prefix passed. */
async function prefixFailure(
  tx: FrameTx,
  sim: Simulation,
  world: WorldFacts | undefined,
): Promise<Decoded | null> {
  const index = sim.failedFrameIndex ?? null
  const senderFailed = index !== null && tx.frames[index]?.mode === SENDER_MODE
  if (senderFailed || !sim.executionError) return null

  const text = sim.executionError
  if (/nonce mismatch/i.test(text)) return { code: 'StaleNonce' }
  if (/not committed|recent-root/i.test(text)) return { code: 'RootNotCommitted' }
  if (/insufficient|balance/i.test(text)) {
    return { code: tx.signatures.length > 1 ? 'SponsorEmpty' : 'InsufficientFunds' }
  }

  const data = (sim as { revertData?: Hex }).revertData
  const decoded = data ? decodeRevert(data) : null
  if (!decoded) return { code: 'ValidationFailed' }
  if (decoded.code === 'ValidationFailed' && world) return { code: await worldFailureCode(tx, world) }
  return decoded
}

/** Reads the reason from text such as "validation frame 0: reverted with data 0x...". */
function sidecarCode(message: string): Decoded {
  const data = /reverted with data (0x[0-9a-fA-F]+)/.exec(message)?.[1] as Hex | undefined
  return (data ? decodeRevert(data) : null) ?? { code: 'SidecarRejected' }
}

function frameStatus(frames: FrameView[], receipt: TxReceipt): FrameView[] {
  const results = receipt.frameReceipts ?? []
  return frames.map((frame, index) => {
    const result = results[index]
    if (!result) return { ...frame, status: 'skipped' as const }
    return {
      ...frame,
      status: result.status === '0x1' ? ('ok' as const) : ('failed' as const),
      gasUsed: BigInt(result.gasUsed).toString(),
    }
  })
}

const isFailed = (receipt: TxReceipt): boolean =>
  receipt.status !== '0x1' || (receipt.frameReceipts ?? []).some((frame) => frame.status !== '0x1')

/** A mined transaction with a failed frame spent its gas and its nonce. */
async function chainRejection(hash: Hex, frames: FrameView[]): Promise<Rejection> {
  const data = await revertDataOf(hash).catch(() => null)
  const decoded = data ? decodeRevert(data) : null
  const failedFrameIndex = frames.find((frame) => frame.status === 'failed')?.index
  return {
    stage: 'chain',
    code: decoded?.code ?? 'Reverted',
    args: decoded?.args,
    message: `Transaction ${hash} was mined, and its frame reverted. It spent gas.${
      !decoded && data ? ` Revert data: ${data}` : ''
    }`,
    failedFrameIndex,
    frames,
    txHash: hash,
  }
}

async function receiptOf(hash: Hex): Promise<TxReceipt | null> {
  return rpc<TxReceipt | null>(RPC_URL, 'eth_getTransactionReceipt', [hash])
}

async function waitForMined(hash: Hex): Promise<TxReceipt | null> {
  const end = Date.now() + RECEIPT_WAIT_MS
  while (Date.now() < end) {
    const receipt = await receiptOf(hash)
    if (receipt) return receipt
    await sleep(1000)
  }
  return null
}

export async function sendTx(body: TxSendRequest): Promise<TxSendResponse> {
  const d = deployment()
  let parsed: FrameTx
  try {
    parsed = decodeRaw(asHex(body.envelope, 'envelope'))
  } catch {
    throw new ApiFailure('BAD_REQUEST', 'The envelope is not a frame transaction.')
  }
  if (parsed.chainId !== BigInt(CHAIN_ID)) throw new ApiFailure('BAD_REQUEST', 'The envelope has another chain ID.')
  const sponsor = sponsorOf(d)
  const entries = sponsor ? 2 : 1
  if (parsed.signatures?.length !== entries || parsed.nonceKeys?.length !== 1 || !parsed.frames?.length) {
    throw new ApiFailure('BAD_REQUEST', 'The envelope is not a WAVE transaction.')
  }
  const validator = validatorOfKey(parsed.nonceKeys[0])
  const method = validator && methodOf(d, validator)
  if (!validator || !method || method.kind !== body.witness?.kind) {
    throw new ApiFailure('BAD_REQUEST', 'The witness does not match the validator of this envelope.')
  }

  const { bytes, world } = witnessBytes(body.witness)
  if (size(bytes) !== size(parsed.signatures[0].signature)) {
    throw new ApiFailure('BAD_REQUEST', 'The witness length differs from the placeholder.')
  }
  const tx = withWitness(parsed, bytes)
  const views = frameViews(d, tx.sender, validator, tx.frames)
  if (!sponsor) return submit(tx, views, world)

  const refused = await reserveSponsor(d, sponsor, tx)
  if (refused) return { ok: false, rejection: { stage: 'sponsor', ...refused, frames: views } }
  try {
    const response = await submit(await signSponsor(tx), views, world)
    // A rejection before the mempool spent no gas, so it does not count.
    if (!response.ok && response.rejection.stage !== 'chain') releaseBudget(tx.sender)
    return response
  } catch (error) {
    releaseBudget(tx.sender)
    throw error
  }
}

/** Simulates, sends to the sidecar and waits for the receipt. */
async function submit(tx: FrameTx, views: FrameView[], world: WorldFacts | undefined): Promise<TxSendResponse> {
  let sim: Simulation
  try {
    sim = await simulate(tx)
  } catch (error) {
    if (!(error instanceof RpcError)) throw error
    return { ok: false, rejection: { stage: 'simulate', code: 'ValidationFailed', message: error.message, frames: views } }
  }

  const failure = await prefixFailure(tx, sim, world)
  if (failure) {
    // A stale nonce stops the transaction before any frame runs.
    const failedFrameIndex =
      failure.code === 'StaleNonce'
        ? undefined
        : (sim.failedFrameIndex ?? tx.frames.findIndex((frame) => frame.mode === VERIFY_MODE))
    return {
      ok: false,
      rejection: {
        stage: 'simulate',
        ...failure,
        message: sim.executionError ?? undefined,
        failedFrameIndex,
        haltReason: sim.haltReason ?? undefined,
        frames: failedFrameIndex === undefined ? views : markFrames(views, failedFrameIndex),
      },
    }
  }

  let hash: Hex
  try {
    hash = await sendToSidecar(tx)
  } catch (error) {
    if (!(error instanceof RpcError)) throw error
    return {
      ok: false,
      rejection: { stage: 'sidecar', ...sidecarCode(error.message), message: error.message, frames: views },
    }
  }

  // The mempool holds the transaction now. The owner must get this hash, also if the next read
  // fails. Otherwise the owner can retry an action that still runs.
  const receipt = await waitForMined(hash).catch((error) => {
    console.error('[wave api] receipt read', hash, error)
    return null
  })
  if (!receipt) return { ok: true, txHash: hash, frames: views }
  const frames = frameStatus(views, receipt)
  if (isFailed(receipt)) return { ok: false, rejection: await chainRejection(hash, frames) }
  return { ok: true, txHash: hash, frames, scheduledId: scheduledIdOf(tx, receipt) }
}

const SCHEDULED_TOPIC = toEventSelector(getAbiItem({ abi: WaveAccountAbi, name: 'Scheduled' }))

/** The action that this transaction queued. Only the account itself can emit this log. */
function scheduledIdOf(tx: FrameTx, receipt: TxReceipt): Hex | undefined {
  const log = receipt.logs.find(
    (item) => item.address.toLowerCase() === tx.sender.toLowerCase() && item.topics[0] === SCHEDULED_TOPIC,
  )
  return log?.topics[1]
}

type RpcFrame = { mode: Hex; to: Address | null; data: Hex }
type RpcTx = { sender?: Address; nonceKeys?: Hex[]; frames?: RpcFrame[] }

export const framesOfRpc = (tx: RpcTx): FrameLike[] =>
  (tx.frames ?? []).map((frame) => ({ mode: Number(frame.mode), target: frame.to, data: frame.data }))

function viewsOfRpc(d: Deployment, tx: RpcTx | null): FrameView[] {
  const validator = tx?.nonceKeys?.[0] ? validatorOfKey(tx.nonceKeys[0]) : null
  if (!tx?.sender || !validator) return []
  return frameViews(d, tx.sender, validator, framesOfRpc(tx))
}

async function queuedState(hash: Hex): Promise<TxState> {
  try {
    const { status } = await rpc<{ status: string }>(SIDECAR_URL, 'skandha_frameTransactionStatus', [hash])
    return /drop|reject|cancel|fail|revert/i.test(status) ? 'dropped' : 'queued'
  } catch (error) {
    if (error instanceof RpcError) return 'dropped'
    throw error
  }
}

export async function txStatus(hash: Hex): Promise<TxStatusResponse> {
  const d = deployment()
  const receipt = await receiptOf(hash)
  if (!receipt) {
    return { hash, state: await queuedState(hash), blockNumber: null, gasUsed: null, frames: [], rejection: null }
  }
  const tx = await rpc<RpcTx | null>(RPC_URL, 'eth_getTransactionByHash', [hash])
  const frames = frameStatus(viewsOfRpc(d, tx), receipt)
  const failed = isFailed(receipt)
  return {
    hash,
    state: failed ? 'failed' : 'included',
    blockNumber: BigInt(receipt.blockNumber).toString(),
    gasUsed: BigInt(receipt.gasUsed).toString(),
    frames,
    rejection: failed ? await chainRejection(hash, frames) : null,
  }
}
