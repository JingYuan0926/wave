// A local stand-in for the World ID device flow, for tests only. IT IS NOT WORLD. It signs real
// RS256 ID tokens with a key that it makes at start, and it answers discovery, keys, the device
// grant and token polls. A test decides each answer. A result from this file proves the checks in
// WAVE. It proves nothing about World ID.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

export const FAKE_ACR = 'https://world.org/oidc/acr/orb'

type Answer = { kind: 'pending' } | { kind: 'approve'; sub: string } | { kind: 'error'; error: string }

type Grant = { deviceCode: string; userCode: string; answer: Answer }

export type FakeIssuer = {
  url: string
  /** Each device code and token that left this process. A test checks that no tool output has one. */
  secrets: () => string[]
  /** The newest grant for a user code. */
  approve: (userCode: string, sub: string) => void
  deny: (userCode: string) => void
  expire: (userCode: string) => void
  stop: () => Promise<void>
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => resolve(new URLSearchParams(body)))
  })
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

export async function startFakeIssuer(port: number, clientId: string, clientSecret: string): Promise<FakeIssuer> {
  const url = `http://localhost:${port}`
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  // A new key needs a new key ID, because the server keeps the keys of an earlier run.
  const jwk = { ...(await exportJWK(publicKey)), kid: randomBytes(8).toString('hex'), alg: 'RS256', use: 'sig' }
  const grants = new Map<string, Grant>()
  const issued: string[] = []
  const basic = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`

  const idToken = async (sub: string) => {
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({ acr: FAKE_ACR, amr: ['fake'], auth_time: now })
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(url)
      .setAudience(clientId)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey)
    issued.push(token)
    return token
  }

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', url).pathname
      if (path === '/.well-known/openid-configuration') {
        return send(response, 200, {
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          jwks_uri: `${url}/jwks`,
          device_authorization_endpoint: `${url}/device`,
        })
      }
      if (path === '/jwks') return send(response, 200, { keys: [jwk] })
      if (request.headers.authorization !== basic) return send(response, 401, { error: 'invalid_client' })

      const form = await readForm(request)
      if (path === '/device') {
        const grant: Grant = {
          deviceCode: randomBytes(24).toString('base64url'),
          userCode: randomBytes(4).toString('hex').toUpperCase(),
          answer: { kind: 'pending' },
        }
        grants.set(grant.userCode, grant)
        issued.push(grant.deviceCode)
        return send(response, 200, {
          device_code: grant.deviceCode,
          user_code: grant.userCode,
          verification_uri: `${url}/activate`,
          verification_uri_complete: `${url}/activate?code=${grant.userCode}`,
          expires_in: 1200,
          interval: 1,
        })
      }
      if (path === '/token') {
        const grant = [...grants.values()].find((item) => item.deviceCode === form.get('device_code'))
        if (!grant) return send(response, 400, { error: 'invalid_grant' })
        if (grant.answer.kind === 'pending') return send(response, 400, { error: 'authorization_pending' })
        if (grant.answer.kind === 'error') return send(response, 400, { error: grant.answer.error })
        return send(response, 200, { id_token: await idToken(grant.answer.sub) })
      }
      return send(response, 404, { error: 'not_found' })
    })().catch(() => send(response, 500, { error: 'server_error' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  const answer = (userCode: string, next: Answer) => {
    const grant = grants.get(userCode)
    if (!grant) throw new Error(`The fake issuer has no grant for ${userCode}.`)
    grant.answer = next
  }

  return {
    url,
    secrets: () => [...issued],
    approve: (userCode, sub) => answer(userCode, { kind: 'approve', sub }),
    deny: (userCode) => answer(userCode, { kind: 'error', error: 'access_denied' }),
    expire: (userCode) => answer(userCode, { kind: 'error', error: 'expired_token' }),
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
