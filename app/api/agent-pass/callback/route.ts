import { connection } from "next/server";
import { handleCallback, returnUrl } from "@/lib/server/agent-pass";

// World redirects the browser here through the tunnel, so this route has no local check.
// The `state` value and the ID token checks protect it. It needs no client JS.
export async function GET(request: Request) {
  await connection();
  const attemptId = await handleCallback(new URL(request.url).searchParams);
  return new Response(null, {
    status: 303,
    headers: { location: returnUrl(attemptId), "cache-control": "no-store" },
  });
}
