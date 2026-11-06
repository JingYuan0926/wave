// The route wrapper for the Whitechain relayer: the shared route() plus CORS for the extension.
import { readBody, route } from './http'
import { corsHeaders } from './wc-relayer'

export function wcPost<T>(handler: (body: Record<string, unknown>) => Promise<T>) {
  const inner = route(async (request) => handler(await readBody<Record<string, unknown>>(request)))
  return async (request: Request): Promise<Response> => {
    const response = await inner(request)
    for (const [k, v] of Object.entries(corsHeaders(request))) response.headers.set(k, v)
    return response
  }
}

export function wcOptions(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}
