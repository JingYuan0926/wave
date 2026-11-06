import type { AgentPassStatusResponse } from "@/lib/api-types";
import { readStatus } from "@/lib/server/agent-pass";
import { route } from "@/lib/server/http";

// With no id, this gives the configuration only. The view never holds a secret.
export const GET = route(async (request): Promise<AgentPassStatusResponse> => {
  return readStatus(new URL(request.url).searchParams.get("id"));
});
