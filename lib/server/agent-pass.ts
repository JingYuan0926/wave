// World ID Agent Pass: an OIDC step-up that guards one protected action. Server side only.
// Two flows use it:
// - The browser flow (the Settings test panel). The server keeps each attempt by `state`, because
//   the flow starts on localhost and returns on the tunnel host, so a cookie cannot bind them.
// - The device flow (agent actions). It needs no callback and no tunnel. The server polls World
//   for the result. World shows no action, so this flow proves only who the person is.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import {
  AGENT_PASS_OPERATION,
  type AgentPassAttempt,
  type AgentPassDevice,
  type AgentPassReason,
  type AgentPassStartResponse,
  type AgentPassStatusResponse,
} from '../api-types'
import { LEGACY_TX, devWallet, explorerLink, publicClient, sleep } from '../chain'
import { TestUSDCAbi } from '../wave-abi'
import { identityOf, linkIdentity, type Identity } from './agent-store'
import { ApiFailure, deployment } from './http'
import { withDevKey } from './roots'

const DEFAULT_ISSUER = 'https://sandbox.auth.world.org'
const DEFAULT_REDIRECT_URI = 'http://localhost:3000/api/agent-pass/callback'
// Orb, and Orb with Face Auth. The sandbox discovery document lists these two only.
const DEFAULT_ACR = 'https://world.org/oidc/acr/orb,https://world.org/oidc/acr/orb-face'

/** The browser returns here. The owner uses the app on this host, not on the tunnel host. */
const RETURN_URL = 'http://localhost:3000/settings'

const ATTEMPT_MS = 60_000
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

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** RFC 8628 section 3.2: the default wait when the response gives no interval. */
const DEFAULT_POLL_SECONDS = 5
const SLOW_DOWN_MS = 5_000
/** The longest extra wait after a poll that timed out. */
const MAX_BACKOFF_MS = 30_000

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
  device_authorization_endpoint?: string
  authorization_response_iss_parameter_supported?: boolean
}

type Stage = 'pending' | 'checking' | 'running' | 'approved' | 'failed'

/** An exact action that waits for a human. lib/server/agents.ts owns the action itself. */
export type GuardedAction = {
  /** Unix milliseconds. It does not move when a person tries again. */
  expiresAt: number
  /**
   * The person passed every check. This does not run the action: WAVE must show it first.
   * This must not await. False if the action is closed.
   */
  authenticated: (identity: Identity) => boolean
  /** One attempt failed. The action stays unsent. */
  refused: (reason: AgentPassReason, detail: string) => void
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
  /** Null for the browser flow. The device code is not here: only the poll loop holds it. */
  handoff: Omit<AgentPassDevice, 'expiresAt'> | null
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
    end(attempt, 'expired', 'The approval window ended before World ID returned.')
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
    guarded: null,
    handoff: null,
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

/** The configuration and the discovery document, or a failure that a route can show. */
async function readProvider(): Promise<{ config: Config; doc: Discovery }> {
  const config = readConfig()
  if (!config) throw new ApiFailure('AGENT_PASS_NOT_CONFIGURED', 'Agent Pass is not configured.', 503)
  try {
    return { config, doc: await discover(config.issuer) }
  } catch (error) {
    throw new ApiFailure('AGENT_PASS_UNAVAILABLE', (error as Error).message, 502)
  }
}

/** An essential request: a token with another class must not arrive at all. */
const acrClaims = (config: Config) => JSON.stringify({ id_token: { acr: { essential: true, values: config.acr } } })

export async function startAttempt(wallet: Address): Promise<AgentPassStartResponse> {
  const { config, doc } = await readProvider()

  prune()
  const now = Date.now()
  const attempt: Attempt = {
    id: randomUUID(),
    state: randomBytes(32).toString('base64url'),
    nonce: randomBytes(32).toString('base64url'),
    codeVerifier: randomBytes(32).toString('base64url'),
    approvalId: randomUUID(),
    wallet,
    token: deployment().testUsdc,
    createdAt: now,
    expiresAt: now + ATTEMPT_MS,
    stage: 'pending',
    reason: null,
    detail: null,
    txHash: null,
    acr: null,
    amr: null,
    identity: null,
    guarded: null,
    handoff: null,
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
    claims: acrClaims(config),
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

const basicAuth = (config: Config) =>
  `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`).toString('base64')}`

async function redeemCode(config: Config, doc: Discovery, attempt: Attempt, code: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(doc.token_endpoint, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        authorization: basicAuth(config),
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
  const device = attempt.handoff !== null
  let claims: JWTPayload
  try {
    const result = await jwtVerify(idToken, jwksFor(doc.jwks_uri), {
      issuer: doc.issuer,
      audience: config.clientId,
      algorithms: ['RS256'],
      requiredClaims: device ? ['exp', 'sub', 'auth_time'] : ['exp', 'sub', 'nonce', 'auth_time'],
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

  // World omits the nonce from device tokens. Only the device code and the client secret bind them.
  if (!device && claims.nonce !== attempt.nonce) throw new Refusal('invalid_token', 'The ID token nonce does not match.')
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
  if (device && !(Array.isArray(claims.amr) && claims.amr.length > 0 && claims.amr.every((item) => typeof item === 'string'))) {
    throw new Refusal('invalid_token', 'The ID token has no amr list.')
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
    throw new Refusal('expired', 'The approval window ended before the checks finished.')
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
  // A guarded action links the person at the confirmation, so a person who only scanned the code
  // cannot take the wallet. A second check at that moment compares the identity again.
  if (attempt.guarded) {
    if (!attempt.guarded.authenticated(identity)) throw new Refusal('replayed', 'This action ended before the checks finished.')
  } else if (!linked) {
    linkIdentity(wallet, identity)
  }
  attempt.identity = linked ? 'matched' : 'linked'
  attempt.acr = claims.acr as string
  attempt.amr = Array.isArray(claims.amr) ? claims.amr.map(String) : null
  attempt.stage = 'running'
}

/** The stand-in for an agent spend: a mint of 1 test USDC, through the dev key like the faucet. */
async function runProtectedAction(attempt: Attempt) {
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
    refuse(attempt, error)
    return attempt.id
  }
  await runProtectedAction(attempt)
  return attempt.id
}

export const returnUrl = (attemptId: string): string => `${RETURN_URL}?agentpass=${encodeURIComponent(attemptId)}`

/** Ends an attempt with the reason of a failed check. */
function refuse(attempt: Attempt, error: unknown) {
  if (error instanceof Refusal) {
    end(attempt, error.reason, error.detail)
  } else {
    console.error('[agent-pass] the checks failed:', error instanceof Error ? error.name : 'unknown')
    end(attempt, 'provider_error', 'The server failed during the checks.')
  }
}

type DeviceGrant = {
  deviceCode: string
  handoff: NonNullable<Attempt['handoff']>
  expiresInMs: number
  intervalMs: number
}

/** RFC 8628 section 3.2. */
async function requestDeviceGrant(config: Config, endpoint: string): Promise<DeviceGrant> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        authorization: basicAuth(config),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ scope: 'openid', claims: acrClaims(config) }),
    })
  } catch {
    throw new ApiFailure('AGENT_PASS_UNAVAILABLE', 'World ID did not answer. An unused code can stay open until it expires.', 502)
  }
  if (response.status === 429) {
    throw new ApiFailure('AGENT_PASS_RATE_LIMITED', 'World ID limits new requests now. Wait one minute, then try again.', 429)
  }
  if (response.status === 503) throw new ApiFailure('AGENT_PASS_UNAVAILABLE', 'World ID is not available now.', 503)
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    throw new ApiFailure('AGENT_PASS_UNAVAILABLE', `World ID returned ${plainCode(body?.error)} with HTTP ${response.status}.`, 502)
  }
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri, verification_uri_complete: complete } = body ?? {}
  const { expires_in: expiresIn, interval } = body ?? {}
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof uri !== 'string' ||
    typeof expiresIn !== 'number' ||
    expiresIn <= 0
  ) {
    throw new ApiFailure('AGENT_PASS_UNAVAILABLE', 'The World ID device response is not complete.', 502)
  }
  return {
    deviceCode,
    handoff: {
      userCode,
      verificationUri: uri,
      verificationUriComplete: typeof complete === 'string' ? complete : null,
    },
    expiresInMs: expiresIn * 1000,
    intervalMs: (typeof interval === 'number' && interval > 0 ? interval : DEFAULT_POLL_SECONDS) * 1000,
  }
}

type PollAnswer = { kind: 'token'; idToken: string } | { kind: 'pending' | 'slow_down' | 'timeout' }

/** One poll. A Refusal ends the attempt. */
async function pollToken(config: Config, doc: Discovery, deviceCode: string, timeoutMs: number): Promise<PollAnswer> {
  let response: Response
  try {
    response = await fetch(doc.token_endpoint, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: basicAuth(config),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({ grant_type: DEVICE_GRANT, device_code: deviceCode }),
    })
  } catch {
    return { kind: 'timeout' }
  }
  if (response.status === 503) {
    throw new Refusal('provider_error', 'World ID returned HTTP 503. This attempt ended, and this is not an approval.')
  }
  if (response.status === 429) {
    throw new Refusal('rate_limited', 'World ID returned HTTP 429. This attempt ended. Wait, then ask for a new code.')
  }
  const body = (await response.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null
  if (response.ok) {
    if (typeof body?.id_token === 'string') return { kind: 'token', idToken: body.id_token }
    throw new Refusal('provider_error', 'The token response has no ID token.')
  }
  if (body?.error === 'authorization_pending') return { kind: 'pending' }
  if (body?.error === 'slow_down') return { kind: 'slow_down' }
  if (body?.error === 'expired_token') throw new Refusal('expired', 'The World ID device code expired.')
  throw refusalForError(typeof body?.error === 'string' ? body.error : `http_${response.status}`)
}

/**
 * Waits for the result of one device attempt. It stops at the first final answer, and it never
 * starts a new attempt. Only a person can do that. The device code lives in this call only.
 */
async function pollDevice(attempt: Attempt, config: Config, doc: Discovery, deviceCode: string, firstIntervalMs: number) {
  let interval = firstIntervalMs
  let backoff = 0
  for (;;) {
    await sleep(interval + backoff)
    expireIfDue(attempt)
    if (attempt.stage !== 'pending') return
    const answer = await pollToken(config, doc, deviceCode, Math.min(FETCH_TIMEOUT_MS, attempt.expiresAt - Date.now() + 1))
    if (answer.kind === 'timeout') {
      backoff = Math.min(backoff ? backoff * 2 : interval, MAX_BACKOFF_MS)
      continue
    }
    backoff = 0
    if (answer.kind === 'slow_down') interval += SLOW_DOWN_MS
    if (answer.kind !== 'token') continue
    if (attempt.stage !== 'pending') return
    attempt.stage = 'checking'
    authorize(attempt, await verifyIdToken(config, doc, attempt, answer.idToken))
    attempt.stage = 'approved'
    return
  }
}

/** Starts a device attempt for one action and gives the attempt ID. The caller shows the handoff. */
export async function startDeviceAttempt(wallet: Address, guarded: GuardedAction): Promise<string> {
  const { config, doc } = await readProvider()
  if (!doc.device_authorization_endpoint) {
    throw new ApiFailure('AGENT_PASS_UNAVAILABLE', 'The World discovery document has no device endpoint.', 502)
  }
  const createdAt = Date.now()
  const grant = await requestDeviceGrant(config, doc.device_authorization_endpoint)

  prune()
  const attempt: Attempt = {
    id: randomUUID(),
    state: '',
    nonce: '',
    codeVerifier: '',
    approvalId: randomUUID(),
    wallet,
    token: null,
    createdAt,
    // The device code lives for 20 minutes. The action decides the real window.
    expiresAt: Math.min(guarded.expiresAt, createdAt + grant.expiresInMs),
    stage: 'pending',
    reason: null,
    detail: null,
    txHash: null,
    acr: null,
    amr: null,
    identity: null,
    guarded,
    handoff: grant.handoff,
  }
  store.byId.set(attempt.id, attempt)
  store.openApprovals.add(attempt.approvalId)
  // This outlives the request, as the state on globalThis does. The action window bounds it.
  void pollDevice(attempt, config, doc, grant.deviceCode, grant.intervalMs).catch((error) => refuse(attempt, error))
  return attempt.id
}

/** The code and the link for a person. Null when the attempt no longer waits for World ID. */
export function deviceHandoff(attemptId: string): AgentPassDevice | null {
  const attempt = store.byId.get(attemptId)
  if (!attempt?.handoff) return null
  expireIfDue(attempt)
  if (attempt.stage !== 'pending' && attempt.stage !== 'checking') return null
  return { ...attempt.handoff, expiresAt: attempt.expiresAt }
}

/** Stops the poll loop of an action that the owner closed. */
export function cancelAttempt(attemptId: string, detail: string) {
  const attempt = store.byId.get(attemptId)
  if (attempt?.stage === 'pending') end(attempt, 'cancelled', detail)
}
