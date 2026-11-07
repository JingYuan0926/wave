// The route wrappers for the Whitechain relayer: the shared route() plus CORS for the extension.
import { readBody, route } from './http'
import { corsHeaders } from './wc-relayer'

function withCors(inner: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const response = await inner(request)
    for (const [k, v] of Object.entries(corsHeaders(request))) response.headers.set(k, v)
    return response
  }
}

/** `guard` runs first and refuses the request with an ApiFailure. */
export function wcPost<T>(handler: (body: Record<string, unknown>) => Promise<T>, guard?: (request: Request) => void) {
  return withCors(
    route(async (request) => {
      guard?.(request)
      return handler(await readBody<Record<string, unknown>>(request))
    }),
  )
}

export function wcGet<T>(handler: () => Promise<T>) {
  return withCors(route(handler))
}

export function wcOptions(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}
