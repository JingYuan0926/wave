// Runs the 12 WAVE cases against the live local stack, with real frame transactions, real
// Groth16 proofs from a dev test identity and a software P-256 WebAuthn authenticator.
// Prints PASS or FAIL with transaction hashes. Exit code 1 if a case fails.
// Prerequisites: devnet/up.sh, contracts deployed, scripts/fetch-zk.sh.
import { encodeFunctionData, keccak256, numberToHex, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { cloneArgs } from '../lib/account'
import { loadDeployment, devWallet, publicClient, LEGACY_TX, explorerLink, rpc, RPC_URL, sleep, sponsorOf, RpcError } from '../lib/chain'
import {
  buildTx,
  keyedNonce,
  sigHashOf,
  signSponsor,
  withWitness,
  simulate,
  sendToSidecar,
  waitForReceipt,
  sidecarStatus,
  revertDataOf,
  WORLD_WITNESS_LEN,
  WORLD_VERIFY_GAS,
  PASSKEY_WITNESS_LEN,
  PASSKEY_VERIFY_GAS,
  type DeployFrame,
  type FrameTx,
  type RootRef,
  type Simulation,
  type TxReceipt,
} from '../lib/frametx'
import {
  ETH,
  KIND_NORMAL,
  KIND_RECOVERY,
  NO_LIMIT,
  SMALL_TIER,
  STATUS,
  WORLD_BIT,
  approveRecoveryData,
  cancelData,
  decodeWaveError,
  erc20Transfer,
  ethTransfer,
  executeData,
  executeScheduledData,
  encodeBatch,
  installModuleCall,
  passkeyBit,
  passkeyInitData,
  scheduleData,
  setOwnerCall,
  setTiersCall,
  tightenData,
  type Call,
  type Tier,
} from '../lib/policy'
import { externalNullifierHash, encodeWorldWitness, DEV_APP_ID, WORLD_ACTION } from '../lib/world'
import {
  randomIdentity,
  identityRoot,
  nullifierHashOf,
  proveDev,
  publishRoot,
  type TestIdentity,
} from '../lib/world-dev'
import { TestUSDCAbi, WaveAccountAbi, WaveAccountFactoryAbi } from '../lib/wave-abi'
import { SoftPasskey } from './lib/soft-passkey'

const d = loadDeployment()
const sponsor = sponsorOf(d)
if (!sponsor) throw new Error('These cases run on the local network, with the gas station deployed.')
const DEMO_DELAY = Number(process.env.E2E_DEMO_DELAY ?? 45)
const USDC = (n: number) => BigInt(Math.round(n * 1e6))
const RECEIVER: Address = '0x000000000000000000000000000000000000bEEF'
const ext = externalNullifierHash(DEV_APP_ID, WORLD_ACTION)

type Method =
  | { kind: 'world'; identity: TestIdentity; label: string }
  | { kind: 'passkey'; key: SoftPasskey; slot: number; label: string }

type Outcome = { hash: Hex; receipt: TxReceipt; frames: { ok: boolean; gas: number; state: number }[]; sim: Simulation }

// ---------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------

const results: { name: string; pass: boolean; notes: string[] }[] = []
let current: { name: string; pass: boolean; notes: string[] }
const gas: Record<string, number[]> = {}

function note(text: string) {
  console.log(`    ${text}`)
  current.notes.push(text)
}

function check(cond: boolean, text: string) {
  console.log(`    ${cond ? 'ok  ' : 'BAD '} ${text}`)
  current.notes.push(`${cond ? 'ok' : 'BAD'} ${text}`)
  if (!cond) current.pass = false
}

// Set E2E_ONLY=1,3 to run some cases. Later cases need the state of earlier ones.
const only = process.env.E2E_ONLY?.split(',')

async function runCase(name: string, body: () => Promise<void>) {
  if (only && !only.includes(name.split('.')[0])) return
  current = { name, pass: true, notes: [] }
  results.push(current)
  console.log(`\n=== ${name}`)
  try {
    await body()
  } catch (e) {
    current.pass = false
    const err = e as RpcError
    console.log(`    EXCEPTION ${err.message} ${JSON.stringify(err.data ?? null)}`)
    current.notes.push(`EXCEPTION ${err.message}`)
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'))
  }
  console.log(`${current.pass ? 'PASS' : 'FAIL'} ${name}`)
}

// ---------------------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------------------

const refs = new Map<string, RootRef>()

async function refFor(identity: TestIdentity): Promise<RootRef> {
  const root = await identityRoot(identity)
  const key = root.toString()
  let ref = refs.get(key)
  if (!ref) {
    const published = await publishRoot(root, d.rootSalt, d.rootSourceId)
    ref = { sourceId: published.sourceId, slot: published.slot, root: published.root }
    refs.set(key, ref)
    await waitForSlotAfter(ref.slot)
  }
  return ref
}

async function waitForSlotAfter(slot: bigint) {
  for (;;) {
    const block = await rpc<{ slotNumber: Hex }>(RPC_URL, 'eth_getBlockByNumber', ['latest', false])
    if (BigInt(block.slotNumber) > slot) return
    await sleep(1000)
  }
}

// ---------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------

type SendOpts = {
  /** The devnet shape: the account pays its own gas. */
  selfPaid?: boolean
  /** The devnet first transaction: a DEFAULT frame deploys the account. */
  deploy?: DeployFrame
  /** Leave the sponsor signature empty. */
  noSponsorSignature?: boolean
  /** The entry names the sponsor, but another key signs. */
  wrongSponsorKey?: boolean
  /** The entry names another signer, and that signer signs. */
  otherSponsor?: boolean
  /** Use these references instead of the default reference of the identity. */
  rootRefs?: RootRef[]
  /** Prove with this identity, but claim the owner nullifier in the witness. */
  claimNullifier?: bigint
  /** Prove in a tree that also holds this leaf. */
  secondLeaf?: bigint
  /** Sign other fees than the app does. */
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
}

const OTHER_KEY = keccak256(toHex('not the sponsor'))
const otherSigner = privateKeyToAccount(OTHER_KEY).address

const stationFor = (opts: SendOpts) => {
  if (opts.selfPaid) return null
  return opts.otherSponsor ? { ...sponsor, signer: otherSigner } : sponsor
}

function sponsored(tx: FrameTx, opts: SendOpts) {
  if (opts.selfPaid || opts.noSponsorSignature) return Promise.resolve(tx)
  return signSponsor(tx, opts.wrongSponsorKey || opts.otherSponsor ? OTHER_KEY : undefined)
}

async function buildSigned(account: Address, method: Method, data: Hex[], opts: SendOpts = {}) {
  const sender = data.map((d) => ({ data: d }))
  if (method.kind === 'world') {
    const rootRefs = opts.rootRefs ?? [await refFor(method.identity)]
    const tx = await buildTx({
      account,
      validator: d.worldIdValidator,
      witnessLen: WORLD_WITNESS_LEN,
      verifyGas: WORLD_VERIFY_GAS,
      sender,
      sponsor: stationFor(opts),
      deploy: opts.deploy,
      rootRefs,
      fees: opts.fees,
    })
    const p = await proveDev(method.identity, ext, sigHashOf(tx), { secondLeaf: opts.secondLeaf })
    return sponsored(withWitness(tx, encodeWorldWitness(p.root, opts.claimNullifier ?? p.nullifierHash, p.proof)), opts)
  }
  const tx = await buildTx({
    account,
    validator: d.passkeyValidators[method.slot - 1],
    witnessLen: PASSKEY_WITNESS_LEN,
    verifyGas: PASSKEY_VERIFY_GAS,
    sender,
    sponsor: stationFor(opts),
    deploy: opts.deploy,
    fees: opts.fees,
  })
  return sponsored(withWitness(tx, method.key.sign(sigHashOf(tx))), opts)
}

function frameOutcome(receipt: TxReceipt) {
  return (receipt.frameReceipts ?? []).map((f) => ({
    ok: f.status === '0x1',
    gas: Number(f.gasUsed),
    state: Number(f.stateGasUsed ?? 0),
  }))
}

function recordVerifyGas(tx: FrameTx, method: Method, frames: Outcome['frames']) {
  const i = tx.frames.findIndex((f) => f.mode === 1)
  const firstUse = tx.nonceSeq === 0n
  const key = `${method.kind} VERIFY${firstUse ? ' (first use of nonce key)' : ''}${i === 1 ? ' (with deploy)' : ''}`
  ;(gas[key] ??= []).push(frames[i].gas)
}

async function sendTx(tx: FrameTx, method: Method): Promise<Outcome> {
  const sim = await simulate(tx)
  const hash = await sendToSidecar(tx)
  const receipt = await waitForReceipt(hash)
  const frames = frameOutcome(receipt)
  recordVerifyGas(tx, method, frames)
  return { hash, receipt, frames, sim }
}

/** The transaction must be admitted and mined, and every frame must succeed. */
async function mustPass(label: string, account: Address, method: Method, data: Hex[], opts: SendOpts = {}) {
  const tx = await buildSigned(account, method, data, opts)
  const out = await sendTx(tx, method)
  const ok = out.receipt.status === '0x1' && out.frames.every((f) => f.ok)
  check(ok, `${label}: mined by ${method.label} tx ${out.hash} block ${Number(out.receipt.blockNumber)} frames ${JSON.stringify(out.frames.map((f) => [f.ok ? 1 : 0, f.gas]))}`)
  return out
}

/** The transaction must be mined with a failed SENDER frame. */
async function mustFailInFrame(
  label: string,
  account: Address,
  method: Method,
  data: Hex[],
  expected: string,
) {
  const tx = await buildSigned(account, method, data)
  const out = await sendTx(tx, method)
  const failed = out.frames.findIndex((f) => !f.ok)
  const data_ = await revertDataOf(out.hash)
  const reason = data_ ? decodeWaveError(data_)?.name ?? data_ : 'no revert data in the trace'
  check(
    failed >= 0 && tx.frames[failed].mode === 2 && reason === expected,
    `${label}: mined with failed SENDER frame ${failed}, reason ${reason} (want ${expected}), by ${method.label} tx ${out.hash}`,
  )
  return out
}

/** The sidecar must reject the transaction. The simulator must show the reason. */
async function mustBeRejected(label: string, tx: FrameTx, expected: RegExp) {
  const sim = await simulate(tx).catch((e: Error) => ({ error: e.message }) as Simulation)
  const revert = (sim as { revertData?: Hex }).revertData
  const decoded = revert ? decodeWaveError(revert)?.name ?? revert : undefined
  let sidecar = ''
  try {
    const hash = await sendToSidecar(tx)
    sidecar = `ADMITTED ${hash}`
  } catch (e) {
    sidecar = (e as Error).message
  }
  const detail = `sim ${JSON.stringify({ err: sim.error, exec: sim.executionError, violation: sim.canonicalMempoolViolation, frame: sim.failedFrameIndex, halt: sim.haltReason, decoded })}, sidecar: ${sidecar.slice(0, 200)}`
  check(!sidecar.startsWith('ADMITTED') && expected.test(`${decoded} ${sim.error ?? ''} ${sim.executionError ?? ''} ${sidecar}`), `${label}: rejected. ${detail}`)
}

/** An eth_call must revert with this custom error. */
async function callReverts(label: string, call: () => Promise<unknown>, expected: string) {
  let reason = 'no revert'
  try {
    await call()
  } catch (e) {
    const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown; message: string }
    const found = err.walk?.((x) => (x as { data?: unknown })?.data !== undefined) as { data?: { errorName?: string } | Hex } | undefined
    const data = found?.data
    reason = typeof data === 'string' ? decodeWaveError(data)?.name ?? data : data?.errorName ?? err.message.slice(0, 200)
  }
  check(reason === expected, `${label}: reverted ${reason} (want ${expected})`)
}

// ---------------------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------------------

const read = <T,>(account: Address, functionName: string, args: unknown[] = []) =>
  publicClient.readContract({ address: account, abi: WaveAccountAbi, functionName: functionName as never, args: args as never }) as Promise<T>

const usdcBalance = (who: Address) =>
  publicClient.readContract({ address: d.testUsdc, abi: TestUSDCAbi, functionName: 'balanceOf', args: [who] })

async function plainTx(to: Address, data: Hex, value = 0n, gasLimit = 3_000_000n) {
  const hash = await devWallet.sendTransaction({ to, data, value, gas: gasLimit, ...LEGACY_TX })
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  return { hash, status: r.status }
}

type Wallet = { account: Address; args: Hex; salt: Hex; world: Method & { kind: 'world' } }

/** The local network deploys a wallet with a plain sponsor transaction. */
async function sponsorDeploys(w: Wallet) {
  const data = encodeFunctionData({
    abi: WaveAccountFactoryAbi,
    functionName: 'createAccount',
    args: [d.implementation, w.args, w.salt],
  })
  const { status } = await plainTx(d.factory, data, 0n, 1_500_000n)
  if (status !== 'success') throw new Error('deploy failed')
}

async function makeWallet(tag: string, identity: TestIdentity, ethFunds = 5n * 10n ** 18n): Promise<Wallet> {
  const owner = await nullifierHashOf(identity, ext)
  const args = cloneArgs({
    worldIdValidator: d.worldIdValidator,
    ownerNullifierHash: owner,
    externalNullifierHash: ext,
    rootSourceId: d.rootSourceId,
    demoDelay: DEMO_DELAY,
  })
  const salt = keccak256(toHex(`wave-e2e-${tag}-${Date.now()}`))
  const account = await publicClient.readContract({
    address: d.factory,
    abi: WaveAccountFactoryAbi,
    functionName: 'predict',
    args: [d.implementation, args, salt],
  })
  if (ethFunds > 0n) {
    const fund = await plainTx(account, '0x', ethFunds, 600_000n)
    if (fund.status !== 'success') throw new Error('funding failed')
  }
  const mint = await plainTx(
    d.testUsdc,
    encodeFunctionData({ abi: TestUSDCAbi, functionName: 'mint', args: [account, USDC(10_000)] }),
    0n,
    500_000n,
  )
  if (mint.status !== 'success') throw new Error('mint failed')
  return { account, args, salt, world: { kind: 'world', identity, label: 'World ID' } }
}

/** Scheduled id from the Scheduled log of a mined transaction. */
function scheduledId(out: Outcome): Hex {
  const log = out.receipt.logs.find((l) => l.topics.length === 2)
  if (!log) throw new Error(`no Scheduled log in ${out.hash}`)
  return log.topics[1]
}

let saltCounter = 0
const newSalt = () => keccak256(toHex(`salt-${Date.now()}-${(saltCounter += 1)}`))

async function waitUntil(unixSeconds: bigint) {
  for (;;) {
    const block = await publicClient.getBlock()
    if (block.timestamp >= unixSeconds) return
    await sleep(2000)
  }
}

/** Waits for the delay, then runs executeScheduled in a plain transaction from another key. */
async function runQueued(label: string, account: Address, id: Hex, calls: Call[]) {
  const p = await read<{ notBefore: number }>(account, 'pendingOf', [id])
  await waitUntil(BigInt(p.notBefore))
  const { hash, status } = await plainTx(account, executeScheduledData(id, calls))
  check(status === 'success', `${label}: executeScheduled by a plain tx from another key: ${hash}`)
}

const approveCall = (spender: Address): Call => ({
  target: d.testUsdc,
  value: 0n,
  callData: encodeFunctionData({ abi: TestUSDCAbi, functionName: 'approve', args: [spender, USDC(1)] }),
})

// ---------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------

async function main() {
  const human = randomIdentity()
  const stranger = randomIdentity()
  const w = await makeWallet('main', human)
  const account = w.account
  const world: Method = w.world
  const strangerM: Method = { kind: 'world', identity: stranger, label: 'other human' }
  const key1 = new SoftPasskey()
  const key2 = new SoftPasskey()
  const key3 = new SoftPasskey(true)
  const pk1: Method = { kind: 'passkey', key: key1, slot: 1, label: 'passkey 1' }
  const pk2: Method = { kind: 'passkey', key: key2, slot: 2, label: 'passkey 2' }
  const pk3: Method = { kind: 'passkey', key: key3, slot: 3, label: 'synced passkey 3' }
  const v = d.passkeyValidators
  console.log(`account ${account}, demo delay ${DEMO_DELAY} s`)

  await runCase('1. Create with World ID only, the sponsor deploys, small transfer', async () => {
    const before = await publicClient.getBalance({ address: RECEIVER })
    await sponsorDeploys(w)
    const out = await mustPass('first transfer', account, world, [executeData([ethTransfer(RECEIVER, 1000n)])])
    const code = await publicClient.getCode({ address: account })
    check(!!code && code.length > 2, `account has code, ${(code!.length - 2) / 2} bytes`)
    check((await publicClient.getBalance({ address: RECEIVER })) === before + 1000n, 'receiver got 1000 wei')
    note(`sidecar status ${(await sidecarStatus(out.hash)).status}`)
    note(`prefix shape ${out.sim.prefixShape}, simulator status ${out.sim.executionStatus}`)
    note(`explorer ${explorerLink(out.hash)}`)
  })

  await runCase('2. Different human: nullifier mismatch', async () => {
    await refFor(stranger)
    const data = [executeData([ethTransfer(RECEIVER, 1n)])]
    await mustBeRejected('other human, own nullifier', await buildSigned(account, strangerM, data), /ValidationFailed/)
    const owner = await read<bigint>(account, 'ownerNullifier')
    await mustBeRejected(
      'other human, claims the owner nullifier',
      await buildSigned(account, strangerM, data, { claimNullifier: owner }),
      /ValidationFailed/,
    )
  })

  await runCase('3. Root not committed or wrong source', async () => {
    const data = [executeData([ethTransfer(RECEIVER, 1n)])]
    const ref = await refFor(human)
    // The same owner in a larger tree: a valid proof for a root that nobody published.
    const secondLeaf = 12345n
    const grown = await identityRoot(human, secondLeaf)
    const unpublished = { ...ref, root: numberToHex(grown, { size: 32 }) }
    await mustBeRejected(
      'valid proof for an uncommitted root',
      await buildSigned(account, world, data, { rootRefs: [unpublished], secondLeaf }),
      /not committed/,
    )
    await mustBeRejected(
      'committed reference, proof for another root',
      await buildSigned(account, world, data, { secondLeaf }),
      /ValidationFailed/,
    )
    const otherSalt = keccak256(toHex('another source'))
    const otherSource = keccak256(`${d.devKeyAddress}${otherSalt.slice(2)}` as Hex)
    const wrong = await publishRoot(BigInt(ref.root), otherSalt, otherSource)
    await waitForSlotAfter(wrong.slot)
    await mustBeRejected(
      'right root under the wrong source',
      await buildSigned(account, world, data, {
        rootRefs: [{ sourceId: wrong.sourceId, slot: wrong.slot, root: wrong.root }],
      }),
      /ValidationFailed/,
    )
    await mustBeRejected('no reference', await buildSigned(account, world, data, { rootRefs: [] }), /ValidationFailed/)
  })

  await runCase('4. Add a passkey through the queue', async () => {
    const calls = [installModuleCall(account, v[0], passkeyInitData(key1.x, key1.y, false))]
    await callReverts(
      'installModule from a plain tx',
      () =>
        publicClient.simulateContract({
          address: account,
          abi: WaveAccountAbi,
          functionName: 'installModule',
          args: [11n, v[0], '0x'],
          account: d.devKeyAddress,
        }),
      'NotScheduled',
    )
    const out = await mustPass('schedule install', account, world, [scheduleData(KIND_NORMAL, calls, newSalt())])
    const id = scheduledId(out)
    const p = await read<{ notBefore: number; status: number }>(account, 'pendingOf', [id])
    note(`queued ${id}, status ${STATUS[p.status]}, notBefore ${p.notBefore}`)
    await callReverts(
      'execute too early',
      () =>
        publicClient.simulateContract({
          address: account,
          abi: WaveAccountAbi,
          functionName: 'executeScheduled',
          args: [id, encodeBatch(calls)],
          account: d.devKeyAddress,
        }),
      'TooEarly',
    )
    await runQueued('install', account, id, calls)
    check((await read<number>(account, 'methodBitOf', [v[0]])) === passkeyBit(1), 'passkey 1 enrolled with bit 1')
    check((await read<number>(account, 'configVersion')) === 1, 'config version is 1')
    await mustPass('passkey signs a tighten of the ETH rule', account, pk1, [
      tightenData(ETH, [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: WORLD_BIT }]),
    ])
  })

  // Tier 0: passkey or World ID, under 100 USDC, 120 per day. Tier 1: World ID.
  const P1 = passkeyBit(1)
  const P2 = passkeyBit(2)
  const P3 = passkeyBit(3)
  const baseTiers: Tier[] = [
    { upTo: USDC(100) - 1n, cap: USDC(120), delay: 0, period: 86_400, methods: P1 | WORLD_BIT },
    { upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: WORLD_BIT },
  ]
  const usdc = (to: Address, n: number) => executeData([erc20Transfer(d.testUsdc, to, USDC(n))])
  const preview = (validator: Address, n: number) => async () => {
    try {
      await publicClient.readContract({
        address: account,
        abi: WaveAccountAbi,
        functionName: 'checkTransfer',
        args: [validator, d.testUsdc, USDC(n)],
      })
      return 'no revert'
    } catch (e) {
      const err = e as { walk: (fn: (x: unknown) => boolean) => { data?: { errorName?: string } } | undefined }
      return err.walk((x) => (x as { data?: unknown })?.data !== undefined)?.data?.errorName ?? 'unknown'
    }
  }

  await runCase('5. Passkey under 100 USDC, World ID from 100 USDC', async () => {
    const calls = [setTiersCall(account, d.testUsdc, baseTiers)]
    const out = await mustPass('schedule rule', account, world, [scheduleData(KIND_NORMAL, calls, newSalt())])
    await runQueued('rule', account, scheduledId(out), calls)
    const b0 = await usdcBalance(RECEIVER)
    await mustPass('50 USDC by passkey', account, pk1, [usdc(RECEIVER, 50)])
    check((await usdcBalance(RECEIVER)) === b0 + USDC(50), 'receiver got 50')
    check((await preview(v[0], 150)()) === 'MethodNotAllowed', 'checkTransfer preview gives MethodNotAllowed for 150 by passkey')
    await mustFailInFrame('150 USDC by passkey', account, pk1, [usdc(RECEIVER, 150)], 'MethodNotAllowed')
    check((await usdcBalance(RECEIVER)) === b0 + USDC(50), 'receiver balance did not change')
    await mustPass('150 USDC by World ID', account, world, [usdc(RECEIVER, 150)])
    check((await usdcBalance(RECEIVER)) === b0 + USDC(200), 'receiver got 150')
  })

  await runCase('6. Period cap is cumulative across methods', async () => {
    check((await read<bigint>(account, 'spentOf', [d.testUsdc, 0n])) === USDC(50), 'counter holds 50 from case 5')
    await mustPass('50 USDC by World ID, same tier', account, world, [usdc(RECEIVER, 50)])
    check((await read<bigint>(account, 'spentOf', [d.testUsdc, 0n])) === USDC(100), 'counter holds 100')
    await mustFailInFrame('50 USDC by passkey over the cap', account, pk1, [usdc(RECEIVER, 50)], 'MethodNotAllowed')
    await mustPass('20 USDC by passkey fills the cap', account, pk1, [usdc(RECEIVER, 20)])
    check((await read<bigint>(account, 'spentOf', [d.testUsdc, 0n])) === USDC(120), 'counter holds 120')
  })

  await runCase('7. installModule directly as a SENDER frame', async () => {
    const direct = installModuleCall(account, v[1], passkeyInitData(key2.x, key2.y, false)).callData
    await mustBeRejected('by passkey', await buildSigned(account, pk1, [direct]), /SenderFrameNotAllowed/)
    await mustBeRejected('by World ID', await buildSigned(account, world, [direct]), /SenderFrameNotAllowed/)
    await mustFailInFrame(
      'through execute with target self',
      account,
      world,
      [executeData([{ target: account, value: 0n, callData: direct }])],
      'SelfCall',
    )
    // ERC7579Utils runs target 0 as a self-call. It must not reach the 24 hour path.
    const toZero = setOwnerCall(account, 424242n)
    await mustFailInFrame(
      'through execute with target 0',
      account,
      world,
      [executeData([{ ...toZero, target: ETH }])],
      'SelfCall',
    )
    await mustFailInFrame(
      'through schedule with target 0',
      account,
      world,
      [scheduleData(KIND_NORMAL, [{ ...toZero, target: ETH }], newSalt())],
      'NotSchedulable',
    )
    // The signer sets the fee, and no spending rule sees it.
    const send = [executeData([ethTransfer(RECEIVER, 1n)])]
    const gwei = 1_000_000_000n
    for (const [label, fee] of [['fee per gas', 51n * gwei], ['total cost', 40n * gwei]] as const) {
      const fees = { maxFeePerGas: fee, maxPriorityFeePerGas: fee }
      await mustBeRejected(`passkey signs a ${label} above the limit`, await buildSigned(account, pk1, send, { fees }), /FeeTooHigh/)
    }
  })

  await runCase('8. Token approve through the queue, passkey cancels', async () => {
    const calls = [approveCall(RECEIVER)]
    await mustFailInFrame('approve by execute', account, world, [executeData(calls)], 'NeedsQueue')
    await mustFailInFrame('schedule by passkey', account, pk1, [scheduleData(KIND_NORMAL, calls, newSalt())], 'MethodNotAllowed')
    const out = await mustPass('schedule by World ID', account, world, [scheduleData(KIND_NORMAL, calls, newSalt())])
    const id = scheduledId(out)
    await mustPass('cancel by passkey', account, pk1, [cancelData(id)])
    const p = await read<{ status: number; notBefore: number }>(account, 'pendingOf', [id])
    check(STATUS[p.status] === 'cancelled', 'status is cancelled')
    await waitUntil(BigInt(p.notBefore))
    await callReverts(
      'execute after cancel',
      () =>
        publicClient.simulateContract({
          address: account,
          abi: WaveAccountAbi,
          functionName: 'executeScheduled',
          args: [id, encodeBatch(calls)],
          account: d.devKeyAddress,
        }),
      'BadStatus',
    )
    const allowance = await publicClient.readContract({
      address: d.testUsdc,
      abi: TestUSDCAbi,
      functionName: 'allowance',
      args: [account, RECEIVER],
    })
    check(allowance === 0n, 'allowance is still 0')
  })

  await runCase('9. Config version change invalidates a queued action', async () => {
    const stale = [approveCall(RECEIVER)]
    const a = await mustPass('schedule approve', account, world, [scheduleData(KIND_NORMAL, stale, newSalt())])
    const staleId = scheduledId(a)
    const add = [installModuleCall(account, v[1], passkeyInitData(key2.x, key2.y, false))]
    const b = await mustPass('schedule install of passkey 2', account, world, [scheduleData(KIND_NORMAL, add, newSalt())])
    await runQueued('install', account, scheduledId(b), add)
    const p = await read<{ notBefore: number }>(account, 'pendingOf', [staleId])
    await waitUntil(BigInt(p.notBefore))
    await callReverts(
      'execute the older action',
      () =>
        publicClient.simulateContract({
          address: account,
          abi: WaveAccountAbi,
          functionName: 'executeScheduled',
          args: [staleId, encodeBatch(stale)],
          account: d.devKeyAddress,
        }),
      'StaleVersion',
    )
  })

  await runCase('10. Tighten at once, looser tighten rejected, loosen waits', async () => {
    const version = await read<number>(account, 'configVersion')
    const tighter: Tier[] = [{ ...baseTiers[0], upTo: USDC(80) - 1n, cap: USDC(120) }, baseTiers[1]]
    await mustPass('tighten by passkey', account, pk1, [tightenData(d.testUsdc, tighter)])
    const now = await read<readonly Tier[]>(account, 'tiersOf', [d.testUsdc])
    check(now[0].upTo === USDC(80) - 1n, 'upTo is lower at once')
    check((await read<number>(account, 'configVersion')) === version, 'config version did not change')
    await mustFailInFrame(
      'looser tighten by passkey',
      account,
      pk1,
      [tightenData(d.testUsdc, baseTiers)],
      'NotStricter',
    )
    await mustFailInFrame(
      'looser tighten by World ID',
      account,
      world,
      [tightenData(d.testUsdc, baseTiers)],
      'NotStricter',
    )
    const calls = [setTiersCall(account, d.testUsdc, baseTiers)]
    await mustFailInFrame('loosen schedule by passkey', account, pk1, [scheduleData(KIND_NORMAL, calls, newSalt())], 'MethodNotAllowed')
    const out = await mustPass('loosen schedule by World ID', account, world, [scheduleData(KIND_NORMAL, calls, newSalt())])
    const id = scheduledId(out)
    const still = await read<readonly Tier[]>(account, 'tiersOf', [d.testUsdc])
    check(still[0].upTo === USDC(80) - 1n, 'rule did not change yet')
    await callReverts(
      'execute too early',
      () =>
        publicClient.simulateContract({
          address: account,
          abi: WaveAccountAbi,
          functionName: 'executeScheduled',
          args: [id, encodeBatch(calls)],
          account: d.devKeyAddress,
        }),
      'TooEarly',
    )
    await runQueued('loosen', account, id, calls)
    const after = await read<readonly Tier[]>(account, 'tiersOf', [d.testUsdc])
    check(after[0].upTo === USDC(100) - 1n, 'rule is looser after the delay')
    check((await read<number>(account, 'configVersion')) === version + 1, 'config version went up')
  })

  const newHuman = randomIdentity()
  const newWorld: Method = { kind: 'world', identity: newHuman, label: 'new World ID' }

  await runCase('11. Recovery by two passkeys', async () => {
    const newOwner = await nullifierHashOf(newHuman, ext)
    const calls = [setOwnerCall(account, newOwner)]
    await mustFailInFrame('recovery proposed by World ID', account, world, [scheduleData(KIND_RECOVERY, calls, newSalt())], 'MethodNotAllowed')

    const first = await mustPass('passkey 1 proposes', account, pk1, [scheduleData(KIND_RECOVERY, calls, newSalt())])
    const id1 = scheduledId(first)
    await mustPass('passkey 2 approves', account, pk2, [approveRecoveryData(id1)])
    await mustFailInFrame('passkey 2 cancels', account, pk2, [cancelData(id1)], 'OnlyWorldId')
    await mustPass('World ID cancels', account, world, [cancelData(id1)])
    check(STATUS[(await read<{ status: number }>(account, 'pendingOf', [id1])).status] === 'cancelled', 'status is cancelled')

    const second = await mustPass('passkey 2 proposes again', account, pk2, [scheduleData(KIND_RECOVERY, calls, newSalt())])
    const id2 = scheduledId(second)
    await mustPass('same passkey approves, still one method', account, pk2, [approveRecoveryData(id2)])
    check(STATUS[(await read<{ status: number }>(account, 'pendingOf', [id2])).status] === 'collecting', 'still collecting')
    await mustPass('passkey 1 approves', account, pk1, [approveRecoveryData(id2)])
    check(STATUS[(await read<{ status: number }>(account, 'pendingOf', [id2])).status] === 'queued', 'queued')
    await runQueued('recovery', account, id2, calls)
    check((await read<bigint>(account, 'ownerNullifier')) === newOwner, 'owner nullifier changed')
    const data = [executeData([ethTransfer(RECEIVER, 1n)])]
    await mustBeRejected('old World ID', await buildSigned(account, world, data), /ValidationFailed/)
    await mustPass('new World ID', account, newWorld, data)
  })

  await runCase('12. Synced passkey cannot approve a non-small tier', async () => {
    const calls = [
      installModuleCall(account, v[2], passkeyInitData(key3.x, key3.y, true)),
      setTiersCall(account, d.testUsdc, [
        { upTo: USDC(10), cap: 0n, delay: 0, period: 0, methods: P3 | P1 | SMALL_TIER },
        { upTo: USDC(1000), cap: 0n, delay: 0, period: 0, methods: P3 | P1 | P2 },
      ]),
    ]
    const out = await mustPass('schedule install and rule', account, newWorld, [scheduleData(KIND_NORMAL, calls, newSalt())])
    await runQueued('install', account, scheduledId(out), calls)
    check((await read<number>(account, 'syncedMask')) === P3, 'synced mask holds passkey 3')
    await mustPass('5 USDC in the small tier by synced passkey', account, pk3, [usdc(RECEIVER, 5)])
    await mustFailInFrame('50 USDC by synced passkey', account, pk3, [usdc(RECEIVER, 50)], 'SyncedNotAllowed')
    await mustPass('50 USDC by device-bound passkey', account, pk1, [usdc(RECEIVER, 50)])
  })

  await runCase('13. A wallet with no ETH runs on the sponsor', async () => {
    const human2 = randomIdentity()
    const poor = await makeWallet('no-eth', human2, 0n)
    await sponsorDeploys(poor)
    const stationBefore = await publicClient.getBalance({ address: sponsor.station })
    const first = await mustPass('first transfer, first use of the nonce key', poor.account, poor.world, [usdc(RECEIVER, 2)])
    await mustPass('second transfer, the same nonce key', poor.account, poor.world, [usdc(RECEIVER, 3)])
    const stationAfter = await publicClient.getBalance({ address: sponsor.station })
    check((await publicClient.getBalance({ address: poor.account })) === 0n, 'the wallet still holds 0 ETH')
    check(stationAfter < stationBefore, `the station paid ${stationBefore - stationAfter} wei`)
    check((await keyedNonce(poor.account, d.worldIdValidator)) === 2n, 'the keyed nonce moved twice')
    note(`frame gas ${JSON.stringify(first.frames)}`)
  })

  await runCase('14. The gas station pays only with the sponsor signature', async () => {
    const data = [usdc(RECEIVER, 1)]
    await mustBeRejected(
      'no sponsor signature',
      await buildSigned(account, pk1, data, { noSponsorSignature: true }),
      /signature|Invalid/i,
    )
    await mustBeRejected(
      'the entry names the sponsor, another key signed',
      await buildSigned(account, pk1, data, { wrongSponsorKey: true }),
      /signature|Invalid/i,
    )
    await mustBeRejected(
      'another signer',
      await buildSigned(account, pk1, data, { otherSponsor: true }),
      /NotSponsored/,
    )
  })

  await runCase('15. The devnet shape still works: self-paid, deploy frame', async () => {
    const human3 = randomIdentity()
    const self = await makeWallet('self-paid', human3)
    const before = await publicClient.getBalance({ address: self.account })
    await mustPass('deploy and transfer', self.account, self.world, [executeData([ethTransfer(RECEIVER, 1n)])], {
      selfPaid: true,
      deploy: { factory: d.factory, implementation: d.implementation, args: self.args, salt: self.salt },
    })
    const after = await publicClient.getBalance({ address: self.account })
    check(after < before - 1n, `the wallet paid ${before - after - 1n} wei of gas`)
  })

  console.log('\n=== VERIFY gas')
  for (const [k, list] of Object.entries(gas)) {
    console.log(`${k}: min ${Math.min(...list)}, max ${Math.max(...list)}, n ${list.length}`)
  }
  console.log('\n=== Summary')
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}`)
  const failed = results.filter((r) => !r.pass).length
  console.log(`${results.length - failed} of ${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
