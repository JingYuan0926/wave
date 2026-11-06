// Runs the WAVE cases against the live local stack, with real frame transactions, real
// Groth16 proofs from a dev test identity and a software P-256 WebAuthn authenticator.
// Prints PASS or FAIL with transaction hashes. Exit code 1 if a case fails.
// Prerequisites: devnet/up.sh, contracts deployed, scripts/fetch-zk.sh.
import { encodeFunctionData, keccak256, numberToHex, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { NO_WAIT, buildWallet } from '../lib/account'
import { tiersAfterRemoval } from '../lib/limits'
import type { PasskeySlot, WalletPlan } from '../lib/api-types'
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
  OWNER_BIT,
  SMALL_TIER,
  STATUS,
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
  setOwnerKeyCall,
  setTiersCall,
  tightenData,
  uninstallModuleCall,
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
const found = sponsorOf(d)
if (!found) throw new Error('These cases run on the local network, with the gas station deployed.')
const sponsor = found
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

type Wallet = { account: Address; args: Hex; salt: Hex; setup: Hex; world: Method & { kind: 'world' } }

/** The local network deploys a wallet with a plain sponsor transaction. */
async function sponsorDeploys(w: Pick<Wallet, 'args' | 'salt' | 'setup'>) {
  const data = encodeFunctionData({
    abi: WaveAccountFactoryAbi,
    functionName: 'createAccount',
    args: [d.implementation, w.args, w.salt, w.setup],
  })
  const { hash, status } = await plainTx(d.factory, data, 0n, w.setup === '0x' ? 1_500_000n : 6_000_000n)
  if (status !== 'success') throw new Error(`deploy failed ${hash}`)
  return hash
}

type Planned = { account: Address; args: Hex; salt: Hex; setup: Hex }

/** A wallet from a plan, the same way that the app builds it. It holds test USDC and no ETH. */
async function plannedWallet(plan: WalletPlan, ethFunds = 0n): Promise<Planned> {
  const built = buildWallet({ contracts: d, plan, demoDelay: DEMO_DELAY, externalNullifierHash: ext, rootSourceId: d.rootSourceId })
  const account = await publicClient.readContract({
    address: d.factory,
    abi: WaveAccountFactoryAbi,
    functionName: 'predict',
    args: [d.implementation, built.args, built.salt],
  })
  if (ethFunds > 0n) await plainTx(account, '0x', ethFunds, 600_000n)
  const mint = encodeFunctionData({ abi: TestUSDCAbi, functionName: 'mint', args: [account, USDC(10_000)] })
  if ((await plainTx(d.testUsdc, mint, 0n, 500_000n)).status !== 'success') throw new Error('mint failed')
  return { account, args: built.args, salt: built.salt, setup: built.setup }
}

const keyFacts = (key: SoftPasskey) => ({ publicKey: { x: key.x, y: key.y }, backupEligible: key.backupEligible })
const passkeyMethod = (key: SoftPasskey, slot: PasskeySlot, label: string): Method => ({ kind: 'passkey', key, slot, label })
const LIMIT = USDC(100).toString()
/** The creation screen's "A limit, then a stronger method": extra method 1 up to the limit, then the owner. */
const limitOf = (amount: string): NonNullable<WalletPlan['sends']> => ({ kind: 'limit', amount, perDay: null, lower: 1, upper: 0 })

async function makeWallet(tag: string, identity: TestIdentity, ethFunds = 5n * 10n ** 18n): Promise<Wallet> {
  const owner = await nullifierHashOf(identity, ext)
  const { args } = buildWallet({
    contracts: d,
    plan: { owner: { kind: 'world', nullifierHash: numberToHex(owner, { size: 32 }) }, extras: [] },
    demoDelay: DEMO_DELAY,
    externalNullifierHash: ext,
    rootSourceId: d.rootSourceId,
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
  return { account, args, salt, setup: '0x', world: { kind: 'world', identity, label: 'World ID' } }
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
      tightenData(ETH, [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: OWNER_BIT }], 0n),
    ])
  })

  // Tier 0: passkey or World ID, under 100 USDC, 120 per day. Tier 1: World ID.
  const P1 = passkeyBit(1)
  const P2 = passkeyBit(2)
  const P3 = passkeyBit(3)
  const baseTiers: Tier[] = [
    { upTo: USDC(100) - 1n, cap: USDC(120), delay: 0, period: 86_400, methods: P1 | OWNER_BIT },
    { upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: OWNER_BIT },
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
    const calls = [setTiersCall(account, d.testUsdc, baseTiers, 0n)]
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
    await mustPass('tighten by passkey', account, pk1, [tightenData(d.testUsdc, tighter, 0n)])
    const now = await read<readonly Tier[]>(account, 'tiersOf', [d.testUsdc])
    check(now[0].upTo === USDC(80) - 1n, 'upTo is lower at once')
    check((await read<number>(account, 'configVersion')) === version, 'config version did not change')
    await mustFailInFrame(
      'looser tighten by passkey',
      account,
      pk1,
      [tightenData(d.testUsdc, baseTiers, 0n)],
      'NotStricter',
    )
    await mustFailInFrame(
      'looser tighten by World ID',
      account,
      world,
      [tightenData(d.testUsdc, baseTiers, 0n)],
      'NotStricter',
    )
    const calls = [setTiersCall(account, d.testUsdc, baseTiers, 0n)]
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
    await mustFailInFrame('passkey 2 cancels', account, pk2, [cancelData(id1)], 'OnlyOwnerMethod')
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
      ], 0n),
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
      deploy: { factory: d.factory, implementation: d.implementation, args: self.args, salt: self.salt, setup: '0x' },
    })
    const after = await publicClient.getBalance({ address: self.account })
    check(after < before - 1n, `the wallet paid ${before - after - 1n} wei of gas`)
  })

  const usdcAt = (to: Address, n: number) => executeData([erc20Transfer(d.testUsdc, to, USDC(n))])

  await runCase('16. Passkey only: no World ID anywhere, a stranger cannot act', async () => {
    // A synced key: the owner bit is a full method, so synced status must not limit it.
    const ownerKey = new SoftPasskey(true)
    const strangerKey = new SoftPasskey(true)
    const second = new SoftPasskey()
    const owner = passkeyMethod(ownerKey, 1, 'owner passkey')
    const stranger = passkeyMethod(strangerKey, 1, 'stranger key')
    const w16 = await plannedWallet({ owner: { kind: 'passkey', ...keyFacts(ownerKey) }, extras: [] })
    check(w16.setup === '0x', 'a one-method wallet has no setup bytes')
    check((w16.args.length - 2) / 2 === 123, 'the clone config has the same 123 bytes as a World ID wallet')
    note(`deploy tx ${await sponsorDeploys(w16)}`)
    check((await read<Address>(w16.account, 'ownerValidator')).toLowerCase() === v[0].toLowerCase(), 'the clone names the passkey validator')
    check((await read<number>(w16.account, 'methodBitOf', [v[0]])) === OWNER_BIT, 'the owner passkey has the owner bit')
    check((await read<number>(w16.account, 'methodBitOf', [d.worldIdValidator])) === 0, 'World ID is not a method of this wallet')
    const b0 = await usdcBalance(RECEIVER)
    await mustPass('5000 USDC by the synced owner passkey, default rule', w16.account, owner, [usdcAt(RECEIVER, 5000)])
    check((await usdcBalance(RECEIVER)) === b0 + USDC(5000), 'receiver got 5000')
    await mustPass('tighten by the owner passkey', w16.account, owner, [
      tightenData(ETH, [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: OWNER_BIT }], 0n),
    ])
    const send = [executeData([ethTransfer(RECEIVER, 0n)])]
    await mustBeRejected('a stranger key on the same validator', await buildSigned(w16.account, stranger, send), /ValidationFailed/)

    const calls = [
      installModuleCall(w16.account, v[1], passkeyInitData(second.x, second.y, false)),
      setTiersCall(w16.account, d.testUsdc, [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: OWNER_BIT }], 0n),
    ]
    await mustBeRejected(
      'a stranger key queues a config change',
      await buildSigned(w16.account, stranger, [scheduleData(KIND_NORMAL, calls, newSalt())]),
      /ValidationFailed/,
    )
    const out = await mustPass('the owner passkey queues a config change', w16.account, owner, [scheduleData(KIND_NORMAL, calls, newSalt())])
    const id = scheduledId(out)
    const p = await read<{ notBefore: number; status: number }>(w16.account, 'pendingOf', [id])
    check(STATUS[p.status] === 'queued', 'the change is queued')
    await callReverts(
      'execute too early',
      () => publicClient.simulateContract({ address: w16.account, abi: WaveAccountAbi, functionName: 'executeScheduled', args: [id, encodeBatch(calls)], account: d.devKeyAddress }),
      'TooEarly',
    )
    await runQueued('config change', w16.account, id, calls)
    check((await read<number>(w16.account, 'methodBitOf', [v[1]])) === passkeyBit(2), 'the new passkey has bit 2')
    await mustPass('600 USDC in a tier with no small mark, by the synced owner', w16.account, owner, [usdcAt(RECEIVER, 600)])
    await mustFailInFrame(
      'the new passkey cannot remove the owner',
      w16.account,
      passkeyMethod(second, 2, 'new passkey'),
      [scheduleData(KIND_NORMAL, [uninstallModuleCall(w16.account, v[0])], newSalt())],
      'MethodNotAllowed',
    )
  })

  await runCase('17. Passkey only, devnet shape: self-paid, deploy frame, no World ID', async () => {
    const ownerKey = new SoftPasskey()
    const owner = passkeyMethod(ownerKey, 1, 'owner passkey')
    const self = await plannedWallet({ owner: { kind: 'passkey', ...keyFacts(ownerKey) }, extras: [] }, 5n * 10n ** 18n)
    await mustPass('deploy and transfer', self.account, owner, [usdcAt(RECEIVER, 1)], {
      selfPaid: true,
      deploy: { factory: d.factory, implementation: d.implementation, ...self },
    })
    check((await read<number>(self.account, 'methodBitOf', [v[0]])) === OWNER_BIT, 'the first transaction deployed the wallet')
  })

  let mixed: Planned
  const mixedKey = new SoftPasskey(true)

  await runCase('18. World ID plus passkey: no proof under the limit, refused above it', async () => {
    const person = randomIdentity()
    const owner = await nullifierHashOf(person, ext)
    const worldM: Method = { kind: 'world', identity: person, label: 'World ID' }
    const pk = passkeyMethod(mixedKey, 1, 'synced extra passkey')
    mixed = await plannedWallet({
      owner: { kind: 'world', nullifierHash: numberToHex(owner, { size: 32 }) },
      extras: [keyFacts(mixedKey)],
      sends: limitOf(LIMIT),
    })
    note(`deploy tx ${await sponsorDeploys(mixed)}`)
    check((await read<number>(mixed.account, 'methodBitOf', [v[0]])) === passkeyBit(1), 'the setup enrolled the passkey')
    check((await read<number>(mixed.account, 'syncedMask')) === passkeyBit(1), 'the setup read the synced flag')
    check((await read<number>(mixed.account, 'configVersion')) === 0, 'the setup left the config version at 0')
    const b0 = await usdcBalance(RECEIVER)
    const first = await mustPass('100 USDC by passkey, at once, no proof', mixed.account, pk, [usdcAt(RECEIVER, 100)])
    check(first.frames.every((frame) => frame.ok), 'one transaction, no queue')
    check((await usdcBalance(RECEIVER)) === b0 + USDC(100), 'receiver got 100 with no queue')
    await mustFailInFrame('100.5 USDC by passkey', mixed.account, pk, [executeData([erc20Transfer(d.testUsdc, RECEIVER, USDC(100.5))])], 'MethodNotAllowed')
    await mustPass('150 USDC by World ID', mixed.account, worldM, [usdcAt(RECEIVER, 150)])
    const tiersNow = await read<readonly Tier[]>(mixed.account, 'tiersOf', [d.testUsdc])
    await mustFailInFrame(
      'the passkey cannot queue a rule change',
      mixed.account,
      pk,
      [scheduleData(KIND_NORMAL, [setTiersCall(mixed.account, d.testUsdc, [...tiersNow], 0n)], newSalt())],
      'MethodNotAllowed',
    )
  })

  await runCase('19. Passkey plus security key: the key owns, the passkey has a limit', async () => {
    const keyOwner = new SoftPasskey()
    const device = new SoftPasskey(true)
    const owner = passkeyMethod(keyOwner, 1, 'security key owner')
    const extra = passkeyMethod(device, 2, 'extra passkey')
    const w19 = await plannedWallet({
      owner: { kind: 'passkey', ...keyFacts(keyOwner) },
      extras: [keyFacts(device)],
      sends: limitOf(USDC(50).toString()),
    })
    await sponsorDeploys(w19)
    await mustPass('50 USDC by the extra passkey', w19.account, extra, [usdcAt(RECEIVER, 50)])
    await mustFailInFrame('51 USDC by the extra passkey', w19.account, extra, [usdcAt(RECEIVER, 51)], 'MethodNotAllowed')
    await mustPass('51 USDC by the owner key', w19.account, owner, [usdcAt(RECEIVER, 51)])
    await mustFailInFrame(
      'the extra passkey cannot propose a config change',
      w19.account,
      extra,
      [scheduleData(KIND_NORMAL, [uninstallModuleCall(w19.account, v[0])], newSalt())],
      'MethodNotAllowed',
    )
  })

  await runCase('20. A tampered setup is refused', async () => {
    const ownerKey = new SoftPasskey()
    const honest = new SoftPasskey()
    const thief = new SoftPasskey()
    const owner = { kind: 'passkey' as const, ...keyFacts(ownerKey) }
    const sends = limitOf(LIMIT)
    const plan: WalletPlan = { owner, extras: [keyFacts(honest)], sends }
    const good = await plannedWallet(plan)
    const swap = (extras: WalletPlan['extras'], changed: WalletPlan['sends'] = sends) =>
      buildWallet({ contracts: d, plan: { owner, extras, sends: changed }, demoDelay: DEMO_DELAY, externalNullifierHash: ext, rootSourceId: d.rootSourceId }).setup
    const create = (args: Hex, setup: Hex) => () =>
      publicClient.simulateContract({
        address: d.factory,
        abi: WaveAccountFactoryAbi,
        functionName: 'createAccount',
        args: [d.implementation, args, good.salt, setup],
        account: d.devKeyAddress,
        gas: 6_000_000n,
      })
    const refused = async (label: string, args: Hex, setup: Hex, reason: string) => {
      let text = 'no revert'
      await create(args, setup)().catch((e: Error) => (text = e.message))
      check(text.includes(reason), `${label}: refused with "${reason}"`)
    }
    await refused('a higher limit', good.args, swap([keyFacts(honest)], limitOf(USDC(1_000_000).toString())), 'setup refused')
    await refused("a stranger's key", good.args, swap([keyFacts(thief)]), 'setup refused')
    await refused('no setup bytes', good.args, '0x', 'setup refused')
    const bare = `0x${good.args.slice(2, 2 + 123 * 2)}` as Hex
    await refused('setup bytes with no hash in the config', bare, good.setup, 'no setup hash')
    const hash = await sponsorDeploys(good)
    note(`the honest setup deploys: ${hash}`)
    check((await read<number>(good.account, 'methodBitOf', [v[1]])) === passkeyBit(2), 'the committed key is enrolled')
  })

  await runCase('21. A method cannot join after creation without the queue', async () => {
    const pk = passkeyMethod(mixedKey, 1, 'extra passkey')
    const thief = new SoftPasskey()
    const setupArgs = [
      [{ validator: v[1], initData: passkeyInitData(thief.x, thief.y, false) }],
      [{ token: d.testUsdc, tiers: [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: passkeyBit(2) }], dailyLimit: 0n }],
    ] as const
    const replay = encodeFunctionData({ abi: WaveAccountAbi, functionName: 'setup', args: setupArgs })
    await callReverts(
      'setup again from a plain tx',
      () => publicClient.simulateContract({ address: mixed.account, abi: WaveAccountAbi, functionName: 'setup', args: setupArgs, account: d.devKeyAddress }),
      'AlreadySetUp',
    )
    await callReverts(
      'the committed setup again',
      () => publicClient.call({ to: mixed.account, data: `${replay.slice(0, 10)}${mixed.setup.slice(2)}` as Hex, account: d.devKeyAddress }),
      'AlreadySetUp',
    )
    await mustBeRejected('setup as a SENDER frame', await buildSigned(mixed.account, pk, [replay]), /SenderFrameNotAllowed/)
    await mustFailInFrame('setup through execute', mixed.account, pk, [executeData([{ target: mixed.account, value: 0n, callData: replay }])], 'SelfCall')
    await callReverts(
      'installModule from a plain tx',
      () => publicClient.simulateContract({ address: mixed.account, abi: WaveAccountAbi, functionName: 'installModule', args: [11n, v[1], passkeyInitData(thief.x, thief.y, false)], account: d.devKeyAddress }),
      'NotScheduled',
    )
    check((await read<number>(mixed.account, 'methodBitOf', [v[1]])) === 0, 'no new method')
  })

  await runCase('22. A World ID only wallet from a plan still works', async () => {
    const person = randomIdentity()
    const owner = await nullifierHashOf(person, ext)
    const only = await plannedWallet({ owner: { kind: 'world', nullifierHash: numberToHex(owner, { size: 32 }) }, extras: [] })
    check((only.args.length - 2) / 2 === 123 && only.setup === '0x', 'the same 123 config bytes and no setup')
    await sponsorDeploys(only)
    await mustPass('2 USDC by World ID', only.account, { kind: 'world', identity: person, label: 'World ID' }, [usdcAt(RECEIVER, 2)])
  })

  await runCase('23. Recovery of an owner passkey with two other methods', async () => {
    const lost = new SoftPasskey(true)
    const one = new SoftPasskey()
    const two = new SoftPasskey()
    const fresh = new SoftPasskey()
    const old = passkeyMethod(lost, 1, 'old owner passkey')
    const m1 = passkeyMethod(one, 2, 'device-bound method A')
    const m2 = passkeyMethod(two, 3, 'device-bound method B')
    const w23 = await plannedWallet({
      owner: { kind: 'passkey', ...keyFacts(lost) },
      extras: [keyFacts(one), keyFacts(two)],
      sends: limitOf(LIMIT),
    })
    await sponsorDeploys(w23)
    const calls = [setOwnerKeyCall(w23.account, passkeyInitData(fresh.x, fresh.y, false))]
    await mustFailInFrame('the owner cannot propose', w23.account, old, [scheduleData(KIND_RECOVERY, calls, newSalt())], 'MethodNotAllowed')
    const first = await mustPass('method A proposes', w23.account, m1, [scheduleData(KIND_RECOVERY, calls, newSalt())])
    const id1 = scheduledId(first)
    await mustPass('method B approves', w23.account, m2, [approveRecoveryData(id1)])
    await mustFailInFrame('method B cannot cancel', w23.account, m2, [cancelData(id1)], 'OnlyOwnerMethod')
    await mustPass('the owner cancels', w23.account, old, [cancelData(id1)])
    const again = await mustPass('method B proposes again', w23.account, m2, [scheduleData(KIND_RECOVERY, calls, newSalt())])
    const id2 = scheduledId(again)
    await mustPass('method A approves', w23.account, m1, [approveRecoveryData(id2)])
    await runQueued('recovery', w23.account, id2, calls)
    const data = [executeData([ethTransfer(RECEIVER, 0n)])]
    await mustBeRejected('the old owner passkey', await buildSigned(w23.account, old, data), /ValidationFailed/)
    await mustPass('600 USDC by the new owner passkey', w23.account, passkeyMethod(fresh, 1, 'new owner passkey'), [usdcAt(RECEIVER, 600)])

    const worldCall = [setOwnerCall(w23.account, 42n)]
    const q = await mustPass('a queued World ID owner change', w23.account, passkeyMethod(fresh, 1, 'new owner passkey'), [scheduleData(KIND_NORMAL, worldCall, newSalt())])
    const qId = scheduledId(q)
    const row = await read<{ notBefore: number }>(w23.account, 'pendingOf', [qId])
    await waitUntil(BigInt(row.notBefore))
    await callReverts(
      'setOwner cannot run on a passkey owner',
      () => publicClient.simulateContract({ address: w23.account, abi: WaveAccountAbi, functionName: 'executeScheduled', args: [qId, encodeBatch(worldCall)], account: d.devKeyAddress }),
      'WrongOwnerKind',
    )
  })

  await runCase('24. Measurement: a setup in a self-paid deploy frame', async () => {
    const ownerKey = new SoftPasskey()
    const extraKey = new SoftPasskey()
    const owner = passkeyMethod(ownerKey, 1, 'owner passkey')
    const self = await plannedWallet(
      { owner: { kind: 'passkey', ...keyFacts(ownerKey) }, extras: [keyFacts(extraKey)], sends: limitOf(LIMIT) },
      5n * 10n ** 18n,
    )
    for (const state of [400_000n, 2_000_000n]) {
      const tx = await buildSigned(self.account, owner, [usdcAt(RECEIVER, 1)], {
        selfPaid: true,
        deploy: { factory: d.factory, implementation: d.implementation, ...self, state },
      })
      const sim = await simulate(tx).catch((e: Error) => ({ executionError: e.message }) as Simulation)
      let sidecar = ''
      try {
        sidecar = `ADMITTED ${await sendToSidecar(tx)}`
      } catch (e) {
        sidecar = (e as Error).message
      }
      note(`frame state ${state}: sim ${JSON.stringify({ err: sim.executionError, halt: sim.haltReason, frame: sim.failedFrameIndex })}, sidecar: ${sidecar.slice(0, 160)}`)
    }
  })

  await runCase('25. No wait: a loosen applies with one approval', async () => {
    const ownerKey = new SoftPasskey()
    const owner = passkeyMethod(ownerKey, 1, 'owner passkey')
    const w25 = await plannedWallet({ owner: { kind: 'passkey', ...keyFacts(ownerKey) }, extras: [], wait: 0 })
    await sponsorDeploys(w25)
    check((await read<number>(w25.account, 'demoDelay')) === NO_WAIT, 'the clone holds NO_WAIT')
    const strict: Tier[] = [{ upTo: USDC(10), cap: 0n, delay: 0, period: 0, methods: OWNER_BIT }]
    await mustPass('tighten first', w25.account, owner, [tightenData(d.testUsdc, strict, 0n)])
    const looser: Tier[] = [{ upTo: USDC(500), cap: 0n, delay: 0, period: 0, methods: OWNER_BIT }]
    const calls = [setTiersCall(w25.account, d.testUsdc, looser, 0n)]
    const out = await mustPass('one approval queues the loosen', w25.account, owner, [scheduleData(KIND_NORMAL, calls, newSalt())])
    const id = scheduledId(out)
    const { hash, status } = await plainTx(w25.account, executeScheduledData(id, calls), 0n, 8_000_000n)
    check(status === 'success', `the loosen ran with no second approval: ${hash}`)
    const now = await read<readonly Tier[]>(w25.account, 'tiersOf', [d.testUsdc])
    check(now[0].upTo === USDC(500), 'the looser rule is live')
    await mustPass('300 USDC under the looser rule', w25.account, owner, [usdcAt(RECEIVER, 300)])
  })

  await runCase('26. A 1-hour wait still refuses an early run', async () => {
    const ownerKey = new SoftPasskey()
    const owner = passkeyMethod(ownerKey, 1, 'owner passkey')
    const w26 = await plannedWallet({ owner: { kind: 'passkey', ...keyFacts(ownerKey) }, extras: [], wait: 3600 })
    await sponsorDeploys(w26)
    check((await read<number>(w26.account, 'effectiveDelay', [172_800])) === 3600, 'a 48 hour rule waits 1 hour here')
    const calls = [setTiersCall(w26.account, d.testUsdc, [{ upTo: USDC(500), cap: 0n, delay: 0, period: 0, methods: OWNER_BIT }], 0n)]
    const out = await mustPass('queue the change', w26.account, owner, [scheduleData(KIND_NORMAL, calls, newSalt())])
    const id = scheduledId(out)
    const p = await read<{ notBefore: number; createdAt: number }>(w26.account, 'pendingOf', [id])
    check(p.notBefore - p.createdAt === 3600, 'the action waits 3600 seconds')
    await callReverts(
      'run before the wait ends',
      () => publicClient.simulateContract({ address: w26.account, abi: WaveAccountAbi, functionName: 'executeScheduled', args: [id, encodeBatch(calls)], account: d.devKeyAddress }),
      'TooEarly',
    )
  })

  await runCase('27. No wait does not remove a tier delay that the owner set', async () => {
    const ownerKey = new SoftPasskey()
    const owner = passkeyMethod(ownerKey, 1, 'owner passkey')
    const w27 = await plannedWallet({ owner: { kind: 'passkey', ...keyFacts(ownerKey) }, extras: [], wait: 0 })
    await sponsorDeploys(w27)
    const tiers: Tier[] = [{ upTo: NO_LIMIT, cap: 0n, delay: 3600, period: 0, methods: OWNER_BIT }]
    const set = [setTiersCall(w27.account, d.testUsdc, tiers, 0n)]
    const queued = await mustPass('queue the rule', w27.account, owner, [scheduleData(KIND_NORMAL, set, newSalt())])
    await plainTx(w27.account, executeScheduledData(scheduledId(queued), set), 0n, 8_000_000n)
    const send = [erc20Transfer(d.testUsdc, RECEIVER, USDC(5))]
    await mustFailInFrame('the transfer cannot skip the queue', w27.account, owner, [executeData(send)], 'NeedsSchedule')
    const out = await mustPass('the transfer goes to the queue', w27.account, owner, [scheduleData(KIND_NORMAL, send, newSalt())])
    const p = await read<{ notBefore: number; createdAt: number }>(w27.account, 'pendingOf', [scheduledId(out)])
    check(p.notBefore - p.createdAt === 3600, 'the tier delay of 1 hour stands')
    await callReverts(
      'run before the tier delay ends',
      () => publicClient.simulateContract({ address: w27.account, abi: WaveAccountAbi, functionName: 'executeScheduled', args: [scheduledId(out), encodeBatch(send)], account: d.devKeyAddress }),
      'TooEarly',
    )
  })

  await runCase('28. A large send keeps its approver after a removal', async () => {
    const OWNER_AND_EXTRA = passkeyBit(2) | OWNER_BIT
    const ownerKey = new SoftPasskey()
    const extraKey = new SoftPasskey()
    const owner = passkeyMethod(ownerKey, 1, 'owner passkey')
    const extra = passkeyMethod(extraKey, 2, 'extra method')
    const plan = (sends: WalletPlan['sends'], key = ownerKey): WalletPlan => ({
      owner: { kind: 'passkey', ...keyFacts(key) },
      extras: [keyFacts(extraKey)],
      wait: 0,
      sends,
    })
    const remove = async (account: Address, calls: Call[], by = owner) => {
      const out = await mustPass('the owner queues the removal', account, by, [scheduleData(KIND_NORMAL, calls, newSalt())])
      await runQueued('removal', account, scheduledId(out), calls)
    }

    const every = await plannedWallet(plan({ kind: 'every', method: 1 }))
    await sponsorDeploys(every)
    const everyTiers = await read<readonly Tier[]>(every.account, 'tiersOf', [d.testUsdc])
    check(everyTiers.length === 1 && everyTiers[0].methods === OWNER_AND_EXTRA, 'every send: the rule holds the owner method too')
    await mustPass('600 USDC by the extra method', every.account, extra, [usdcAt(RECEIVER, 600)])
    await mustPass('600 USDC by the owner method', every.account, owner, [usdcAt(RECEIVER, 600)])
    await remove(every.account, [uninstallModuleCall(every.account, v[1])])
    check((await read<number>(every.account, 'methodBitOf', [v[1]])) === 0, 'the extra method is gone')
    await mustPass('600 USDC by the owner method after the removal', every.account, owner, [usdcAt(RECEIVER, 600)])

    const limit = await plannedWallet(plan({ kind: 'limit', amount: LIMIT, perDay: null, lower: 0, upper: 1 }))
    await sponsorDeploys(limit)
    const limitTiers = await read<readonly Tier[]>(limit.account, 'tiersOf', [d.testUsdc])
    check(
      limitTiers.length === 2 && limitTiers[0].methods === OWNER_BIT && limitTiers[1].methods === OWNER_AND_EXTRA,
      'a limit: the last step holds the owner method too',
    )
    check(limitTiers[0].cap === 0n && limitTiers[0].period === 0, 'no step holds a total')
    await mustPass('100 USDC by the owner method', limit.account, owner, [usdcAt(RECEIVER, 100)])
    await mustPass('150 USDC above the limit, by the extra method', limit.account, extra, [usdcAt(RECEIVER, 150)])
    await remove(limit.account, [uninstallModuleCall(limit.account, v[1])])
    await mustPass('600 USDC by the owner method after the removal', limit.account, owner, [usdcAt(RECEIVER, 600)])

    // An older rule, or a tighten, can name the extra method alone.
    const oldKey = new SoftPasskey()
    const oldOwner = passkeyMethod(oldKey, 1, 'owner passkey of the older rule')
    const old = await plannedWallet(plan({ kind: 'every', method: 1 }, oldKey))
    await sponsorDeploys(old)
    const alone: Tier[] = [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: passkeyBit(2) }]
    await mustPass('a tighten leaves the extra method alone', old.account, extra, [tightenData(d.testUsdc, alone, 0n)])
    await mustFailInFrame('the owner method is out of the rule', old.account, oldOwner, [usdcAt(RECEIVER, 5)], 'MethodNotAllowed')
    const tiers = await read<readonly Tier[]>(old.account, 'tiersOf', [d.testUsdc])
    const fixed = tiersAfterRemoval(tiers, passkeyBit(2), await read<number>(old.account, 'enrolledMask'), await read<number>(old.account, 'syncedMask'))
    check(fixed?.[0].methods === OWNER_BIT, 'the app repairs the rule that would have no approver')
    await remove(old.account, [setTiersCall(old.account, d.testUsdc, fixed as Tier[], 0n), uninstallModuleCall(old.account, v[1])], oldOwner)
    check((await read<number>(old.account, 'methodBitOf', [v[1]])) === 0, 'one action removed the method')
    await mustPass('600 USDC by the owner method after the repair', old.account, oldOwner, [usdcAt(RECEIVER, 600)])
  })

  await runCase('29. The daily limit stops every method', async () => {
    const identity = randomIdentity()
    const nullifier = await nullifierHashOf(identity, ext)
    const world: Method = { kind: 'world', identity, label: 'World ID' }
    const key = new SoftPasskey()
    const passkey = passkeyMethod(key, 1, 'extra passkey')
    const w = await plannedWallet({
      owner: { kind: 'world', nullifierHash: numberToHex(nullifier, { size: 32 }) },
      extras: [keyFacts(key)],
      sends: { kind: 'limit', amount: LIMIT, perDay: USDC(300).toString(), lower: 1, upper: 0 },
    })
    await sponsorDeploys(w)
    const daily = () => read<readonly [bigint, bigint, bigint, number]>(w.account, 'dailyOf', [d.testUsdc])
    const tiers = [...(await read<readonly Tier[]>(w.account, 'tiersOf', [d.testUsdc]))]
    check((await daily())[0] === USDC(300), 'the creation setup set the limit, and the address commits to it')
    check(tiers[0].cap === 0n && tiers[0].period === 0, 'the limit is not a tier cap')

    await mustPass('a send under the limit, by the passkey', w.account, passkey, [usdcAt(RECEIVER, 100)])
    check((await daily())[2] === USDC(200), '200 USDC left')

    await mustPass('a lower limit applies at once, by the passkey', w.account, passkey, [tightenData(d.testUsdc, tiers, USDC(150))])
    const lowered = await daily()
    check(lowered[0] === USDC(150) && lowered[2] === USDC(50), `the limit is 150 USDC and ${lowered[2]} is left`)
    await callReverts(
      'the preview refuses 60 USDC',
      () => read(w.account, 'checkTransfer', [d.worldIdValidator, d.testUsdc, USDC(60)]),
      'DailyLimitReached',
    )
    await mustFailInFrame('60 USDC after the lower limit, by the passkey', w.account, passkey, [usdcAt(RECEIVER, 60)], 'DailyLimitReached')
    await mustPass('the last 50 USDC, by the passkey', w.account, passkey, [usdcAt(RECEIVER, 50)])

    const before = await usdcBalance(RECEIVER)
    await mustFailInFrame('1 USDC after the limit, by the passkey', w.account, passkey, [usdcAt(RECEIVER, 1)], 'DailyLimitReached')
    await mustFailInFrame('1 USDC after the limit, by World ID', w.account, world, [usdcAt(RECEIVER, 1)], 'DailyLimitReached')
    await mustFailInFrame('150 USDC after the limit, by World ID', w.account, world, [usdcAt(RECEIVER, 150)], 'DailyLimitReached')
    check((await usdcBalance(RECEIVER)) === before, 'no token moved after the limit')

    await mustFailInFrame('a higher limit in a tighten, by World ID', w.account, world, [tightenData(d.testUsdc, tiers, USDC(500))], 'NotStricter')
    await mustFailInFrame('no limit in a tighten, by the passkey', w.account, passkey, [tightenData(d.testUsdc, tiers, 0n)], 'NotStricter')
    const raise = [setTiersCall(w.account, d.testUsdc, tiers, USDC(500))]
    await mustFailInFrame('a higher limit by the passkey', w.account, passkey, [scheduleData(KIND_NORMAL, raise, newSalt())], 'MethodNotAllowed')
    const out = await mustPass('a higher limit by the owner method', w.account, world, [scheduleData(KIND_NORMAL, raise, newSalt())])
    const id = scheduledId(out)
    check((await daily())[0] === USDC(150), 'the higher limit waits in the queue')
    await mustFailInFrame('1 USDC while the higher limit waits', w.account, world, [usdcAt(RECEIVER, 1)], 'DailyLimitReached')
    await runQueued('the higher limit', w.account, id, raise)
    const raised = await daily()
    check(raised[0] === USDC(500) && raised[1] === USDC(150) && raised[2] === USDC(350), 'the window keeps what was sent')
    await mustPass('a send under the higher limit, by the passkey', w.account, passkey, [usdcAt(RECEIVER, 100)])
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
