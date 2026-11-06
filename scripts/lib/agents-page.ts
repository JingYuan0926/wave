// Drives the real /agents page in Chromium for scripts/mcp-smoke.ts. Playwright is not a project
// dependency. Set SMOKE_PLAYWRIGHT to the path of a playwright-core build, or install it locally.
// All approvals use the local test identity. It makes real proofs, but it is not a World ID.
import path from 'node:path'
import type { Address, DevIdentity, Hex, WalletPlan } from '../../lib/api-types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- The project has no Playwright types.
type Page = any

type Stored = { wallet: { address: Address; plan: WalletPlan; rootHint: Hex | null }; identity: DevIdentity }

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 900 }
const LONG = { timeout: 90_000 }

export class AgentsPage {
  constructor(
    readonly page: Page,
    private readonly base: string,
    private readonly shots: string | null,
  ) {}

  /** Writes one phone and one desktop screenshot of the whole page. */
  async shot(name: string) {
    if (!this.shots) return
    for (const [label, size] of [['phone', PHONE], ['desktop', DESKTOP]] as const) {
      await this.page.setViewportSize(size)
      await this.page.waitForTimeout(300)
      await this.page.screenshot({ path: path.join(this.shots, `${name}-${label}.png`), fullPage: true })
    }
  }

  /** Creates a wallet with the test identity. It deploys at its first transaction. */
  async createWallet(waitLabel?: string) {
    await this.page.goto(this.base)
    await this.page.getByRole('heading', { name: 'Choose how you approve' }).waitFor(LONG)
    await this.page.getByRole('checkbox', { name: /World ID/ }).check()
    if (waitLabel) {
      await this.page.getByRole('checkbox', { name: 'Wait before risky changes' }).check()
      await this.page.getByLabel('Wait for').selectOption({ label: waitLabel })
    }
    await this.page.getByRole('button', { name: /Create wallet with World ID/ }).click()
    await this.page.getByRole('link', { name: 'Agents' }).first().waitFor(LONG)
    await this.page.getByText('Not deployed yet').waitFor(LONG)
    await this.openAgents()
  }

  async openAgents() {
    await this.page.goto(`${this.base}/agents`)
    await this.page.getByRole('heading', { name: 'Agent wallets' }).waitFor(LONG)
    await this.page.getByRole('heading', { name: 'Create an agent wallet' }).waitFor(LONG)
  }

  /** What only this browser holds. A script needs it to make an agent that the page cannot make. */
  stored(): Promise<Stored> {
    return this.page.evaluate(() => JSON.parse(localStorage.getItem('wave.local.v1') as string))
  }

  /** One field at a time. A fill moves the focus, so two at once type into the wrong field. */
  async fillLimits(alone: string, perDay: string) {
    await this.page.locator('input[name="agent-alone"]').first().fill(alone)
    await this.page.locator('input[name="agent-per-day"]').first().fill(perDay)
  }

  /** The text of the page, for a check on what the owner reads. */
  text(): Promise<string> {
    return this.page.locator('body').innerText()
  }

  /** Scans in the open Approve sheet and waits for its result. The result stays on the sheet. */
  async approveInSheet(): Promise<string> {
    const result = this.page.locator('p.font-semibold').getByText(/^(Sent|Applied|Queued)$/)
    const scan = this.page.getByRole('button', { name: /^(Scan with World ID|Scan again)$/ })
    await result.or(scan).first().waitFor(LONG)
    if (await scan.isVisible()) await scan.click()
    await result.or(scan.filter({ hasText: 'Scan again' })).first().waitFor(LONG)
    if (await scan.isVisible()) await scan.click()
    await result.waitFor(LONG)
    return result.innerText()
  }

  closeSheet() {
    return this.page.keyboard.press('Escape')
  }

  /** Creates an agent through the form. It returns when the card is on the page. */
  async createAgent(alone: string, perDay: string, cardName = 'Agent 1') {
    await this.fillLimits(alone, perDay)
    await this.page.getByRole('button', { name: /^Create with/ }).click()
    const result = await this.approveInSheet()
    await this.closeSheet()
    await this.card(cardName).waitFor(LONG)
    return result
  }

  card(name = 'Agent 1') {
    return this.page.locator(`section[aria-label="${name}"]`)
  }

  async getTestUsdc(name = 'Agent 1') {
    await this.card(name).getByRole('button', { name: 'Get test USDC' }).click()
    await this.page.waitForTimeout(500)
    await this.card(name).getByRole('button', { name: 'Get test USDC' }).waitFor(LONG)
  }

  async useWithClaude(name = 'Agent 1') {
    await this.card(name).getByRole('button', { name: 'Use with Claude Code' }).click()
    await this.card(name).getByText('Claude Code uses this agent').waitFor(LONG)
  }

  /** Opens the Limits sheet and types new values. The caller presses Save. */
  async editLimits(alone: string, perDay: string, name = 'Agent 1') {
    await this.card(name).getByRole('button', { name: 'Limits', exact: true }).click()
    const sheet = this.page.getByRole('dialog')
    await sheet.getByRole('heading', { name: 'Agent limits' }).waitFor(LONG)
    await sheet.locator('input[name="agent-alone"]').fill(alone)
    await sheet.locator('input[name="agent-per-day"]').fill(perDay)
    return sheet
  }

  async pressSave(sheet: Page) {
    await sheet.getByRole('button', { name: 'Save', exact: true }).click()
  }

  /** Presses a card button that opens the Approve sheet, then scans. */
  async adminAction(button: string, name = 'Agent 1') {
    await this.card(name).getByRole('button', { name: button, exact: true }).click()
    const result = await this.approveInSheet()
    await this.closeSheet()
    return result
  }

  /** The row of one waiting action. `title` is the action title from the tool output. */
  row(title: string) {
    return this.page.locator('li').filter({ hasText: title }).first()
  }

  async confirm(title: string) {
    const button = this.row(title).getByRole('button', { name: 'Confirm', exact: true })
    await button.waitFor(LONG)
    await button.click()
  }

  /** Starts the World ID login from the page. The code then shows in the row. */
  async startLogin(title: string) {
    await this.row(title).getByRole('button', { name: 'Approve with World ID', exact: true }).click()
  }

  async reject(title: string) {
    const button = this.row(title).getByRole('button', { name: 'Reject', exact: true })
    await button.waitFor(LONG)
    await button.click()
  }

  /** Runs one queued action from the Wallet page, when its wait ends. */
  async executeQueued() {
    await this.page.goto(this.base)
    const button = this.page.getByRole('button', { name: 'Execute', exact: true })
    await button.waitFor(LONG)
    await this.page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Execute' && !item.disabled),
      undefined,
      LONG,
    )
    await button.click()
    await button.waitFor({ state: 'detached', ...LONG })
    await this.openAgents()
  }
}

export type Chromium = {
  newWallet: (waitLabel?: string) => Promise<AgentsPage>
  /** Each page error and failed asset. A test checks that this stays empty. */
  errors: string[]
  close: () => Promise<void>
}

export async function openChromium(base: string, shots: string | null): Promise<Chromium> {
  const source = process.env.SMOKE_PLAYWRIGHT ?? 'playwright-core'
  const { chromium } = await import(source)
  const browser = await chromium.launch({ headless: true })
  const errors: string[] = []
  return {
    errors,
    newWallet: async (waitLabel) => {
      // One context per wallet, because the page keeps one wallet in localStorage.
      const context = await browser.newContext({ viewport: DESKTOP })
      const page = await context.newPage()
      page.on('pageerror', (error: Error) => errors.push(`pageerror: ${error.message.slice(0, 200)}`))
      const agents = new AgentsPage(page, base, shots)
      await agents.createWallet(waitLabel)
      return agents
    },
    close: () => browser.close(),
  }
}
