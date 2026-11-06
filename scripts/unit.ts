// Tests with no chain: decoding, text, input checks and the guards of the server code.
// A small fake RPC server plays the node. Run: npx tsx scripts/unit.ts
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { type AddressInfo } from 'node:net'
import { concat, encodeFunctionData, numberToHex, pad, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { MethodView, TokenInfo } from '../lib/api-types'

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

  await test('durations and demo delays', () => {
    assert.equal(format.formatDuration(604800), '7 days')
    assert.equal(format.formatDuration(1209600), '2 weeks')
    assert.equal(format.delayText(86400, 120), 'Demo delay: 2 minutes (real: 24 hours)')
    assert.equal(format.delayText(86400, 0), '24 hours')
    const tier = { upTo: '100', cap: '0', delay: 86400, period: 0, methods: 1, small: false, spent: '0', periodEndsAt: null }
    const summary = rules.describeSpend({ token: token.address, tiers: [tier] }, 1n, [], 120).summary
    assert.ok(summary.includes('Demo delay: 2 minutes (real: 24 hours)'), summary)
  })

  await test('labels and recovery choices', () => {
    const world: MethodView = { ref: { kind: 'world' }, validator: addr(1), mask: 1, backup: null }
    const bound: MethodView = { ref: { kind: 'passkey', slot: 1 }, validator: addr(2), mask: 2, backup: 'device-bound' }
    const synced: MethodView = { ref: { kind: 'passkey', slot: 2 }, validator: addr(3), mask: 4, backup: 'synced' }
    assert.equal(rules.methodLabel({ kind: 'world' }, { mode: 'dev' }), 'Test identity')
    assert.equal(rules.methodLabel({ kind: 'world' }), 'World ID')
    assert.deepEqual(
      rules.recoveryChoices([world, bound, synced], { mode: 'dev' }).map((choice) => choice.allowed),
      [false, true, false],
    )
    assert.equal(rules.recoveryChoices([bound], null, [{ kind: 'passkey', slot: 1 }])[0].allowed, false)
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
