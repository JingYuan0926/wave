// Runs the agent payment flow end to end, as Claude Code does. It starts mcp/wave-server.ts over
// stdio with the MCP SDK client, and it presses the real buttons on /agents in Chromium.
//
// THIS DOES NOT USE WORLD. A local fake issuer (scripts/lib/fake-issuer.ts) answers the device flow,
// and the local test identity approves wallet changes. A pass here proves the checks in WAVE only.
//
// Do not run this against the server on port 3000: it refuses that. Use a separate copy of the app,
// so that its .wave folder holds no real agent. The server and this script need the same values:
//   WAVE_NETWORK=local WAVE_DEMO_DELAY=20 WAVE_AGENT_DEMO_KEY=<a new key>
//   AGENT_PASS_CLIENT_ID=fake-client AGENT_PASS_CLIENT_SECRET=<any text>
//   AGENT_PASS_ISSUER=http://localhost:3101, with the World ID values blank at build time.
// Then: next build, next start -p 3100, and
//   WAVE_URL=http://localhost:3100 SMOKE_PLAYWRIGHT=<playwright-core> npx tsx scripts/mcp-smoke.ts
// SMOKE_SHOTS=<folder> saves phone and desktop screenshots. The run takes about 8 minutes, because
// it waits for the whole 3 minute approval window to end.
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts'
import {
  AGENT_METHOD_MASK,
  API_ROUTES,
  type Address,
  type AgentOperationView,
  type AgentPassStatusResponse,
  type AgentsResponse,
  type InfoResponse,
  type RootPublishResponse,
  type Tier,
  type TxPrepareResponse,
  type TxSendResponse,
  type WorldDevProofResponse,
} from '../lib/api-types'
import { publicClient } from '../lib/chain'
import { TestUSDCAbi } from '../lib/wave-abi'
import { openChromium, type AgentsPage, type Chromium } from './lib/agents-page'
import { startFakeIssuer, type FakeIssuer } from './lib/fake-issuer'

const BASE = process.env.WAVE_URL ?? 'http://localhost:3100'
const CLIENT_ID = process.env.AGENT_PASS_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.AGENT_PASS_CLIENT_SECRET ?? ''
const AGENT_KEY = process.env.WAVE_AGENT_DEMO_KEY ?? ''
const ISSUER = process.env.AGENT_PASS_ISSUER ?? ''
const SHOTS = process.env.SMOKE_SHOTS ?? null

const OWNER = 'fake-person-owner'
const STRANGER = 'fake-person-stranger'
const ONE = 1_000_000n
/** A clientRef stays on the server, so each run needs its own. */
const RUN = randomUUID().slice(0, 8)

let failures = 0
const hashes: string[] = []
const outputs: string[] = []

function check(ok: boolean, text: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${text}`)
  if (!ok) failures += 1
}

const step = (title: string) => console.log(`\n--- ${title}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(read: () => Promise<T | null | undefined | false>, label: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await sleep(500)
  }
}

async function rawPost(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as { error?: { code: string } } | null }
}

/** fetch cannot set the Host header, so this uses a plain HTTP request. */
function withHost(host: string, path: string, body: unknown, headers: Record<string, string>): Promise<number | undefined> {
  const { hostname, port } = new URL(BASE)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname, port, path, method: 'POST', headers: { ...headers, host, 'content-type': 'application/json' } },
      (response) => {
        response.resume()
        resolve(response.statusCode)
      },
    )
    request.on('error', reject)
    request.end(JSON.stringify(body))
  })
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const answer = await rawPost(path, body)
  if (answer.status >= 400) throw new Error(`${path} returned ${answer.status}: ${JSON.stringify(answer.body)}`)
  return answer.body as T
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`)
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  return (await response.json()) as T
}

/** A real MCP client on the real tool server, over stdio. */
async function startTools(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['--no-install', 'tsx', 'mcp/wave-server.ts'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', WAVE_URL: BASE },
  })
  const client = new Client({ name: 'wave-smoke', version: '0.0.1' })
  await client.connect(transport)
  return client
}

type ToolOutput = { text: string; isError: boolean }

function makeTool(client: Client) {
  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutput> => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as { type: string; text?: string }[]
    const text = content.map((item) => item.text ?? '').join('\n')
    outputs.push(text)
    console.log(`  [${name}] ${text.replace(/\n/g, '\n    ')}`)
    return { text, isError: result.isError === true }
  }
}

const field = (text: string, label: string) => text.match(new RegExp(`^${label}: (\\S+)`, 'm'))?.[1] ?? null

/** The first line of the action, as the page shows it. */
const actionTitle = (text: string) => text.split('\n')[1] ?? ''

type Waiting = { operation: string; code: string; title: string; text: string }

function waitingFrom(text: string): Waiting {
  const [operation, code] = [field(text, 'Operation'), field(text, 'Code')]
  if (!operation || !code) throw new Error(`No operation or code in: ${text}`)
  return { operation, code, title: actionTitle(text), text }
}

class Run {
  readonly tool: ReturnType<typeof makeTool>

  constructor(
    client: Client,
    readonly issuer: FakeIssuer,
    readonly page: AgentsPage,
    readonly usdc: Address,
    readonly agent: Address,
    readonly to: Address,
  ) {
    this.tool = makeTool(client)
  }

  balance(holder: Address): Promise<bigint> {
    return publicClient.readContract({ address: this.usdc, abi: TestUSDCAbi, functionName: 'balanceOf', args: [holder] })
  }

  send(amount: string, clientRef: string) {
    return this.tool('send_payment', { to: this.to, amount, token: 'tUSDC', clientRef: `${RUN}-${clientRef}` })
  }

  /** Asks for a payment above the alone amount. */
  async ask(amount: string, clientRef: string): Promise<Waiting> {
    const { text } = await this.send(amount, clientRef)
    check(text.startsWith('needs_approval'), `${amount} tUSDC needs approval`)
    return waitingFrom(text)
  }

  status(operation: string) {
    return get<AgentOperationView>(`${API_ROUTES.agentOperation}?id=${operation}`)
  }

  /** Waits until the fake issuer's answer reached the operation. */
  async approved(waiting: Waiting, sub = OWNER) {
    this.issuer.approve(waiting.code, sub)
    await until(
      async () => {
        const view = await this.status(waiting.operation)
        if (view.refusal) throw new Error(`The approval was refused: ${view.refusal.reason}`)
        return view.status === 'needs-confirmation'
      },
      'World ID step',
      20_000,
    )
  }

  /** Each check for "nothing moved" reads the chain, not the tool text. */
  async same(paid: bigint, label: string) {
    const now = await this.balance(this.to)
    check(now === paid, `${label}: the recipient holds ${now}, want ${paid}`)
  }

  async refusedOnPage(operation: string, status: AgentOperationView['status'], label: string) {
    const view = await until(
      async () => {
        const seen = await this.status(operation)
        return seen.status === status ? seen : null
      },
      label,
    ).catch(() => null)
    check(view !== null && view.txHash === null, `${label}: status ${status}, no transaction`)
  }
}

async function receiptOf(hash: string) {
  const response = await fetch(`${(await get<InfoResponse>(API_ROUTES.info)).rpcUrl}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
  })
  return ((await response.json()) as { result: { status: string; blockNumber: string } | null }).result
}

async function onChain(hash: string | null, label: string) {
  const receipt = hash ? await receiptOf(hash) : null
  check(receipt?.status === '0x1', `${label}: ${hash} is on chain in block ${receipt ? Number(receipt.blockNumber) : 'none'}`)
  if (hash) hashes.push(`${label}: ${hash}`)
}

async function basicSteps(run: Run) {
  const { tool, to } = run

  step('Step 1. get_balance and get_limits show the two numbers')
  const { text: balance } = await tool('get_balance')
  check(balance.includes(run.agent) && /\d+ tUSDC/.test(balance), 'get_balance names the agent and its tUSDC')
  check(balance.includes('The agent is active.'), 'get_balance says that the agent is active')
  const { text: limits } = await tool('get_limits')
  check(limits.includes('the agent sends alone up to 5. A human must approve above that.'), 'get_limits shows the alone amount')
  check(limits.includes('most per day 50, 50 left today'), 'get_limits shows the most per day')
  check(!limits.includes('one payment can send at most'), 'get_limits has no third number')

  step('Step 2. A payment under the alone amount')
  const small = await run.send('2', 'smoke-small')
  check(small.text.startsWith('sent.'), 'send_payment says sent')
  await onChain(field(small.text, 'Transaction'), 'alone payment of 2 tUSDC')
  await run.same(2n * ONE, 'after the alone payment')

  step('Step 3. A payment above the alone amount')
  const big = await run.ask('7', 'smoke-big')
  check(big.text.includes(to) && /7 tUSDC/.test(big.title), 'the output holds the exact action')
  check(field(big.text, 'Link') !== null && big.code.length > 0, 'the output holds the code and the link')
  await run.same(2n * ONE, 'needs_approval moved nothing')
  await run.page.page.getByText(big.code).first().waitFor({ timeout: 15_000 })
  await run.page.shot('needs-approval')

  step('Step 4. The fake issuer approves. This is not World.')
  await run.approved(big)
  const waiting = await run.tool('check_approval', { operationId: big.operation })
  check(waiting.text.startsWith('World ID passed.') && waiting.text.includes('Nothing was sent yet.'), 'check_approval waits for Confirm')
  await run.same(2n * ONE, 'check_approval moved nothing')
  await run.page.row(big.title).getByRole('button', { name: 'Confirm', exact: true }).waitFor({ timeout: 15_000 })
  await run.page.shot('confirm')
  await run.page.confirm(big.title)
  const done = await until(async () => {
    const view = await run.status(big.operation)
    return view.status === 'done' ? view : null
  }, 'the confirmed send', 60_000)
  await onChain(done.txHash, 'confirmed payment of 7 tUSDC')
  await run.same(9n * ONE, 'the confirmed payment ran once')

  step('Step 5. Retries send nothing')
  const again = await tool('check_approval', { operationId: big.operation })
  check(again.text.startsWith('sent.') && again.text.includes(done.txHash as string), 'check_approval shows the same hash')
  const repeat = await run.send('7', 'smoke-big')
  check(repeat.text.includes('This clientRef ran before') && repeat.text.includes(done.txHash as string), 'the same clientRef gives the same hash')
  const smallAgain = await run.send('2', 'smoke-small')
  check(smallAgain.text.includes('This clientRef ran before'), 'the alone payment does not repeat')
  const reused = await run.send('3', 'smoke-big')
  check(reused.isError && reused.text.includes('belongs to another payment'), 'another amount with that clientRef is refused')
  await run.same(9n * ONE, 'no retry moved anything')
}

/** Step 10 runs first: its payment must reach the page, so that a good token still works after. */
async function confirmGuards(run: Run) {
  step('Step 10. Confirm with no token or a wrong Origin')
  const op = await run.ask('6', 'smoke-guard')
  await run.approved(op)
  const operationId = op.operation
  const page = {
    origin: BASE,
    referer: `${BASE}/agents`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  }
  const refused = async (label: string, path: string, body: unknown, headers: Record<string, string>, status: number, code: string) => {
    const answer = await rawPost(path, body, headers)
    check(answer.status === status && answer.body?.error?.code === code, `${label}: HTTP ${answer.status} ${answer.body?.error?.code}`)
  }
  const decision = API_ROUTES.agentDecision
  const token = API_ROUTES.agentConfirmToken
  await refused('no page headers', decision, { operationId, decision: 'confirm' }, {}, 403, 'PAGE_ONLY')
  await refused('page headers, no token', decision, { operationId, decision: 'confirm' }, page, 403, 'CONFIRM_TOKEN_INVALID')
  await refused('page headers, wrong token', decision, { operationId, decision: 'confirm', confirmToken: 'x'.repeat(43) }, page, 403, 'CONFIRM_TOKEN_INVALID')
  await refused('wrong Origin on decision', decision, { operationId, decision: 'confirm' }, { ...page, origin: 'https://evil.example' }, 403, 'LOCAL_ONLY')
  await refused('wrong Origin on the token', token, { operationId }, { ...page, origin: 'https://evil.example' }, 403, 'LOCAL_ONLY')
  await refused('no page headers on the token', token, { operationId }, {}, 403, 'PAGE_ONLY')
  await refused('the Origin text null', decision, { operationId, decision: 'confirm' }, { ...page, origin: 'null' }, 403, 'LOCAL_ONLY')
  const tunnel = await withHost('evil.example', decision, { operationId, decision: 'confirm' }, page)
  check(tunnel === 403, `a tunnel host on decision: HTTP ${tunnel}`)
  await refused('text/plain', decision, { operationId, decision: 'confirm' }, { ...page, 'content-type': 'text/plain' }, 415, 'BAD_REQUEST')
  check((await run.status(operationId)).status === 'needs-confirmation', 'the operation still waits')
  await run.same(9n * ONE, 'no refused confirm moved anything')

  const reject = await rawPost(decision, { operationId, decision: 'reject' }, { origin: 'https://evil.example' })
  check(reject.status === 403, `a reject from another site: HTTP ${reject.status}`)

  await run.page.confirm(op.title)
  const done = await until(async () => {
    const view = await run.status(operationId)
    return view.status === 'done' ? view : null
  }, 'the guarded send', 60_000)
  await onChain(done.txHash, 'confirm after refused tries, 6 tUSDC')
  await run.same(15n * ONE, 'the page confirm still works')

  const replay = await run.page.page.evaluate(
    async ({ id, path }: { id: string; path: string }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: id }),
      })
      return response.status
    },
    { id: operationId, path: token },
  )
  check(replay === 409, `the page asks for a second token after the send: HTTP ${replay}`)
}

async function refusalSteps(run: Run) {
  step('Step 6. Denied, expired and wrong person')
  const denied = await run.ask('8', 'smoke-deny')
  run.issuer.deny(denied.code)
  await until(async () => (await run.status(denied.operation)).refusal?.reason === 'cancelled', 'the denial')
  const afterDeny = await run.tool('check_approval', { operationId: denied.operation })
  check(afterDeny.text.includes('The last approval did not pass') && afterDeny.text.includes('Nothing was sent'), 'check_approval shows the denial')
  check((await rawPost(API_ROUTES.agentPassDevice, { operationId: denied.operation })).status === 200, 'a person can start a new login')
  const second = (await run.status(denied.operation)).device?.userCode as string
  check(second !== denied.code, 'the new login has a new code')
  await run.approved({ ...denied, code: second })
  await run.page.reject(denied.title)
  await run.refusedOnPage(denied.operation, 'rejected', 'the owner rejects after World ID')
  const rejected = await run.send('8', 'smoke-deny')
  check(rejected.text.startsWith('refused.') && rejected.text.includes('The owner rejected this'), 'a retry of the rejected payment reads refused')

  const late = await run.ask('9', 'smoke-late-code')
  run.issuer.expire(late.code)
  await until(async () => (await run.status(late.operation)).refusal?.reason === 'expired', 'the expired code')
  const stale = await run.tool('check_approval', { operationId: late.operation })
  check(stale.text.includes('The last approval did not pass'), 'check_approval shows the expired code')

  const stranger = await run.ask('10', 'smoke-stranger')
  run.issuer.approve(stranger.code, STRANGER)
  await until(async () => (await run.status(stranger.operation)).refusal?.reason === 'identity_mismatch', 'the wrong person')
  check((await run.status(stranger.operation)).status === 'needs-approval', 'the wrong person gets no Confirm')
  await run.same(15n * ONE, 'denied, expired and wrong person sent nothing')
}

async function overDaily(run: Run) {
  step('Step 7. Above the daily total')
  const above = await run.send('60', 'smoke-over')
  check(above.text.startsWith('refused.') && above.text.includes('above the most per day'), '60 tUSDC is refused')
  check(!above.text.includes('Operation:') && !above.text.includes('Code:'), '60 tUSDC offers no approval')
  const left = await run.send('40', 'smoke-over-left')
  check(left.text.startsWith('refused.') && left.text.includes('35 tUSDC is left today'), '40 tUSDC is above the 35 left today')
  check(!left.text.includes('Operation:') && !left.text.includes('Code:'), '40 tUSDC offers no approval')
  await run.same(15n * ONE, 'above the daily total sent nothing')
}

async function limitSheet(run: Run) {
  const { page, tool } = run
  step('Limits sheet. A lower alone amount applies at once, and it ends an open approval')
  const open = await run.ask('6.5', 'smoke-limit-open')
  await run.approved(open)
  const sheet = await page.editLimits('3', '50')
  await page.shot('limits-sheet')
  check((await sheet.innerText()).includes('The alone amount applies at once.'), 'the sheet says what Save does')
  await page.pressSave(sheet)
  await sheet.getByText('The alone amount is saved.').waitFor({ timeout: 15_000 })
  await page.closeSheet()
  const lower = await tool('get_limits')
  check(lower.text.includes('sends alone up to 3.'), 'get_limits shows the lower alone amount')
  await page.confirm(open.title)
  await run.refusedOnPage(open.operation, 'failed', 'a confirm after the limit changed')
  await run.same(15n * ONE, 'the changed limit stopped the old approval')
  const between = await run.ask('4', 'smoke-between')
  await page.reject(between.title)
  await run.refusedOnPage(between.operation, 'rejected', '4 tUSDC now asks for a human')

  step('Limits sheet. A lower most per day goes through the Approve sheet')
  const tighter = await page.editLimits('3', '45')
  await page.pressSave(tighter)
  check((await page.approveInSheet()) === 'Sent', 'the tighten ran')
  await page.closeSheet()
  await until(async () => (await tool('get_limits')).text.includes('most per day 45, 30 left today'), 'the tighten')
  check(true, 'get_limits shows 45 and 30 left')

  step('Limits sheet. One Save raises both limits')
  const both = await page.editLimits('6', '60')
  const line = await both.innerText()
  check(line.includes('The higher alone amount needs your approval') && line.includes('The new onchain limit needs the owner method'), 'the sheet names both steps')
  await page.pressSave(both)
  const raised = await page.approveInSheet()
  check(raised === 'Applied', `the owner method applied the higher limit: ${raised}`)
  await page.closeSheet()
  await until(async () => (await tool('get_limits')).text.includes('most per day 60, 45 left today'), 'the loosen')
  const views = await get<AgentsResponse>(`${API_ROUTES.agents}?master=${(await page.stored()).wallet.address}`)
  const raise = views.operations.find((item) => item.status === 'needs-approval' && item.decoded.title.includes('send alone up to 6'))
  check(raise !== undefined, 'the higher alone amount waits in Needs human approval')
  const title = raise?.decoded.title as string
  await page.startLogin(title)
  const started = await until(async () => {
    const view = await run.status(raise?.id as string)
    return view.device ? view : null
  }, 'the login from the page')
  await run.approved({ operation: started.id, code: started.device?.userCode as string, title, text: '' })
  await page.confirm(title)
  await run.refusedOnPage(started.id, 'done', 'the raise ran with no payment')
  check((await tool('get_limits')).text.includes('sends alone up to 6.'), 'get_limits shows the higher alone amount')
  await run.same(15n * ONE, 'the limit changes moved no token')
  await page.shot('agent-card')

  const unchanged = await page.editLimits('6', '60')
  check(await unchanged.getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'Save stays off with no change')
  await unchanged.getByLabel('Token').selectOption({ label: 'ETH' })
  await unchanged.locator('input[name="agent-alone"]').fill('0.1')
  await unchanged.locator('input[name="agent-per-day"]').fill('0.5')
  check((await unchanged.innerText()).includes('The new onchain limit needs the owner method'), 'a token with no limit needs the owner method')
  await page.closeSheet()
}

async function stoppedAgent(run: Run) {
  step('Step 8. A paused agent, then a revoked agent')
  const open = await run.ask('13', 'smoke-paused-open')
  await run.approved(open)
  await run.page.adminAction('Pause')
  await until(async () => (await run.tool('get_balance')).text.includes('The agent is paused.'), 'the pause')
  const small = await run.send('1', 'smoke-paused')
  check(small.text.startsWith('refused.'), 'a paused agent refuses a payment under the alone amount')
  const big = await run.send('10.5', 'smoke-paused-big')
  check(big.text.startsWith('refused.') && !big.text.includes('Operation:'), 'a paused agent offers no approval')
  await run.page.confirm(open.title)
  await run.refusedOnPage(open.operation, 'failed', 'a confirm of an approved payment while paused')
  await run.page.adminAction('Revoke key')
  await until(async () => (await run.tool('get_balance')).text.includes('The agent key is revoked.'), 'the revoke')
  const after = await run.send('1', 'smoke-revoked')
  check(after.text.startsWith('refused.'), 'a revoked agent refuses a payment')
  await run.same(15n * ONE, 'paused and revoked sent nothing')
}

/** The approvals that nobody finished. Their window of 3 minutes must end by itself. */
async function windowEnd(run: Run, idle: Waiting, unconfirmed: Waiting) {
  step('Step 6. The whole approval window ends')
  const left = (await run.status(idle.operation)).expiresAt - Date.now()
  await sleep(Math.max(0, left) + 2000)
  const waited = await run.tool('check_approval', { operationId: idle.operation })
  check(waited.text.startsWith('refused.') && waited.text.includes('window ended'), 'an idle approval expires')
  const confirmed = await run.tool('check_approval', { operationId: unconfirmed.operation })
  check(confirmed.text.startsWith('refused.'), 'a World ID pass with no Confirm expires')
  const retry = await run.send('12', 'smoke-window-confirm')
  check(retry.text.startsWith('refused.') && retry.text.includes('window ended'), 'a retry of the expired payment reads refused')
  const late = await run.page.page.evaluate(
    async ({ id, path }: { id: string; path: string }) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationId: id }),
        })
      ).status,
    { id: unconfirmed.operation, path: API_ROUTES.agentConfirmToken },
  )
  check(late === 409, `the page gets no token after the window: HTTP ${late}`)
  await run.same(15n * ONE, 'the ended window sent nothing')
}

async function createOldAgent(page: AgentsPage, usdc: Address) {
  const { wallet, identity } = await page.stored()
  const { next } = await get<AgentsResponse>(`${API_ROUTES.agents}?master=${wallet.address}`)
  if (!next) throw new Error('The server gave no next agent.')
  const tier: Tier = {
    upTo: (5n * ONE).toString(),
    cap: (100n * ONE).toString(),
    delay: 0,
    period: 86_400,
    methods: AGENT_METHOD_MASK,
    small: false,
  }
  const action = { kind: 'agent', agent: next.address, op: { kind: 'create', salt: next.salt, rules: [{ token: usdc, tiers: [tier] }] } }
  let rootHint = wallet.rootHint
  for (let scan = 0; scan < 3; scan += 1) {
    const prepared = await post<TxPrepareResponse>(API_ROUTES.txPrepare, {
      account: wallet.address,
      deployment: wallet.plan,
      action,
      method: { kind: 'world' },
      rootHint,
    })
    if (!prepared.ok) throw new Error(`prepare: ${JSON.stringify(prepared.rejection)}`)
    const proof = await post<WorldDevProofResponse>(API_ROUTES.worldDevProof, { identity, signal: prepared.sigHash })
    if (BigInt(proof.merkleRoot) !== BigInt(prepared.rootReference?.root ?? 0)) {
      await post<RootPublishResponse>(API_ROUTES.rootPublish, { root: proof.merkleRoot })
      rootHint = proof.merkleRoot
      continue
    }
    const sent = await post<TxSendResponse>(API_ROUTES.txSend, {
      envelope: prepared.envelope,
      method: prepared.method,
      witness: { kind: 'world', root: proof.merkleRoot, nullifierHash: proof.nullifierHash, proof: proof.proof },
    })
    if (!sent.ok) throw new Error(`send: ${JSON.stringify(sent.rejection)}`)
    await post(API_ROUTES.agentCheckpoint, { agent: next.address, token: usdc, askAbove: (50n * ONE).toString() })
    return next.address
  }
  throw new Error('The root changed three times.')
}

/** The shape of an agent from before the two fields, on a wallet with a wait. */
async function oldShape(browser: Chromium, client: Client, issuer: FakeIssuer, usdc: Address) {
  step('An agent with the old shape: Save converts it, through the wait of the wallet')
  const page = await browser.newWallet('5 seconds (demo)')
  const agent = await createOldAgent(page, usdc)
  await page.card().waitFor({ timeout: 30_000 })
  await page.useWithClaude()
  await page.getTestUsdc()
  const to = privateKeyToAddress(generatePrivateKey())
  const run = new Run(client, issuer, page, usdc, agent, to)
  await until(async () => (await run.balance(agent)) > 0n, 'the faucet', 40_000)
  const before = await run.tool('get_limits')
  check(before.text.includes('sends alone up to 5.'), 'get_limits shows the effective alone amount, not the stored 50')
  check(before.text.includes('one payment can send at most 5'), 'get_limits shows the old third number')
  const note = 'The saved alone amount is 50 tUSDC, but the chain stops one payment at 5 tUSDC. Save in Limits fixes this.'
  check((await page.card().innerText()).includes(note), 'the card names the old limit')
  const old = await run.send('6', 'smoke-old-refused')
  check(old.text.startsWith('refused.') && old.text.includes('One payment can send at most 5 tUSDC'), 'the old shape refuses 6 tUSDC')

  const sheet = await page.editLimits('5', '100')
  await page.shot('limits-old-shape')
  const saveLine = await sheet.innerText()
  check(saveLine.includes('The alone amount applies at once.') && saveLine.includes('The new onchain limit needs the owner method'), 'Save names both steps')
  await page.pressSave(sheet)
  const queued = await page.approveInSheet()
  check(queued === 'Queued', `the raise waits in the queue: ${queued}`)
  await page.closeSheet()
  const early = await run.send('6', 'smoke-old-early')
  check(early.text.startsWith('refused.'), 'the old limit holds during the wait')
  await page.executeQueued()
  const after = await until(async () => {
    const seen = await run.tool('get_limits')
    return seen.text.includes('one payment can send at most') ? null : seen
  }, 'the queued change', 60_000)
  check(after.text.includes('most per day 100, 100 left today'), 'get_limits has only two numbers')
  const ask = await run.ask('6', 'smoke-old-now')
  check(ask.text.includes('Step 1. Approve with World ID'), 'after Save, 6 tUSDC asks for a human')
  await page.page.getByText(ask.code).first().waitFor({ timeout: 15_000 })
  await page.reject(ask.title)
  await run.refusedOnPage(ask.operation, 'rejected', 'the owner rejects')
  await run.same(0n, 'the old-shape agent sent nothing')

  step('Two calls at once cannot pay twice')
  const race = await Promise.all([run.send('1', 'smoke-race'), run.send('1', 'smoke-race')])
  const [first, second] = race.map(({ text }) => field(text, 'Transaction'))
  check(first !== null && first === second, 'two calls with one clientRef give one hash')
  await onChain(first, 'race payment of 1 tUSDC')
  await run.same(ONE, 'the race paid once')

  const pair = await run.ask('7', 'smoke-two-tabs')
  await run.approved(pair)
  const codes: number[] = await page.page.evaluate(
    async ({ id, token, decision }: { id: string; token: string; decision: string }) => {
      // tsx renames a named function here, and the page does not have its helper.
      const headers = { 'content-type': 'application/json' }
      const first = await fetch(token, { method: 'POST', headers, body: JSON.stringify({ operationId: id }) })
      const { confirmToken } = await first.json()
      const body = JSON.stringify({ operationId: id, decision: 'confirm', confirmToken })
      const answers = await Promise.all([1, 2].map(() => fetch(decision, { method: 'POST', headers, body })))
      return answers.map((item) => item.status)
    },
    { id: pair.operation, token: API_ROUTES.agentConfirmToken, decision: API_ROUTES.agentDecision },
  )
  check(codes.filter((code) => code === 200).length === 1, `two confirms with one token, HTTP ${codes.join(' and ')}`)
  const paid = await until(async () => {
    const view = await run.status(pair.operation)
    return view.status === 'done' ? view : null
  }, 'the confirmed send', 60_000)
  await onChain(paid.txHash, 'two tabs payment of 7 tUSDC')
  await run.same(8n * ONE, 'two confirms paid once')
}

async function createForm(page: AgentsPage) {
  step('The create form, in Chromium')
  await page.fillLimits('60', '50')
  check((await page.text()).includes('This must be 50 tUSDC or less, the most per day.'), 'alone above daily shows an error')
  check(await page.page.getByRole('button', { name: /^Create with/ }).isDisabled(), 'Create stays off')
  await page.fillLimits('5', '')
  check(await page.page.getByRole('button', { name: /^Create with/ }).isDisabled(), 'Create stays off with no most per day')
  await page.fillLimits('5', '50')
  const summary = 'Up to 5 tUSDC: the agent sends alone. Above that: you approve with World ID. Most per day: 50 tUSDC.'
  check((await page.text()).includes(summary), 'the summary line is exact')
  await page.shot('create-form')
}

function secretsCheck(run: Run, raw: string[]) {
  step('Step 9. No tool output has a key, secret, token or device_code')
  const all = [...outputs, ...raw].join('\n')
  const exact = [CLIENT_SECRET, AGENT_KEY, AGENT_KEY.slice(2), ...run.issuer.secrets()]
  check(run.issuer.secrets().length > 0, `the fake issuer gave out ${run.issuer.secrets().length} device codes and tokens`)
  check(!exact.some((value) => all.includes(value)), `${outputs.length} tool outputs and ${raw.length} route bodies hold no exact secret`)
  check(!/device_code|client_secret|id_token|confirmToken|access_token|eyJ[\w-]{10,}\./i.test(all), 'no secret field name or JWT in any output')
}

async function main() {
  const { port, hostname } = new URL(ISSUER)
  if (port === '' || hostname !== 'localhost') throw new Error('AGENT_PASS_ISSUER must be the local fake issuer.')
  if (new URL(BASE).port === '3000') throw new Error('Do not run this on port 3000. It uses a test server.')
  if (!CLIENT_SECRET || !AGENT_KEY) throw new Error('Set the same values as the test server.')

  const issuer = await startFakeIssuer(Number(port), CLIENT_ID, CLIENT_SECRET)
  console.log(`server ${BASE}. Fake issuer ${issuer.url}. THIS IS NOT WORLD.`)
  const browser = await openChromium(BASE, SHOTS)
  try {
    const info = await get<InfoResponse>(API_ROUTES.info)
    const pass = await get<AgentPassStatusResponse>(API_ROUTES.agentPassStatus)
    if (info.world.mode !== 'dev' || pass.issuer !== issuer.url) throw new Error('The server does not use the test identity and the fake issuer.')
    const usdc = info.tokens.find((token) => token.isTest)?.address as Address

    const page = await browser.newWallet()
    await createForm(page)
    const created = await page.createAgent('5', '50')
    check(created === 'Sent', `Chromium created the agent: ${created}`)
    await page.useWithClaude()
    await page.getTestUsdc()
    const master = (await page.stored()).wallet.address
    const agent = (await get<AgentsResponse>(`${API_ROUTES.agents}?master=${master}`)).agents[0].address
    await until(async () => (await publicClient.readContract({ address: usdc, abi: TestUSDCAbi, functionName: 'balanceOf', args: [agent] })) > 0n, 'the faucet', 40_000)

    const client = await startTools()
    const names = (await client.listTools()).tools.map((item) => item.name).sort()
    check(names.join() === 'check_approval,get_balance,get_limits,send_payment', `the tools: ${names.join(', ')}`)

    const to = privateKeyToAddress(generatePrivateKey())
    const run = new Run(client, issuer, page, usdc, agent, to)
    await basicSteps(run)
    await confirmGuards(run)
    await refusalSteps(run)
    const idle = await run.ask('11', 'smoke-window-idle')
    const unconfirmed = await run.ask('12', 'smoke-window-confirm')
    await run.approved(unconfirmed)
    await overDaily(run)
    await limitSheet(run)
    await stoppedAgent(run)
    await windowEnd(run, idle, unconfirmed)

    const raw = [
      JSON.stringify(await get(`${API_ROUTES.agents}?master=${master}`)),
      JSON.stringify(await get(API_ROUTES.mcpAgent)),
      JSON.stringify(await run.status(idle.operation)),
    ]
    await oldShape(browser, client, issuer, usdc)
    secretsCheck(run, raw)
    check(browser.errors.length === 0, `the page threw no error: ${browser.errors.join(' | ')}`)
    await client.close()
  } finally {
    await browser.close()
    await issuer.stop()
  }

  console.log('\nTransactions:')
  hashes.forEach((line) => console.log(`  ${line}`))
  console.log(failures === 0 ? '\nMCP smoke passed. It used a fake issuer, not World.' : `\nMCP smoke FAILED: ${failures} checks`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('FATAL', error instanceof Error ? error.message : error)
  process.exit(1)
})
