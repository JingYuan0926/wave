// Runs WAVE through its HTTP routes, the same way the browser does, against a running server.
// It creates an account, funds it, and sends a transfer approved with a dev World ID proof.
// SMOKE_FULL=1 also runs the queue, a passkey, rule checks and rejections. Start the server with
// WAVE_DEMO_DELAY=20 for that, so that the full run takes about 3 minutes.
// SMOKE_BUDGET=1 runs only the sponsor limits. Start the server with WAVE_SPONSOR_DAILY_TX=1 for that.
// Prerequisites: devnet/up.sh, contracts deployed, scripts/fetch-zk.sh, and `npx next dev`.
import { encodeFunctionData, keccak256, stringToHex, type Hex } from 'viem'
import {
  API_ROUTES,
  CREATE_SIGNAL,
  ETH_TOKEN,
  type AccountResponse,
  type ActivityResponse,
  type Address,
  type ApiErrorBody,
  type DevIdentity,
  type FaucetResponse,
  type InfoResponse,
  type MethodRef,
  type Rejection,
  type RootPublishResponse,
  type Tier,
  type TxAction,
  type TxPrepareRequest,
  type TxPrepareResponse,
  type TxPrepared,
  type TxSendResponse,
  type TxStatusResponse,
  type WalletPlan,
  type WalletPlanResponse,
  type WorldDevProofResponse,
  type WorldVerifyResponse,
} from '../lib/api-types'
import { LEGACY_TX, devWallet, loadDeployment, publicClient } from '../lib/chain'
import { TestUSDCAbi, WaveGasStationAbi } from '../lib/wave-abi'
import { SoftPasskey } from './lib/soft-passkey'

const BASE = process.env.WAVE_API_URL ?? 'http://localhost:3000'
const RECEIVER: Address = '0x000000000000000000000000000000000000bEEF'
const FULL = process.env.SMOKE_FULL === '1'
const usdc = (n: number) => String(Math.round(n * 1e6))
const WORLD: MethodRef = { kind: 'world' }
const PASSKEY_1: MethodRef = { kind: 'passkey', slot: 1 }

let failures = 0

function check(ok: boolean, text: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) failures += 1
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    let detail = text.slice(0, 300)
    try {
      const { error } = JSON.parse(text) as ApiErrorBody
      detail = `${error.code}: ${error.message}`
    } catch {
      // The body is not JSON. Show its first bytes.
    }
    throw new Error(`${method} ${path} returned ${response.status}: ${detail}`)
  }
  return JSON.parse(text) as T
}

const get = <T,>(path: string) => call<T>('GET', path)
const post = <T,>(path: string, body: unknown) => call<T>('POST', path, body)

const randomHex = (): Hex => {
  const bytes = crypto.getRandomValues(new Uint8Array(31))
  return `0x${Buffer.from(bytes).toString('hex')}`
}
const newIdentity = (): DevIdentity => ({ trapdoor: randomHex(), nullifier: randomHex() })

const prove = (identity: DevIdentity, signal: string) =>
  post<WorldDevProofResponse>(API_ROUTES.worldDevProof, { identity, signal })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Wallet = { address: Address; owner: Hex; salt: Hex; rootHint: Hex; identity: DevIdentity }

const accountOf = (address: Address) =>
  get<AccountResponse>(`${API_ROUTES.account}?address=${address}`)

async function prepare(
  wallet: Wallet,
  action: TxAction,
  method: MethodRef,
  deployed: boolean,
): Promise<TxPrepareResponse> {
  const request: TxPrepareRequest = {
    account: wallet.address,
    deployment: deployed ? undefined : { owner: { kind: 'world', nullifierHash: wallet.owner }, extras: [] },
    action,
    method,
    rootHint: wallet.rootHint,
  }
  return post<TxPrepareResponse>(API_ROUTES.txPrepare, request)
}

function must(prepared: TxPrepareResponse, label: string): TxPrepared {
  if (!prepared.ok) throw new Error(`${label}: prepare rejected: ${JSON.stringify(prepared.rejection)}`)
  return prepared
}

/** The same steps as onWorldProof in components/approve-flow.tsx. */
async function sendWithWorld(
  wallet: Wallet,
  action: TxAction,
  deployed: boolean,
  identity = wallet.identity,
): Promise<{ prepared: TxPrepared; sent: TxSendResponse; scans: number }> {
  let hint = wallet.rootHint
  for (let scans = 1; ; scans += 1) {
    const prepared = must(await prepare({ ...wallet, rootHint: hint }, action, WORLD, deployed), action.kind)
    const proof = await prove(identity, prepared.sigHash)
    if (BigInt(proof.merkleRoot) !== BigInt(prepared.rootReference?.root ?? 0)) {
      if (scans > 2) throw new Error('the root changed twice')
      await post<RootPublishResponse>(API_ROUTES.rootPublish, { root: proof.merkleRoot })
      hint = proof.merkleRoot
      continue
    }
    const sent = await post<TxSendResponse>(API_ROUTES.txSend, {
      envelope: prepared.envelope,
      method: prepared.method,
      witness: { kind: 'world', root: proof.merkleRoot, nullifierHash: proof.nullifierHash, proof: proof.proof },
    })
    return { prepared, sent, scans }
  }
}

async function sendWithPasskey(
  wallet: Wallet,
  key: SoftPasskey,
  action: TxAction,
  slot: 1 | 2 = 1,
): Promise<TxSendResponse> {
  const prepared = must(await prepare(wallet, action, { kind: 'passkey', slot }, true), action.kind)
  return post<TxSendResponse>(API_ROUTES.txSend, {
    envelope: prepared.envelope,
    method: prepared.method,
    witness: { kind: 'passkey', slot, data: key.sign(prepared.sigHash) },
  })
}

function sentOk(sent: TxSendResponse, label: string): Hex {
  if (!sent.ok) throw new Error(`${label}: ${JSON.stringify(sent.rejection)}`)
  const frames = sent.frames.map((f) => `${f.index} ${f.mode} ${f.label} ${f.status} gas ${f.gasUsed}`).join('; ')
  console.log(`  ${label}: tx ${sent.txHash} [${frames}]`)
  return sent.txHash
}

function rejectedWith(rejection: Rejection | undefined, code: string, stage: Rejection['stage'], label: string) {
  check(
    rejection?.code === code && rejection.stage === stage,
    `${label}: rejected at ${rejection?.stage} with ${rejection?.code} (want ${stage} ${code})${
      rejection?.message ? `, detail: ${rejection.message.slice(0, 120)}` : ''
    }`,
  )
}

/** Waits for the delay of one queued action, then returns it. */
async function queued(wallet: Wallet, title: RegExp) {
  const { pending } = await accountOf(wallet.address)
  const action = pending.find((item) => title.test(item.decoded.title))
  if (!action?.executeAfter) throw new Error(`no queued action matches ${title}: ${JSON.stringify(pending)}`)
  return action
}

async function runQueued(wallet: Wallet, title: RegExp) {
  const action = await queued(wallet, title)
  console.log(`  queued "${action.decoded.title}": kind ${action.kind}, real ${action.realDelay} s, applied ${action.appliedDelay} s`)
  await sleep(Math.max(0, (action.executeAfter as number) * 1000 - Date.now()) + 7000)
  const { sent } = await sendWithWorld(wallet, { kind: 'execute-scheduled', actionId: action.id }, true)
  sentOk(sent, `execute-scheduled ${action.decoded.title}`)
}

async function full(wallet: Wallet) {
  const key = new SoftPasskey()

  console.log('\n--- passkey through the queue')
  const added = await sendWithWorld(
    wallet,
    { kind: 'install-passkey', slot: 1, publicKey: { x: key.x, y: key.y }, backupEligible: false },
    true,
  )
  check(added.prepared.route === 'schedule', `install-passkey route is ${added.prepared.route}`)
  console.log(`  review: ${JSON.stringify(added.prepared.decoded)}`)
  sentOk(added.sent, 'schedule install')
  await runQueued(wallet, /Add passkey/)
  const withKey = await accountOf(wallet.address)
  const method = withKey.methods.find((m) => m.ref.kind === 'passkey')
  check(method?.mask === 2 && method.backup === 'device-bound', `passkey view ${JSON.stringify(method)}`)

  console.log('\n--- rules through the queue: passkey under 100 USDC, World ID from 100 USDC')
  const tiers: Tier[] = [
    { upTo: usdc(100), cap: usdc(120), delay: 0, period: 86_400, methods: 1 | 2, small: false },
    { upTo: String(2n ** 96n - 1n), cap: '0', delay: 0, period: 0, methods: 1, small: false },
  ]
  const { d } = { d: await get<InfoResponse>(API_ROUTES.info) }
  const token = d.tokens.find((t) => t.isTest)?.address as Address
  sentOk((await sendWithWorld(wallet, { kind: 'set-rules', token, tiers, dailyLimit: '0' }, true)).sent, 'schedule set-rules')
  await runQueued(wallet, /Change tUSDC rules/)
  const ruled = await accountOf(wallet.address)
  const usdcRules = ruled.rules.find((r) => r.token === token)
  check(usdcRules?.tiers.length === 2 && usdcRules.tiers[0].methods === 3, `tiers on chain: ${JSON.stringify(usdcRules?.tiers)}`)

  console.log('\n--- transfers by passkey')
  sentOk(
    await sendWithPasskey(wallet, key, { kind: 'transfer', token, to: RECEIVER, amount: usdc(50) }),
    '50 USDC by passkey',
  )
  const after = await accountOf(wallet.address)
  const spent = after.rules.find((r) => r.token === token)?.tiers[0]
  check(spent?.spent === usdc(50) && spent.periodEndsAt !== null, `counter ${spent?.spent}, ends ${spent?.periodEndsAt}`)

  const big = await prepare(wallet, { kind: 'transfer', token, to: RECEIVER, amount: usdc(150) }, PASSKEY_1, true)
  rejectedWith(big.ok ? undefined : big.rejection, 'MethodNotAllowed', 'prepare', '150 USDC by passkey')

  console.log('\n--- rejections')
  const direct = await sendWithPasskey(wallet, key, { kind: 'demo-direct-install' })
  rejectedWith(direct.ok ? undefined : direct.rejection, 'SenderFrameNotAllowed', 'simulate', 'stolen passkey calls installModule')

  const queuedByKey = await sendWithPasskey(wallet, key, {
    kind: 'set-rules',
    token: ETH_TOKEN,
    tiers: [{ upTo: '1', cap: '0', delay: 0, period: 0, methods: 1, small: false }],
    dailyLimit: '0',
  })
  rejectedWith(queuedByKey.ok ? undefined : queuedByKey.rejection, 'MethodNotAllowed', 'chain', 'set-rules by passkey')

  console.log('\n--- tighten and cancel')
  sentOk(
    await sendWithPasskey(wallet, key, {
      kind: 'tighten',
      token,
      tiers: [{ ...tiers[0], upTo: usdc(80) }, tiers[1]],
      dailyLimit: '0',
    }),
    'tighten by passkey',
  )
  const looser = await sendWithWorld(wallet, { kind: 'tighten', token, tiers, dailyLimit: '0' }, true)
  rejectedWith(looser.sent.ok ? undefined : looser.sent.rejection, 'NotStricter', 'chain', 'looser tighten by World ID')

  sentOk((await sendWithWorld(wallet, { kind: 'set-rules', token, tiers, dailyLimit: '0' }, true)).sent, 'schedule loosen')
  const loosen = await queued(wallet, /Change tUSDC rules/)
  check(loosen.decoded.lines.some((line) => line.label === 'Limit 1'), 'a pending row carries its limit lines')
  sentOk(await sendWithPasskey(wallet, key, { kind: 'cancel', actionId: loosen.id }), 'passkey cancels the loosen')
  const left = (await accountOf(wallet.address)).pending.filter((item) => item.id === loosen.id)
  check(left.length === 0, 'the cancelled action left the pending list')

  console.log('\n--- review fixes')
  const stranger = newIdentity()
  const strangerTry = await sendWithWorld(wallet, { kind: 'demo-stranger' }, true, stranger)
  rejectedWith(strangerTry.sent.ok ? undefined : strangerTry.sent.rejection, 'NullifierMismatch', 'simulate', 'different human')

  // The sponsor pays the gas, so only the amount itself must fit.
  const { balances } = await accountOf(wallet.address)
  const eth = balances.find((b) => b.token === ETH_TOKEN)?.amount as string
  const over = (BigInt(eth) + 1n).toString()
  const full = await prepare(wallet, { kind: 'transfer', token: ETH_TOKEN, to: RECEIVER, amount: over }, WORLD, true)
  rejectedWith(full.ok ? undefined : full.rejection, 'InsufficientFunds', 'prepare', 'more ETH than the balance')

  const spend: TxAction = { kind: 'transfer', token, to: RECEIVER, amount: usdc(1) }
  const first = must(await prepare(wallet, spend, PASSKEY_1, true), 'first')
  const second = must(await prepare(wallet, spend, PASSKEY_1, true), 'second')
  const witness = (sigHash: Hex) => ({ kind: 'passkey' as const, slot: 1 as const, data: key.sign(sigHash) })
  sentOk(await post<TxSendResponse>(API_ROUTES.txSend, { envelope: first.envelope, method: first.method, witness: witness(first.sigHash) }), 'first tab')
  const stale = await post<TxSendResponse>(API_ROUTES.txSend, { envelope: second.envelope, method: second.method, witness: witness(second.sigHash) })
  rejectedWith(stale.ok ? undefined : stale.rejection, 'StaleNonce', 'simulate', 'second tab with the same nonce')

  console.log('\n--- recovery through the routes')
  const key2 = new SoftPasskey()
  sentOk(
    (await sendWithWorld(wallet, { kind: 'install-passkey', slot: 2, publicKey: { x: key2.x, y: key2.y }, backupEligible: false }, true)).sent,
    'schedule install 2',
  )
  await runQueued(wallet, /Add passkey/)
  const twoKeys = await accountOf(wallet.address)
  check(twoKeys.recovery.available, `recovery is available with ${twoKeys.recovery.otherMethods} other methods`)

  const newOwner = `0x${'ab'.repeat(32)}` as Hex
  const change = { kind: 'owner', nullifierHash: newOwner } as const
  const byWorld = await prepare(wallet, { kind: 'propose-recovery', change }, WORLD, true)
  rejectedWith(byWorld.ok ? undefined : byWorld.rejection, 'MethodNotAllowed', 'prepare', 'World ID proposes a recovery')
  sentOk(await sendWithPasskey(wallet, key, { kind: 'propose-recovery', change }), 'passkey 1 proposes')
  const proposal = (await accountOf(wallet.address)).pending.find((item) => item.kind === 'recovery')
  check(proposal?.status === 'needs-approval' && proposal.executeAfter === null, `recovery row status ${proposal?.status}`)
  check(proposal?.appliedDelay === proposal?.realDelay || (proposal?.appliedDelay ?? 0) <= 20, `recovery delay label before approval: ${proposal?.appliedDelay} of ${proposal?.realDelay}`)
  const actionId = proposal?.id as Hex

  const again = await prepare(wallet, { kind: 'approve-recovery', actionId }, PASSKEY_1, true)
  rejectedWith(again.ok ? undefined : again.rejection, 'AlreadyApproved', 'prepare', 'the proposer approves again')
  const worldApprove = await prepare(wallet, { kind: 'approve-recovery', actionId }, WORLD, true)
  rejectedWith(worldApprove.ok ? undefined : worldApprove.rejection, 'MethodNotAllowed', 'prepare', 'World ID approves a recovery')
  const review = must(await prepare(wallet, { kind: 'approve-recovery', actionId }, { kind: 'passkey', slot: 2 }, true), 'approve')
  console.log(`  review: ${JSON.stringify(review.decoded)}`)
  check(review.decoded.lines.some((line) => line.label === 'New owner' && line.value === newOwner), 'the approval review shows the full new owner')
  sentOk(await sendWithPasskey(wallet, key2, { kind: 'approve-recovery', actionId }, 2), 'passkey 2 approves')
  const collected = (await accountOf(wallet.address)).pending.find((item) => item.id === actionId)
  check(collected?.status !== 'needs-approval' && collected?.executeAfter !== null, `recovery is queued: ${collected?.status}`)

  const cancelReview = must(await prepare(wallet, { kind: 'cancel', actionId }, WORLD, true), 'cancel')
  check(cancelReview.decoded.lines.some((line) => line.value === newOwner), 'the cancel review shows the new owner')
  const passkeyCancel = await prepare(wallet, { kind: 'cancel', actionId }, PASSKEY_1, true)
  rejectedWith(passkeyCancel.ok ? undefined : passkeyCancel.rejection, 'OnlyOwnerMethod', 'prepare', 'a passkey cancels a recovery')
  sentOk((await sendWithWorld(wallet, { kind: 'cancel', actionId }, true)).sent, 'World ID cancels the recovery')
}

/**
 * A rule that a tighten left with the extra method alone. The removal must repair the rule in the
 * same action, so a large send keeps its approver.
 */
async function removalRepair(rootHint: Hex, token: Address) {
  const ownerKey = new SoftPasskey()
  const extraKey = new SoftPasskey()
  const facts = (key: SoftPasskey) => ({ publicKey: { x: key.x, y: key.y }, backupEligible: false })
  const plan: WalletPlan = {
    owner: { kind: 'passkey', ...facts(ownerKey) },
    extras: [facts(extraKey)],
    wait: 0,
    sends: { kind: 'every', method: 1 },
  }
  const planned = await post<WalletPlanResponse>(API_ROUTES.walletPlan, plan)
  check(planned.ownerSlot === 1 && planned.extraSlots[0] === 2, `plan: owner slot ${planned.ownerSlot}, extra slot ${planned.extraSlots[0]}`)
  const wallet: Wallet = { address: planned.address, owner: rootHint, salt: rootHint, rootHint, identity: newIdentity() }
  await mineDevTx(token, encodeFunctionData({ abi: TestUSDCAbi, functionName: 'mint', args: [wallet.address, BigInt(usdc(1000))] }))

  const alone: Tier[] = [{ upTo: String(2n ** 96n - 1n), cap: '0', delay: 0, period: 0, methods: 4, small: false }]
  const tighten = must(
    await post<TxPrepareResponse>(API_ROUTES.txPrepare, {
      account: wallet.address,
      deployment: plan,
      action: { kind: 'tighten', token, tiers: alone, dailyLimit: '0' },
      method: { kind: 'passkey', slot: 2 },
    }),
    'tighten',
  )
  sentOk(
    await post<TxSendResponse>(API_ROUTES.txSend, {
      envelope: tighten.envelope,
      method: tighten.method,
      witness: { kind: 'passkey', slot: 2, data: extraKey.sign(tighten.sigHash) },
    }),
    'the extra method leaves itself alone in the rule',
  )
  const before = await accountOf(wallet.address)
  check(before.rules.find((r) => r.token === token)?.tiers[0].methods === 4, 'the owner method is out of the rule')

  const removal = must(await prepare(wallet, { kind: 'remove-passkey', slot: 2 }, PASSKEY_1, true), 'remove-passkey')
  check(removal.decoded.title === 'Remove passkey in slot 2, and change limits', `review title: ${removal.decoded.title}`)
  check(removal.runAtOnce, 'a wallet with no wait runs the removal at once')
  console.log(`  review: ${JSON.stringify(removal.decoded)}`)
  const sent = await post<TxSendResponse>(API_ROUTES.txSend, {
    envelope: removal.envelope,
    method: removal.method,
    witness: { kind: 'passkey', slot: 1, data: ownerKey.sign(removal.sigHash) },
  })
  sentOk(sent, 'the owner approves the removal')
  const actionId = sent.ok ? sent.scheduledId : undefined
  const ran = await post<{ txHash: Hex }>(API_ROUTES.runScheduled, { account: wallet.address, actionId })
  console.log(`  run: tx ${ran.txHash}`)
  const after = await accountOf(wallet.address)
  check(after.methods.length === 1 && after.methods[0].owner, 'the extra method is gone')
  check(after.rules.find((r) => r.token === token)?.tiers[0].methods === 1, 'the rule names the owner method')
  sentOk(await sendWithPasskey(wallet, ownerKey, { kind: 'transfer', token, to: RECEIVER, amount: usdc(600) }), '600 tUSDC by the owner method')
}

async function mineDevTx(to: Address, data: Hex, value = 0n) {
  const hash = await devWallet.sendTransaction({ to, data, value, gas: 600_000n, ...LEGACY_TX })
  await publicClient.waitForTransactionReceipt({ hash })
}

/** A new wallet that holds 10 tUSDC and no ETH. */
async function tokenOnlyWallet(testUsdc: Address): Promise<Wallet> {
  const identity = newIdentity()
  const created = await prove(identity, CREATE_SIGNAL)
  const verified = await post<WorldVerifyResponse>(API_ROUTES.worldVerify, { source: 'dev', proof: created })
  const wallet: Wallet = {
    address: verified.address,
    owner: verified.ownerNullifierHash,
    salt: verified.salt,
    rootHint: verified.merkleRoot,
    identity,
  }
  await mineDevTx(testUsdc, encodeFunctionData({ abi: TestUSDCAbi, functionName: 'mint', args: [wallet.address, BigInt(usdc(10))] }))
  return wallet
}

/** The server refuses before it signs: first the budget, then an empty station. */
async function sponsorLimits(testUsdc: Address) {
  const wallet = await tokenOnlyWallet(testUsdc)
  const action: TxAction = { kind: 'transfer', token: testUsdc, to: RECEIVER, amount: usdc(1) }
  // Deploys the wallet. The next prepare then has a real nonce, so both can use the same one.
  const first = must(await prepare(wallet, action, WORLD, false), 'first')
  const second = must(await prepare(wallet, action, WORLD, true), 'second')
  const witness = async (sigHash: Hex) => {
    const proof = await prove(wallet.identity, sigHash)
    return { kind: 'world' as const, root: proof.merkleRoot, nullifierHash: proof.nullifierHash, proof: proof.proof }
  }
  sentOk(await post<TxSendResponse>(API_ROUTES.txSend, { envelope: first.envelope, method: WORLD, witness: await witness(first.sigHash) }), 'the one tx of the budget')
  const over = await post<TxSendResponse>(API_ROUTES.txSend, { envelope: second.envelope, method: WORLD, witness: await witness(second.sigHash) })
  rejectedWith(over.ok ? undefined : over.rejection, 'SponsorLimit', 'sponsor', 'a send over the budget')
  const late = await prepare(wallet, action, WORLD, true)
  rejectedWith(late.ok ? undefined : late.rejection, 'SponsorLimit', 'prepare', 'a prepare over the budget')

  const { gasStation } = loadDeployment()
  const station = gasStation as Address
  const held = await publicClient.getBalance({ address: station })
  await mineDevTx(station, encodeFunctionData({ abi: WaveGasStationAbi, functionName: 'withdraw', args: [devWallet.account.address, held] }))
  try {
    const fresh = await tokenOnlyWallet(testUsdc)
    const empty = await prepare(fresh, action, WORLD, false)
    rejectedWith(empty.ok ? undefined : empty.rejection, 'SponsorEmpty', 'prepare', 'a prepare with an empty station')
    const view = await accountOf(fresh.address)
    check(view.sponsor?.stationEmpty === true && !view.deployed, `the account says the station is empty: ${JSON.stringify(view.sponsor)}`)
  } finally {
    await mineDevTx(station, '0x', held)
  }
  check((await publicClient.getBalance({ address: station })) === held, 'the station has its funds back')
}

/** A wallet that never held ETH. Only tUSDC reaches it, through a direct mint. */
async function noEthWallet(testUsdc: Address) {
  const wallet = await tokenOnlyWallet(testUsdc)
  const { sent, prepared } = await sendWithWorld(wallet, { kind: 'transfer', token: testUsdc, to: RECEIVER, amount: usdc(2) }, false)
  check(prepared.sponsored, 'prepare says the sponsor pays')
  sentOk(sent, 'transfer from a wallet with no ETH')
  const view = await accountOf(wallet.address)
  const eth = view.balances.find((b) => b.token === ETH_TOKEN)?.amount
  check(view.deployed && eth === '0', `the wallet has code and ${eth} ETH`)
}

async function main() {
  console.log(`server ${BASE}`)
  const info = await get<InfoResponse>(API_ROUTES.info)
  console.log(JSON.stringify(info))
  check(info.chainOnline && info.sidecarOnline && info.contractsDeployed, 'info: chain, sidecar and contracts are up')
  check(info.world.mode === 'dev', `info: World ID mode is ${info.world.mode}`)
  check(info.gasSponsored, 'info: the local network has the gas sponsor')
  const testUsdc = info.tokens.find((t) => t.isTest)?.address as Address

  if (process.env.SMOKE_BUDGET === '1') {
    await sponsorLimits(testUsdc)
    console.log(failures === 0 ? '\nSponsor limits passed' : `\nSponsor limits FAILED: ${failures} checks`)
    process.exit(failures === 0 ? 0 : 1)
  }

  console.log('\n--- create an account')
  const identity = newIdentity()
  const created = await prove(identity, CREATE_SIGNAL)
  const verified = await post<WorldVerifyResponse>(API_ROUTES.worldVerify, { source: 'dev', proof: created })
  console.log(`  address ${verified.address}, root ${verified.merkleRoot}`)
  const wallet: Wallet = {
    address: verified.address,
    owner: verified.ownerNullifierHash,
    salt: verified.salt,
    rootHint: verified.merkleRoot,
    identity,
  }
  const tampered = { ...created, signalHash: keccak256(stringToHex('x')), proof: created.proof.replace(/.$/, (last) => (last === '0' ? '1' : '0')) as Hex }
  const refused = await post(API_ROUTES.worldVerify, { source: 'dev', proof: tampered }).catch((e: Error) => e.message)
  check(typeof refused === 'string' && /PROOF_INVALID/.test(refused), `a changed proof is refused: ${String(refused).slice(0, 120)}`)

  const fresh = await accountOf(wallet.address)
  check(!fresh.deployed && fresh.methods.length === 1, 'account has no code yet, World ID is the only method')

  const noGas = await prepare(wallet, { kind: 'transfer', token: testUsdc, to: RECEIVER, amount: usdc(1) }, WORLD, false)
  rejectedWith(noGas.ok ? undefined : noGas.rejection, 'InsufficientFunds', 'prepare', 'transfer before funding')

  console.log('\n--- fund it')
  const funded = await post<FaucetResponse>(API_ROUTES.faucet, { address: wallet.address })
  console.log(`  faucet txs ${funded.txHashes.join(' ')}`)

  console.log('\n--- guards')
  const failing = (text: string) => async (error: Error) => {
    check(error.message.includes(text), `refused: ${error.message.slice(0, 110)}`)
  }
  await post(API_ROUTES.faucet, { address: wallet.address }).then(
    () => check(false, 'a second faucet call passed'),
    failing('FAUCET_COOLDOWN'),
  )
  const plain = await fetch(`${BASE}${API_ROUTES.faucet}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ address: wallet.address }),
  })
  check(plain.status === 415, `a text/plain faucet call gets ${plain.status}`)
  const foreign = await fetch(`${BASE}${API_ROUTES.faucet}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ address: wallet.address }),
  })
  check(foreign.status === 403, `a call from another site gets ${foreign.status}`)
  const deployment: WalletPlan = { owner: { kind: 'world', nullifierHash: wallet.owner }, extras: [] }
  await post(API_ROUTES.txPrepare, { account: wallet.address, deployment, method: WORLD, rootHint: '0x', action: { kind: 'demo-stranger' } }).then(
    () => check(false, 'an empty root hint passed'),
    failing('BAD_REQUEST'),
  )
  await post(API_ROUTES.txPrepare, { account: wallet.address, deployment, method: WORLD }).then(
    () => check(false, 'a missing action passed'),
    failing('BAD_REQUEST'),
  )
  const rich = await accountOf(wallet.address)
  check(rich.balances.every((b) => BigInt(b.amount) > 0n), `balances ${JSON.stringify(rich.balances)}`)
  check(rich.sponsor?.used === 0 && rich.sponsor.limit > 0 && !rich.sponsor.stationEmpty, `sponsor ${JSON.stringify(rich.sponsor)}`)

  console.log('\n--- a wallet with no ETH: the sponsor deploys it and pays')
  await noEthWallet(testUsdc)

  console.log('\n--- transfer approved with a dev World ID proof. The sponsor deploys the account.')
  const action: TxAction = { kind: 'transfer', token: testUsdc, to: RECEIVER, amount: usdc(5) }
  const first = await sendWithWorld(wallet, action, false)
  check(!first.prepared.deploys && first.prepared.sponsored, 'the sponsor deployed the account, and it pays this tx')
  check(first.prepared.frames[1]?.label === 'Gas sponsor pays', `frame 1 is ${first.prepared.frames[1]?.label}`)
  check(first.prepared.route === 'execute', `route is ${first.prepared.route}`)
  console.log(`  review: ${JSON.stringify(first.prepared.decoded)}`)
  console.log(`  sig_hash ${first.prepared.sigHash}, reference ${JSON.stringify(first.prepared.rootReference)}`)
  const txHash = sentOk(first.sent, 'transfer')

  const status = await get<TxStatusResponse>(`${API_ROUTES.txStatus}?hash=${txHash}`)
  check(status.state === 'included', `tx/status says ${status.state}, block ${status.blockNumber}, gas ${status.gasUsed}`)
  console.log(`  explorer ${info.explorerUrl}/tx/${txHash}?node=${encodeURIComponent(info.rpcUrl)}`)

  const after = await accountOf(wallet.address)
  const left = BigInt(after.balances.find((b) => b.token === testUsdc)?.amount ?? 0)
  check(after.deployed, 'the account has code')
  check(after.sponsor?.used === 1, `the budget counted one tx: ${after.sponsor?.used}`)
  check(left === BigInt(usdc(1000)) - BigInt(usdc(5)), `USDC balance is ${left}`)

  const activity = await get<ActivityResponse>(`${API_ROUTES.activity}?address=${wallet.address}`)
  console.log(`  activity: ${activity.items.map((item) => `${item.title} (${item.state}, ${item.direction})`).join(' | ')}`)
  check(activity.items.some((item) => item.txHash === txHash && item.direction === 'out'), 'activity holds the transfer')

  console.log('\n--- a different human')
  const stranger = await sendWithWorld(wallet, action, true, newIdentity())
  check(stranger.scans === 2, `the second scan followed a root change: ${stranger.scans} scans`)
  rejectedWith(stranger.sent.ok ? undefined : stranger.sent.rejection, 'NullifierMismatch', 'simulate', 'different human')

  if (FULL) {
    await full(wallet)
    console.log('\n--- a removal keeps an approver for large sends')
    await removalRepair(wallet.rootHint, testUsdc)
  }

  console.log(failures === 0 ? '\nAPI smoke passed' : `\nAPI smoke FAILED: ${failures} checks`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
