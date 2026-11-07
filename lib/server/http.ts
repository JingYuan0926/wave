// The route wrapper, the error body and the input checks. Server side only.
import { connection } from 'next/server'
import { isAddress, isHex, size, type Address, type Hex } from 'viem'
import { loadDeployment, type Deployment } from '../chain'

/** A failure that a route turns into a non-2xx response with an ApiErrorBody. */
export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** JSON has no BigInt, so every BigInt travels as a decimal string. */
export function json(body: unknown, status = 200): Response {
  const text = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

const OFFLINE_NAMES = new Set(['HttpRequestError', 'TimeoutError', 'WebSocketRequestError'])

/** True if the error chain shows that the local chain or the sidecar does not answer. */
export function isOffline(error: unknown): boolean {
  for (let e = error as { name?: string; message?: string; code?: string; cause?: unknown } | undefined; e; ) {
    if (e.name && OFFLINE_NAMES.has(e.name)) return true
    if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'UND_ERR_SOCKET') return true
    if (e.message === 'fetch failed') return true
    e = e.cause as typeof e
  }
  return false
}

/** Turns an error into a response. Raw error text can hold an RPC URL with an API key. */
export function failure(error: unknown): Response {
  if (error instanceof ApiFailure) {
    return json({ error: { code: error.code, message: error.message } }, error.status)
  }
  if (isOffline(error)) {
    return json({ error: { code: 'CHAIN_OFFLINE', message: 'The local chain does not answer.' } }, 503)
  }
  console.error('[wave api]', error)
  return json({ error: { code: 'SERVER_ERROR', message: 'The server failed. The server log has the detail.' } }, 500)
}

/** Wraps a route. `connection` makes a GET route run at request time, not at build time. */
export function route<T>(body: (request: Request) => Promise<T>) {
  return async (request: Request): Promise<Response> => {
    await connection()
    try {
      return json(await body(request))
    } catch (error) {
      return failure(error)
    }
  }
}

export async function readBody<T>(request: Request): Promise<T> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ApiFailure('BAD_REQUEST', 'The request body is not JSON.')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiFailure('BAD_REQUEST', 'The request body is not a JSON object.')
  }
  return body as T
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Refuses a request that comes through a tunnel or the LAN. Returns the Host header. */
export function requireLocalHost(request: Request): string {
  const host = request.headers.get('host') ?? ''
  const name = host.replace(/:\d+$/, '')
  if (!LOCAL_HOSTS.has(name) && process.env.WAVE_ALLOW_LAN !== '1') {
    throw new ApiFailure('LOCAL_ONLY', 'This route accepts local callers only.', 403)
  }
  return host
}

/**
 * For routes that spend the dev key. They have no login, so they accept local callers only.
 * A JSON content type makes a browser send a preflight, and these routes do not answer one.
 * Set WAVE_ALLOW_LAN=1 to reach them from a phone on the local network.
 */
export function requireLocal(request: Request): void {
  const host = requireLocalHost(request)
  // A sandboxed page sends the text "null", which is no URL.
  const origin = request.headers.get('origin')
  if (origin && URL.parse(origin)?.host !== host) {
    throw new ApiFailure('LOCAL_ONLY', 'This route rejects calls from another site.', 403)
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiFailure('BAD_REQUEST', 'This route needs a JSON content type.', 415)
  }
}

/** Exact paths only. Vite serves other files below /wallet/, and those files get no power here. */
const PAGE_PATHS = new Set(['/agents', '/wallet', '/wallet/'])

/**
 * For a step that only a WAVE page can take: /agents, or the phone UI at /wallet. A browser sets
 * these headers itself, and code in a web page cannot change them. So this refuses a tool or a
 * script that uses the normal routes.
 * It is not a wall against a program on this computer: such a program can copy the headers.
 * A browser sets Sec-Fetch headers only on a secure origin, so use localhost, not a LAN address.
 */
export function requirePage(request: Request): void {
  requireLocal(request)
  const headers = request.headers
  const referer = URL.parse(headers.get('referer') ?? '')
  const fromPage =
    Boolean(headers.get('origin')) &&
    headers.get('sec-fetch-site') === 'same-origin' &&
    headers.get('sec-fetch-mode') === 'cors' &&
    headers.get('sec-fetch-dest') === 'empty' &&
    PAGE_PATHS.has(referer?.pathname ?? '')
  if (!fromPage) throw new ApiFailure('PAGE_ONLY', 'Only the /agents or /wallet page on localhost can do this.', 403)
}

export function queryParam(request: Request, name: string): string {
  const value = new URL(request.url).searchParams.get(name)
  if (!value) throw new ApiFailure('BAD_REQUEST', `The query needs ${name}.`)
  return value
}

export function asAddress(value: unknown, label = 'address'): Address {
  // Strict mode rejects a bad checksum here. Otherwise the ABI encoder throws later, and the route gives a 500.
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new ApiFailure('BAD_REQUEST', `${label} is not an address, or its checksum is wrong.`)
  }
  return value as Address
}

export function asHex(value: unknown, label: string, bytes?: number): Hex {
  if (!isHex(value) || size(value) === 0 || (bytes !== undefined && size(value) !== bytes)) {
    throw new ApiFailure('BAD_REQUEST', `${label} is not ${bytes ?? 'valid'} bytes of hex.`)
  }
  return value
}

/** A hex number that fits in one 32-byte word. */
export function asWord(value: unknown, label: string): Hex {
  const hex = asHex(value, label)
  if (size(hex) > 32) throw new ApiFailure('BAD_REQUEST', `${label} is larger than 32 bytes.`)
  return hex
}

export const UINT96_MAX = (1n << 96n) - 1n
const UINT256_MAX = (1n << 256n) - 1n

/** Accepts a decimal string of a non-negative integer, up to `max`. */
export function asBaseUnits(value: unknown, label: string, max = UINT256_MAX): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ApiFailure('BAD_REQUEST', `${label} is not an integer string.`)
  }
  const amount = BigInt(value)
  if (amount > max) throw new ApiFailure('BAD_REQUEST', `${label} is too large.`)
  return amount
}

/** Accepts an integer from 0 to `max`. */
export function asInt(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ApiFailure('BAD_REQUEST', `${label} is not a valid number.`)
  }
  return value
}

/** Reads the deployment, or fails with a clear code. */
export function deployment(): Deployment {
  try {
    return loadDeployment()
  } catch {
    throw new ApiFailure('CONTRACTS_NOT_DEPLOYED', 'Deploy the contracts first: npm run deploy in contracts/.', 503)
  }
}
