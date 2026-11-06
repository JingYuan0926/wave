// World ID Agent Pass: an OIDC step-up that guards one protected action. Server side only.
// The server keeps each attempt by `state`, because the flow starts on localhost and returns on
// the tunnel host, so a browser cookie cannot bind them.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose'
import { after } from 'next/server'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import {
  AGENT_PASS_OPERATION,
  type AgentPassAttempt,
  type AgentPassReason,
  type AgentPassStartResponse,
  type AgentPassStatusResponse,
} from '../api-types'
import { LEGACY_TX, devWallet, explorerLink, publicClient } from '../chain'
import { TestUSDCAbi } from '../wave-abi'
import { identityOf, linkIdentity } from './agent-store'
import { ApiFailure, deployment } from './http'
import { withDevKey } from './roots'

const DEFAULT_ISSUER = 'https://sandbox.auth.world.org'
const DEFAULT_REDIRECT_URI = 'http://localhost:3000/api/agent-pass/callback'
// Orb, and Orb with Face Auth. The sandbox discovery document lists these two only.
const DEFAULT_ACR = 'https://world.org/oidc/acr/orb,https://world.org/oidc/acr/orb-face'

/** The browser returns here. The owner uses the app on this host, not on the tunnel host. */
const RETURN_URL = 'http://localhost:3000/settings'
/** The return page for an agent action, and for a callback that matches no attempt. */
const AGENTS_URL = 'http://localhost:3000/agents'

const ATTEMPT_MS = 5 * 60_000
const CLOCK_SKEW_SECONDS = 30
const DISCOVERY_MS = 60 * 60_000
const FETCH_TIMEOUT_MS = 10_000
const RECEIPT_TIMEOUT_MS = 60_000
/** Ended attempts stay this long, so a late callback reads as a replay. */
const KEEP_ENDED_MS = 60 * 60_000
/** The callback is public through the tunnel, so bad requests must not fill the memory. */
const MAX_ATTEMPTS = 500

/** 1 tUSDC. The token has 6 decimals. */
const DEMO_AMOUNT = 1_000_000n
const MINT_GAS = 500_000n

type Config = {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  acr: string[]
}

type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  authorization_response_iss_parameter_supported?: boolean
}

type Stage = 'pending' | 'checking' | 'running' | 'approved' | 'failed'

/** An exact action that waits for a human. lib/server/agents.ts owns the action itself. */
export type GuardedAction = {
  /** Unix milliseconds. It does not move when a person tries again. */
  expiresAt: number
  /** Uses the one-use approval. This must not await. False if the action cannot run now. */
  consume: () => boolean
  /** Runs after consume. It records its own failure and gives the transaction hash, if any. */
  run: () => Promise<Hex | null>
  /** One attempt failed. The action stays unsent. */
  refused: (reason: AgentPassReason, detail: string) => void
  returnUrl: string
}

type Attempt = {
  id: string
  /** Empty for a record of a callback that matched no live attempt. */
  state: string
  nonce: string
  codeVerifier: string
  approvalId: string
  wallet: Address | null
  token: Address | null
  createdAt: number
  expiresAt: number
  stage: Stage
  reason: AgentPassReason | null
  detail: string | null
  txHash: Hex | null
  acr: string | null
  amr: string[] | null
  identity: 'linked' | 'matched' | null
  /** Null for the test panel: its action is a mint, and the wallet has no agent. */
  guarded: GuardedAction | null
}

type Store = {
  byState: Map<string, Attempt>
  byId: Map<string, Attempt>
  /** Each ID leaves this set once, and only one caller can remove it. */
  openApprovals: Set<string>
  discovery: Map<string, { doc: Discovery; until: number }>
  jwks: Map<string, ReturnType<typeof createRemoteJWKSet>>
}

// Each route has its own module copy in dev, so the state lives on globalThis.
const shared = globalThis as typeof globalThis & { __waveAgentPass?: Store }
const store: Store = (shared.__waveAgentPass ??= {
  byState: new Map(),
  byId: new Map(),
  openApprovals: new Set(),
  discovery: new Map(),
  jwks: new Map(),
})

/** A stop with a reason code. Every path that throws this leaves the action not run. */
class Refusal extends Error {
  constructor(
    readonly reason: AgentPassReason,
    readonly detail: string,
  ) {
    super(detail)
  }
}

export const agentPassConfigured = (): boolean => readConfig() !== null

function readConfig(): Config | null {
  const clientId = process.env.AGENT_PASS_CLIENT_ID?.trim()
  const clientSecret = process.env.AGENT_PASS_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return null
  return {
    issuer: issuerName(),
    clientId,
    clientSecret,
    redirectUri: process.env.AGENT_PASS_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI,
    acr: (process.env.AGENT_PASS_ACR?.trim() || DEFAULT_ACR)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

function issuerName(): string {
  return (process.env.AGENT_PASS_ISSUER?.trim() || DEFAULT_ISSUER).replace(/\/$/, '')
}

async function discover(issuer: string): Promise<Discovery> {
  const cached = store.discovery.get(issuer)
  if (cached && cached.until > Date.now()) return cached.doc
  let doc: Discovery
  try {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    doc = (await response.json()) as Discovery
  } catch {
    throw new Refusal('provider_error', 'The World discovery document did not load.')
  }
  if (doc.issuer !== issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Refusal('provider_error', 'The World discovery document does not match the issuer.')
  }
  store.discovery.set(issuer, { doc, until: Date.now() + DISCOVERY_MS })
  return doc
}

function jwksFor(uri: string) {
  let jwks = store.jwks.get(uri)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(uri))
    store.jwks.set(uri, jwks)
  }
  return jwks
}

function prune() {
  const now = Date.now()
  const drop = (attempt: Attempt) => {
    store.byId.delete(attempt.id)
    if (attempt.state) store.byState.delete(attempt.state)
    store.openApprovals.delete(attempt.approvalId)
  }
  for (const attempt of store.byId.values()) {
    if (attempt.expiresAt + KEEP_ENDED_MS < now) drop(attempt)
  }
  // A Map keeps its insertion order, so this removes the oldest first.
  for (const attempt of store.byId.values()) {
    if (store.byId.size <= MAX_ATTEMPTS) break
    if (attempt.stage === 'failed' || attempt.stage === 'approved') drop(attempt)
  }
}

function end(attempt: Attempt, reason: AgentPassReason, detail: string) {
  attempt.stage = 'failed'
  attempt.reason = reason
  attempt.detail = detail
  store.openApprovals.delete(attempt.approvalId)
  attempt.guarded?.refused(reason, detail)
}

function expireIfDue(attempt: Attempt) {
  if (attempt.stage === 'pending' && Date.now() > attempt.expiresAt) {
    end(attempt, 'expired', 'The 5-minute window ended before World ID returned.')
  }
}

/** Records a callback that has no live attempt. This never changes the first attempt's result. */
function refusedCallback(reason: AgentPassReason, detail: string, first?: Attempt): string {
  prune()
  const now = Date.now()
  const record: Attempt = {
    id: randomUUID(),
    state: '',
    nonce: '',
    codeVerifier: '',
    approvalId: '',
    wallet: first?.wallet ?? null,
    token: first?.token ?? null,
    createdAt: now,
    expiresAt: first?.expiresAt ?? 0,
    stage: 'failed',
    reason,
    detail,
    txHash: null,
    acr: null,
    amr: null,
    identity: null,
    guarded: first?.guarded ?? null,
  }
  store.byId.set(record.id, record)
  return record.id
}

function toView(attempt: Attempt): AgentPassAttempt {
  expireIfDue(attempt)
  const { stage, wallet, token, txHash } = attempt
  return {
    id: attempt.id,
    status: stage === 'checking' ? 'running' : stage,
    reason: attempt.reason,
    detail: attempt.detail,
    operation:
      wallet && token
        ? { kind: AGENT_PASS_OPERATION, to: wallet, token, amount: DEMO_AMOUNT.toString() }
        : null,
    expiresAt: attempt.expiresAt,
    txHash,
    explorerUrl: txHash ? explorerLink(txHash) : null,
    acr: attempt.acr,
    amr: attempt.amr,
    identity: attempt.identity,
  }
}

export function readStatus(id: string | null): AgentPassStatusResponse {
  const issuer = issuerName()
  const attempt = id ? store.byId.get(id) : undefined
  return {
    configured: readConfig() !== null,
    issuer,
    sandbox: new URL(issuer).hostname.startsWith('sandbox.'),
    attempt: attempt ? toView(attempt) : null,
  }
}

export async function startAttempt(wallet: Address, guarded?: GuardedAction): Promise<AgentPassStartResponse> {
  const config = readConfig()
  if (!config) throw new ApiFailure('AGENT_PASS_NOT_CONFIGURED', 'Agent Pass is not configured.', 503)
  let doc: Discovery
  try {
    doc = await discover(config.issuer)
  } catch (error) {
    throw new ApiFailure('AGENT_PASS_UNAVAILABLE', (error as Error).message, 502)
  }

  prune()
  const now = Date.now()
  const attempt: Attempt = {
    id: randomUUID(),
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    codeVerifier: randomBytes(32).toString('base64url'),
    approvalId: randomUUID(),
    wallet,
    token: guarded ? null : deployment().testUsdc,
    createdAt: now,
    expiresAt: guarded?.expiresAt ?? now + ATTEMPT_MS,
    stage: 'pending',
    reason: null,
    detail: null,
    txHash: null,
    acr: null,
    amr: null,
    identity: null,
    guarded: guarded ?? null,
  }
  store.byState.set(attempt.state, attempt)
  store.byId.set(attempt.id, attempt)
  store.openApprovals.add(attempt.approvalId)

  const url = new URL(doc.authorization_endpoint)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid',
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge: createHash('sha256').update(attempt.codeVerifier).digest('base64url'),
    code_challenge_method: 'S256',
    // max_age=0 asks for a new authentication, even with a live World session.
    max_age: '0',
    claims: JSON.stringify({ id_token: { acr: { essential: true, values: config.acr } } }),
  }).toString()
  return { attemptId: attempt.id, authorizeUrl: url.toString(), expiresAt: attempt.expiresAt }
}

/** Error text from a URL can come from anyone, so only a plain code goes into a detail. */
function plainCode(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : 'unknown'
}

function refusalForError(code: string): Refusal {
  const detail = `World ID returned ${plainCode(code)}.`
  if (code === 'access_denied') return new Refusal('cancelled', detail)
  if (code === 'unmet_authentication_requirements' || code === 'account_not_eligible') {
    return new Refusal('unsupported_assurance', detail)
  }
  return new Refusal('provider_error', detail)
}

/** RFC 6749 section 2.3.1: form-encode each part before HTTP Basic. */
const formEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+')

async function redeemCode(config: Config, doc: Discovery, attempt: Attempt, code: string): Promise<string> {
  const basic = Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`).toString('base64')
  let response: Response
  try {
    response = await fetch(doc.token_endpoint, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: attempt.codeVerifier,
      }),
    })
  } catch {
    throw new Refusal('provider_error', 'The token endpoint did not answer.')
  }
  const body = (await response.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null
  if (!response.ok) {
    throw new Refusal(
      'provider_error',
      `The token endpoint returned ${plainCode(body?.error)} with HTTP ${response.status}.`,
    )
  }
  if (typeof body?.id_token !== 'string') {
    throw new Refusal('provider_error', 'The token response has no ID token.')
  }
  return body.id_token
}

async function verifyIdToken(config: Config, doc: Discovery, attempt: Attempt, idToken: string): Promise<JWTPayload> {
  let claims: JWTPayload
  try {
    const result = await jwtVerify(idToken, jwksFor(doc.jwks_uri), {
      issuer: doc.issuer,
      audience: config.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'sub', 'nonce', 'auth_time'],
      clockTolerance: CLOCK_SKEW_SECONDS,
    })
    claims = result.payload
  } catch (error) {
    // A key source failure is the provider's failure. Every other library error is a bad token.
    if (
      error instanceof errors.JOSEError &&
      error.code !== 'ERR_JWKS_TIMEOUT' &&
      error.code !== 'ERR_JWKS_INVALID'
    ) {
      throw new Refusal('invalid_token', `The ID token failed a check: ${error.code}.`)
    }
    throw new Refusal('provider_error', 'The World signing keys did not load.')
  }

  if (claims.nonce !== attempt.nonce) throw new Refusal('invalid_token', 'The ID token nonce does not match.')
  if (typeof claims.acr !== 'string' || !config.acr.includes(claims.acr)) {
    throw new Refusal('unsupported_assurance', `World ID returned the acr ${String(claims.acr).slice(0, 80)}.`)
  }
  const authTime = claims.auth_time
  if (typeof authTime !== 'number') throw new Refusal('invalid_token', 'The ID token auth_time is not a number.')
  if (authTime < Math.floor(attempt.createdAt / 1000) - CLOCK_SKEW_SECONDS) {
    throw new Refusal('unsupported_assurance', 'The World ID authentication is older than this attempt.')
  }
  if (authTime > Date.now() / 1000 + CLOCK_SKEW_SECONDS) {
    throw new Refusal('invalid_token', 'The ID token auth_time is in the future.')
  }
  return claims
}

async function verifyResponse(attempt: Attempt, params: URLSearchParams): Promise<JWTPayload> {
  const config = readConfig()
  if (!config) throw new Refusal('provider_error', 'Agent Pass is not configured.')
  const doc = await discover(config.issuer)

  const iss = params.get('iss')
  const issRequired = doc.authorization_response_iss_parameter_supported === true
  if (iss !== doc.issuer && (issRequired || iss !== null)) {
    throw new Refusal('invalid_token', 'The callback iss does not match the issuer.')
  }
  const error = params.get('error')
  if (error) throw refusalForError(error)
  const code = params.get('code')
  if (!code) throw new Refusal('invalid_token', 'The callback has no code.')

  const idToken = await redeemCode(config, doc, attempt, code)
  return verifyIdToken(config, doc, attempt, idToken)
}

/**
 * The last checks, the link and the use of the approval ID. This has no `await`, so these steps
 * happen as one step: no other request can run between them.
 */
function authorize(attempt: Attempt, claims: JWTPayload) {
  if (Date.now() > attempt.expiresAt) {
    throw new Refusal('expired', 'The 5-minute window ended before the checks finished.')
  }
  // A redeploy changes the token address. A mint to the old address would do nothing.
  if (!attempt.guarded && deployment().testUsdc !== attempt.token) {
    throw new Refusal('provider_error', 'The test token changed after this attempt started.')
  }
  const identity = { iss: claims.iss as string, sub: claims.sub as string }
  const wallet = attempt.wallet as Address
  const linked = identityOf(wallet)
  if (linked && (linked.iss !== identity.iss || linked.sub !== identity.sub)) {
    throw new Refusal('identity_mismatch', 'Another World ID is linked to this wallet.')
  }
  if (!store.openApprovals.delete(attempt.approvalId)) {
    throw new Refusal('replayed', 'This approval ID was used before.')
  }
  if (attempt.guarded && !attempt.guarded.consume()) {
    throw new Refusal('replayed', 'This action ran before, or it ended.')
  }
  if (!linked) linkIdentity(wallet, identity)
  attempt.identity = linked ? 'matched' : 'linked'
  attempt.acr = claims.acr as string
  attempt.amr = Array.isArray(claims.amr) ? claims.amr.map(String) : null
  attempt.stage = 'running'
}

/** The stand-in for an agent spend: a mint of 1 test USDC, through the dev key like the faucet. */
async function runProtectedAction(attempt: Attempt) {
  if (attempt.guarded) {
    attempt.txHash = await attempt.guarded.run()
    attempt.stage = 'approved'
    return
  }
  try {
    await withDevKey(async () => {
      const hash = await devWallet.sendTransaction({
        to: attempt.token as Address,
        data: encodeFunctionData({
          abi: TestUSDCAbi,
          functionName: 'mint',
          args: [attempt.wallet as Address, DEMO_AMOUNT],
        }),
        gas: MINT_GAS,
        ...LEGACY_TX,
      })
      attempt.txHash = hash
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
      if (receipt.status !== 'success') throw new Error('reverted')
    })
    attempt.stage = 'approved'
  } catch (error) {
    // Do not log the raw error: it can hold an RPC URL with an API key.
    console.error('[agent-pass] the protected action failed:', error instanceof Error ? error.name : 'unknown')
    // The approval is used, so nothing retries this. A sent transaction may still land.
    end(
      attempt,
      'provider_error',
      attempt.txHash
        ? 'World ID approved, but the server cannot confirm the transaction. Check its link.'
        : 'World ID approved, but the chain did not take the transaction.',
    )
  }
}

/** Handles the World redirect and returns the attempt ID to show. It never throws. */
export async function handleCallback(params: URLSearchParams): Promise<string> {
  const attempt = store.byState.get(params.get('state') ?? '')
  if (!attempt) return refusedCallback('invalid_token', 'The callback state matches no attempt.')

  expireIfDue(attempt)
  if (attempt.reason === 'expired') return attempt.id
  if (attempt.stage !== 'pending') {
    return refusedCallback('replayed', 'This callback was used before, so it ran nothing.', attempt)
  }
  // No `await` comes before this line, so only one request can pass it for one state.
  attempt.stage = 'checking'

  try {
    authorize(attempt, await verifyResponse(attempt, params))
  } catch (error) {
    if (error instanceof Refusal) {
      end(attempt, error.reason, error.detail)
    } else {
      console.error('[agent-pass] the checks failed:', error instanceof Error ? error.name : 'unknown')
      end(attempt, 'provider_error', 'The server failed during the checks.')
    }
    return attempt.id
  }

  // An agent send waits for its receipt. The browser must not wait on the World redirect for that,
  // so the page shows the send and its result.
  if (attempt.guarded) after(() => runProtectedAction(attempt))
  else await runProtectedAction(attempt)
  return attempt.id
}

export function returnUrl(attemptId: string): string {
  const attempt = store.byId.get(attemptId)
  const base = attempt?.guarded?.returnUrl ?? (attempt?.wallet ? RETURN_URL : AGENTS_URL)
  return `${base}?agentpass=${encodeURIComponent(attemptId)}`
}
