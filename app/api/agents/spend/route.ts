import type { AgentSpendRequest, AgentSpendResponse } from "@/lib/api-types";
import { requestSpend } from "@/lib/server/agents";
import { readBody, requireLocal, route } from "@/lib/server/http";

// This route signs with the agent key on this server, so only a local caller can reach it.
export const POST = route(async (request): Promise<AgentSpendResponse> => {
  requireLocal(request);
  return requestSpend(await readBody<AgentSpendRequest>(request));
});
