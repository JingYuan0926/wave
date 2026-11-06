// Tests with no chain: decoding, text, input checks and the guards of the server code.
// A small fake RPC server plays the node. Run: npx tsx scripts/unit.ts
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { concat, encodeFunctionData, numberToHex, pad, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { MethodView, TokenInfo, WalletPlan } from '../lib/api-types'

type Tx = Record<string, unknown>
const chain: { genesis: Hex; head: number; slot: number; blocks: Record<number, Tx[]> } = {
  genesis: pad('0x01', { size: 32 }),
  head: 0,
  slot: 100,
  blocks: {},
}

const server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] }
    let result: unknown = null
    if (method === 'eth_blockNumber') result = numberToHex(chain.head)
    if (method === 'eth_getTransactionReceipt') result = { status: '0x1', logs: [] }
    if (method === 'eth_getBlockByNumber') {
      const tag = params[0] as string
      const number = tag === 'latest' ? chain.head : Number(tag)
      result = {
        hash: number === 0 ? chain.genesis : pad('0x02', { size: 32 }),
        timestamp: '0x10',
        slotNumber: numberToHex(chain.slot),
        transactions: chain.blocks[number] ?? [],
      }
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  })
})

let failures = 0
async function test(name: string, body: () => void | Promise<void>) {
  try {
    await body()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${(error as Error).message}`)
  }
}

async function main() {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.WAVE_RPC_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.WAVE_DEPLOYMENT = '/nonexistent'

  // These read WAVE_RPC_URL when they load.
  const { readActivity } = await import('../lib/server/activity')
  const { describeCall, describeSender, tokensOf, validatorOfKey } = await import('../lib/server/decode')
  const { ApiFailure, asBaseUnits, asHex, asWord, failure, readBody, requireLocal } = await import('../lib/server/http')
  const { referenceFor, waitForSlotAfter } = await import('../lib/server/roots')
  const { toRawTier } = await import('../lib/server/prepare')
  const { decodeCallError, decodeRevert } = await import('../lib/server/reject')
  const { WaveAccountAbi } = await import('../lib/wave-abi')
  const { executeData, ethTransfer, erc20Transfer, scheduleData, setOwnerCall, encodeBatch } = await import('../lib/policy')
  const frametx = await import('../lib/frametx')
  const sponsor = await import('../lib/server/sponsor')
  const format = await import('../lib/ui/format')
  const rules = await import('../lib/ui/rules')
  const limits = await import('../lib/ui/limits')
  const rejections = await import('../lib/ui/rejections')
  const { shapeTiers, tiersAfterRemoval } = await import('../lib/limits')
  const { buildWallet, firstTiers } = await import('../lib/account')
  const { checkPlan } = await import('../lib/server/wallet-plan')

  const addr = (n: number) => pad(numberToHex(n), { size: 20 }) as Address
  const d = {
    chainId: 1337,
    rpcUrl: '',
    deployedAtBlock: 1,
    devKeyAddress: addr(1),
    rootPublisher: addr(1),
    rootSalt: pad('0x03', { size: 32 }),
    rootSourceId: pad('0x04', { size: 32 }),
    semaphoreVerifier: addr(2),
    recentRootRead: addr(3),
    worldIdValidator: addr(0xa1),
    passkeyValidators: [addr(0xa2), addr(0xa3), addr(0xa4)] as [Address, Address, Address],
    implementation: addr(5),
    factory: addr(6),
    testUsdc: addr(0xc0),
  }
  const account = addr(0x77)
  const to = addr(0xd0)

  await test('a call with target 0 reads as a call to the wallet', () => {
    const call = { ...setOwnerCall(account, 42n), target: addr(0) }
    assert.equal(describeCall(d, account, call).title, 'Change the wallet owner')
  })

  await test('setOwner shows the full new owner', () => {
    const owner = (1n << 250n) + 7n
    const line = describeCall(d, account, setOwnerCall(account, owner)).lines[0]
    assert.equal(line.value, numberToHex(owner, { size: 32 }))
  })

  await test('a contract call shows its ETH value', () => {
    const text = describeCall(d, account, { target: to, value: 100n * 10n ** 18n, callData: '0x01' })
    assert.ok(text.lines.some((line) => line.label === 'Value' && line.value === '100 ETH'))
  })

  await test('a batch shows each recipient and an exact title', () => {
    const data = scheduleData(0, [erc20Transfer(d.testUsdc, to, 5_000_010n), ethTransfer(addr(0xd1), 1n)], pad('0x05', { size: 32 }))
    const { decoded } = describeSender(d, account, data)
    const text = JSON.stringify(decoded.lines).toLowerCase()
    assert.ok(text.includes('send 5.00001 tusdc'), text)
    assert.ok(text.includes(to) && text.includes(addr(0xd1)), text)
  })

  await test('test USDC is never plain USDC', () => {
    assert.equal(tokensOf(d)[1].symbol, 'tUSDC')
  })

  await test('frames that do not decode give Unknown call', () => {
    const empty = encodeFunctionData({ abi: WaveAccountAbi, functionName: 'execute', args: [pad('0x00', { size: 32 }), '0x'] })
    assert.equal(describeSender(d, account, empty).decoded.title, 'Unknown call')
    assert.equal(describeSender(d, account, '0xdeadbeef').decoded.title, 'Unknown call')
  })

  await test('nonce keys that name no validator give null', () => {
    assert.equal(validatorOfKey('0x0'), null)
    assert.equal(validatorOfKey(`0x1${'0'.repeat(40)}`), null)
    assert.equal(validatorOfKey('0xa2'), addr(0xa2))
  })

  await test('odd transactions do not stop the activity index', async () => {
    const data = executeData([ethTransfer(to, 1n)])
    const tx = (hash: number, nonceKey: Hex, frame: Hex, sender: Address | undefined = account): Tx => ({
      hash: pad(numberToHex(hash), { size: 32 }),
      from: account,
      sender,
      nonceKeys: [nonceKey],
      frames: [{ mode: '0x2', data: frame }],
    })
    chain.blocks = {
      1: [tx(1, '0x0', data), tx(2, '0x1234', data)],
      2: [
        tx(3, '0xa2', encodeFunctionData({ abi: WaveAccountAbi, functionName: 'execute', args: [pad('0x00', { size: 32 }), '0x'] })),
        tx(4, '0xa2', data, undefined),
      ],
      3: [tx(5, '0xa2', data)],
    }
    chain.blocks[2][1] = { ...chain.blocks[2][1], sender: null }
    chain.head = 3
    const items = await readActivity(d, account)
    assert.equal(items.length, 4, JSON.stringify(items))
    assert.deepEqual(items[0].method, { kind: 'passkey', slot: 1 })
    assert.equal(items.at(-1)?.method, null)
  })

  await test('a restarted chain empties the activity index', async () => {
    chain.genesis = pad('0x09', { size: 32 })
    chain.blocks = {}
    chain.head = 1
    assert.equal((await readActivity(d, account)).length, 0)
  })

  await test('a root reference stops at a chain restart', async () => {
    chain.head = 5
    const root = pad('0x0a', { size: 32 })
    const shared = globalThis as unknown as { __waveRoots: { refs: Map<string, unknown> } }
    await assert.rejects(() => referenceFor(root)) // The first read has no deployment file here.
    shared.__waveRoots.refs.set('old', { slot: 1n })
    chain.genesis = pad('0x0b', { size: 32 })
    await assert.rejects(() => referenceFor(root))
    assert.equal(shared.__waveRoots.refs.size, 0)
  })

  await test('waitForSlotAfter ends when the chain stops', async () => {
    await assert.rejects(
      () => waitForSlotAfter(9n, async () => 9n, 0),
      (error: Error) => error instanceof ApiFailure && error.code === 'CHAIN_STALLED',
    )
  })

  await test('a server error hides raw text', async () => {
    const original = console.error
    console.error = () => {}
    const response = failure(new Error('URL: http://rpc.example/v2/SECRET_API_KEY'))
    console.error = original
    const text = await response.text()
    assert.equal(response.status, 500)
    assert.ok(!text.includes('SECRET_API_KEY'), text)
  })

  const request = (headers: Record<string, string>) =>
    new Request('http://localhost:3000/api/faucet', { method: 'POST', headers })

  await test('local routes accept only local JSON callers', () => {
    const json = { 'content-type': 'application/json' }
    requireLocal(request({ host: 'localhost:3000', ...json }))
    requireLocal(request({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', ...json }))
    const code = (headers: Record<string, string>) => {
      try {
        requireLocal(request(headers))
      } catch (error) {
        return (error as InstanceType<typeof ApiFailure>).code
      }
      return 'passed'
    }
    assert.equal(code({ host: 'evil.example', ...json }), 'LOCAL_ONLY')
    assert.equal(code({ host: 'localhost:3000', origin: 'https://evil.example', ...json }), 'LOCAL_ONLY')
    assert.equal(code({ host: 'localhost:3000', 'content-type': 'text/plain' }), 'BAD_REQUEST')
  })

  await test('bad input gives BAD_REQUEST', async () => {
    const bad = (body: () => unknown) => assert.throws(body, (error: Error) => error instanceof ApiFailure)
    bad(() => asHex('0x', 'root'))
    bad(() => asWord(`0x${'11'.repeat(33)}`, 'root'))
    bad(() => asBaseUnits('1'.repeat(90), 'amount'))
    bad(() => toRawTier({ upTo: (1n << 96n).toString(), cap: '0', delay: 0, period: 0, methods: 1, small: false }, 0))
    bad(() => toRawTier({ upTo: '1', cap: '0', delay: -1, period: 0, methods: 1, small: false }, 0))
    bad(() => toRawTier(null as never, 0))
    await assert.rejects(() => readBody(new Request('http://x/', { method: 'POST', body: 'null' })))
  })

  await test('token errors decode', () => {
    const data = concat(['0xe450d38c', pad(to), pad('0x00'), pad('0x01')])
    assert.equal(decodeRevert(data)?.code, 'InsufficientFunds')
    const walk = (test: (cause: unknown) => boolean) => [{ name: 'ContractFunctionRevertedError', data: { errorName: 'ERC20InsufficientBalance', args: [] } }].find(test)
    assert.equal(decodeCallError({ walk })?.code, 'InsufficientFunds')
    const unknown = (test: (cause: unknown) => boolean) => [{ name: 'ContractFunctionRevertedError' }].find(test)
    assert.equal(decodeCallError({ walk: unknown })?.code, 'Reverted')
    assert.equal(decodeCallError({ walk: () => null }), null)
  })

  await test('amounts never round', () => {
    assert.equal(format.parseTokenAmount('1.000001', 6).value, 1_000_001n)
    assert.ok(format.parseTokenAmount('1.0000009', 6).error)
    assert.ok(format.parseTokenAmount('1,000', 6).error)
    assert.ok(format.parseTokenAmount('-5', 6).error)
    assert.equal(format.parseTokenAmount('.5', 6).value, 500_000n)
    assert.equal(format.parseTokenAmount('5.', 6).value, 5_000_000n)
  })

  const token: TokenInfo = { address: d.testUsdc, symbol: 'tUSDC', name: 'Test USDC', decimals: 6, isTest: true }

  await test('a bad cap is a problem, and no cap is not', () => {
    assert.equal(rules.tierAmountError('', token, true), null)
    assert.ok(rules.tierAmountError('', token, false))
    assert.ok(rules.tierAmountError('1,000', token, true))
    assert.ok(rules.tierAmountError('-5', token, true))
    assert.ok(rules.tierAmountError('0', token, true))
    assert.ok(rules.tierAmountError('1'.repeat(40), token, true))
  })

  await test('durations and waits', () => {
    assert.equal(format.formatDuration(604800), '7 days')
    assert.equal(format.formatDuration(1209600), '2 weeks')
    assert.equal(format.delayText(86400, 120), 'Wait: 2 minutes')
    assert.equal(format.delayText(86400, 0), '24 hours')
    assert.equal(format.delayText(86400, 0xffffffff), 'No wait')
    const tier = { upTo: '100', cap: '0', delay: 86400, period: 0, methods: 1, small: false, spent: '0', periodEndsAt: null }
    const summary = rules.describeSpend({ token: token.address, tiers: [tier], daily: null }, 1n, []).summary
    assert.ok(summary.includes('It waits 24 hours'), summary)
  })

  await test('labels and recovery choices', () => {
    const world: MethodView = { ref: { kind: 'world' }, validator: addr(1), mask: 1, backup: null, owner: true }
    const bound: MethodView = { ref: { kind: 'passkey', slot: 1 }, validator: addr(2), mask: 2, backup: 'device-bound', owner: false }
    const synced: MethodView = { ref: { kind: 'passkey', slot: 2 }, validator: addr(3), mask: 4, backup: 'synced', owner: false }
    assert.equal(rules.methodLabel({ kind: 'world' }, { mode: 'dev' }), 'Test identity')
    assert.equal(rules.methodLabel({ kind: 'world' }), 'World ID')
    assert.deepEqual(
      rules.recoveryChoices([world, bound, synced], { mode: 'dev' }).map((choice) => choice.allowed),
      [false, true, false],
    )
    assert.equal(rules.recoveryChoices([bound], null, [{ kind: 'passkey', slot: 1 }])[0].allowed, false)
  })

  const usdc: TokenInfo = { address: addr(0xc0), symbol: 'tUSDC', name: 'Test USDC', decimals: 6, isTest: true }
  const NO_LIMIT = (1n << 96n) - 1n
  const world = { id: '1', name: 'World ID', owner: true, full: true }
  const bound = { id: '2', name: 'Passkey 1', owner: false, full: true }
  const syncedKey = { id: '4', name: 'Passkey 2', owner: false, full: false }
  const chainTier = (upTo: bigint, methods: number, cap = 0n, period = 0, small = false) => ({
    upTo: upTo.toString(),
    cap: cap.toString(),
    delay: 0,
    period,
    methods,
    small,
  })
  const ownerKey = pad('0x11', { size: 32 })
  const facts = (byte: number, backupEligible = false) => ({
    publicKey: { x: pad(numberToHex(byte), { size: 32 }), y: ownerKey },
    backupEligible,
  })
  const ownerWorld = { kind: 'world' as const, nullifierHash: ownerKey }
  const sendsOf = (extras: unknown[], sends: unknown) => () => checkPlan({ owner: ownerWorld, extras, sends }, { ...d, gasStation: addr(9), sponsor: addr(9) })

  await test('the last step always holds the owner bit', () => {
    assert.equal(shapeTiers({ kind: 'every', method: 2 })[0].methods, 3)
    assert.equal(shapeTiers({ kind: 'every', method: 1 })[0].methods, 1)
    const steps = shapeTiers({ kind: 'limit', amount: 5n, lower: 2, upper: 4, lowerSynced: false })
    assert.deepEqual(steps.map((step) => step.methods), [3, 5])
    assert.deepEqual(steps.map((step) => step.upTo), [5n, NO_LIMIT])
    assert.equal(steps[1].small, false)
  })

  await test('the sends plan path builds the same rule as the Settings form', () => {
    const plan: WalletPlan = { owner: ownerWorld, extras: [facts(1, true)], wait: 0, sends: { kind: 'limit', amount: '100000000', perDay: '500000000', lower: 1, upper: 0 } }
    const built = buildWallet({ contracts: d, plan, demoDelay: 45, externalNullifierHash: 1n, rootSourceId: pad('0x04', { size: 32 }) })
    // Slot 1 is bit 2, the first step is small for a synced key, and the last step is the owner.
    assert.deepEqual(built.tiers.map((tier) => tier.methods), [0x83, 1])
    // The daily limit is the hard total, so no step holds it.
    assert.equal(built.dailyLimit, 500_000_000n)
    assert.equal(built.tiers[0].cap, 0n)
    assert.equal(built.tiers[0].period, 0)
    const form = { choice: 'limit', every: '', amount: '100', perDay: '500', lower: '2', upper: '1' } as const
    const fromForm = limits.formTiers(form, [world, bound], usdc)
    assert.deepEqual(fromForm.map((tier) => tier.methods), [3, 1])
    assert.equal(fromForm[0].upTo, built.tiers[0].upTo.toString())
    assert.equal(fromForm[0].cap, '0')
    assert.equal(limits.formDailyLimit(form, usdc), built.dailyLimit.toString())
  })

  await test('the address commits to the daily limit', () => {
    const plan = (perDay: string | null): WalletPlan => ({ owner: ownerWorld, extras: [facts(1)], wait: 0, sends: { kind: 'every', method: 1, perDay } })
    const build = (next: WalletPlan) => buildWallet({ contracts: d, plan: next, demoDelay: 45, externalNullifierHash: 1n, rootSourceId: pad('0x04', { size: 32 }) })
    assert.notEqual(build(plan('100')).args, build(plan('200')).args)
    assert.notEqual(build(plan('100')).args, build(plan(null)).args)
    assert.equal(build(plan('100')).dailyLimit, 100n)
    assert.equal(build(plan(null)).dailyLimit, 0n)
  })

  await test('older plans with a limit per extra still build', () => {
    const tiers = firstTiers([{ slot: 1, limit: '5' }])
    assert.deepEqual(tiers.map((tier) => tier.methods), [0x83, 1])
  })

  await test('checkPlan reads the sends choice', () => {
    const limit = { kind: 'limit', amount: '5', perDay: null, lower: 1, upper: 0 }
    assert.deepEqual(sendsOf([facts(1)], limit)().sends, limit)
    assert.throws(sendsOf([facts(1, true)], { ...limit, lower: 0, upper: 1 }), /synced passkey needs a limit/)
    assert.throws(sendsOf([facts(1, true)], { kind: 'every', method: 1 }), /synced passkey needs a limit/)
    assert.throws(sendsOf([facts(1)], { ...limit, upper: 1 }), /different method/)
    assert.throws(sendsOf([facts(1)], { ...limit, upper: 2 }), /unknown method/)
    assert.throws(sendsOf([facts(1)], { ...limit, amount: '0' }), /above 0/)
    assert.throws(sendsOf([facts(1)], { ...limit, perDay: '4' }), /below the limit/)
    assert.deepEqual(sendsOf([facts(1)], { kind: 'every', method: 1, perDay: '4' })().sends, { kind: 'every', method: 1, perDay: '4' })
    assert.deepEqual(sendsOf([facts(1)], { kind: 'every', method: 1, perDay: null })().sends, { kind: 'every', method: 1 })
    assert.throws(sendsOf([facts(1)], { kind: 'every', method: 1, perDay: 'x' }), /integer string/)
    assert.throws(sendsOf([facts(1)], { kind: 'other' }), /unknown send rule/)
  })

  await test('a removal repairs only a step that would have no approver', () => {
    const tier = (upTo: bigint, methods: number) => ({ upTo, cap: 0n, delay: 0, period: 0, methods })
    const every = [tier(NO_LIMIT, 2 | 1)]
    assert.equal(tiersAfterRemoval(every, 2, 2, 0), null, 'the owner method stays')
    const alone = [tier(5n, 1), tier(NO_LIMIT, 2)]
    assert.deepEqual(tiersAfterRemoval(alone, 2, 2, 0)?.map((step) => step.methods), [1, 1])
    assert.equal(tiersAfterRemoval(alone, 4, 2 | 4, 0), null, 'the rule does not name the method')
    const twoFull = [tier(NO_LIMIT, 2 | 4)]
    assert.equal(tiersAfterRemoval(twoFull, 2, 2 | 4, 0), null, 'another full method stays')
    assert.deepEqual(tiersAfterRemoval(twoFull, 2, 2 | 4, 4)?.map((step) => step.methods), [4 | 1], 'a synced passkey alone cannot be last')
    const small = [tier(5n, 2 | 4 | 0x80), tier(NO_LIMIT, 1)]
    assert.equal(tiersAfterRemoval(small, 2, 2 | 4, 4), null, 'a synced passkey can keep a small step')
    assert.deepEqual(tiersAfterRemoval([tier(5n, 2 | 4), tier(NO_LIMIT, 1)], 2, 2 | 4, 4)?.map((step) => step.methods), [4 | 1, 1])
  })

  await test('the two choices read a live rule back', () => {
    const methods = [world, bound]
    const every = limits.readForm([chainTier(NO_LIMIT, 3)], methods, usdc)
    assert.equal(every?.choice, 'every')
    assert.equal(every?.every, '2')
    assert.equal(limits.readForm([chainTier(NO_LIMIT, 1)], methods, usdc)?.every, '1')
    const limit = limits.readForm([chainTier(100_000_000n, 3), chainTier(NO_LIMIT, 1)], methods, usdc, '500000000')
    assert.deepEqual(limit, { choice: 'limit', amount: '100', perDay: '500', every: '', lower: '2', upper: '1' })
    assert.equal(limits.readForm([chainTier(NO_LIMIT, 1)], methods, usdc, '500000000')?.perDay, '500')
    assert.equal(limits.readForm([], methods, usdc, '500000000')?.perDay, '500')
    assert.equal(limits.readForm([chainTier(NO_LIMIT, 1)], methods, usdc)?.perDay, '')
    assert.equal(limits.readForm([chainTier(5n, 1, 9n, 86_400), chainTier(NO_LIMIT, 1)], methods, usdc), null, 'a total on a step')
    assert.equal(limits.readForm([chainTier(100_000_000n, 1), chainTier(NO_LIMIT, 3)], methods, usdc)?.upper, '2')
    assert.equal(limits.readForm([chainTier(NO_LIMIT, 2)], methods, usdc), null, 'a step with no owner method')
    assert.equal(limits.readForm([chainTier(5n, 1), chainTier(NO_LIMIT, 2)], methods, usdc), null, 'a last step with no owner method')
    assert.equal(limits.readForm([chainTier(5n, 1, 9n, 604_800), chainTier(NO_LIMIT, 1)], methods, usdc), null, 'a weekly total')
  })

  await test('a removed method does not count in a live rule', () => {
    const left = [world, bound]
    const upperGone = limits.readForm([chainTier(100_000_000n, 3), chainTier(NO_LIMIT, 4 | 1)], left, usdc)
    assert.equal(upperGone?.lower, '2')
    assert.equal(upperGone?.upper, '1')
    assert.equal(limits.readForm([chainTier(NO_LIMIT, 4 | 1)], left, usdc)?.every, '1')
    const lowerGone = limits.readForm([chainTier(100_000_000n, 4 | 1), chainTier(NO_LIMIT, 3)], left, usdc)
    assert.equal(lowerGone?.lower, '1')
    assert.equal(lowerGone?.upper, '2')
    const both = limits.readForm([chainTier(100_000_000n, 1), chainTier(NO_LIMIT, 4 | 1)], left, usdc)
    assert.equal(both?.choice, 'every')
    assert.equal(both?.every, '1')
  })

  await test('the form never picks a synced passkey for the last step', () => {
    const methods = [world, syncedKey]
    const form = limits.defaultForm(methods, '100')
    assert.equal(form.upper, '1')
    assert.equal(form.lower, '4')
    assert.equal(limits.pickUpper(form, '1', methods).lower, '4')
    assert.equal(limits.pickLower(form, '1', methods).upper, '1')
    assert.equal(limits.canUseLimit([world]), false)
    assert.equal(limits.fitForm({ ...form, choice: 'every', every: '4' }, methods).every, '1')
  })

  await test('the summary names the owner method where it can also approve', () => {
    const methods = [world, bound]
    const form = (next: object) => ({ choice: 'limit', every: '', amount: '100', perDay: '', lower: '2', upper: '1', ...next }) as const
    assert.deepEqual(limits.formSummary(form({ choice: 'every', every: '2' }), methods, usdc), [
      'Every send: Passkey 1.',
      'World ID can also approve every send.',
    ])
    assert.deepEqual(limits.formSummary(form({ choice: 'every', every: '1' }), methods, usdc), ['Every send: World ID.'])
    assert.deepEqual(limits.formSummary(form({}), methods, usdc), [
      'Sends up to 100 tUSDC: Passkey 1. Above 100 tUSDC: World ID.',
      'World ID can also approve up to the limit.',
    ])
    assert.deepEqual(limits.formSummary(form({ lower: '1', upper: '2' }), methods, usdc), [
      'Sends up to 100 tUSDC: World ID. Above 100 tUSDC: Passkey 1.',
      'World ID can also approve above the limit.',
    ])
    const three = [...methods, { id: '4', name: 'Security key', owner: false, full: true }]
    assert.equal(limits.formSummary(form({ lower: '2', upper: '4' }), three, usdc)[1], 'World ID can also approve any amount.')
    assert.deepEqual(limits.formSummary(form({ amount: '' }), methods, usdc), ['Enter a limit to see what happens.'])
  })

  await test('the summary states the hard daily limit', () => {
    const methods = [world, bound]
    const line = 'Most you can send per day: 300 tUSDC. After that, no method can send until the 24 hours end.'
    const limit = { choice: 'limit', every: '', amount: '100', perDay: '300', lower: '2', upper: '1' } as const
    assert.deepEqual(limits.formSummary(limit, methods, usdc), [
      'Sends up to 100 tUSDC: Passkey 1. Above 100 tUSDC: World ID.',
      line,
      'World ID can also approve up to the limit.',
    ])
    assert.deepEqual(limits.formSummary({ ...limit, choice: 'every', every: '1' }, methods, usdc), ['Every send: World ID.', line])
    assert.ok(!limits.formSummary(limit, methods, usdc).join(' ').includes('approves.'))
    const custom = [{ ...chainTier(5n, 1, 9n, 604_800), spent: '0', periodEndsAt: null }, { ...chainTier(NO_LIMIT, 1), spent: '0', periodEndsAt: null }]
    assert.equal(limits.ruleSentences(custom, methods, usdc, '300000000').at(-1), line)
  })

  await test('the Send sheet stops at the daily limit', () => {
    const daily = { limit: '300000000', spent: '150000000', left: '150000000', resetsAt: 1_800_000_000 }
    assert.equal(limits.leftToday(daily, usdc), '150 tUSDC left today')
    assert.equal(limits.dailyStop(daily, 150_000_000n, usdc), null)
    assert.equal(limits.dailyStop(null, 1n, usdc), null)
    const stop = limits.dailyStop(daily, 150_000_001n, usdc) as string
    assert.ok(stop.startsWith('You reached your daily limit. 150 tUSDC left. It resets at '), stop)
    assert.ok(stop.endsWith(`${format.formatTime(1_800_000_000)}.`), stop)
    const fresh = { limit: '300000000', spent: '0', left: '300000000', resetsAt: null }
    assert.equal(limits.dailyStop(fresh, 300_000_001n, usdc), 'This is above your daily limit. 300 tUSDC left.')
    assert.deepEqual(limits.liveDaily(daily, 1_799_999_999), daily)
    assert.deepEqual(limits.liveDaily(daily, 1_800_000_000), { ...daily, spent: '0', left: '300000000', resetsAt: null })
    assert.equal(limits.liveDaily(undefined, 5), null)
    assert.deepEqual(limits.liveDaily(daily, 0), daily, 'the server render has no clock')
  })

  await test('the daily limit has its own direction', () => {
    assert.equal(rules.dailyDirection('0', '0'), 'same')
    assert.equal(rules.dailyDirection('5', '5'), 'same')
    assert.equal(rules.dailyDirection('0', '5'), 'stricter')
    assert.equal(rules.dailyDirection('5', '4'), 'stricter')
    assert.equal(rules.dailyDirection('5', '6'), 'looser')
    assert.equal(rules.dailyDirection('5', '0'), 'looser')
    assert.equal(rules.joinDirections('same', 'stricter'), 'stricter')
    assert.equal(rules.joinDirections('stricter', 'looser'), 'looser')
    assert.equal(rules.joinDirections('looser', 'same'), 'looser')
    assert.equal(rules.joinDirections('same', 'same'), 'same')
  })

  await test('the plain text names DailyLimitReached', () => {
    const text = rejections.explainRejection({ stage: 'prepare', code: 'DailyLimitReached' })
    assert.equal(text.title, 'You reached your daily limit')
    assert.ok(text.detail.includes('No method can send'), text.detail)
  })

  await test('a form that only changes the daily limit is a change', () => {
    const form = { choice: 'every', every: '1', amount: '', perDay: '5', lower: '', upper: '' } as const
    assert.equal(limits.sameForm(form, { ...form, perDay: '' }, usdc), false)
    assert.equal(limits.sameForm(form, { ...form }, usdc), true)
    assert.equal(limits.formProblems({ ...form, perDay: 'x' }, usdc).perDay, 'Enter a number, such as 12.5.')
  })

  await test('the form checks amounts in plain words', () => {
    const form = { choice: 'limit', every: '', amount: '100', perDay: '50', lower: '2', upper: '1' } as const
    assert.equal(limits.formProblems(form, usdc).perDay, 'Enter at least 100 tUSDC, or leave this empty.')
    assert.equal(limits.formProblems({ ...form, amount: '0', perDay: '' }, usdc).amount, 'Enter an amount above 0.')
    assert.equal(limits.formIsValid({ ...form, perDay: '' }, usdc), true)
  })

  await test('an open-ended step reads as any amount', () => {
    const call = { target: account, value: 0n, callData: encodeFunctionData({ abi: WaveAccountAbi, functionName: 'setTiers', args: [d.testUsdc, [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: 1 }], 0n] }) }
    assert.equal(describeCall(d, account, call).lines[0].value, 'any amount, Owner method, no delay, no total limit')
    assert.equal(describeCall(d, account, call).lines[1].value, 'no daily limit')
  })

  await test('a review shows the daily limit', () => {
    const tiers = [{ upTo: NO_LIMIT, cap: 0n, delay: 0, period: 0, methods: 1 }]
    const call = { target: account, value: 0n, callData: encodeFunctionData({ abi: WaveAccountAbi, functionName: 'setTiers', args: [d.testUsdc, tiers, 300_000_000n] }) }
    assert.deepEqual(describeCall(d, account, call).lines[1], { label: 'Most per day', value: '300 tUSDC' })
    const data = encodeFunctionData({ abi: WaveAccountAbi, functionName: 'tighten', args: [d.testUsdc, tiers, 100_000_000n] })
    assert.deepEqual(describeSender(d, account, data).decoded.lines[1], { label: 'Most per day', value: '100 tUSDC' })
  })

  await test('the owner sees a repair and a removal as one action', () => {
    const repair = { target: account, value: 0n, callData: encodeFunctionData({ abi: WaveAccountAbi, functionName: 'setTiers', args: [d.testUsdc, [], 0n] }) }
    const remove = { target: account, value: 0n, callData: encodeFunctionData({ abi: WaveAccountAbi, functionName: 'uninstallModule', args: [11n, d.passkeyValidators[0], '0x'] }) }
    const text = describeSender(d, account, scheduleData(0, [repair, remove], pad('0x01', { size: 32 }))).decoded
    assert.equal(text.title, 'Remove passkey in slot 1, and change limits')
  })

  await test('the sponsor budget counts per wallet per day', () => {
    process.env.WAVE_SPONSOR_DAILY_TX = '2'
    const wallet = addr(50)
    const day = 86_400_000 * 20_000
    assert.equal(sponsor.dailyLimit(), 2)
    assert.equal(sponsor.takeBudget(wallet, day), true)
    assert.equal(sponsor.takeBudget(wallet, day), true)
    assert.equal(sponsor.takeBudget(wallet, day), false)
    assert.equal(sponsor.takeBudget(addr(51), day), true)
    sponsor.releaseBudget(wallet, day)
    assert.equal(sponsor.usedToday(wallet, day), 1)
    assert.equal(sponsor.takeBudget(wallet, day + 86_400_000), true)
    assert.equal(sponsor.usedToday(wallet, day + 86_400_000), 1)
    process.env.WAVE_SPONSOR_DAILY_TX = 'x'
    assert.equal(sponsor.dailyLimit(), 50)
    delete process.env.WAVE_SPONSOR_DAILY_TX
    assert.equal(sponsor.dailyLimit(), 50)
  })

  await test('the sponsor signs only the app shape, under the fee cap', async () => {
    const station = { station: addr(60), signer: addr(61) }
    const base = {
      account: addr(62),
      validator: addr(63),
      witnessLen: 512,
      verifyGas: 60_000n,
      sender: [{ data: '0x01' as Hex }],
      nonceSeq: 1n,
      sponsor: station,
    }
    const good = await frametx.buildTx(base)
    assert.equal(sponsor.shapeIsSponsorable(good, station), true)
    assert.equal(sponsor.feeIsSponsorable(good), true)
    assert.equal(frametx.withWitness(good, '0x02').signatures.length, 2)

    const selfPaid = await frametx.buildTx({ ...base, sponsor: null })
    assert.equal(sponsor.shapeIsSponsorable(selfPaid, station), false)
    assert.equal(sponsor.shapeIsSponsorable(good, { ...station, station: addr(64) }), false)
    assert.equal(sponsor.shapeIsSponsorable(good, { ...station, signer: addr(64) }), false)
    const toOther = { ...good, frames: good.frames.map((frame, i) => (i === 2 ? { ...frame, target: addr(65) } : frame)) }
    assert.equal(sponsor.shapeIsSponsorable(toOther, station), false)
    const withValue = { ...good, frames: good.frames.map((frame, i) => (i === 2 ? { ...frame, value: 1n } : frame)) }
    assert.equal(sponsor.shapeIsSponsorable(withValue, station), false)

    const fees = { maxFeePerGas: 11_000_000_000n, maxPriorityFeePerGas: 1n }
    assert.equal(sponsor.feeIsSponsorable(await frametx.buildTx({ ...base, fees })), false)
    const heavy = { ...base, sender: [{ data: '0x01' as Hex, execution: 9_000_000n, state: 9_000_000n }] }
    assert.equal(sponsor.feeIsSponsorable(await frametx.buildTx(heavy)), false)
  })

  await test('a sponsored transaction keeps its sig_hash after both signatures', async () => {
    const key = pad('0x07', { size: 32 })
    const tx = await frametx.buildTx({
      account: addr(62),
      validator: addr(63),
      witnessLen: 512,
      verifyGas: 60_000n,
      sender: [{ data: '0x01' as Hex }],
      nonceSeq: 1n,
      sponsor: { station: addr(60), signer: privateKeyToAccount(key).address },
    })
    const before = frametx.sigHashOf(tx)
    const signed = await frametx.signSponsor(frametx.withWitness(tx, pad('0x09', { size: 512 })), key)
    assert.equal(frametx.sigHashOf(signed), before)
    assert.equal(signed.signatures[1].signature.length, 2 + 65 * 2)
    assert.equal(frametx.sigHashOf(frametx.decodeRaw(frametx.encodeRaw(signed))), before)
  })

  assert.ok(encodeBatch([]))
  server.close()
  console.log(failures === 0 ? 'unit: all passed' : `unit: ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
